// Pure bigint math shared by the bots and the indexer (BOTS-SPEC 4.8): MS 4.5's owed, the maker's fair value (3.2),
// ticks, Kuru units, and day ids in a series' own clock. Every division rounds down, as the contracts do.
import { daysIn, firstDayOf, monthOf } from "@agate/watcher";
import { KURU_SIZE_PRECISION, LOT, TICK, U } from "./constants.ts";
import type { Side } from "./types.ts";

export { daysIn, firstDayOf, monthOf };

/** The terms owed needs (a SeriesTerms or a SeriesListed event carries them). */
export interface OwedTerms {
  n: number;
  floor: bigint;
  cap: bigint;
}

/** MS 4.5: owed(LONG, q) = floor(q (S + (N - k) F) / (N U)); owed(SHORT, q) = floor(q (k C - S) / (N U)), each from
 *  its own numerator (never the complement of the other). */
export function owed(side: Side, q: bigint, k: number, S: bigint, t: OwedTerms): bigint {
  const N = BigInt(t.n);
  const kk = BigInt(k);
  if (kk < 0n || kk > N) throw new RangeError(`k ${k} outside 0..${t.n}`);
  const num = side === 0 ? S + (N - kk) * t.floor : kk * t.cap - S;
  if (num < 0n) throw new RangeError("negative owed numerator");
  return (q * num) / (N * U);
}

/** What a claim would pay now: owed at (k, S) minus what the position was already paid, never below 0. */
export function claimable(side: Side, q: bigint, paid: bigint, k: number, S: bigint, t: OwedTerms): bigint {
  const o = owed(side, q, k, S, t);
  return o > paid ? o - paid : 0n;
}

export function clamp(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

/** BOTS-SPEC 3.2: fair = floor((S + (N - k) clamp(x, F, C)) / N), u per token. */
export function fair(S: bigint, k: number, x: bigint, t: OwedTerms): bigint {
  const N = BigInt(t.n);
  return (S + (N - BigInt(k)) * clamp(x, t.floor, t.cap)) / N;
}

export function floorTick(p: bigint): bigint {
  return p >= 0n ? (p / TICK) * TICK : -(((-p + TICK - 1n) / TICK) * TICK);
}
export function ceilTick(p: bigint): bigint {
  return -floorTick(-p);
}

/** Token base units to Kuru size units (one unit = LOT base units), rounded down. */
export function units(tokensBase: bigint): bigint {
  return tokensBase / LOT;
}

/** Dollars (u) a resting bid of `unitsN` size units at `price` u per token locks: price * units / 10^4, exact. */
export function quoteLocked(price: bigint, unitsN: bigint): bigint {
  return (price * unitsN) / KURU_SIZE_PRECISION;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/** The index day id at chain time t in a series' clock: startDay + floor((t - startTs) / day), toward minus infinity. */
export function dayIdAt(terms: { startDay: number; startTs: bigint; day: number }, t: bigint): number {
  return terms.startDay + Number(floorDiv(t - terms.startTs, BigInt(terms.day)));
}

/** BOTS-SPEC 2.4: the index calls a sync-bearing call makes now: the ended days not yet applied (kPrev - kState,
 *  which counts the days a call would force) plus one when the next ended day is not final yet (the loop asks the
 *  index and stops). */
export function indexCalls(terms: { n: number; startTs: bigint; day: number }, kState: number, kPrev: number, t: bigint): number {
  const pending = kPrev - kState;
  const nextEnded = kPrev < terms.n && t >= terms.startTs + BigInt(kPrev + 1) * BigInt(terms.day);
  return pending + (nextEnded ? 1 : 0);
}
