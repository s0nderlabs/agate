// fetchSource for bun (BUILD-SPEC 7.7): one GET with an honest user agent and a timeout, one retry after a gap
// when it still starts inside the interval. Bodies are decoded (gzip, br, deflate) by fetch itself; `bytes` is the
// decoded size, which is what CRE's 250 KB cap applies to.
import { createHash } from "node:crypto";
import { CRE_CAP_BYTES } from "../pure/recipe.ts";
import type { FetchOutcome } from "../types.ts";

export interface FetchSourceOptions {
  role: string; // "watcher", "standby", ... (enters the user agent)
  timeoutMs?: number; // default 40 s (production); slice / 10 on demo profiles
  /** Retry gap bounds in ms (default 30 to 120 s, already scaled by the caller for short slices). */
  retryGapMs?: [number, number];
  /** No retry when it would start at or after this unix second (the end of the reading's interval). */
  retryBefore?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number; // unix seconds
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

export interface SourceFetch extends FetchOutcome {
  pageTime?: number; // X-Agate-Page-Time of a replayed page
  overCap: boolean; // decoded body above CRE's cap
}

export function userAgent(role: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(role)) throw new Error(`bad role ${role}`);
  return `agate-wall/${role}/0.1 (+https://github.com/s0nderlabs/agate)`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function once(url: string, o: FetchSourceOptions, attempt: number): Promise<SourceFetch> {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(url, {
      headers: { "user-agent": userAgent(o.role), accept: "*/*" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 40_000),
      redirect: "follow",
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ok = res.status >= 200 && res.status < 300 && bytes.length > 0;
    const out: SourceFetch = {
      ok,
      httpStatus: res.status,
      body: new TextDecoder("utf-8").decode(bytes),
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      fetchedAt: now(),
      attempts: attempt,
      overCap: bytes.length > CRE_CAP_BYTES,
    };
    const pt = res.headers.get("x-agate-page-time");
    if (pt && /^\d{9,11}$/.test(pt)) out.pageTime = Number(pt);
    if (!ok) out.error = bytes.length === 0 ? `HTTP ${res.status}, empty body` : `HTTP ${res.status}`;
    return out;
  } catch (e) {
    return {
      ok: false,
      httpStatus: 0,
      body: "",
      bytes: 0,
      sha256: "",
      fetchedAt: now(),
      attempts: attempt,
      overCap: false,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

/** One fetch, and one retry after a random gap if the first fails and the retry still starts before retryBefore. */
export async function fetchSource(url: string, o: FetchSourceOptions): Promise<SourceFetch> {
  const first = await once(url, o, 1);
  if (first.ok) return first;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const [lo, hi] = o.retryGapMs ?? [30_000, 120_000];
  const gap = Math.round(lo + (o.rand ?? Math.random)() * (hi - lo));
  if (o.retryBefore !== undefined && now() + gap / 1000 >= o.retryBefore) return first;
  await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(gap);
  return once(url, o, 2);
}
