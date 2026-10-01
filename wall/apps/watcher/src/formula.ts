// Offchain port of the daily formula (BUILD-SPEC 4.6) and of carryDay's carryPost (4.9). Pure, integers only.
// The attester refuses to act when this ever differs from previewRecord or slotStates (9.2).
import { digestOf } from "@agate/report";
import type { Address, Hex, SlotState } from "@agate/report/types";
import { HOLD_DAYS, Kind, NEVER, SHADOW_DAYS, Status } from "@agate/report/types";
import { fullBits } from "./clock.ts";
import { isFirstOfMonth } from "./date.ts";

export function cent(v: number): number {
  return Math.floor((v + 5_000) / 10_000) * 10_000;
}

/** Sorted median; even n: the floor mean of the two middle values (exact on the cent grid). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error("median of nothing");
  return n % 2 === 1 ? s[(n - 1) / 2]! : Math.floor((s[n / 2 - 1]! + s[n / 2]!) / 2);
}

/** The static shape of a registered GPU plus its slot windows. */
export interface GpuShape {
  nSlots: number;
  family: readonly number[]; // slot -> family
  famQ: readonly number[]; // family -> famQ
  liveFrom: readonly number[];
  liveUntil: readonly number[];
}

export interface FormulaParams {
  slices: number;
  minReadings: number;
  qMin: number;
  signAll: boolean;
  tPend: number;
}

/** One writer's accumulators for (gpu, day). */
export interface Acc {
  sums: readonly number[];
  counts: readonly number[];
  sliceBits: number;
  late: boolean;
  anyValid: boolean;
}

export function live(g: GpuShape, i: number, d: number): boolean {
  return g.liveFrom[i]! <= d && d < g.liveUntil[i]!;
}
export function readable(g: GpuShape, i: number, d: number): boolean {
  return g.liveFrom[i]! !== NEVER && g.liveFrom[i]! <= d + SHADOW_DAYS && d < g.liveUntil[i]!;
}
export function isEntry(d: number, firstRecordDay: number | null): boolean {
  return isFirstOfMonth(d) || !(firstRecordDay !== null && firstRecordDay < d);
}

export interface ComputeInput {
  params: FormulaParams;
  gpu: GpuShape;
  gpuId: Hex;
  day: number;
  writer: Address;
  postedAt: number;
  pre: readonly SlotState[];
  acc: Acc | null;
  prev: { value: number } | null; // record(d - 1), a CARRIED one counts
  firstRecordDay: number | null;
  firstWriter: Address | null; // C3's first writer at the time of the call
}

export interface Computed {
  value: number;
  status: Status;
  fresh: number;
  quorum: number;
  quorate: boolean;
  held: number;
  freshMedian: number;
  late: boolean;
  incomplete: boolean;
  changed: boolean;
  needsSign: boolean;
  source: Address;
  postedAt: number;
  finalAt: number;
  digest: Hex;
  p: number[];
  kinds: Kind[];
  counts: number[];
  post: SlotState[];
}

export function computeRecord(x: ComputeInput): Computed {
  const { params: P, gpu: g, day: d } = x;
  const H = HOLD_DAYS;
  const n = g.nSlots;
  const entry = isEntry(d, x.firstRecordDay);
  const post: SlotState[] = x.pre.map((s) => ({ ...s }));
  const p: number[] = Array(n).fill(0);
  const counts: number[] = Array(n).fill(0);
  const kinds: Kind[] = Array(n).fill(Kind.OUT);
  for (let i = 0; i < n; i++) {
    const s = post[i]!;
    if (!readable(g, i, d)) {
      s.inMedian = false;
      s.miss = H + 1;
      continue;
    }
    const c = x.acc ? x.acc.counts[i]! : 0;
    counts[i] = c;
    if (c >= P.minReadings) {
      p[i] = cent(Math.floor(x.acc!.sums[i]! / c));
      s.e = p[i]!;
      s.miss = 0;
    } else {
      s.miss = Math.min(x.pre[i]!.miss + 1, H + 1);
    }
    s.inMedian = live(g, i, d) && s.miss <= H && (x.pre[i]!.wasIn || entry);
    if (s.inMedian) {
      s.wasIn = true;
      kinds[i] = s.miss === 0 ? Kind.FRESH : Kind.HELD;
    }
  }
  const famVals: number[] = [];
  const freshMeds: number[] = [];
  let q = 0;
  let freshFamilies = 0;
  let held = 0;
  let anyFresh = false;
  for (let f = 0; f < g.famQ.length; f++) {
    const IN: number[] = [];
    let nf = 0;
    let nh = 0;
    for (let i = 0; i < n; i++) {
      if (g.family[i] !== f || kinds[i] === Kind.OUT) continue;
      IN.push(i);
      if (kinds[i] === Kind.FRESH) nf++;
      else nh++;
    }
    held += nh;
    if (IN.length > 0) famVals.push(cent(median(IN.map((i) => post[i]!.e))));
    if (nf > 0) anyFresh = true;
    if (nf >= g.famQ[f]!) {
      freshFamilies++;
      freshMeds.push(cent(median(IN.filter((i) => kinds[i] === Kind.FRESH).map((i) => p[i]!))));
    }
    if (nf + nh >= g.famQ[f]!) q++;
  }
  const quorum = anyFresh ? q : 0;
  const value = famVals.length === 0 ? 0 : cent(median(famVals));
  const status = freshFamilies >= 5 ? Status.FULL : freshFamilies >= 3 ? Status.DEGRADED : Status.DEMO;
  const freshMedian = freshMeds.length === 0 ? 0 : cent(median(freshMeds));
  let changed = x.prev === null || value !== x.prev.value;
  for (let i = 0; i < n && !changed; i++) {
    if (post[i]!.inMedian !== x.pre[i]!.inMedian) changed = true;
    if (entry && live(g, i, d) && !x.pre[i]!.inMedian) changed = true;
  }
  const complete = x.acc !== null && x.acc.sliceBits === fullBits(P);
  const firstW = x.firstWriter?.toLowerCase();
  const needsSign = changed || P.signAll || firstW !== x.writer.toLowerCase();
  const digest = digestOf({ gpuId: x.gpuId, day: d, source: x.writer, p, kinds, counts, post, value });
  return {
    value,
    status,
    fresh: freshFamilies,
    quorum,
    quorate: quorum >= P.qMin,
    held,
    freshMedian,
    late: x.acc?.late ?? false,
    incomplete: !complete,
    changed,
    needsSign,
    source: x.writer,
    postedAt: x.postedAt,
    finalAt: needsSign ? 0 : x.postedAt + P.tPend,
    digest,
    p,
    kinds,
    counts,
    post,
  };
}

/** Quorum of one writer's readings on (gpu, d) against pre, as C3 and carry case 2 judge it. */
export function quorumOf(params: FormulaParams, gpu: GpuShape, d: number, pre: readonly SlotState[], acc: Acc | null, firstRecordDay: number | null): number {
  return computeRecord({
    params,
    gpu,
    gpuId: `0x${"00".repeat(32)}`,
    day: d,
    writer: "0x0000000000000000000000000000000000000000",
    postedAt: 0,
    pre,
    acc,
    prev: null,
    firstRecordDay,
    firstWriter: null,
  }).quorum;
}

/** 4.9 carryPost: advance a miss counter only on every eligible writer's evidence, never past HOLD_DAYS. */
export function carryPost(
  pre: readonly SlotState[],
  gpu: GpuShape,
  d: number,
  minReadings: number,
  eligibleCounts: readonly (readonly number[])[],
): { post: SlotState[]; mask: number } {
  const post = pre.map((s) => ({ ...s }));
  let mask = 0;
  if (eligibleCounts.length === 0) return { post, mask };
  for (let i = 0; i < gpu.nSlots; i++) {
    if (!readable(gpu, i, d) || pre[i]!.miss >= HOLD_DAYS) continue;
    if (eligibleCounts.every((c) => (c[i] ?? 0) < minReadings)) {
      post[i]!.miss = pre[i]!.miss + 1;
      mask += 2 ** i;
    }
  }
  return { post, mask };
}

export function initialState(nSlots: number): SlotState[] {
  return Array.from({ length: nSlots }, () => ({ e: 0, miss: HOLD_DAYS + 1, inMedian: false, wasIn: false }));
}

export function sameState(a: readonly SlotState[], b: readonly SlotState[]): boolean {
  return a.length === b.length && a.every((s, i) => s.e === b[i]!.e && s.miss === b[i]!.miss && s.inMedian === b[i]!.inMedian && s.wasIn === b[i]!.wasIn);
}
