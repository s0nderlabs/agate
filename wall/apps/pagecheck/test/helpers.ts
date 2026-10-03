// Test helpers: synthetic tracker files in the trackers' own field names (never a copy of a tracker file), a watcher
// log writer, a scripted fetcher and a PageCheck on a temporary home.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GpuModel, Hex, WatcherReading } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { AlertSink } from "@agate/watcher";
import type { FetchTracker, TrackerPage } from "../src/fetch.ts";
import { PageCheck, type PcClock } from "../src/pagecheck.ts";
import { WatchLog } from "../src/watchlog.ts";

export const INDEX = "0x1234567890abcdef1234567890abcdef12345678";
export const H100_ID = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955" as Hex;
export const H200_ID = "0x2200000000000000000000000000000000000000000000000000000000000000" as Hex;
/** TEST-like clock: DAY 2,400 s, slice 200 s (12 intervals a day), MIN_READINGS 6; epoch on a real date. */
export const CLOCK: PcClock = { day: 2_400, slice: 200, minReadings: 6, epochTs: 1_790_000_000 };

export const PANELS: Panel[] = [
  {
    gpu: "H100",
    spec: "H100-SXM/on-demand-list/neocloud/v1",
    gpuId: H100_ID,
    families: [{ name: "Lambda", famQ: 1 }, { name: "Hyperstack", famQ: 1 }, { name: "Seeweb", famQ: 1 }],
    slots: [
      { slot: 0, sourceId: "p_lambda", family: 0, liveAtStart: true },
      { slot: 1, sourceId: "p_hyperstack", family: 1, liveAtStart: false },
      { slot: 2, sourceId: "p_seeweb", family: 2, liveAtStart: true },
    ],
  },
  {
    gpu: "H200",
    spec: "H200-SXM/on-demand-list/neocloud/v1",
    gpuId: H200_ID,
    families: [{ name: "Nebius", famQ: 1 }],
    slots: [{ slot: 0, sourceId: "p_nebius", family: 0, liveAtStart: true }],
  },
];

const dirs: string[] = [];
export function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "agate-pagecheck-"));
  dirs.push(d);
  return d;
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export const iso = (t: number) => new Date(t * 1000).toISOString();

/** A GPU Economy per-GPU file. */
export function geFile(updatedAt: number, rows: Record<string, unknown>[]): string {
  return JSON.stringify({ name: "synthetic", data_updated_at: iso(updatedAt), count: rows.length, prices: rows });
}
export const geRow = (provider_id: string, usd: number | string, o: Record<string, unknown> = {}) => ({
  provider: provider_id,
  provider_id,
  price_type: "on_demand",
  status: "live",
  gpu_count: 8,
  usd_per_gpu_hour: usd,
  listed_since: "2026-09-07T00:58:28+00:00",
  last_confirmed_at: "2026-10-02T07:40:13+00:00",
  ...o,
});
/** A GPUTable data.json. */
export function gtFile(rows: Record<string, unknown>[]): string {
  return JSON.stringify({ generated_at: "2026-10-02T12:00:00+00:00", source: "synthetic", data: rows });
}
export const gtRow = (provider: string, gpu: string, usd: number, o: Record<string, unknown> = {}) => ({
  gpu,
  provider,
  gpu_count: 8,
  price_per_hour_usd: usd,
  pricing_type: "on_demand",
  commitment_months: null,
  available: null,
  source_url: "https://example.invalid/?ref=gputable",
  ...o,
});

export type Script = (url: string) => TrackerPage | undefined;
/** A fetcher answering from a script; anything unscripted is a 404. Records every URL. */
export function scripted(script: { current: Script }): { fetch: FetchTracker; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return script.current(url) ?? { ok: false, status: 404, body: "", error: "HTTP 404" };
    },
  };
}
export const ok = (body: string, pageTime?: number): TrackerPage => ({ ok: true, status: 200, body, ...(pageTime !== undefined ? { pageTime } : {}) });

export const start = (k: number, c = CLOCK) => c.epochTs + k * c.slice;

/** Appends a watcher line for (source, k) with every listed GPU in the given state. */
export function writeLine(home: string, sourceId: string, k: number, gpus: Partial<Record<GpuModel, number | "NO_ROW" | "NOT_RENTABLE" | "FAILED">>, extra: Partial<WatcherReading> = {}): void {
  const dir = join(home, "watcher", INDEX.toLowerCase(), "log");
  mkdirSync(dir, { recursive: true });
  const g: WatcherReading["gpus"] = {};
  for (const [m, v] of Object.entries(gpus) as [GpuModel, number | string][]) g[m] = typeof v === "number" ? { state: "VALID", valueU: v } : { state: v as "NO_ROW", valueU: 0 };
  const line: WatcherReading = { sourceId, interval: k, scheduledAt: start(k) + 50, fetchedAt: start(k) + 50, attempts: 1, httpStatus: 200, bytes: 100, sha256: "ab", gpus: g, ...extra };
  appendFileSync(join(dir, `${new Date(start(k) * 1000).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
}

export function makeCheck(home: string, fetch: FetchTracker, o: { panels?: Panel[]; clock?: PcClock; base?: string } = {}) {
  const now = { t: CLOCK.epochTs };
  const alerts = new AlertSink(join(home, "alerts", "alerts.jsonl"), { now: () => now.t, role: "pagecheck", index: INDEX, print: false });
  const pc = new PageCheck({ index: INDEX, clock: o.clock ?? CLOCK, panels: o.panels ?? PANELS, log: new WatchLog(join(home, "watcher", INDEX.toLowerCase())), alerts, home, fetch, ...(o.base ? { trackerBaseUrl: o.base } : {}), now: () => now.t, retryMs: 0, settleS: 5 });
  /** Runs interval k: fetch inside it, compare right after it ends. */
  const step = async (k: number) => {
    now.t = start(k) + 100;
    await pc.tick(now.t);
    now.t = start(k + 1) + 6;
    await pc.tick(now.t);
  };
  return { pc, alerts, now, step };
}
