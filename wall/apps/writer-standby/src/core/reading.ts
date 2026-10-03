// One reading run: pages in, report entries and a log record out. Shared by the CRE workflow (inside WASM) and
// the bun writers, so everything here is pure (no Node, Bun or DOM APIs, no float money math).
import type { Entry, GpuModel, Hex, ReadState } from "@agate/report/types";
import type { FxRate, Panel, ParseResult, ReaderRef, SourceDef, SourcesPureApi } from "@agate/sources/types";
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
  /** 8.6: the parser version per GPU, present when any GPU of this source reads with another than the registered one. */
  parsers?: Partial<Record<GpuModel, string>>;
  /** 8.6: the reader URL per GPU whose URL is not the registered one. */
  urls?: Partial<Record<GpuModel, string>>;
  /** 8.6: GPUs whose reader in force could not be used (READER_MISSING or READER_REFUSED): read as MISSED, sent as 0. */
  refused?: Partial<Record<GpuModel, string>>;
  /** Further pages of this source fetched in the same run (two readers of one source on two URLs). */
  extra?: { url: string; httpStatus: number; bytes: number; sha256?: string; error?: string }[];
}

/** A slot's reader for one run: an allowed reader, or a refusal (that slot reads nothing, never another reader). */
export type ReaderChoice = ReaderRef | { refused: string };

/** The readers of swapped slots for one run: gpuId -> slot (decimal) -> choice. A slot absent here reads with the
 * registered recipe's reader. This is the CRE workflow config's `readers` (8.2). */
export type SlotReaders = Readonly<Record<string, Readonly<Record<string, ReaderChoice>>>>;

/** Per source, per GPU it prices: the reader in force for this run. A source has one slot per GPU panel, so each
 * (source, GPU) has exactly one reader. */
export interface SourcePlan {
  def: SourceDef;
  byGpu: Partial<Record<GpuModel, ReaderChoice>>;
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
  for (const k of ["parse", "parseEcb", "toValueU", "slotValues", "recipeHash", "gpuIdOf", "parseWith", "sourceOfVersion", "readerAllowed", "readerProblem", "readerInForce"] as const) {
    if (typeof x?.[k] !== "function") throw new Error(`@agate/sources/pure does not export ${k} yet`);
  }
  if (!Array.isArray(x.SOURCES)) throw new Error("@agate/sources/pure does not export SOURCES yet");
  if (!Array.isArray(x.PARSER_VERSIONS)) throw new Error("@agate/sources/pure does not export PARSER_VERSIONS yet");
  return x as SourcesPureApi;
}

const isRefused = (c: ReaderChoice | undefined): c is { refused: string } => Boolean(c && "refused" in c);

/** The reader in force per (source, GPU) for one run. A swapped reader is checked again here (https, the source's
 * hosts, installed and of this source): one that fails is a refusal, whatever the caller passed. */
export function planReaders(api: SourcesPureApi, defs: readonly SourceDef[], panels: readonly Panel[], readers?: SlotReaders): SourcePlan[] {
  const byId = new Map<string, Readonly<Record<string, ReaderChoice>>>();
  for (const [g, m] of Object.entries(readers ?? {})) byId.set(g.toLowerCase(), m);
  return defs.map((def) => {
    const byGpu: Partial<Record<GpuModel, ReaderChoice>> = {};
    for (const g of gpusOf(def)) {
      const p = panels.find((x) => x.gpu === g);
      const slot = p?.slots.find((s) => s.sourceId === def.id);
      const r = p && slot ? byId.get(p.gpuId.toLowerCase())?.[String(slot.slot)] : undefined;
      if (!r) byGpu[g] = { url: def.url, parserVersion: def.parserVersion };
      else if (isRefused(r)) byGpu[g] = { refused: String(r.refused) };
      else {
        const ok = api.readerAllowed(def.id, r);
        byGpu[g] = ok.ok ? { url: r.url, parserVersion: r.parserVersion } : { refused: ok.why };
      }
    }
    return { def, byGpu };
  });
}

/** The page a reader needs, as a key into the pages of one run: the source id for its registered URL, else
 * "<sourceId> <url>". */
export function pageKey(def: SourceDef, url: string): string {
  return url === def.url ? def.id : `${def.id} ${url}`;
}

/** Each distinct page of a run once: key and fetch URL (under a replay base every reader of a source fetches
 * <base>/<sourceId>, 7.9, so a source is fetched once whatever its readers). Registered URLs first. */
export function fetchesOf(plans: readonly SourcePlan[], base?: string): { sourceId: string; key: string; url: string; fetchUrl: string }[] {
  const out: { sourceId: string; key: string; url: string; fetchUrl: string }[] = [];
  for (const p of plans) {
    const urls: string[] = [];
    for (const c of Object.values(p.byGpu)) if (c && !isRefused(c) && !urls.includes(c.url)) urls.push(c.url);
    urls.sort((a, b) => (a === p.def.url ? -1 : b === p.def.url ? 1 : 0));
    for (const url of urls) out.push({ sourceId: p.def.id, key: pageKey(p.def, url), url, fetchUrl: pageUrl(p.def.id, url, base) });
  }
  return out;
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

/** Parses every page. A failed fetch gives FAILED rows and no ParseResult (so its slots send 0). With plans (8.6),
 * pages are keyed by pageKey and each GPU is read with its reader in force; without, every source is read with its
 * registered reader from pages[sourceId]. */
export function parsePages(
  api: SourcesPureApi,
  defs: readonly SourceDef[],
  pages: Readonly<Record<string, PageResult | undefined>>,
  fxPage: PageResult | undefined,
  readAt: number,
  plans?: readonly SourcePlan[],
): { rows: Record<string, ParseResult>; logs: SourceLog[] } {
  if (plans) return parsePlanned(api, plans, pages, fxPage, readAt);
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

/** One FX lookup per UTC date within a run. */
function fxLookup(api: SourcesPureApi, fxPage: PageResult | undefined): (date: string) => FxRate | null {
  const cache = new Map<string, FxRate | null>();
  return (date) => {
    if (!cache.has(date)) {
      let r: FxRate | null = null;
      if (fxPage?.ok) {
        try {
          r = api.parseEcb(fxPage.body, date);
        } catch {
          r = null;
        }
      }
      cache.set(date, r);
    }
    return cache.get(date) ?? null;
  };
}

function parsePlanned(
  api: SourcesPureApi,
  plans: readonly SourcePlan[],
  pages: Readonly<Record<string, PageResult | undefined>>,
  fxPage: PageResult | undefined,
  readAt: number,
): { rows: Record<string, ParseResult>; logs: SourceLog[] } {
  const rows: Record<string, ParseResult> = {};
  const logs: SourceLog[] = [];
  const fxFor = fxLookup(api, fxPage);
  for (const plan of plans) {
    const def = plan.def;
    const gpus = gpusOf(def).filter((g) => plan.byGpu[g] !== undefined);
    const keys: string[] = [];
    for (const g of gpus) {
      const c = plan.byGpu[g]!;
      if (!isRefused(c) && !keys.includes(pageKey(def, c.url))) keys.push(pageKey(def, c.url));
    }
    keys.sort((a, b) => (a === def.id ? -1 : b === def.id ? 1 : 0));
    const main = keys[0] !== undefined ? pages[keys[0]] : undefined;
    const log: SourceLog = { sourceId: def.id, httpStatus: main?.httpStatus ?? 0, bytes: main?.bytes ?? 0, rows: {} };
    if (main?.sha256) log.sha256 = main.sha256;
    if (main?.pageTime !== undefined) log.pageTime = main.pageTime;
    if (main?.error) log.error = main.error;
    for (const k of keys.slice(1)) {
      const pg = pages[k];
      const url = k.slice(def.id.length + 1);
      log.extra = [...(log.extra ?? []), { url, httpStatus: pg?.httpStatus ?? 0, bytes: pg?.bytes ?? 0, ...(pg?.sha256 ? { sha256: pg.sha256 } : {}), ...(pg?.error ? { error: pg.error } : {}) }];
    }
    const result: ParseResult = {};
    let anyParsed = false;
    const parsed = new Map<string, ParseResult>();
    for (const g of gpus) {
      const c = plan.byGpu[g]!;
      if (isRefused(c)) {
        log.rows[g] = { state: "MISSED", valueU: 0 };
        log.refused = { ...(log.refused ?? {}), [g]: c.refused };
        continue;
      }
      if (c.url !== def.url) log.urls = { ...(log.urls ?? {}), [g]: c.url };
      const page = pages[pageKey(def, c.url)];
      if (!page?.ok) {
        log.rows[g] = { state: "FAILED", valueU: 0 };
        continue;
      }
      if (api.sourceOfVersion(c.parserVersion) !== def.id) {
        log.rows[g] = { state: "MISSED", valueU: 0 };
        log.refused = { ...(log.refused ?? {}), [g]: `parser ${c.parserVersion} is not installed for ${def.id} in this build` };
        continue;
      }
      const memo = `${pageKey(def, c.url)}\n${c.parserVersion}`;
      let r = parsed.get(memo);
      if (!r) {
        const nowSec = page.pageTime ?? readAt;
        const date = utcDate(nowSec);
        if (def.currency === "EUR") {
          const fx = fxFor(date);
          if (fx) log.fxDate = fx.date;
          r = fx ? safeParseWith(api, def, c.parserVersion, page.body, { utcDate: date, nowSec, fx }) : allRows(gpusOf(def), "NO_ROW", "no ECB rate");
        } else r = safeParseWith(api, def, c.parserVersion, page.body, { utcDate: date, nowSec });
        parsed.set(memo, r);
      }
      const row = r[g];
      log.rows[g] = row ? { state: row.state, valueU: row.state === "VALID" ? row.valueU : 0 } : { state: "NO_ROW", valueU: 0 };
      if (row) result[g] = row;
      else result[g] = { state: "NO_ROW", valueU: 0 };
      anyParsed = true;
    }
    if (gpus.some((g) => !isRefused(plan.byGpu[g]!) && (plan.byGpu[g] as ReaderRef).parserVersion !== def.parserVersion) || log.refused) {
      const parsers: Partial<Record<GpuModel, string>> = {};
      for (const g of gpus) {
        const c = plan.byGpu[g]!;
        if (!isRefused(c)) parsers[g] = c.parserVersion;
      }
      log.parsers = parsers;
    }
    if (anyParsed) rows[def.id] = result;
    logs.push(log);
  }
  return { rows, logs };
}

/** The deterministic reader notes of a plan (parsers, urls, refused per source), to put back on logs rebuilt from
 * CRE's consensus numbers. */
export function planNotes(plans: readonly SourcePlan[]): Record<string, Pick<SourceLog, "parsers" | "urls" | "refused">> {
  const out: Record<string, Pick<SourceLog, "parsers" | "urls" | "refused">> = {};
  for (const p of plans) {
    const n: Pick<SourceLog, "parsers" | "urls" | "refused"> = {};
    let swapped = false;
    for (const g of gpusOf(p.def)) {
      const c = p.byGpu[g];
      if (!c) continue;
      if (isRefused(c)) {
        n.refused = { ...(n.refused ?? {}), [g]: c.refused };
        swapped = true;
        continue;
      }
      if (c.url !== p.def.url) n.urls = { ...(n.urls ?? {}), [g]: c.url };
      if (c.parserVersion !== p.def.parserVersion) swapped = true;
    }
    if (swapped) {
      n.parsers = {};
      for (const g of gpusOf(p.def)) {
        const c = p.byGpu[g];
        if (c && !isRefused(c)) n.parsers[g] = c.parserVersion;
      }
    }
    if (n.parsers || n.urls || n.refused) out[p.def.id] = n;
  }
  return out;
}

function safeParseWith(api: SourcesPureApi, def: SourceDef, version: string, body: string, ctx: Parameters<SourcesPureApi["parse"]>[2]): ParseResult {
  try {
    return api.parseWith(version, body, ctx);
  } catch (e) {
    return allRows(gpusOf(def), "NO_ROW", `parser threw: ${String(e)}`);
  }
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
  plans?: readonly SourcePlan[],
): Reading {
  const { rows, logs } = parsePages(api, defs, pages, fxPage, at.readAt, plans);
  return { readAt: at.readAt, dayId: at.dayId, slice: at.slice, entries: buildEntries(api, panels, rows, at.dayId, at.slice, at.readAt), sources: logs };
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
