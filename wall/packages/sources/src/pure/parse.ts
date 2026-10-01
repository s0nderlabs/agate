// parse(): page text to one ParsedRow per GPU the source prices (BUILD-SPEC 7.5). Never throws: a page it cannot
// understand gives NO_ROW for every GPU, with the reason in `detail` ("<code>: <text>", codes in REASONS).
import type { GpuModel } from "@agate/report/types";
import type { Currency, ParseContext, ParsedRow, ParseResult, SourceDef } from "../types.ts";
import { dayNumber, fxUsableFor } from "./ecb.ts";
import { centValueU, DecimalError, fxMicro, inBounds, MICRO, parseMicro } from "./money.ts";
import { extractCivo } from "./parsers/civo.ts";
import { extractCoreWeave } from "./parsers/coreweave.ts";
import { extractGcore } from "./parsers/gcore.ts";
import { extractHyperstack } from "./parsers/hyperstack.ts";
import { extractLambda } from "./parsers/lambda.ts";
import { extractNebius } from "./parsers/nebius.ts";
import { extractSeeweb } from "./parsers/seeweb.ts";
import { extractVerda } from "./parsers/verda.ts";
import { GPUS, SOURCES } from "./recipe.ts";
import { type Cell, LayoutError } from "./text.ts";

/** The reason codes that prefix ParsedRow.detail. */
export const REASONS = {
  "missing-row": "NO_ROW: the page has no such row (removed, renamed, or no 8x / 1x instance)",
  "not-rentable": "NOT_RENTABLE: the row is shown but not orderable now (sold out, N/A, contact sales, ...)",
  "out-of-bounds": "BAD_VALUE: the per-GPU USD price is outside [$0.10, $1,000]",
  "too-many-decimals": "BAD_VALUE: the native price has more than 6 decimals",
  "parse-error": "NO_ROW: the row is there but its price cell is unreadable",
  "layout-changed": "NO_ROW: a structural anchor moved, so nothing on the page is read",
  ambiguous: "NO_ROW: several rows that should agree (sizes, platforms, copies) disagree",
  "other-currency": "NO_ROW: the page was served in another currency; never converted from it",
  "no-fx": "NO_ROW: an EUR price with no usable ECB rate for the page's date",
  "bad-context": "NO_ROW: the reading time given to the parser is not valid",
  "not-text": "NO_ROW: the body is binary or still compressed, not decoded text",
} as const;
export type Reason = keyof typeof REASONS;

/** The reason code of a row (the prefix of detail), if any. */
export function reasonOf(row: ParsedRow | undefined): Reason | undefined {
  const code = row?.detail?.split(":")[0];
  return code && code in REASONS ? (code as Reason) : undefined;
}

type Extractor = (body: string, ctx: ParseContext) => Partial<Record<GpuModel, Cell>>;

export const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  p_verda: extractVerda,
  p_nebius: extractNebius,
  p_lambda: extractLambda,
  p_coreweave: extractCoreWeave,
  p_civo: extractCivo,
  p_hyperstack: extractHyperstack,
  p_seeweb: extractSeeweb,
  p_gcore: extractGcore,
};

const row = (state: ParsedRow["state"], reason: Reason, text: string): ParsedRow => ({ state, valueU: 0, detail: `${reason}: ${text}` });

function gpusOf(def: SourceDef): GpuModel[] {
  return GPUS.filter((g) => def.rules[g] !== undefined);
}

function allRows(def: SourceDef, reason: Reason, text: string): ParseResult {
  const out: ParseResult = {};
  for (const g of gpusOf(def)) out[g] = row(reason === "not-rentable" ? "NOT_RENTABLE" : "NO_ROW", reason, text);
  return out;
}

/** Money math and bounds for one found price (7.3 rules 3, 5, 7 and 7.4). */
export function priceRow(raw: string, gpuCount: number, currency: Currency, ctx: ParseContext, where: string): ParsedRow {
  let n: bigint;
  try {
    n = parseMicro(raw);
  } catch (e) {
    if (e instanceof DecimalError && e.code === "precision") return { ...row("BAD_VALUE", "too-many-decimals", `${where}: ${raw}`), raw, gpuCount };
    return { ...row("NO_ROW", "parse-error", `${where}: ${(e as Error).message}`), raw, gpuCount };
  }
  let r = MICRO;
  if (currency === "EUR") {
    if (!fxUsableFor(ctx.fx, ctx.utcDate)) return { ...row("NO_ROW", "no-fx", `${where}: no usable ECB rate for ${ctx.utcDate}`), raw, gpuCount };
    r = fxMicro(ctx.fx!);
  }
  const v = centValueU(n, r, gpuCount);
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || !inBounds(Number(v))) {
    return { ...row("BAD_VALUE", "out-of-bounds", `${where}: ${raw}/${gpuCount} ${currency} gives ${v} u`), raw, gpuCount };
  }
  return { state: "VALID", valueU: Number(v), raw, gpuCount };
}

function contextError(ctx: ParseContext): string | undefined {
  if (!ctx || typeof ctx !== "object") return "no context";
  if (!Number.isSafeInteger(ctx.nowSec) || ctx.nowSec < 1_500_000_000) return `nowSec ${String(ctx?.nowSec)}`;
  if (dayNumber(ctx.utcDate) === null) return `utcDate ${String(ctx.utcDate)}`;
  if (new Date(ctx.nowSec * 1000).toISOString().slice(0, 10) !== ctx.utcDate) return `utcDate ${ctx.utcDate} is not the date of nowSec ${ctx.nowSec}`;
  return undefined;
}

function looksBinary(body: string): boolean {
  if (body.charCodeAt(0) === 0x1f && body.charCodeAt(1) === 0x8b) return true; // gzip magic, still compressed
  const head = body.slice(0, 2048);
  let bad = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c === 0 || c === 0xfffd || (c < 0x09 && c !== 0)) bad++;
  }
  return bad > 4;
}

/** Far above any real page (the largest seen is about 0.5 MB); a bigger body is refused, never scanned. */
export const MAX_BODY_CHARS = 4_000_000;

export function parse(sourceId: string, body: string, ctx: ParseContext): ParseResult {
  const def = SOURCES.find((s) => s.id === sourceId);
  const extract = EXTRACTORS[sourceId];
  if (!def || !extract) return {};
  try {
    if (typeof body !== "string" || body.length === 0) return allRows(def, "layout-changed", "empty body");
    if (body.length > MAX_BODY_CHARS) return allRows(def, "layout-changed", `body of ${body.length} characters is far larger than any pricing page`);
    if (looksBinary(body)) return allRows(def, "not-text", "the body is not decoded text");
    const ce = contextError(ctx);
    if (ce) return allRows(def, "bad-context", ce);
    let cells: Partial<Record<GpuModel, Cell>>;
    try {
      cells = extract(body, ctx);
    } catch (e) {
      if (e instanceof LayoutError) return allRows(def, "layout-changed", e.message);
      throw e;
    }
    const out: ParseResult = {};
    for (const g of gpusOf(def)) {
      const c = cells[g] ?? { kind: "missing", why: "the parser returned nothing for this GPU" };
      let r: ParsedRow;
      if (c.kind === "price") r = priceRow(c.raw, c.gpuCount, def.currency, ctx, c.where);
      else if (c.kind === "not-rentable") r = row("NOT_RENTABLE", "not-rentable", `${c.where}: ${c.text}`);
      else if (c.kind === "missing") r = row("NO_ROW", "missing-row", c.why);
      else r = row("NO_ROW", c.code, c.why);
      // Last line of defence: a VALID row is always on the cent grid and inside the bounds.
      if (r.state === "VALID" && !inBounds(r.valueU)) r = row("BAD_VALUE", "out-of-bounds", `value ${r.valueU} off grid or out of bounds`);
      out[g] = r;
    }
    return out;
  } catch (e) {
    return allRows(def, "parse-error", `parser failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
