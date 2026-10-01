// Differential test against the independent Python model of rule R v4.3 (model43.py, outside the repo): its vectors
// in test/vectors-model (numbers only, synthetic pages) are converted to RuleScenario and evaluate() must agree on
// the formula (value, kinds, p), W(d), every slot's class, blindness, expected kinds, complete and partial ranges,
// every candidate's tier, and R1's action. Remembered ranges are model inputs (scenario.remembered).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { Kind } from "@agate/report/types";
import { computeRecord } from "../src/formula.ts";
import { evaluate } from "../src/rule/decide.ts";
import type { CandidateRecord, LogCell, PendingRecord, Range, RuleScenario, WriterDay } from "../src/rule/types.ts";

const DIR = join(import.meta.dir, "vectors-model");
const ADDR: Record<string, Address> = { w1: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", w2: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" };
const KIND: Record<string, Kind> = { OUT: Kind.OUT, FRESH: Kind.FRESH, HELD: Kind.HELD };
const GPU: Hex = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";

interface MRange { lo: number; hi: number; open: boolean; empty: boolean }
interface MVector {
  id: string;
  description: string;
  clocks: { DAY: number; SLICES: number; MIN_READINGS: number; Q_MIN: number; signAll: boolean; EPOCH_TS: number; EPOCH_DAY: number; T_PEND: number };
  now: number;
  day: number;
  gpu: { nSlots: number; family: number[]; famQ: number[]; liveFrom: number[]; liveUntil: number[]; firstRecordDay: number | null };
  preState: { e: number[]; inMedian: boolean[]; miss: number[]; wasIn: boolean[] };
  firstWriter: string;
  watcherLog: { kFrom: number; slots: string[][] };
  accumulators: Record<string, { counts: number[]; sums: number[]; sliceBits: number; slotSliceBits: number[] }>;
  candidates: { writer: string; isPending: boolean; complete: boolean; value: number; changed: boolean; needsSign: boolean; p: number[]; kinds: string[]; counts: number[] }[];
  expected: {
    W: number;
    slots: ({ readable: false } | { readable: true; cls: string; blind: boolean; expected: string[]; completeRange: MRange | null; partialRange: MRange | null; remembered: MRange | null; anchorDay?: number })[];
    verdicts: { writer: string; tier: number; firstFailure: string | null }[];
    action: { type: string; writer?: string; alert?: string };
  };
}

function cellOf(s: string): LogCell {
  if (s.startsWith("V:")) return Number(s.slice(2));
  if (s === "UNREAD") return "MISSED";
  return s as LogCell;
}

export function toScenario(v: MVector): RuleScenario {
  const c = v.clocks;
  const n = v.gpu.nSlots;
  const pre = v.preState.e.map((e, i) => ({ e, miss: v.preState.miss[i]!, inMedian: v.preState.inMedian[i]!, wasIn: v.preState.wasIn[i]! }));
  const log = v.watcherLog.slots.map((cells) => {
    let end = cells.length;
    while (end > 0 && cells[end - 1] === "UNREAD") end--; // not yet read: beyond the log
    return { k0: v.watcherLog.kFrom, cells: cells.slice(0, end).map(cellOf) };
  });
  const writers: WriterDay[] = Object.entries(v.accumulators).map(([w, a], slot) => ({ address: ADDR[w]!, slot, eligible: true, sums: a.sums, counts: a.counts, sliceBits: a.sliceBits, slotSlices: a.slotSliceBits }));
  const recs = v.candidates.map((m) => {
    const a = v.accumulators[m.writer]!;
    const r = computeRecord({
      params: { slices: c.SLICES, minReadings: c.MIN_READINGS, qMin: c.Q_MIN, signAll: c.signAll, tPend: c.T_PEND },
      gpu: { nSlots: n, family: v.gpu.family, famQ: v.gpu.famQ, liveFrom: v.gpu.liveFrom, liveUntil: v.gpu.liveUntil },
      gpuId: GPU,
      day: v.day,
      writer: ADDR[m.writer]!,
      postedAt: 0,
      pre,
      acc: { sums: a.sums, counts: a.counts, sliceBits: a.sliceBits, late: false, anyValid: true },
      prev: null,
      firstRecordDay: v.gpu.firstRecordDay,
      firstWriter: ADDR[v.firstWriter] ?? null,
    });
    const rec: CandidateRecord = { source: ADDR[m.writer]!, digest: r.digest, value: r.value, p: r.p, kinds: r.kinds, counts: r.counts, post: r.post, complete: m.complete, changed: m.changed, needsSign: m.needsSign, quorate: r.quorate };
    return { m, rec };
  });
  const pend = recs.find((x) => x.m.isPending);
  const pending: PendingRecord | null = pend ? { ...pend.rec, postedAt: v.now - 1, finalAt: pend.m.needsSign ? 0 : v.now + 1_000_000, attestedAt: 0 } : null;
  const rangeOf = (r: MRange | null | undefined) => (r && !r.empty ? { lo: r.lo, hi: r.hi } : null);
  return {
    version: 1,
    clock: { day: c.DAY, slices: c.SLICES, minReadings: c.MIN_READINGS, qMin: c.Q_MIN, signAll: c.signAll, epochTs: c.EPOCH_TS, epochDay: c.EPOCH_DAY, tPend: c.T_PEND },
    gpu: { gpuId: GPU, nSlots: n, family: v.gpu.family, famQ: v.gpu.famQ, liveFrom: v.gpu.liveFrom, liveUntil: v.gpu.liveUntil, firstDay: v.gpu.firstRecordDay ?? v.day },
    day: v.day,
    now: v.now,
    firstRecordDay: v.gpu.firstRecordDay,
    pre,
    log,
    writers,
    pending,
    candidates: recs.filter((x) => !x.m.isPending).map((x) => x.rec),
    history: [],
    remembered: v.expected.slots.map((s) => (s.readable ? rangeOf(s.remembered) && { ...rangeOf(s.remembered)!, ...(s.anchorDay !== undefined ? { anchorDay: s.anchorDay } : {}) } : null)),
  };
}

const asRange = (r: Range): MRange | null => (r.t === "int" ? { lo: r.lo, hi: r.hi, open: Boolean(r.open), empty: false } : r.t === "empty" ? { lo: 0, hi: 0, open: false, empty: true } : null);
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^r1-\d+\.json$/.test(f)).sort() : [];

describe.skipIf(files.length === 0)("differential: rule R v4.3 against model43.py vectors", () => {
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(DIR, f), "utf8")) as MVector;
    test(`${v.id}: ${v.description}`, () => {
      const sc = toScenario(v);
      // the formula: the model's records equal 4.6 on the same readings and pre-state
      for (const m of v.candidates) {
        const mine = (m.isPending ? sc.pending! : sc.candidates.find((x) => x.source === ADDR[m.writer]))!;
        expect([m.writer, mine.value, mine.p, mine.kinds]).toEqual([m.writer, m.value, m.p, m.kinds.map((k) => KIND[k]!)]);
      }
      const ev = evaluate(sc);
      expect(ev.W).toBe(v.expected.W);
      v.expected.slots.forEach((s, i) => {
        const mine = ev.slots[i]!;
        expect([i, mine.readable]).toEqual([i, s.readable]);
        if (!s.readable) return;
        const exp = [mine.exp, ...(mine.expAlt !== undefined ? [mine.expAlt] : [])].map((k) => ["OUT", "FRESH", "HELD"][k!]);
        expect([i, mine.cls, mine.blind, [...new Set(exp)].sort()] as unknown[]).toEqual([i, s.cls, s.blind, [...new Set(s.expected)].sort()]);
        // every slice EMPTY (the page dark all day): the model gives no complete range, this module an EMPTY one; both
        // leave a fresh value nowhere to pass (6.2: "a slot the watcher read DARK is never unverifiable")
        const mc = mine.complete.t === "empty" ? null : asRange(mine.complete);
        expect([i, "complete", mc]).toEqual([i, "complete", s.completeRange && { ...s.completeRange, open: false }]);
        expect([i, "partial", asRange(mine.partial)]).toEqual([i, "partial", s.partialRange]);
      });
      const tiers: unknown[] = v.expected.verdicts.map((x) => [x.writer, x.tier]);
      const mineT: unknown[] = v.expected.verdicts.map((x) => [x.writer, ev.candidates.find((c) => c.source === ADDR[x.writer])!.tier]);
      expect(mineT).toEqual(tiers);
      const a = v.expected.action;
      expect([ev.action.kind, ev.action.writer ? Object.keys(ADDR).find((k) => ADDR[k] === ev.action.writer) : undefined]).toEqual([a.type, a.writer]);
      if (a.alert) expect(ev.alerts.some((x) => x.code === a.alert)).toBe(true);
    });
  }
});
