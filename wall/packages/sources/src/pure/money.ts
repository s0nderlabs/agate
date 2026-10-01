// Money math of BUILD-SPEC 7.4: integers only (BigInt), no floats anywhere in the price path.
import { P_MAX, P_MIN, TICK } from "@agate/report/types";
import type { Currency, FxRate } from "../types.ts";

export const MICRO = 1_000_000n;
const E10 = 10_000_000_000n;
const TICK_N = BigInt(TICK);

export class DecimalError extends Error {
  constructor(
    readonly code: "format" | "precision",
    message: string,
  ) {
    super(message);
    this.name = "DecimalError";
  }
}

// Plain digits ("3.627") or comma-grouped thousands ("17,461.60"); nothing else (no sign, exponent or spaces).
const DECIMAL = /^(?:\d{1,15}|\d{1,3}(?:,\d{3}){1,4})(?:\.(\d+))?$/;

/** An exact decimal string to an integer count of 10^-6 units. More than 6 decimals is a precision error. */
export function parseMicro(s: string): bigint {
  const m = DECIMAL.exec(s);
  if (!m) throw new DecimalError("format", `not a plain decimal: ${JSON.stringify(s.slice(0, 40))}`);
  const frac = m[1] ?? "";
  if (frac.length > 6) throw new DecimalError("precision", `more than 6 decimals: ${s}`);
  const int = s.split(".")[0]!.replaceAll(",", "");
  return BigInt(int) * MICRO + BigInt((frac + "000000").slice(0, 6));
}

/** USD per EUR in 10^-6 units, with a sanity range: a rate outside [0.5, 2.5] is never a real ECB rate. */
export function fxMicro(fx: FxRate): bigint {
  const r = parseMicro(fx.usdPerEur);
  if (r < 500_000n || r > 2_500_000n) throw new DecimalError("format", `USD per EUR ${fx.usdPerEur} outside [0.5, 2.5]`);
  return r;
}

/**
 * cents = floor((200 X + 10^12 g) / (2 * 10^12 g)) = round_half_up(X / (10^10 g)), X = N * R (7.4).
 * Returns valueU = cents * TICK. No bounds check here.
 */
export function centValueU(nativeMicro: bigint, rateMicro: bigint, gpuCount: number): bigint {
  if (!Number.isSafeInteger(gpuCount) || gpuCount < 1 || gpuCount > 64) throw new RangeError(`bad gpu count ${gpuCount}`);
  if (nativeMicro < 0n || rateMicro <= 0n) throw new RangeError("negative price or rate");
  const g = BigInt(gpuCount);
  const X = nativeMicro * rateMicro;
  const cents = (2n * X + E10 * g) / (2n * E10 * g);
  return cents * TICK_N;
}

export function inBounds(valueU: number): boolean {
  return Number.isSafeInteger(valueU) && valueU >= P_MIN && valueU <= P_MAX && valueU % TICK === 0;
}

/**
 * SourcesPureApi.toValueU: the native decimal (per instance) over gpuCount, EUR times usdPerEur, cent half-up once.
 * Throws RangeError on a malformed input (bad decimal, more than 6 decimals, missing or absurd FX rate, bad count).
 * The bounds of rule 7 are applied by parse, not here.
 */
export function toValueU(native: string, currency: Currency, gpuCount: number, fx?: FxRate): number {
  let n: bigint;
  let r: bigint;
  try {
    n = parseMicro(native);
    if (currency === "USD") r = MICRO;
    else if (currency === "EUR") {
      if (!fx) throw new RangeError("EUR price without an FX rate");
      r = fxMicro(fx);
    } else throw new RangeError(`unknown currency ${String(currency)}`);
  } catch (e) {
    throw e instanceof RangeError ? e : new RangeError((e as Error).message);
  }
  const v = centValueU(n, r, gpuCount);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`value too large: ${native}`);
  return Number(v);
}
