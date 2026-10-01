// The contract between the sources package and its users (writers, watcher, guardian, e2e).
// Everything under src/pure must run in CRE's WASM runtime: no Node, Bun or DOM APIs, no float money math.
// See docs/wall/BUILD-SPEC.md section 7.

import type { GpuModel, Hex, ReadState } from "@agate/report/types";

export type { GpuModel };
export type Currency = "USD" | "EUR";

/** Row-level outcome of parsing one page for one GPU (FAILED and MISSED are fetch outcomes, never parse outcomes). */
export type RowState = Extract<ReadState, "VALID" | "NOT_RENTABLE" | "NO_ROW" | "BAD_VALUE">;

/** The extraction rule of one source for one GPU. Every field enters recipeHash. */
export interface ExtractionRule {
  product: string; // the exact row as named on the page, e.g. "NVIDIA H100 SXM"
  form: "SXM" | "NVLink"; // never PCIe or NVL variants
  priceClass: "on-demand"; // never spot, preemptible, community, reserved, commitment, serverless, marketplace
  instance: "per-GPU of the 8-GPU instance, else of the 1-GPU instance";
  rentable: "page-shows-availability" | "assumed-rentable"; // the latter: the page shows no stock state
  effectiveDate: "a price shown from date X counts from 00:00 UTC of X";
  tax: "excluding VAT";
  notes: string; // table name, tab, selector hints, anything a re-implementer needs
}

export interface SourceDef {
  id: string; // stable id, same as the logger's: "p_lambda"
  company: string; // the corporate group (one family per company): "Lambda"
  url: string; // the one page or API fetched per run; every GPU is read from it
  currency: Currency;
  parserVersion: string; // bump on any parser change; enters recipeHash
  rules: Partial<Record<GpuModel, ExtractionRule>>; // GPUs this source can price
}

export interface ParsedRow {
  state: RowState;
  /** USD micro-dollars per GPU-hour, on the cent grid (cent-rounded, halves up), 0 unless VALID. */
  valueU: number;
  /** The decimal string read from the page before any division or conversion, for the log. */
  raw?: string;
  gpuCount?: number; // instance size the price was read from (8 or 1)
  detail?: string; // why NO_ROW / BAD_VALUE / NOT_RENTABLE
}

export type ParseResult = Partial<Record<GpuModel, ParsedRow>>;

/** ECB reference rate: USD per 1 EUR, as published (up to 6 decimals), for an ECB business day. */
export interface FxRate {
  date: string; // YYYY-MM-DD of the ECB publication
  usdPerEur: string; // decimal string, e.g. "1.1734"
}

export interface ParseContext {
  utcDate: string; // YYYY-MM-DD of the page's own time: live = the reading time; replay = X-Agate-Page-Time
  nowSec: number; // the page's own time in unix seconds (same rule), for effective-date rules
  fx?: FxRate; // required for EUR sources: the rate of the business day before utcDate
}

/** A pure parser: page body (already decoded to text) to one row per GPU it prices. Never throws: a page it
 * cannot understand gives NO_ROW for every GPU of the source. */
export type Parser = (body: string, ctx: ParseContext) => ParseResult;

/** One slot of a registered GPU (order = slot index onchain). */
export interface PanelSlot {
  slot: number;
  sourceId: string;
  family: number; // index into the GPU's family list
  liveAtStart: boolean; // false = reserved (liveFrom NEVER until the owner's timelocked setLiveFrom)
}

export interface Panel {
  gpu: GpuModel;
  spec: string; // e.g. "H100-SXM/on-demand-list/neocloud/v1"; gpuId = keccak256(utf8(spec))
  gpuId: Hex;
  families: { name: string; famQ: number }[];
  slots: PanelSlot[];
}

/** Outcome of one live fetch (io layer, not pure). */
export interface FetchOutcome {
  ok: boolean; // HTTP 2xx and a body
  httpStatus: number; // 0 if no response
  body: string;
  bytes: number;
  sha256: string;
  fetchedAt: number; // unix s
  attempts: number;
  error?: string;
}

/** What the pure layer must export (src/pure/index.ts). Writers and the watcher depend on exactly this. */
export interface SourcesPureApi {
  SOURCES: readonly SourceDef[];
  parse(sourceId: string, body: string, ctx: ParseContext): ParseResult;
  parseEcb(body: string, forUtcDate: string): FxRate | null; // latest ECB rate dated strictly before forUtcDate
  /** Exact integer conversion: native decimal string (per instance) / gpuCount, EUR times usdPerEur, cent half-up. */
  toValueU(native: string, currency: Currency, gpuCount: number, fx?: FxRate): number;
  /** values[] of one report entry for one GPU at one reading time: VALID rows' valueU, everything else 0. */
  slotValues(panel: Panel, rows: Readonly<Record<string, ParseResult>>): number[];
  recipeHash(panel: Panel): Hex;
  gpuIdOf(spec: string): Hex;
}
