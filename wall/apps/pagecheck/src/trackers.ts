// The two trackers the page check reads (BUILD-SPEC 15.1): GPU Economy's per-GPU files (primary) and GPUTable's
// data.json (fallback). Tracker files are untrusted input (15.3): JSON.parse only, only the named fields, every
// provider not in the map ignored, Runpod and Crusoe rows skipped by provider name before any other field is read.
import type { GpuModel } from "@agate/report/types";
import { parseMicro } from "@agate/sources/pure";

export type TrackerId = "gpueconomy" | "gputable";

export interface TrackerMapEntry {
  /** GPU Economy `provider_id` */
  ge: string;
  /** GPUTable `provider` */
  gt: string;
  /** GPUs whose GPUTable row is never read for this source (Hyperstack H100: its PCIe price labelled SXM) */
  gtNever?: readonly GpuModel[];
}

/** sourceId to tracker provider (15.1). p_seeweb and p_gcore: none, not compared. */
export const TRACKER_MAP: Readonly<Record<string, TrackerMapEntry>> = {
  p_verda: { ge: "datacrunch", gt: "Verda" },
  p_nebius: { ge: "nebius", gt: "Nebius" },
  p_lambda: { ge: "lambda", gt: "Lambda Labs" },
  p_coreweave: { ge: "coreweave", gt: "CoreWeave" },
  p_civo: { ge: "civo", gt: "Civo" },
  p_hyperstack: { ge: "hyperstack", gt: "Hyperstack", gtNever: ["H100"] },
};

export const GE_FILE: Readonly<Record<GpuModel, string>> = { H100: "h100-sxm", H200: "h200", B200: "b200" };
export const GT_GPU: Readonly<Record<GpuModel, string>> = { H100: "H100 SXM", H200: "H200", B200: "B200" };
export const GE_URL = (gpu: GpuModel) => `https://gpueconomy.com/gpu/${GE_FILE[gpu]}/prices.json`;
export const GT_URL = "https://gputable.dev/data.json";
export const ATTRIBUTION = { gpueconomy: "GPU Economy (https://gpueconomy.com)", gputable: "GPUTable (https://gputable.dev)" } as const;
/** GPU Economy's file is "stale" (fall back to GPUTable) when data_updated_at is older than this. */
export const GE_STALE_S = 26 * 3_600;

/** Provider names never read, in any tracker (7.1): Runpod, Runpod Community, Crusoe. */
export function forbiddenProvider(name: unknown): boolean {
  return typeof name === "string" && /run\s*pod|crusoe/i.test(name);
}
/** GPUTable rows excluded from the comparison: every Together row (shifted columns). */
function gtExcludedProvider(name: string): boolean {
  return /^together/i.test(name);
}

/** A tracker decimal (a JSON number or a decimal string) to an exact count of u, half up beyond six decimals.
 *  Null when it is not a plain non-negative decimal. No floats in the arithmetic. */
export function trackerMicro(x: unknown): bigint | null {
  let s: string;
  if (typeof x === "number") {
    if (!Number.isFinite(x) || x < 0) return null;
    s = String(x);
  } else if (typeof x === "string") s = x.trim();
  else return null;
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  try {
    const base = parseMicro(frac.length > 0 ? `${m[1]}.${frac.slice(0, 6)}` : m[1]!);
    return frac.length > 6 && frac.charCodeAt(6) >= 53 /* "5" */ ? base + 1n : base;
  } catch {
    return null;
  }
}

/** One usable tracker row for one (source, GPU), after the provider, class and status filters. */
export interface TrackerRow {
  tracker: TrackerId;
  valueU: number;
  gpuCount: number | null;
  listedSince?: string;
  lastConfirmedAt?: string;
}

/** A parsed tracker file: the rows the map can use, nothing else. */
export interface ParsedGe {
  ok: true;
  updatedAt: number | null; // unix s of data_updated_at
  rows: { providerId: string; row: TrackerRow }[];
}
export interface ParsedGt {
  ok: true;
  rows: { provider: string; gpu: string; row: TrackerRow }[];
}
export type ParseFail = { ok: false; why: string };

const mapped = (field: "ge" | "gt") => new Set(Object.values(TRACKER_MAP).map((e) => e[field]));
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const isoS = (x: unknown): number | null => {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const count = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : null);
const usableU = (u: bigint | null): number | null => (u !== null && u > 0n && u <= 1_000_000_000_000n ? Number(u) : null);

/** GPU Economy's per-GPU file: `{ data_updated_at, prices: [ { provider_id, price_type, status, usd_per_gpu_hour,
 *  gpu_count, listed_since, last_confirmed_at, ... } ] }`. */
export function parseGpuEconomy(body: string): ParsedGe | ParseFail {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  const top = obj(j);
  if (!top || !Array.isArray(top.prices)) return { ok: false, why: "no prices array" };
  const want = mapped("ge");
  const rows: ParsedGe["rows"] = [];
  for (const r0 of top.prices) {
    const r = obj(r0);
    if (!r) continue;
    if (forbiddenProvider(r.provider_id) || forbiddenProvider(r.provider)) continue; // before any other field
    const pid = r.provider_id;
    if (typeof pid !== "string" || !want.has(pid)) continue;
    if (r.price_type !== "on_demand" || r.status !== "live") continue;
    const v = usableU(trackerMicro(r.usd_per_gpu_hour));
    if (v === null) continue;
    const row: TrackerRow = { tracker: "gpueconomy", valueU: v, gpuCount: count(r.gpu_count) };
    if (typeof r.listed_since === "string") row.listedSince = r.listed_since;
    if (typeof r.last_confirmed_at === "string") row.lastConfirmedAt = r.last_confirmed_at;
    rows.push({ providerId: pid, row });
  }
  return { ok: true, updatedAt: isoS(top.data_updated_at), rows };
}

/** GPUTable's data.json: `{ generated_at, data: [ { provider, gpu, gpu_count, price_per_hour_usd, pricing_type,
 *  commitment_months, ... } ] }`; price_per_hour_usd is already per GPU. */
export function parseGpuTable(body: string): ParsedGt | ParseFail {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  const top = obj(j);
  if (!top || !Array.isArray(top.data)) return { ok: false, why: "no data array" };
  const want = mapped("gt");
  const rows: ParsedGt["rows"] = [];
  for (const r0 of top.data) {
    const r = obj(r0);
    if (!r) continue;
    const p = r.provider;
    if (forbiddenProvider(p)) continue; // before any other field
    if (typeof p !== "string" || gtExcludedProvider(p) || !want.has(p)) continue;
    if (typeof r.gpu !== "string") continue;
    if (r.pricing_type !== "on_demand" || r.commitment_months !== null) continue;
    const v = usableU(trackerMicro(r.price_per_hour_usd));
    if (v === null) continue;
    rows.push({ provider: p, gpu: r.gpu, row: { tracker: "gputable", valueU: v, gpuCount: count(r.gpu_count) } });
  }
  return { ok: true, rows };
}

/** 15.1 row selection: gpu_count 8 rows, else 1, else all; of those the row nearest our value (ties: the lower). */
export function pickRow(rows: readonly TrackerRow[], own: number): TrackerRow | null {
  if (rows.length === 0) return null;
  const eight = rows.filter((r) => r.gpuCount === 8);
  const one = rows.filter((r) => r.gpuCount === 1);
  const pool = eight.length > 0 ? eight : one.length > 0 ? one : rows;
  return pool.slice().sort((a, b) => Math.abs(a.valueU - own) - Math.abs(b.valueU - own) || a.valueU - b.valueU)[0]!;
}

export function geRowsFor(f: ParsedGe, sourceId: string): TrackerRow[] {
  const m = TRACKER_MAP[sourceId];
  return m ? f.rows.filter((r) => r.providerId === m.ge).map((r) => r.row) : [];
}
export function gtRowsFor(f: ParsedGt, sourceId: string, gpu: GpuModel): TrackerRow[] {
  const m = TRACKER_MAP[sourceId];
  if (!m || m.gtNever?.includes(gpu)) return [];
  return f.rows.filter((r) => r.provider === m.gt && r.gpu === GT_GPU[gpu]).map((r) => r.row);
}

/** What one interval's fetch gave (per GPU for GPU Economy; one file for GPUTable). */
export interface IntervalTrackers {
  /** reference time for staleness: the page time the server stated, else the fetch time */
  at: number;
  ge: Partial<Record<GpuModel, ParsedGe | ParseFail>>;
  gt?: ParsedGt | ParseFail;
}

export type GeUsable = { use: true } | { use: false; why: "file-failed" | "stale" | "no-row" | "stale-row" };

/** A GPU Economy row is fresh when its last_confirmed_at is at most GE_STALE_S before t (absent or unreadable: the
 *  file's data_updated_at decides, as before). Fix round (audit L3): a row stuck inside a fresh file is no row. */
export function rowFresh(r: TrackerRow, at: number): boolean {
  const c = isoS(r.lastConfirmedAt);
  return c === null || at - c <= GE_STALE_S;
}

/** Whether GPU Economy serves this pair in this interval (else the GPUTable fallback, per pair). */
export function geUsable(t: IntervalTrackers, sourceId: string, gpu: GpuModel): GeUsable {
  const f = t.ge[gpu];
  if (!f || !f.ok) return { use: false, why: "file-failed" };
  if (f.updatedAt === null || t.at - f.updatedAt > GE_STALE_S) return { use: false, why: "stale" };
  const rows = geRowsFor(f, sourceId);
  if (rows.length === 0) return { use: false, why: "no-row" };
  return rows.some((r) => rowFresh(r, t.at)) ? { use: true } : { use: false, why: "stale-row" };
}

/** The tracker value to compare own against for one pair, or null when no tracker lists it. */
export function trackerFor(t: IntervalTrackers, sourceId: string, gpu: GpuModel, own: number): TrackerRow | null {
  if (!TRACKER_MAP[sourceId]) return null;
  const f = t.ge[gpu];
  if (geUsable(t, sourceId, gpu).use && f && f.ok) return pickRow(geRowsFor(f, sourceId).filter((r) => rowFresh(r, t.at)), own);
  if (t.gt && t.gt.ok) return pickRow(gtRowsFor(t.gt, sourceId, gpu), own);
  return null;
}

/** Whether any tracker lists the pair at all in this interval (for TRACKERS_DOWN and the repair agent's gates). */
export function trackerLists(t: IntervalTrackers, sourceId: string, gpu: GpuModel): boolean {
  return trackerFor(t, sourceId, gpu, 0) !== null;
}

/** Gap above 10%: 10 * |own - t| > t (integers; exactly 10% is not a gap). */
export function isGap(own: number, t: number): boolean {
  return 10 * Math.abs(own - t) > t;
}
export function gapBps(own: number, t: number): number {
  return t > 0 ? Math.floor((Math.abs(own - t) * 10_000) / t) : 0;
}
