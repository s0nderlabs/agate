// Builders for synthetic rule-R scenarios (numbers only; no third-party pages).
import type { Address, Hex, SlotState } from "@agate/report/types";
import { NEVER } from "@agate/report/types";
import { computeRecord } from "../src/formula.ts";
import type { CandidateRecord, HistoryDay, LogCell, PendingRecord, RuleScenario, SlotLog, WriterDay } from "../src/rule/types.ts";

export const A: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const B: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const G: Hex = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
export const D = 100; // the scenario day (epochDay 0, so k(d, h) = d * slices + h)

export interface Geo {
  slices: number;
  mr: number;
  n: number;
}
export const TEST: Geo = { slices: 12, mr: 6, n: 5 };

/** A slot's log from a function of (day, slice), for days [d0, d1]. */
export function slotLog(g: Geo, d0: number, d1: number, f: (d: number, h: number) => LogCell | undefined): SlotLog {
  const cells: LogCell[] = [];
  for (let d = d0; d <= d1; d++) for (let h = 0; h < g.slices; h++) cells.push(f(d, h) ?? "MISSED");
  return { k0: d0 * g.slices, cells };
}

/** One writer's day from its per-slice readings (0 = no reading). */
export function writer(g: Geo, address: Address, slot: number, perSlice: (h: number, i: number) => number, opts: { eligible?: boolean; skip?: number[] } = {}): WriterDay {
  const sums = Array(g.n).fill(0);
  const counts = Array(g.n).fill(0);
  const slotSlices = Array(g.n).fill(0);
  let sliceBits = 0;
  for (let h = 0; h < g.slices; h++) {
    if (opts.skip?.includes(h)) continue;
    sliceBits += 2 ** h;
    for (let i = 0; i < g.n; i++) {
      const v = perSlice(h, i);
      if (v > 0) {
        sums[i] += v;
        counts[i] += 1;
        slotSlices[i] += 2 ** h;
      }
    }
  }
  return { address, slot, eligible: opts.eligible ?? true, sums, counts, sliceBits, slotSlices };
}

export function steady(e: number[], miss = 0): SlotState[] {
  return e.map((v) => ({ e: v, miss, inMedian: true, wasIn: true }));
}

export interface ScenOpts {
  g?: Geo;
  d?: number;
  log: SlotLog[];
  pre: SlotState[];
  writers: WriterDay[];
  pendingSource?: Address;
  pendingNeedsSign?: boolean;
  history?: HistoryDay[];
  liveFrom?: number[];
  liveUntil?: number[];
  family?: number[];
  firstRecordDay?: number | null;
  firstDay?: number;
  now?: number;
  qMin?: number;
}

export function computeFor(o: ScenOpts, w: WriterDay): CandidateRecord {
  const g = o.g ?? TEST;
  const d = o.d ?? D;
  const family = o.family ?? Array.from({ length: g.n }, (_, i) => i);
  const r = computeRecord({
    params: { slices: g.slices, minReadings: g.mr, qMin: o.qMin ?? 1, signAll: false, tPend: 600 },
    gpu: { nSlots: g.n, family, famQ: Array(Math.max(...family) + 1).fill(1), liveFrom: o.liveFrom ?? Array(g.n).fill(0), liveUntil: o.liveUntil ?? Array(g.n).fill(NEVER) },
    gpuId: G,
    day: d,
    writer: w.address,
    postedAt: 0,
    pre: o.pre,
    acc: { sums: w.sums, counts: w.counts, sliceBits: w.sliceBits, late: false, anyValid: true },
    prev: { value: 0 },
    firstRecordDay: o.firstRecordDay === undefined ? 0 : o.firstRecordDay,
    firstWriter: A,
  });
  return { source: w.address, digest: r.digest, value: r.value, p: r.p, kinds: r.kinds, counts: r.counts, post: r.post, complete: !r.incomplete, changed: r.changed, needsSign: r.needsSign, quorate: r.quorate };
}

export function scen(o: ScenOpts): RuleScenario {
  const g = o.g ?? TEST;
  const d = o.d ?? D;
  const family = o.family ?? Array.from({ length: g.n }, (_, i) => i);
  const recs = o.writers.map((w) => computeFor(o, w));
  const src = o.pendingSource ?? o.writers[0]!.address;
  const pr = recs.find((r) => r.source === src)!;
  const pending: PendingRecord = { ...pr, needsSign: o.pendingNeedsSign ?? pr.changed, postedAt: (d + 1) * g.slices * 200 + 200, finalAt: 0, attestedAt: 0 };
  if (!pending.needsSign) pending.finalAt = pending.postedAt + 600;
  return {
    version: 1,
    clock: { day: g.slices * 200, slices: g.slices, minReadings: g.mr, qMin: o.qMin ?? 1, signAll: false, epochTs: 0, epochDay: 0, tPend: 600 },
    gpu: { gpuId: G, nSlots: g.n, family, famQ: Array(Math.max(...family) + 1).fill(1), liveFrom: o.liveFrom ?? Array(g.n).fill(0), liveUntil: o.liveUntil ?? Array(g.n).fill(NEVER), firstDay: o.firstDay ?? 0 },
    day: d,
    now: o.now ?? (d + 1) * g.slices * 200 + 400,
    firstRecordDay: o.firstRecordDay === undefined ? 0 : o.firstRecordDay,
    pre: o.pre,
    log: o.log,
    writers: o.writers,
    pending,
    candidates: recs.filter((r) => r.source !== src),
    history: o.history ?? [],
  };
}
