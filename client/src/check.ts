// Check any day yourself: recompute one GPU's index price for one day from what the chain stores, and compare it with
// the record the index keeps. A port of the daily formula (contracts/src/lib/IndexFormula.sol, BUILD-SPEC 4.6) and of
// carryDay's state step (carryPost in contracts/src/lib/IndexDays.sol, 4.9) in whole numbers, so a match is exact to
// the u. A day's inputs are its source writer's readings as the index stores them (readings(): per slot the sum and
// count of the hourly readings, kept for ever). The state a day starts from (each slot's held price, dark-day counter
// and membership) is not stored per day, so it is rebuilt by replaying every record from the GPU's first day, each
// one checked against its stored record the same way.
import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";
import type { DayCheck, DayCheckSource, Gpu } from "./types.ts";
import { dateOfDay, toNumber6 } from "./units.ts";

const TICK_U = 10_000; // $0.01 in u
const HOLD_DAYS = 5;
const SHADOW_DAYS = 5;
const NEVER = 0xffff_ffff;
/** IAgateIndex.Kind */
const OUT = 0;
const FRESH = 1;
const HELD = 2;
/** IAgateIndex.Status */
/** the index Status of a carried day (IAgateIndex Status.CARRIED) */
export const CARRIED = 4;
const STATUS = ["none", "full", "degraded", "demo", "carried"] as const;
const KIND = ["out", "fresh", "held"] as const;

/** A slot's state after a record (IAgateIndex.SlotState): held value (u), computed days since its last fresh day
 *  (0..HOLD_DAYS + 1), in the median, ever in the median. */
export interface IndexSlotState {
  e: number;
  miss: number;
  inMedian: boolean;
  wasIn: boolean;
}
/** A registered GPU's shape: per slot its family and live window (gpu, familyOf, slotWindow); per family the fresh
 *  slots it needs to count as fresh. */
export interface IndexShape {
  family: readonly number[];
  famQ: readonly number[];
  liveFrom: readonly number[];
  liveUntil: readonly number[];
}
/** One writer's stored readings of one GPU on one day (readings()): per slot the sum (u) and count. */
export interface DayReadings {
  sums: readonly number[];
  counts: readonly number[];
  sliceBits: bigint;
  late: boolean;
}
/** record() of one day: the fields a check compares (u for prices). */
export interface StoredRecord {
  exists: boolean;
  isFinal: boolean;
  value: number;
  status: number;
  fresh: number;
  quorum: number;
  held: number;
  freshMedian: number;
  late: boolean;
  incomplete: boolean;
  changed: boolean;
  source: Address;
  digest: Hex;
}
/** The formula's result for one writer on one day, as the contract's Calc. */
export interface Recomputed {
  value: number;
  status: number;
  fresh: number;
  quorum: number;
  held: number;
  freshMedian: number;
  changed: boolean;
  late: boolean;
  incomplete: boolean;
  p: number[];
  kinds: number[];
  counts: number[];
  post: IndexSlotState[];
  digest: Hex;
}

/** To the cent, halves up. */
function centU(v: number): number {
  return Math.floor((v + TICK_U / 2) / TICK_U) * TICK_U;
}
/** Median; an even count takes the floor mean of the two middle values. */
function medianU(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length;
  return k % 2 === 1 ? s[(k - 1) / 2]! : Math.floor((s[k / 2 - 1]! + s[k / 2]!) / 2);
}
function live(g: IndexShape, i: number, d: number): boolean {
  return g.liveFrom[i]! <= d && d < g.liveUntil[i]!;
}
/** A slot whose readings count on day d: live, or queued to go live within SHADOW_DAYS. */
function readable(g: IndexShape, i: number, d: number): boolean {
  return g.liveFrom[i]! !== NEVER && g.liveFrom[i]! <= d + SHADOW_DAYS && d < g.liveUntil[i]!;
}

/** Every slot's state at registration: held value 0, dark past HOLD_DAYS, never in the median. */
export function initialState(nSlots: number): IndexSlotState[] {
  return Array.from({ length: nSlots }, () => ({ e: 0, miss: HOLD_DAYS + 1, inMedian: false, wasIn: false }));
}

/** keccak256(abi.encode(gpuId, day, source, p, kinds, counts, inMedian[], miss[], wasIn[], value)): the digest
 *  closeDay records (IndexMath.digest). */
export function recordDigest(gpuId: Hex, day: number, source: Address, r: { p: readonly number[]; kinds: readonly number[]; counts: readonly number[]; post: readonly IndexSlotState[]; value: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint32" }, { type: "address" }, { type: "uint32[]" }, { type: "uint8[]" }, { type: "uint8[]" }, { type: "bool[]" }, { type: "uint8[]" }, { type: "bool[]" }, { type: "uint32" }],
      [gpuId, day, source, [...r.p], [...r.kinds], [...r.counts], r.post.map((s) => s.inMedian), r.post.map((s) => s.miss), r.post.map((s) => s.wasIn), r.value],
    ),
  );
}

/** The daily formula (4.6) for one writer's readings on day `day`, from the state `pre` the day before left. */
export function recomputeDay(x: {
  gpuId: Hex;
  day: number;
  source: Address;
  shape: IndexShape;
  minReadings: number;
  slices: number;
  pre: readonly IndexSlotState[];
  readings: DayReadings;
  /** record(day - 1)'s value, null when there is none */
  prevValue: number | null;
  /** firstRecordDay(), null when no record exists yet */
  firstRecordDay: number | null;
}): Recomputed {
  const { shape: g, day: d } = x;
  const n = g.family.length;
  const entry = dateOfDay(d).endsWith("-01") || !(x.firstRecordDay !== null && x.firstRecordDay < d);
  const p: number[] = Array(n).fill(0);
  const counts: number[] = Array(n).fill(0);
  const kinds: number[] = Array(n).fill(OUT);
  const post = x.pre.map((s) => ({ ...s }));
  let moved = false;
  for (let i = 0; i < n; i++) {
    const pr = x.pre[i]!;
    const po = post[i]!;
    const lv = live(g, i, d);
    if (!readable(g, i, d)) {
      po.inMedian = false;
      po.miss = HOLD_DAYS + 1;
    } else {
      const c = x.readings.counts[i] ?? 0;
      counts[i] = c;
      if (c >= x.minReadings && c > 0) {
        const v = centU(Math.floor((x.readings.sums[i] ?? 0) / c));
        p[i] = v;
        po.e = v;
        po.miss = 0;
      } else {
        po.miss = pr.miss >= HOLD_DAYS ? HOLD_DAYS + 1 : pr.miss + 1;
      }
      po.inMedian = lv && po.miss <= HOLD_DAYS && (pr.wasIn || entry);
      if (po.inMedian) {
        po.wasIn = true;
        kinds[i] = po.miss === 0 ? FRESH : HELD;
      }
    }
    if (po.inMedian !== pr.inMedian || (entry && lv && !pr.inMedian)) moved = true;
  }
  // one value per family (the median of its counted slots), then the median across families
  const famVals: number[] = [];
  const freshMeds: number[] = [];
  let q = 0;
  let fresh = 0;
  let held = 0;
  let anyFresh = false;
  for (let f = 0; f < g.famQ.length; f++) {
    const inVals: number[] = [];
    const freshVals: number[] = [];
    for (let i = 0; i < n; i++) {
      if (g.family[i] !== f || kinds[i] === OUT) continue;
      inVals.push(post[i]!.e);
      if (kinds[i] === FRESH) freshVals.push(p[i]!);
    }
    held += inVals.length - freshVals.length;
    if (inVals.length > 0) famVals.push(centU(medianU(inVals)));
    if (freshVals.length > 0) anyFresh = true;
    if (freshVals.length >= g.famQ[f]!) {
      fresh++;
      freshMeds.push(centU(medianU(freshVals)));
    }
    if (inVals.length >= g.famQ[f]!) q++;
  }
  const value = famVals.length === 0 ? 0 : centU(medianU(famVals));
  const r = {
    value,
    status: fresh >= 5 ? 1 : fresh >= 3 ? 2 : 3,
    fresh,
    quorum: anyFresh ? q : 0,
    held,
    freshMedian: freshMeds.length === 0 ? 0 : centU(medianU(freshMeds)),
    changed: x.prevValue === null || value !== x.prevValue || moved,
    late: x.readings.late,
    incomplete: x.readings.sliceBits !== (1n << BigInt(x.slices)) - 1n,
    p,
    kinds,
    counts,
    post,
  };
  return { ...r, digest: recordDigest(x.gpuId, d, x.source, r) };
}

/** carryDay's state step (4.9): each readable slot not yet dark past HOLD_DAYS that every eligible writer of the day
 *  read below minReadings moves one dark day on; with no eligible writer nothing moves. */
export function carryState(pre: readonly IndexSlotState[], shape: IndexShape, day: number, minReadings: number, eligibleCounts: readonly (readonly number[])[]): IndexSlotState[] {
  const post = pre.map((s) => ({ ...s }));
  if (eligibleCounts.length === 0) return post;
  for (let i = 0; i < post.length; i++) {
    if (post[i]!.miss >= HOLD_DAYS || !readable(shape, i, day)) continue;
    if (eligibleCounts.every((c) => (c[i] ?? 0) < minReadings)) post[i]!.miss += 1;
  }
  return post;
}

/** Everything a check reads from the chain, from the GPU's first day to the checked day. */
export interface DayCheckInput {
  gpu: Gpu;
  gpuId: Hex;
  day: number;
  firstDay: number;
  firstRecordDay: number | null;
  minReadings: number;
  slices: number;
  shape: IndexShape;
  /** per slot, the company it reads */
  names: readonly string[];
  /** record(d) of every day from firstDay to day */
  records: ReadonlyMap<number, StoredRecord>;
  /** readings(d, source) of every computed record's source */
  readings: ReadonlyMap<number, DayReadings>;
  /** per carried day, the reading counts of every writer eligible that day */
  carried: ReadonlyMap<number, readonly (readonly number[])[]>;
}

const COMPARED = ["value", "status", "fresh", "quorum", "held", "freshMedian", "changed", "late", "incomplete", "digest"] as const;

/** Replays every record from firstDay to day and answers for day: the stored price beside the recomputed one, whether
 *  every compared field agrees, and the per-source inputs. Throws when day has no record. */
export function checkDayFrom(x: DayCheckInput): DayCheck {
  const target = x.records.get(x.day);
  if (!target?.exists) throw new Error(`no record for ${x.gpu} on ${dateOfDay(x.day)}`);
  const empty: DayReadings = { sums: [], counts: [], sliceBits: 0n, late: false };
  let state = initialState(x.shape.family.length);
  const values = new Map<number, number>();
  const mismatches: string[] = [];
  let days = 0;
  let calc: Recomputed | null = null;
  let differences: string[] = [];
  for (let d = x.firstDay; d <= x.day; d++) {
    const r = x.records.get(d);
    if (!r?.exists) continue; // a skipped day leaves the state as it was
    days++;
    const prev = x.records.get(d - 1);
    let diff: string[];
    if (r.status === CARRIED) {
      state = carryState(state, x.shape, d, x.minReadings, x.carried.get(d) ?? []);
      // a carried day repeats the day before's price
      const v = values.get(d - 1) ?? 0;
      values.set(d, v);
      diff = prev?.exists && v === r.value ? [] : ["value"];
    } else {
      const c = recomputeDay({ gpuId: x.gpuId, day: d, source: r.source, shape: x.shape, minReadings: x.minReadings, slices: x.slices, pre: state, readings: x.readings.get(d) ?? empty, prevValue: prev?.exists ? prev.value : null, firstRecordDay: x.firstRecordDay });
      state = c.post;
      values.set(d, c.value);
      diff = COMPARED.filter((k) => (k === "digest" ? c.digest.toLowerCase() !== r.digest.toLowerCase() : c[k] !== r[k]));
      if (d === x.day) calc = c;
    }
    if (d < x.day && diff.length > 0) mismatches.push(dateOfDay(d));
    if (d === x.day) differences = diff;
  }
  const dollars = (u: number) => toNumber6(BigInt(u));
  const c = calc as Recomputed | null;
  const sources: DayCheckSource[] = c
    ? x.shape.family.map((_, i) => {
        const k = c.kinds[i]!;
        return {
          family: x.names[i] ?? `slot ${i}`,
          slot: i,
          readings: c.counts[i]!,
          dayPrice: c.p[i]! > 0 ? dollars(c.p[i]!) : null,
          kind: KIND[k]!,
          used: k === FRESH ? dollars(c.p[i]!) : k === HELD ? dollars(c.post[i]!.e) : null,
        };
      })
    : [];
  return {
    gpu: x.gpu,
    date: dateOfDay(x.day),
    day: x.day,
    final: target.isFinal,
    status: STATUS[target.status] as DayCheck["status"],
    stored: dollars(target.value),
    recomputed: dollars(values.get(x.day) ?? 0),
    match: differences.length === 0,
    differences,
    source: c ? target.source.toLowerCase() : "",
    digest: c ? { stored: target.digest.toLowerCase(), recomputed: c.digest.toLowerCase() } : null,
    minReadings: x.minReadings,
    sources,
    replay: { from: dateOfDay(x.firstDay), days, mismatches },
  };
}
