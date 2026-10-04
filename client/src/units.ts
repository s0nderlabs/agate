// Units, exactly. Onchain every dollar amount and every price is an integer number of u (1 u = $0.000001, the
// dollar's 6 decimals; prices are u per GPU-hour), a token amount is base units (10^6 per token, one token = one
// GPU-hour), and a Kuru size is size units (10^4 per token, one unit = LOT = 100 base units). Reads convert to plain
// numbers for display through the exact decimal string; writes take decimal strings (or bigint base units) and
// never touch a float.
import { formatUnits } from "viem";

export const U = 1_000_000n; // u per dollar; base units per token
export const LOT = 100n; // token base units per Kuru size unit
export const SIZE_PER_TOKEN = 10_000n; // Kuru size units per token
export const TICK = 10_000n; // $0.01: the index's grid and the Kuru tick
export const GRID = 50_000n; // $0.05: the band's grid
export const KURU_MIN_SIZE = 10_000n; // one token
export const KURU_MAX_SIZE = 10_000_000_000n; // 1,000,000 tokens
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export class AmountError extends Error {
  override name = "AmountError";
}

/** u (or token base units) to a plain number of dollars (or GPU-hours), through the exact decimal string. */
export function toNumber6(v: bigint): number {
  return Number(formatUnits(v, 6));
}
/** Kuru size units to GPU-hours. */
export function unitsToHours(units: bigint): number {
  return Number(formatUnits(units, 4));
}
/** dollars as a number (display) */
export const dollarsOf = toNumber6;
/** GPU-hours as a number (display) */
export const hoursOf = toNumber6;

/** An amount a write takes: a decimal string ("12.5", "1,000" is refused) or a bigint already in base units. */
export type Amount = string | bigint;

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Parses a non-negative decimal string into base units with `decimals` places, exactly; more places than that, a
 *  sign, an exponent, a separator or a number (a float) are refused. */
export function parseDecimal(v: Amount, decimals: number, what: string): bigint {
  if (typeof v === "bigint") {
    if (v < 0n) throw new AmountError(`${what} is negative`);
    return v;
  }
  if (typeof v !== "string") throw new AmountError(`${what} must be a decimal string or a bigint, never a number (no float on the write path)`);
  const s = v.trim();
  if (!DECIMAL.test(s)) throw new AmountError(`${what} "${v}" is not a plain decimal like 12.34`);
  const [whole, frac = ""] = s.split(".") as [string, string?];
  const f = frac ?? "";
  if (f.length > decimals) throw new AmountError(`${what} "${v}" has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Dollars to u (6 decimals). */
export function parseDollars(v: Amount, what = "dollars"): bigint {
  return parseDecimal(v, 6, what);
}

/** GPU-hours to token base units: a multiple of LOT (0.0001 GPU-hour), as every mint, sale and position needs. */
export function parseHours(v: Amount, what = "GPU-hours"): bigint {
  const q = parseDecimal(v, 6, what);
  if (q % LOT !== 0n) throw new AmountError(`${what} must be a multiple of 0.0001 GPU-hour (${LOT} base units)`);
  return q;
}

/** A price in dollars per GPU-hour to u, on the $0.01 tick. */
export function parsePrice(v: Amount, what = "price"): bigint {
  const p = parseDecimal(v, 6, what);
  if (p === 0n || p % TICK !== 0n) throw new AmountError(`${what} must be a positive multiple of $0.01`);
  return p;
}

/** a * num / den rounded down (bigint, a >= 0) */
export function mulDiv(a: bigint, num: bigint, den: bigint): bigint {
  return (a * num) / den;
}

/** Applies a slippage allowance in basis points downwards (a minimum we accept). */
export function minus(v: bigint, bps: number): bigint {
  checkBps(bps);
  return (v * (10_000n - BigInt(bps))) / 10_000n;
}
/** Applies a slippage allowance in basis points upwards (a maximum we spend), rounded up. */
export function plus(v: bigint, bps: number): bigint {
  checkBps(bps);
  return (v * (10_000n + BigInt(bps)) + 9_999n) / 10_000n;
}
export function checkBps(bps: number): void {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps >= 10_000) throw new AmountError(`slippage ${bps} bps must be an integer from 0 to 9,999`);
}

/** ISO time of a unix second (bigint or number). */
export function iso(t: bigint | number): string {
  return new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z");
}
/** The calendar date (YYYY-MM-DD) of an index day id (days since 1970-01-01). */
export function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}
/** "2026-11" of a month (year * 12 + month - 1). */
export function monthLabel(month: number): string {
  const y = Math.floor(month / 12);
  const m = (month % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}
/** year * 12 + month - 1 of "2026-11". */
export function monthOfLabel(label: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new AmountError(`month "${label}" is not YYYY-MM`);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) throw new AmountError(`month "${label}" is not YYYY-MM`);
  return Number(m[1]) * 12 + mm - 1;
}
/** The month (year * 12 + month - 1) of an index day id. */
export function monthOfDay(day: number): number {
  const d = new Date(day * 86_400_000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}
/** The index day id of the 1st of a month. */
export function firstDayOf(month: number): number {
  return Math.round(Date.UTC(Math.floor(month / 12), month % 12, 1) / 86_400_000);
}
export function daysIn(month: number): number {
  return firstDayOf(month + 1) - firstDayOf(month);
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov" of a month */
export function monthShort(month: number): string {
  return MON[month % 12]!;
}
