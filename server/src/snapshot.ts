// The markets snapshot (GET /api/markets): every market and every listed month's book, read here once for all the
// app's visitors instead of each browser reading the chain and the indexer itself (four rounds, dozens of calls on a
// public RPC). A snapshot younger than FRESH_MS is served as it is; an older one is served at once while a single read
// refreshes it in the background; past SERVE_MAX_MS (under the client's SNAPSHOT_MAX_AGE_MS) a request waits for a
// read, and gets none (503, the app then reads the chain itself) when that read fails. From the first ask on, a timer
// refreshes it every WARM_EVERY_MS, so a visitor never waits on a cold read (the client gives up after 2.5 s).
import { type AgateClient, type MarketsSnapshot, SNAPSHOT_MAX_AGE_MS } from "@agate/client";

export const FRESH_MS = 5_000;
export const SERVE_MAX_MS = SNAPSHOT_MAX_AGE_MS - 10_000;
export const WARM_EVERY_MS = 15_000;

export interface SnapshotCache {
  /** the snapshot to serve, or null when none could be read */
  get(): Promise<MarketsSnapshot | null>;
  /** stops the warm timer */
  stop(): void;
}

type Data = Awaited<ReturnType<AgateClient["marketsAndBooks"]>>;

export function snapshotCache(client: () => AgateClient, o: { now?: () => number; freshMs?: number; serveMaxMs?: number; warmEveryMs?: number; log?: (e: Record<string, unknown>) => void } = {}): SnapshotCache {
  const now = o.now ?? Date.now;
  const fresh = o.freshMs ?? FRESH_MS;
  const serveMax = o.serveMaxMs ?? SERVE_MAX_MS;
  let last: { at: number; data: Data; chainId: number; index: string } | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** one read at a time; its age counts from when it started */
  const refresh = (): Promise<void> => {
    if (!inflight) {
      const read = async () => {
        const started = now();
        const c = client();
        try {
          const data = await c.marketsAndBooks();
          last = { at: started, data, chainId: c.chain.id, index: c.index.toLowerCase() };
        } catch (e) {
          o.log?.({ event: "snapshot.failed", error: String(e).slice(0, 300) });
          throw e;
        }
      };
      inflight = read().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const warm = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (!last || now() - last.at >= fresh) refresh().catch(() => {});
    }, o.warmEveryMs ?? WARM_EVERY_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    async get() {
      warm();
      if (!last || now() - last.at > serveMax) {
        try {
          await refresh();
        } catch {
          // a concurrent read may still have left one young enough
        }
      } else if (now() - last.at >= fresh) refresh().catch(() => {});
      const s = last as typeof last;
      if (!s) return null;
      const age = now() - s.at;
      if (age > serveMax) return null;
      return { v: 1, chainId: s.chainId, index: s.index, readAt: new Date(s.at).toISOString(), ageMs: age, markets: s.data.markets, books: s.data.books };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
