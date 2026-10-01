// Page fetching for the bun writers: one GET per page, honest user agent, a timeout, one retry while it still
// starts inside the slice (7.7). Replay pages carry their own time in X-Agate-Page-Time (7.4, 7.9).
import type { SourceDef } from "@agate/sources/types";
import { type Clock, ECB_ID, ECB_URL, type PageResult, pageUrl, userAgent, utcDate } from "../core/index.ts";

export type Fetcher = (url: string) => Promise<PageResult>;

export interface FetchOptions {
  role: string;
  timeoutMs: number;
  /** Retry gap bounds in seconds before scaling (30 to 120 s at a 3,600 s slice). */
  retryGap?: [number, number];
  /** The retry is skipped when it would start at or after this unix second. */
  retryBefore?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  fetchImpl?: typeof fetch;
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function fetchOnce(url: string, role: string, timeoutMs: number, f: typeof fetch = fetch): Promise<PageResult> {
  try {
    const res = await f(url, {
      headers: { "user-agent": userAgent(role), accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pt = res.headers.get("x-agate-page-time");
    const page: PageResult = {
      ok: res.status >= 200 && res.status < 300 && bytes.length > 0,
      httpStatus: res.status,
      body: new TextDecoder("utf-8").decode(bytes),
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      attempts: 1,
    };
    if (pt && /^\d+$/.test(pt)) page.pageTime = Number(pt);
    if (!page.ok) page.error = `HTTP ${res.status}`;
    return page;
  } catch (e) {
    return { ok: false, httpStatus: 0, body: "", bytes: 0, attempts: 1, error: e instanceof Error ? e.message : String(e) };
  }
}

export function makeFetcher(o: FetchOptions, c: Clock): Fetcher {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = o.rand ?? Math.random;
  const [lo, hi] = o.retryGap ?? [30, 120];
  return async (url) => {
    const first = await fetchOnce(url, o.role, o.timeoutMs, o.fetchImpl);
    if (first.ok) return first;
    const gapS = ((lo + rand() * (hi - lo)) * c.slice) / 3_600;
    if (o.retryBefore && now() + gapS >= o.retryBefore()) return first;
    await sleep(Math.round(gapS * 1000));
    const second = await fetchOnce(url, o.role, o.timeoutMs, o.fetchImpl);
    return { ...second, attempts: 2 };
  };
}

/** Production timeout 40 s; slice / 10 on the short demo profiles (7.7). */
export function timeoutFor(c: Clock): number {
  return Math.min(40, Math.max(1, c.slice / 10)) * 1000;
}

/** Fetches every needed page once (in parallel) plus the ECB file, reused within one UTC day. */
export class PageReader {
  private ecb?: { date: string; page: PageResult };
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base?: string,
  ) {}

  async readAll(defs: readonly SourceDef[], at: number): Promise<{ pages: Record<string, PageResult>; fx?: PageResult }> {
    const wantFx = defs.some((d) => d.currency === "EUR");
    const [fx, ...results] = await Promise.all([
      wantFx ? this.fx(at) : Promise.resolve(undefined),
      ...defs.map((d) => this.fetcher(pageUrl(d.id, d.url, this.base))),
    ]);
    const pages: Record<string, PageResult> = {};
    defs.forEach((d, i) => {
      pages[d.id] = results[i]!;
    });
    return fx ? { pages, fx } : { pages };
  }

  private async fx(at: number): Promise<PageResult> {
    const date = utcDate(at);
    if (this.ecb?.date === date && this.ecb.page.ok) return this.ecb.page;
    const page = await this.fetcher(pageUrl(ECB_ID, ECB_URL, this.base));
    this.ecb = { date, page };
    return page;
  }
}
