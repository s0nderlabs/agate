// The index clock as the watcher, attester, keeper and guardian use it (BUILD-SPEC 2.2, 3). Pure.
import type { Clocks } from "@agate/report/types";

/** Every clock the offchain roles need. Onchain values come from clocks(); the rest are derived (2.2). */
export interface WallClock {
  day: number;
  slices: number;
  slice: number;
  minReadings: number;
  qMin: number;
  signAll: boolean;
  demoLabel: boolean;
  epochTs: number;
  epochDay: number;
  tPend: number;
  closeGrace: number;
  grace: number;
  holdMove: number;
  holdMin: number;
  step: number;
  reopenWait: number;
  timelock: number;
  // offchain (2.2 rows marked offchain)
  gap: number;
  pendFloor: number;
  margin: number;
  guardAct: number;
  keeperPeriod: number;
  lagMax: number;
  /** The proof bound B of 6.6 (equals lagMax on DEMO and FAST). */
  lagBound: number;
}

export interface ProfileInput {
  day: number;
  slices: number;
  minReadings?: number;
  qMin?: number;
  signAll?: boolean;
  demoLabel?: boolean;
  epochTs?: number;
  epochDay?: number;
}

export function gapOf(slices: number): number {
  return Math.max(1, Math.floor(slices / 8));
}

/** The contract's derivation (2.2), for profiles built offchain (tests, the sim). Throws on a profile the constructor
 *  would refuse with BadInit. */
export function deriveClocks(p: ProfileInput): Clocks {
  const { day, slices } = p;
  const minReadings = p.minReadings ?? Math.floor(slices / 2);
  const qMin = p.qMin ?? 3;
  const signAll = p.signAll ?? false;
  const demoLabel = p.demoLabel ?? qMin < 3;
  if (!(day > 0) || day % slices !== 0 || day % 12 !== 0 || slices < 1 || slices > 255) throw new Error("BadInit: day/slices");
  if (minReadings < 1 || minReadings > slices || qMin < 1 || (qMin < 3 && !demoLabel)) throw new Error("BadInit: readings/quorum");
  const slice = day / slices;
  const pendFloor = gapOf(slices) * slice + 60;
  if (pendFloor > day / 2 && !signAll) throw new Error("BadInit: PEND_FLOOR > DAY/2 needs signAll");
  const tPend = signAll && pendFloor > day / 2 ? Math.floor(day / 4) : Math.max(Math.floor(day / 4), pendFloor);
  return {
    day,
    slice,
    tPend,
    closeGrace: slice,
    grace: day,
    holdMove: 7 * day,
    holdMin: (3 * day) / 4,
    step: day / 6,
    reopenWait: day / 4,
    timelock: 2 * day,
    slices,
    minReadings,
    qMin,
    demoLabel,
    signAll,
    epochTs: BigInt(p.epochTs ?? 0),
    epochDay: p.epochDay ?? 0,
    chainSelector: 0n,
  };
}

export const PROFILES = {
  PRODUCTION: { day: 86_400, slices: 24 },
  DEMO: { day: 600, slices: 4, qMin: 1 },
  FAST: { day: 24, slices: 2, qMin: 1, signAll: true },
  TEST: { day: 2_400, slices: 12 },
} as const satisfies Record<string, ProfileInput>;

/** Offchain clocks from the onchain Clocks struct (numbers or bigints as viem decodes them). */
export function wallClock(c: Clocks): WallClock {
  const day = Number(c.day);
  const slices = Number(c.slices);
  const slice = Number(c.slice);
  if (!(day > 0) || !(slices > 0) || slice * slices !== day) throw new Error(`bad clocks: day ${day} slices ${slices} slice ${slice}`);
  const gap = gapOf(slices);
  const tPend = Number(c.tPend);
  const guardAct = Math.floor(day / 4);
  const keeperPeriod = Math.floor(day / 12);
  const pass = keeperPeriod + slice + Math.max(guardAct, tPend);
  const grace = Number(c.grace);
  const lagBound = grace + 2 * pass;
  return {
    day,
    slices,
    slice,
    minReadings: Number(c.minReadings),
    qMin: Number(c.qMin),
    signAll: Boolean(c.signAll),
    demoLabel: Boolean(c.demoLabel),
    epochTs: Number(c.epochTs),
    epochDay: Number(c.epochDay),
    tPend,
    closeGrace: Number(c.closeGrace),
    grace,
    holdMove: Number(c.holdMove),
    holdMin: Number(c.holdMin),
    step: Number(c.step),
    reopenWait: Number(c.reopenWait),
    timelock: Number(c.timelock),
    gap,
    pendFloor: gap * slice + 60,
    margin: Math.max(30, Math.floor(slice / 12)),
    guardAct,
    keeperPeriod,
    lagMax: 2 * pass <= day ? 2 * day : lagBound,
    lagBound,
  };
}

export function dayIdAt(c: WallClock, t: number): number {
  return t < c.epochTs ? c.epochDay : c.epochDay + Math.floor((t - c.epochTs) / c.day);
}
export function dayStart(c: WallClock, d: number): number {
  return c.epochTs + (d - c.epochDay) * c.day;
}
export function dayEnd(c: WallClock, d: number): number {
  return dayStart(c, d + 1);
}
/** Absolute interval k of (d, h): [EPOCH_TS + k*slice, +slice). */
export function kOf(c: WallClock, d: number, h: number): number {
  return (d - c.epochDay) * c.slices + h;
}
export interface IntervalClock {
  epochTs: number;
  slice: number;
}
export function intervalAt(c: IntervalClock, t: number): number {
  return Math.floor((t - c.epochTs) / c.slice);
}
export function intervalStart(c: IntervalClock, k: number): number {
  return c.epochTs + k * c.slice;
}
export function dayOfInterval(c: WallClock, k: number): number {
  return c.epochDay + Math.floor(k / c.slices);
}
export function graceStart(c: WallClock, d: number, registeredAt: number): number {
  return Math.max(dayEnd(c, d), registeredAt);
}
/** R1's settle point: the watcher's states are known through interval k(d, SLICES-1) + 1 + GAP. */
export function settleInterval(c: WallClock, d: number): number {
  return kOf(c, d, c.slices - 1) + 1 + c.gap;
}
/** Slice and slot masks are plain numbers (exact to 2^53); never use JS bitwise operators on them (32-bit). */
export function fullBits(c: { slices: number }): number {
  if (c.slices > 52) throw new Error(`slices ${c.slices} above 52 are not supported offchain`);
  return 2 ** c.slices - 1;
}
export function hasBit(mask: number, i: number): boolean {
  return Math.floor(mask / 2 ** i) % 2 === 1;
}
export function withBit(mask: number, i: number): number {
  return hasBit(mask, i) ? mask : mask + 2 ** i;
}
export function bitCount(mask: number): number {
  let n = 0;
  for (let m = mask; m > 0; m = Math.floor(m / 2)) n += m % 2;
  return n;
}
export function utcDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
/** Fetch timeout: 40 s on PRODUCTION, slice / 10 on short profiles (7.7). */
export function fetchTimeoutS(c: { slice: number }): number {
  return Math.min(40, Math.max(1, c.slice / 10));
}
