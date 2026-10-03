// Pure integer math the handlers share (BOTS-SPEC 1, 5.5; MS 1, 4.5). Amounts are bigint in u (1 u = $0.000001)
// or token base units (10^6 per token); days, months and k are numbers.

export const U = 1_000_000n; // base units per token, u per dollar
export const LOT = 100n; // token base units per Kuru size unit
export const TICK = 10_000n; // $0.01, the Kuru tick
export const KURU_VAULT = 1_000_000_000_000n; // Trade.price = price (u per token) * 10^12
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Floor division for bigint (BigInt "/" truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

// ------------------------------------------------------------------ DateLib (MS 2; the wall's date.ts)

export function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

export function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** year * 12 + (month - 1) of an index day. */
export function monthOf(day: number): number {
  const [y, m] = civilFromDays(day);
  return y * 12 + (m - 1);
}
export function firstDayOf(month: number): number {
  return daysFromCivil(Math.floor(month / 12), (month % 12) + 1, 1);
}
export function daysIn(month: number): number {
  return firstDayOf(month + 1) - firstDayOf(month);
}
/** YYYY-MM-DD of an index day. */
export function isoOfDay(day: number): string {
  const [y, m, d] = civilFromDays(day);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** 2026-11 for month = 2026 * 12 + 10. */
export function monthLabel(month: number): string {
  return `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ the index clock

/** A factory's clock anchor from its first series: startTs - startDay * day (MS 2: dayStart(d) = anchor + d * day). */
export function clockAnchor(startTs: bigint, startDay: number, day: number): bigint {
  return startTs - BigInt(startDay) * BigInt(day);
}
/** The index day containing chain time t, on a clock with this anchor and day length. */
export function dayIdAt(anchor: bigint, day: number, t: bigint): number {
  return Number(floorDiv(t - anchor, BigInt(day)));
}

// ------------------------------------------------------------------ positions (MS 4.5)

/** What a position of q is owed after k of n days with clamped sum s (exact integers, rounded down). */
export function owed(side: "LONG" | "SHORT", q: bigint, k: number, s: bigint, n: number, floor: bigint, cap: bigint): bigint {
  const num = side === "LONG" ? s + BigInt(n - k) * floor : BigInt(k) * cap - s;
  return (q * num) / (BigInt(n) * U);
}

// ------------------------------------------------------------------ Kuru V1 units (BOTS-SPEC 1)

/** Trade.price (vault precision) to u per token. */
export function tradePriceU(price: bigint): bigint {
  return price / KURU_VAULT;
}
/** Kuru size units to token base units. */
export function sizeToTokens(size: bigint): bigint {
  return size * LOT;
}
/** Dollars (u) of `size` units at `priceU`: price * size / 10^4, exact on the tick. */
export function notionalU(priceU: bigint, size: bigint): bigint {
  return (priceU * size) / 10_000n;
}
/** The mean of bid and ask, floored to the tick. */
export function midU(bid: bigint, ask: bigint): bigint {
  return (((bid + ask) / 2n) / TICK) * TICK;
}
