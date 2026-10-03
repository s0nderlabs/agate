// Tracker fetches for one interval (BUILD-SPEC 15.1): one fetch per file, honest user agent, timeout
// min(40 s, slice / 10), one retry; raw bodies gzipped under <pagecheck>/<index8>/raw/<date>/<interval>/, kept 14 days.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel } from "@agate/report/types";
import { writeAtomic } from "@agate/watcher";
import { GE_FILE, GE_URL, GT_URL, type IntervalTrackers, parseGpuEconomy, parseGpuTable, type ParseFail, type TrackerId } from "./trackers.ts";

export const USER_AGENT = "agate-wall/pagecheck/0.1 (+https://github.com/s0nderlabs/agate)";
export const RAW_KEEP_DAYS = 14;

export interface TrackerPage {
  ok: boolean;
  status: number;
  body: string;
  pageTime?: number;
  error?: string;
}
export type FetchTracker = (url: string, timeoutMs: number) => Promise<TrackerPage>;

/** The most a tracker body may hold (GPUTable's whole file was 169 KB on Oct 2; recheck r1, L2). */
export const MAX_TRACKER_BYTES = 8 * 1024 * 1024;

/** The body as text, or null past `cap` bytes (the read stops there). */
async function cappedText(res: Response, cap: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > cap) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export const httpFetchTracker: FetchTracker = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const body = await cappedText(res, MAX_TRACKER_BYTES);
    if (body === null) return { ok: false, status: res.status, body: "", error: `body over ${MAX_TRACKER_BYTES} bytes` };
    const pt = res.headers.get("x-agate-page-time");
    const page: TrackerPage = { ok: res.status >= 200 && res.status < 300 && body.length > 0, status: res.status, body };
    if (pt && /^\d+$/.test(pt)) page.pageTime = Number(pt);
    if (!page.ok) page.error = `HTTP ${res.status}`;
    return page;
  } catch (e) {
    return { ok: false, status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
};

/** The tracker URLs, or the replay server's routes under TRACKER_BASE_URL (7.9). */
export function trackerUrls(base?: string): { ge: (gpu: GpuModel) => string; gt: string } {
  if (!base) return { ge: GE_URL, gt: GT_URL };
  const b = base.replace(/\/+$/, "");
  return { ge: (gpu) => `${b}/t_gpu_economy/${GE_FILE[gpu]}`, gt: `${b}/t_gputable` };
}

export function rawFile(rawDir: string, date: string, k: number, tracker: TrackerId, gpu?: GpuModel): string {
  return join(rawDir, date, String(k), tracker === "gpueconomy" ? `gpueconomy.${GE_FILE[gpu!]}.gz` : "gputable.all.gz");
}

export interface FetchDeps {
  fetch: FetchTracker;
  timeoutMs: number;
  base?: string;
  rawDir: string | null;
  now: () => number;
  /** wait before the one retry (ms); tests pass 0 */
  retryMs?: number;
}

async function once(d: FetchDeps, url: string): Promise<TrackerPage> {
  const p = await d.fetch(url, d.timeoutMs);
  if (p.ok) return p;
  if (d.retryMs) await Bun.sleep(d.retryMs);
  return d.fetch(url, d.timeoutMs);
}

const utcDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** One interval's fetch: GPU Economy's file per GPU, then GPUTable only when some pair may need the fallback. */
export async function fetchInterval(d: FetchDeps, k: number, kStart: number, gpus: readonly GpuModel[], needGt: (t: IntervalTrackers) => boolean): Promise<{ t: IntervalTrackers; fetched: string[]; failed: string[] }> {
  const urls = trackerUrls(d.base);
  // the page-time header is the replay's (7.9): a production tracker never decides what "stale" means (recheck r1, L2)
  const replay = Boolean(d.base);
  const t: IntervalTrackers = { at: d.now(), ge: {} };
  const fetched: string[] = [];
  const failed: string[] = [];
  let pageTime: number | undefined;
  const save = (p: TrackerPage, tracker: TrackerId, gpu?: GpuModel) => {
    if (!d.rawDir || !p.ok) return;
    writeAtomic(rawFile(d.rawDir, utcDate(kStart), k, tracker, gpu), Bun.gzipSync(new TextEncoder().encode(p.body)));
  };
  for (const gpu of gpus) {
    const p = await once(d, urls.ge(gpu));
    if (replay && p.pageTime !== undefined) pageTime = p.pageTime;
    save(p, "gpueconomy", gpu);
    (p.ok ? fetched : failed).push(`gpueconomy.${GE_FILE[gpu]}`);
    t.ge[gpu] = p.ok ? parseGpuEconomy(p.body) : ({ ok: false, why: p.error ?? "failed" } as ParseFail);
  }
  if (pageTime !== undefined) t.at = pageTime;
  if (needGt(t)) {
    const p = await once(d, urls.gt);
    if (replay && p.pageTime !== undefined && pageTime === undefined) t.at = p.pageTime;
    save(p, "gputable");
    (p.ok ? fetched : failed).push("gputable");
    t.gt = p.ok ? parseGpuTable(p.body) : { ok: false, why: p.error ?? "failed" };
  }
  return { t, fetched, failed };
}

/** Rebuilds one interval's trackers from the saved raw bodies (the repair agent's evidence). Null when none was saved. */
export function loadInterval(rawDir: string, k: number, kStart: number, at: number): IntervalTrackers | null {
  const date = utcDate(kStart);
  const t: IntervalTrackers = { at, ge: {} };
  let any = false;
  for (const gpu of Object.keys(GE_FILE) as GpuModel[]) {
    const f = rawFile(rawDir, date, k, "gpueconomy", gpu);
    if (!existsSync(f)) continue;
    any = true;
    t.ge[gpu] = parseGpuEconomy(new TextDecoder().decode(Bun.gunzipSync(readFileSync(f))));
  }
  const g = rawFile(rawDir, date, k, "gputable");
  if (existsSync(g)) {
    any = true;
    t.gt = parseGpuTable(new TextDecoder().decode(Bun.gunzipSync(readFileSync(g))));
  }
  return any ? t : null;
}

/** Removes raw date folders older than RAW_KEEP_DAYS. */
export function pruneRaw(rawDir: string, now: number, keepDays = RAW_KEEP_DAYS): string[] {
  if (!existsSync(rawDir)) return [];
  const cut = utcDate(now - keepDays * 86_400);
  const gone: string[] = [];
  for (const d of readdirSync(rawDir)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cut) {
      rmSync(join(rawDir, d), { recursive: true, force: true });
      gone.push(d);
    }
  }
  return gone;
}
