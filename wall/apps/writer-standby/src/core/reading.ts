// One reading run: pages in, report entries and a log record out. Shared by the CRE workflow (inside WASM) and
// the bun writers, so everything here is pure (no Node, Bun or DOM APIs, no float money math).
import type { Entry, GpuModel, Hex, ReadState } from "@agate/report/types";
import type { FxRate, Panel, ParseResult, SourceDef, SourcesPureApi } from "@agate/sources/types";
import { utcDate } from "./clock.ts";

export const ECB_ID = "fx_ecb";
export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
export const GPUS: readonly GpuModel[] = ["H100", "H200", "B200"];

/** Replay override: every page is served at `<base>/<sourceId>` (the ECB file at `<base>/fx_ecb`). */
export function pageUrl(id: string, liveUrl: string, base?: string): string {
  return base ? `${base.replace(/\/+$/, "")}/${id}` : liveUrl;
}

export function userAgent(role: string): string {
  return `agate-wall/${role}/0.1 (+https://github.com/s0nderlabs/agate)`;
}

/** One fetched page as the reading needs it. pageTime: the replay server's X-Agate-Page-Time, else absent. */
export interface PageResult {
  ok: boolean;
  httpStatus: number;
  body: string;
  bytes: number;
  sha256?: string;
  pageTime?: number;
  attempts?: number;
  error?: string;
}

export interface SourceLog {
  sourceId: string;
  httpStatus: number;
  bytes: number;
  sha256?: string;
  pageTime?: number;
  fxDate?: string;
  error?: string;
  rows: Partial<Record<GpuModel, { state: ReadState; valueU: number }>>;
}

export interface Reading {
  readAt: number;
  dayId: number;
  slice: number;
  entries: Entry[];
  sources: SourceLog[];
}

/** Runtime check that the sources package exports the pure API (it is built by another builder). */
export function asSourcesApi(m: unknown): SourcesPureApi {
  const x = m as Partial<SourcesPureApi>;
  for (const k of ["parse", "parseEcb", "toValueU", "slotValues", "recipeHash", "gpuIdOf"] as const) {
    if (typeof x?.[k] !== "function") throw new Error(`@agate/sources/pure does not export ${k} yet`);
  }
  if (!Array.isArray(x.SOURCES)) throw new Error("@agate/sources/pure does not export SOURCES yet");
  return x as SourcesPureApi;
}

/** The sources a set of panels reads (every slot, live or reserved), each once, in SOURCES order. */
export function neededSources(api: SourcesPureApi, panels: readonly Panel[]): SourceDef[] {
  const ids = new Set(panels.flatMap((p) => p.slots.map((s) => s.sourceId)));
  for (const id of ids) {
    if (!api.SOURCES.some((s) => s.id === id)) throw new Error(`panel names unknown source ${id}`);
  }
  return api.SOURCES.filter((s) => ids.has(s.id));
}

export function needsFx(defs: readonly SourceDef[]): boolean {
  return defs.some((d) => d.currency === "EUR");
}

function gpusOf(def: SourceDef): GpuModel[] {
  return GPUS.filter((g) => def.rules[g] !== undefined);
}

/** Parses every page. A failed fetch gives FAILED rows and no ParseResult (so its slots send 0). */
export function parsePages(
  api: SourcesPureApi,
  defs: readonly SourceDef[],
  pages: Readonly<Record<string, PageResult | undefined>>,
  fxPage: PageResult | undefined,
  readAt: number,
): { rows: Record<string, ParseResult>; logs: SourceLog[] } {
  const rows: Record<string, ParseResult> = {};
  const logs: SourceLog[] = [];
  const fxCache = new Map<string, FxRate | null>();
  const fxFor = (date: string): FxRate | null => {
    if (!fxCache.has(date)) {
      let r: FxRate | null = null;
      if (fxPage?.ok) {
        try {
          r = api.parseEcb(fxPage.body, date);
        } catch {
          r = null;
        }
      }
      fxCache.set(date, r);
    }
    return fxCache.get(date) ?? null;
  };

  for (const def of defs) {
    const page = pages[def.id];
    const log: SourceLog = {
      sourceId: def.id,
      httpStatus: page?.httpStatus ?? 0,
      bytes: page?.bytes ?? 0,
      rows: {},
    };
    if (page?.sha256) log.sha256 = page.sha256;
    if (page?.pageTime !== undefined) log.pageTime = page.pageTime;
    if (page?.error) log.error = page.error;
    const gpus = gpusOf(def);

    if (!page?.ok) {
      for (const g of gpus) log.rows[g] = { state: "FAILED", valueU: 0 };
      logs.push(log);
      continue;
    }
    const nowSec = page.pageTime ?? readAt;
    const date = utcDate(nowSec);
    let result: ParseResult;
    if (def.currency === "EUR") {
      const fx = fxFor(date);
      if (fx) log.fxDate = fx.date;
      result = fx ? safeParse(api, def, page.body, { utcDate: date, nowSec, fx }) : allRows(gpus, "NO_ROW", "no ECB rate");
    } else {
      result = safeParse(api, def, page.body, { utcDate: date, nowSec });
    }
    rows[def.id] = result;
    for (const g of gpus) {
      const r = result[g];
      log.rows[g] = r ? { state: r.state, valueU: r.state === "VALID" ? r.valueU : 0 } : { state: "NO_ROW", valueU: 0 };
    }
    logs.push(log);
  }
  return { rows, logs };
}

function allRows(gpus: readonly GpuModel[], state: "NO_ROW", detail: string): ParseResult {
  const r: ParseResult = {};
  for (const g of gpus) r[g] = { state, valueU: 0, detail };
  return r;
}

function safeParse(api: SourcesPureApi, def: SourceDef, body: string, ctx: Parameters<SourcesPureApi["parse"]>[2]) {
  try {
    return api.parse(def.id, body, ctx);
  } catch (e) {
    return allRows(gpusOf(def), "NO_ROW", `parser threw: ${String(e)}`);
  }
}

/** One entry per panel (registered GPU), all with the same (dayId, slice, readAt), values in slot order. */
export function buildEntries(
  api: SourcesPureApi,
  panels: readonly Panel[],
  rows: Readonly<Record<string, ParseResult>>,
  dayId: number,
  slice: number,
  readAt: number,
): Entry[] {
  return panels.map((p) => {
    const values = api.slotValues(p, rows);
    if (values.length !== p.slots.length) throw new Error(`slotValues gave ${values.length} values for ${p.gpu}`);
    return { gpuId: p.gpuId as Hex, dayId, slice, readAt: BigInt(readAt), values };
  });
}

export function takeReading(
  api: SourcesPureApi,
  panels: readonly Panel[],
  defs: readonly SourceDef[],
  at: { dayId: number; slice: number; readAt: number },
  pages: Readonly<Record<string, PageResult | undefined>>,
  fxPage: PageResult | undefined,
): Reading {
  const { rows, logs } = parsePages(api, defs, pages, fxPage, at.readAt);
  return { ...at, entries: buildEntries(api, panels, rows, at.dayId, at.slice, at.readAt), sources: logs };
}

// ---------------------------------------------------------------- numeric codes (CRE consensus is on numbers)

export function cent(v: number): number {
  const n = Math.round(v);
  return Math.floor((n + 5_000) / 10_000) * 10_000;
}

export const STATE_CODES: readonly ReadState[] = ["VALID", "NOT_RENTABLE", "NO_ROW", "BAD_VALUE", "FAILED", "MISSED"];

export function stateCode(s: ReadState): number {
  return STATE_CODES.indexOf(s);
}

export function stateOf(code: number): ReadState {
  return STATE_CODES[Math.round(code)] ?? "NO_ROW";
}

/** "2026-10-01" <-> 20261001, so a date can travel through median consensus. */
export function dateNum(d: string): number {
  return Number(d.replaceAll("-", ""));
}

export function numDate(n: number): string {
  const s = String(Math.round(n)).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Flattens source logs to numbers (field `<id>.<gpu>.v` etc.) and back, for CRE's per-field median consensus. */
export function flattenLogs(logs: readonly SourceLog[]): Record<string, number> {
  const f: Record<string, number> = {};
  for (const l of logs) {
    f[`${l.sourceId}.http`] = l.httpStatus;
    f[`${l.sourceId}.bytes`] = l.bytes;
    f[`${l.sourceId}.pt`] = l.pageTime ?? 0;
    f[`${l.sourceId}.fx`] = l.fxDate ? dateNum(l.fxDate) : 0;
    for (const g of GPUS) {
      const r = l.rows[g];
      if (!r) continue;
      f[`${l.sourceId}.${g}.v`] = r.valueU;
      f[`${l.sourceId}.${g}.s`] = stateCode(r.state);
    }
  }
  return f;
}

export function flatFields(defs: readonly SourceDef[]): string[] {
  const keys: string[] = [];
  for (const d of defs) {
    keys.push(`${d.id}.http`, `${d.id}.bytes`, `${d.id}.pt`, `${d.id}.fx`);
    for (const g of gpusOf(d)) keys.push(`${d.id}.${g}.v`, `${d.id}.${g}.s`);
  }
  return keys;
}

/** Rebuilds the logs and the rows slotValues needs from the agreed numbers. */
export function unflatten(
  defs: readonly SourceDef[],
  f: Readonly<Record<string, number>>,
): { rows: Record<string, ParseResult>; logs: SourceLog[] } {
  const rows: Record<string, ParseResult> = {};
  const logs: SourceLog[] = [];
  for (const d of defs) {
    const log: SourceLog = { sourceId: d.id, httpStatus: f[`${d.id}.http`] ?? 0, bytes: f[`${d.id}.bytes`] ?? 0, rows: {} };
    const pt = f[`${d.id}.pt`] ?? 0;
    if (pt) log.pageTime = pt;
    const fx = f[`${d.id}.fx`] ?? 0;
    if (fx) log.fxDate = numDate(fx);
    const pr: ParseResult = {};
    let fetched = false;
    for (const g of gpusOf(d)) {
      const state = stateOf(f[`${d.id}.${g}.s`] ?? stateCode("FAILED"));
      // A DON median of an even node count may average two cent values: snap back to the cent grid, halves up.
      const valueU = state === "VALID" ? cent(f[`${d.id}.${g}.v`] ?? 0) : 0;
      log.rows[g] = { state, valueU };
      if (state !== "FAILED" && state !== "MISSED") {
        fetched = true;
        pr[g] = { state, valueU };
      }
    }
    if (fetched) rows[d.id] = pr;
    logs.push(log);
  }
  return { rows, logs };
}
