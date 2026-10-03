// The contract between the sources package and its users (writers, watcher, guardian, e2e).
// Everything under src/pure must run in CRE's WASM runtime: no Node, Bun or DOM APIs, no float money math.
// See docs/wall/BUILD-SPEC.md section 7.

import type { GpuModel, Hex, ReadState } from "@agate/report/types";
import type { Cell } from "./pure/text.ts";

export type { Cell, GpuModel };
export type Currency = "USD" | "EUR";

/** Row-level outcome of parsing one page for one GPU (FAILED and MISSED are fetch outcomes, never parse outcomes). */
export type RowState = Extract<ReadState, "VALID" | "NOT_RENTABLE" | "NO_ROW" | "BAD_VALUE">;

/** The extraction rule of one source for one GPU. Every field enters recipeHash. */
export interface ExtractionRule {
  product: string; // the exact row as named on the page, e.g. "NVIDIA H100 SXM"
  form: "SXM" | "NVLink" | "PCIe"; // the GPU's own form (FORM_OF): PCIe only for L40S; never NVL variants
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
  parserVersion: string; // the registered version (inside recipeHash for ever); later ones live in the registry
  rules: Partial<Record<GpuModel, ExtractionRule>>; // GPUs this source can price
  /** Exact hostnames a reader of this source may fetch (the company's own domains; 7.7, 8.6). Not in recipeHash. */
  hosts: readonly string[];
}

/** A slot's reader: the page it fetches and the parser version that reads it (4.15, 7.6). */
export interface ReaderRef {
  url: string;
  parserVersion: string;
}

/** One executed reader swap as the readers use it (the fields of readerHistory they need). */
export interface ReaderSwap {
  fromDay: number;
  url: string;
  parserVersion: string;
}

/** Why a reader cannot be used: "missing" = its parserVersion is not installed (READER_MISSING); "refused" = not
 * https, a host off the source's list, or a version of another source (READER_REFUSED). */
export type ReaderProblem = { code: "missing" | "refused"; why: string };

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

/** One parser version's page reading: the cell found per GPU, before money math, bounds and row states (parse adds
 * those). May throw LayoutError when a structural anchor moved. Registry: src/pure/parsers/index.ts. */
export type Extractor = (body: string, ctx: ParseContext) => Partial<Record<GpuModel, Cell>>;

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
  /** Every installed parser version (the registry's keys). */
  PARSER_VERSIONS: readonly string[];
  /** "lambda/2" -> "p_lambda"; null when the version is not installed. */
  sourceOfVersion(parserVersion: string): string | null;
  /** parse with one installed version; an unknown version gives {}. parse(id) = parseWith(registered version). */
  parseWith(parserVersion: string, body: string, ctx: ParseContext): ParseResult;
  /** https, host on the source's hosts, version installed and of this source. */
  readerAllowed(sourceId: string, r: ReaderRef): { ok: true } | { ok: false; why: string };
  /** Why a reader cannot be used, or null (8.6): the URL and host are checked first, so a hostile URL is "refused"
   *  whatever version it names; "missing" only for an allowed URL whose version this build lacks. The one rule every
   *  role classifies READER_MISSING and READER_REFUSED by. */
  readerProblem(sourceId: string, r: ReaderRef): ReaderProblem | null;
  /** The reader in force on `day`: the newest swap with fromDay <= day, else the registered reader. */
  readerInForce(slot: PanelSlot, history: readonly ReaderSwap[], day: number): ReaderRef;
}
