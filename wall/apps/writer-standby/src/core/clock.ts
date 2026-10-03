// The index clock as the writers use it (BUILD-SPEC 2.2 and 3, rule R v4.3). Pure: runs in CRE's WASM runtime.
import type { Clocks } from "@agate/report/types";

/** The constructor inputs that define a profile; every other duration is derived from them. */
export interface ClockConfig {
  day: number;
  slices: number;
  epochTs: number;
  epochDay: number;
  signAll?: boolean;
}

export interface Clock {
  day: number;
  slices: number;
  epochTs: number;
  epochDay: number;
  signAll: boolean;
  slice: number;
  minReadings: number;
  /** GAP: the watcher's walk cap in intervals (6.2). */
  gap: number;
  /** PEND_FLOOR: the attester's settle point plus a real minute (T8). */
  pendFloor: number;
  tPend: number;
  closeGrace: number;
  grace: number;
  reopenWait: number;
  holdMove: number;
  holdMin: number;
  step: number;
  timelock: number;
}

/** Every derived clock of 2.2 from the constructor inputs, exactly as the contract derives them. */
export function deriveClock(c: ClockConfig): Clock {
  const day = Number(c.day);
  const slices = Number(c.slices);
  if (!Number.isSafeInteger(day) || !Number.isSafeInteger(slices) || day <= 0 || slices < 1 || slices > 255 || day % slices !== 0 || day % 12 !== 0) {
    throw new Error(`bad clock: day ${day}, slices ${slices}`);
  }
  const signAll = Boolean(c.signAll);
  const slice = day / slices;
  const gap = Math.max(1, Math.floor(slices / 8));
  const pendFloor = gap * slice + 60;
  const quarter = Math.floor(day / 4);
  if (pendFloor > Math.floor(day / 2) && !signAll) throw new Error(`bad clock: PEND_FLOOR ${pendFloor} > DAY / 2 needs signAll (T8)`);
  return {
    day,
    slices,
    epochTs: Number(c.epochTs),
    epochDay: Number(c.epochDay),
    signAll,
    slice,
    minReadings: Math.floor(slices / 2),
    gap,
    pendFloor,
    tPend: signAll && pendFloor > Math.floor(day / 2) ? quarter : Math.max(quarter, pendFloor),
    closeGrace: slice,
    grace: day,
    reopenWait: quarter,
    holdMove: 7 * day,
    holdMin: Math.floor((3 * day) / 4),
    step: Math.floor(day / 6),
    timelock: 2 * day,
  };
}

const CHAIN_FIELDS = ["slice", "tPend", "closeGrace", "grace", "holdMove", "holdMin", "step", "reopenWait", "timelock", "minReadings"] as const;

/** Fields where the chain's clocks() differ from 2.2's derivation (empty when the contract and this file agree). */
export function clockMismatches(c: Clocks): string[] {
  const d = deriveClock({ day: Number(c.day), slices: Number(c.slices), epochTs: Number(c.epochTs), epochDay: Number(c.epochDay), signAll: c.signAll });
  return CHAIN_FIELDS.filter((k) => Number(c[k]) !== d[k]).map((k) => `${k}: chain ${c[k]}, derived ${d[k]}`);
}

/** From a profile, derived; from the chain's clocks(), the chain's values (authoritative) on the same shape. */
export function clockOf(c: ClockConfig | Clocks): Clock {
  if (!("tPend" in c)) return deriveClock(c);
  const derived = (() => {
    try {
      return deriveClock({ day: Number(c.day), slices: Number(c.slices), epochTs: Number(c.epochTs), epochDay: Number(c.epochDay), signAll: c.signAll });
    } catch {
      return undefined;
    }
  })();
  const slices = Number(c.slices);
  const slice = Number(c.slice);
  const gap = Math.max(1, Math.floor(slices / 8));
  return {
    day: Number(c.day),
    slices,
    epochTs: Number(c.epochTs),
    epochDay: Number(c.epochDay),
    signAll: Boolean(c.signAll),
    slice,
    minReadings: Number(c.minReadings),
    gap,
    pendFloor: derived?.pendFloor ?? gap * slice + 60,
    tPend: Number(c.tPend),
    closeGrace: Number(c.closeGrace),
    grace: Number(c.grace),
    reopenWait: Number(c.reopenWait),
    holdMove: Number(c.holdMove),
    holdMin: Number(c.holdMin),
    step: Number(c.step),
    timelock: Number(c.timelock),
  };
}

export function dayIdAt(c: Clock, t: number): number {
  return t < c.epochTs ? c.epochDay : c.epochDay + Math.floor((t - c.epochTs) / c.day);
}

export function dayStart(c: Clock, d: number): number {
  return c.epochTs + (d - c.epochDay) * c.day;
}

export function dayEnd(c: Clock, d: number): number {
  return dayStart(c, d + 1);
}

export function sliceStart(c: Clock, d: number, h: number): number {
  return dayStart(c, d) + h * c.slice;
}

export interface SliceAt {
  dayId: number;
  slice: number;
  start: number;
  end: number;
}

export function sliceAt(c: Clock, t: number): SliceAt {
  const dayId = dayIdAt(c, t);
  const slice = Math.min(c.slices - 1, Math.floor((Math.max(t, c.epochTs) - dayStart(c, dayId)) / c.slice));
  const start = sliceStart(c, dayId, slice);
  return { dayId, slice, start, end: start + c.slice };
}

/** The readAt a run reports: its start, a little in the past (never before the slice) so a node clock slightly
 * ahead of the chain never gives a readAt later than the block that carries it (E6). Seen on an anvil fork: +1 s. */
export function readAtFor(c: Clock, now: number, skew?: number): SliceAt & { readAt: number } {
  const s = sliceAt(c, now);
  const lag = skew ?? Math.min(2, Math.floor(c.slice / 20));
  return { ...s, readAt: Math.max(s.start, now - lag) };
}

/** The read window inside a slice, as offsets: a fresh random second in [slice/20, slice/2) (HF-5). */
export function readWindow(c: Clock): [number, number] {
  const lo = Math.floor(c.slice / 20);
  return [lo, Math.max(lo + 1, Math.floor(c.slice / 2))];
}

export function readOffset(c: Clock, rand: number, from = 0): number {
  const [lo0, hi] = readWindow(c);
  const lo = Math.min(hi - 1, Math.max(lo0, from));
  return lo + Math.min(hi - lo - 1, Math.floor(rand * (hi - lo)));
}

/** The writers' margin before the F1 close point: slice / 12, at least 1 s. */
export function margin(c: Clock): number {
  return Math.max(1, Math.floor(c.slice / 12));
}

/** The attester's margin before a finality deadline (offchain, 2.2): max(30 s, slice / 12). */
export function attesterMargin(c: Clock): number {
  return Math.max(30, Math.floor(c.slice / 12));
}

/** F1's repost point: reposts aim to have landed by here, so a close at dayEnd + CLOSE_GRACE finds them. Since Oct 3 a
 * logged entry whose bit is still missing is reposted after it only while its day is open, until repostEnd. */
export function sendDeadline(c: Clock, d: number): number {
  return dayEnd(c, d) + c.closeGrace - margin(c);
}

/** graceStart(d) = max(dayEnd(d), registeredAt): every carry clock of a GPU starts here (3; a backfilled day's is the
 * registration time). An unknown registeredAt gives dayEnd(d), the earliest possible graceStart. */
export function graceStart(c: Clock, d: number, registeredAt?: number): number {
  return Math.max(dayEnd(c, d), registeredAt ?? 0);
}

/** REPOST_END (8.1 step 2, Oct 3): the last second a logged in-slice entry of a still-open day d may be reposted,
 * graceStart + GRACE - slice (82,800 s after graceStart on PRODUCTION). */
export function repostEnd(c: Clock, d: number, registeredAt?: number): number {
  return graceStart(c, d, registeredAt) + c.grace - c.slice;
}

/** The earliest second closeDay can succeed for day d (C1). */
export function closableAt(c: Clock, d: number): number {
  return dayEnd(c, d) + c.closeGrace;
}

/** From here any active writer may close day d whatever its own completeness (C3, C4 after T_PEND). */
export function pendEnd(c: Clock, d: number): number {
  return dayEnd(c, d) + c.tPend;
}

/** GUARD_ACT (L1): a person's deadline after an action alert. */
export function guardAct(c: Clock): number {
  return Math.floor(c.day / 4);
}

/** LAG_MAX (L1, 6.6): 2 DAY where the proof bound fits in it, else the bound B itself. */
export function lagMax(c: Clock): number {
  const part = 2 * (Math.floor(c.day / 12) + c.slice + Math.max(guardAct(c), c.tPend));
  return part <= c.day ? 2 * c.day : c.grace + part;
}

/** The writers' loop period: min(20 s, slice / 30), at least 1 s. */
export function tickPeriod(c: Clock): number {
  return Math.min(20, Math.max(1, Math.floor(c.slice / 30)));
}

export function fullBits(c: Clock): bigint {
  return (1n << BigInt(c.slices)) - 1n;
}

export function utcDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
