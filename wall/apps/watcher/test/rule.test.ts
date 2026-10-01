// Unit tests of rule R v4.3, sections 6.1 to 6.5, on synthetic logs (BUILD-SPEC 12.5's unit list).
import { describe, expect, test } from "bun:test";
import { Kind } from "@agate/report/types";
import { RuleContext } from "../src/rule/context.ts";
import { evaluate } from "../src/rule/decide.ts";
import { SlotEvidence } from "../src/rule/evidence.ts";
import type { LogCell } from "../src/rule/types.ts";
import { fixOk, gate, hand, near, strict } from "../src/rule/verdicts.ts";
import { A, B, D, scen, slotLog, steady, TEST, writer, type Geo } from "./helpers.ts";

const geo = { slices: 12, epochDay: 0, minReadings: 6, gap: 1 };
const ev = (cells: LogCell[], k0 = D * 12) => new SlotEvidence(geo, { k0, cells });
const day = (f: (h: number) => LogCell): LogCell[] => Array.from({ length: 12 }, (_, h) => f(h));
const pad = (inner: LogCell[], before: LogCell = 3_400_000, after: LogCell = 3_400_000) => [...Array(12).fill(before), ...inner, ...Array(12).fill(after)];
const ev3 = (inner: LogCell[], before: LogCell = 3_400_000, after: LogCell = 3_400_000) => ev(pad(inner, before, after), (D - 1) * 12);

describe("6.1 states", () => {
  test("isolated FAILED is UNK, a run of FAILED is DARK, NO_ROW and BAD_VALUE are DARK, MISSED is UNK", () => {
    const e = ev(["FAILED", 3_400_000, "FAILED", "FAILED", "NO_ROW", "BAD_VALUE", "NOT_RENTABLE", "MISSED"]);
    const k = D * 12;
    expect(e.R(k).s).toBe("UNK");
    expect(e.R(k + 2).s).toBe("DARK");
    expect(e.R(k + 3).s).toBe("DARK");
    expect(e.R(k + 4).s).toBe("DARK");
    expect(e.R(k + 5).s).toBe("DARK");
    expect(e.R(k + 6).s).toBe("NR");
    expect(e.R(k + 7).s).toBe("UNK");
    expect(e.R(k + 99).s).toBe("UNK");
    expect(e.pageRead(k + 4)).toBe(true);
    expect(e.pageRead(k + 2)).toBe(false);
  });
});

describe("6.2 side, span and the day class", () => {
  test("UNK widens a span to the nearest V within GAP; beyond GAP it is UNKNOWN", () => {
    const e = ev3(day((h) => (h === 5 ? "MISSED" : h < 5 ? 3_400_000 : 3_600_000)));
    expect(e.span(D, 5)).toEqual({ t: "int", lo: 3_400_000, hi: 3_600_000 });
    // side() looks at its own interval plus GAP more: a run of five unknowns leaves the middle span UNKNOWN
    const e2 = ev3(day((h) => (h >= 3 && h <= 7 ? "MISSED" : 3_400_000)));
    expect(e2.span(D, 5).t).toBe("unknown");
    expect(e2.span(D, 2).t).toBe("unknown"); // a V slice whose side walk meets only UNK is UNKNOWN too
    expect(e2.span(D, 1)).toEqual({ t: "int", lo: 3_400_000, hi: 3_400_000 });
  });
  test("observed darkness beyond the walk contributes nothing; a dark slice next to dark is EMPTY", () => {
    const e = ev3(day((h) => (h >= 6 ? "NOT_RENTABLE" : 3_400_000)));
    expect(e.span(D, 6)).toEqual({ t: "int", lo: 3_400_000, hi: 3_400_000 });
    expect(e.span(D, 8)).toEqual({ t: "empty" });
    expect(e.dayClass(D)).toBe("FRESH");
  });
  test("the class at the 6-of-12 line", () => {
    expect(ev3(day((h) => (h < 6 ? 3_400_000 : "NO_ROW")), 3_400_000, "NO_ROW").dayClass(D)).toBe("FRESH");
    // n_hi counts the slice after the last V too (its neighbour is not dark): 5 V slices give n_hi 6, UNKNOWN
    expect(ev3(day((h) => (h < 5 ? 3_400_000 : "NO_ROW")), 3_400_000, "NO_ROW").dayClass(D)).toBe("UNKNOWN");
    expect(ev3(day((h) => (h < 4 ? 3_400_000 : "NO_ROW")), 3_400_000, "NO_ROW").dayClass(D)).toBe("NOT_FRESH");
    expect(ev3(day((h) => (h < 5 ? 3_400_000 : h < 7 ? "MISSED" : "NO_ROW")), 3_400_000, "NO_ROW").dayClass(D)).toBe("UNKNOWN");
  });
  test("PRODUCTION GAP 3 walks three intervals", () => {
    const g24 = { slices: 24, epochDay: 0, minReadings: 12, gap: 3 };
    const cells: LogCell[] = Array(72).fill(3_800_000);
    for (let j = 24 + 10; j < 24 + 13; j++) cells[j] = "MISSED";
    cells[24 + 13] = 4_400_000;
    const e = new SlotEvidence(g24, { k0: (D - 1) * 24, cells });
    expect(e.span(D, 11)).toEqual({ t: "int", lo: 3_800_000, hi: 4_400_000 });
  });
});

describe("HF-1 widened complete range (BUILD-SPEC 12.5: 4.03 to 4.10)", () => {
  test("slot 4 3.80 -> 4.40 at 12:30, one watcher timeout at 13:25; writers at :10 (4.08) and :40 (4.10) inside", () => {
    const g24 = { slices: 24, epochDay: 0, minReadings: 12, gap: 3 };
    const cells: LogCell[] = [];
    for (let h = 0; h < 72; h++) {
      const hh = h - 24;
      if (hh === 13) cells.push("FAILED");
      else cells.push(hh < 12 || (hh === 12 && true) ? (hh < 0 ? 3_800_000 : 3_800_000) : 4_400_000);
    }
    // the watcher read slice 12 at 12:20 (before the change): 3.80
    for (let h = 48; h < 72; h++) cells[h] = 4_400_000;
    const e = new SlotEvidence(g24, { k0: (D - 1) * 24, cells });
    expect(e.completeRange(D)).toEqual({ t: "int", lo: 4_030_000, hi: 4_100_000 });
  });
});

describe("6.2 writer, partial, VETO ranges and the dark count", () => {
  test("writer range over the writer's slices; FAIL when a valid reading sits in an EMPTY slice", () => {
    const e = ev3(day((h) => (h < 6 ? 3_400_000 : "NO_ROW")), 3_400_000, "NO_ROW");
    expect(e.writerRange(D, 0b11111)).toEqual({ t: "int", lo: 3_400_000, hi: 3_400_000 });
    expect(e.writerRange(D, 0b11111 + 2 ** 9)).toEqual({ t: "fail" });
    // LV-1: slice 5 is V next to a dark run with no V logged beyond it: the page may have been repriced and then
    // gone dark inside that interval, so its span (and any range over it) is UNKNOWN
    expect(e.writerRange(D, 0b111111)).toEqual({ t: "unknown" });
  });
  test("LV-1 dark edge: a V slice next to observed darkness reaches the nearest V beyond the dark run", () => {
    // sold out slices 0 to 4, back in stock at 3.40 then repriced to 4.40 inside interval 5: the watcher saw 4.40
    const left = ev3(day((h) => (h < 5 ? "NOT_RENTABLE" : 4_400_000)), 3_400_000, 4_400_000);
    expect(left.span(D, 5)).toEqual({ t: "int", lo: 3_400_000, hi: 4_400_000 });
    // the mirror: repriced then sold out inside interval 6, dark to the end of D, back at 4.40 the next day
    const right = ev3(day((h) => (h <= 6 ? 3_400_000 : "NOT_RENTABLE")), 3_400_000, 4_400_000);
    expect(right.span(D, 6)).toEqual({ t: "int", lo: 3_400_000, hi: 4_400_000 });
    // a dark slice keeps the plain rule (no V of its own): EMPTY between dark neighbours
    expect(right.span(D, 9)).toEqual({ t: "empty" });
    // an UNK before the next V: UNKNOWN
    const unk = ev3(day((h) => (h <= 6 ? 3_400_000 : h < 11 ? "NOT_RENTABLE" : "MISSED")), 3_400_000, 4_400_000);
    expect(unk.span(D, 6).t).toBe("unknown");
  });
  test("partial range: closed, open, empty", () => {
    const closed = ev3(day((h) => (h < 3 ? 3_400_000 : h < 9 ? "MISSED" : 3_600_000)));
    const p = closed.partialRange(D, null);
    expect(p).toMatchObject({ t: "int", lo: 3_400_000, hi: 3_600_000, open: false });
    const open = ev(day(() => "MISSED"));
    expect(open.partialRange(D, null)).toEqual({ t: "unknown" });
    // LV-1: a and b are the nearest V states; a page dark as far as the log goes leaves the range open, no values
    const dark = ev3(day(() => "NO_ROW"), "NO_ROW", "NO_ROW");
    expect(dark.partialRange(D, null)).toEqual({ t: "unknown" });
    const darkDay = ev3(day(() => "NO_ROW"), 3_400_000, 3_600_000);
    expect(darkDay.partialRange(D, null)).toMatchObject({ t: "int", lo: 3_400_000, hi: 3_600_000, open: false });
    // looks fill UNK intervals
    const withLook = new SlotEvidence(geo, { k0: D * 12, cells: day(() => "MISSED") }, [{ slot: 0, interval: D * 12 + 3, at: 0, cell: 3_500_000, region: "x", writerRegion: true }]);
    expect(withLook.partialRange(D, null)).toMatchObject({ t: "int", lo: 3_500_000, hi: 3_500_000 });
  });
  test("VETO range: any value next to a non-V state; else the averaged min3 and max3", () => {
    const e = ev3(day((h) => (h === 4 ? "MISSED" : 3_400_000)));
    expect(e.vetoRange(D, 2 ** 4)).toEqual({ t: "any" });
    expect(e.vetoRange(D, 2 ** 8 + 2 ** 9)).toEqual({ t: "int", lo: 3_400_000, hi: 3_400_000 });
    const d2 = ev3(day((h) => (h >= 4 && h <= 8 ? "NO_ROW" : 3_400_000)));
    expect(d2.darkSlices(D, 0b111111111111)).toEqual([5, 6, 7]);
  });
});

function honest(g: Geo, base: number[], skip: number[] = [], over: (h: number, i: number, v: number) => number = (_h, _i, v) => v) {
  return (h: number, i: number) => (skip.includes(h) ? 0 : over(h, i, base[i]!));
}

const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const flatLog = (base: number[]) => base.map((v) => slotLog(TEST, D - 1, D + 1, () => v));

describe("6.3 to 6.5 verdicts and R1", () => {
  test("an honest complete writer is STRICT and an unchanged record is left to become final", () => {
    const sc = scen({ log: flatLog(BASE), pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, BASE)), writer(TEST, B, 1, honest(TEST, BASE))], pendingNeedsSign: false });
    const out = evaluate(sc);
    expect(out.candidates.map((c) => c.tier)).toEqual([3, 3]);
    expect(out.action.kind).toBe("none");
    const signed = evaluate(scen({ log: flatLog(BASE), pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, BASE))], pendingNeedsSign: true }));
    expect(signed.action).toMatchObject({ kind: "attest", writer: A });
    expect(out.W).toBe(3_400_000);
  });

  test("a thief's freeze through a step is replaced by the STRICT standby (select)", () => {
    const now = BASE.map((v, i) => (i === 2 ? 3_900_000 : v));
    const sc = scen({
      log: [0, 1, 2, 3, 4].map((i) => slotLog(TEST, D - 1, D + 1, (d) => (d >= D ? now[i]! : BASE[i]!))),
      pre: steady(BASE),
      writers: [writer(TEST, A, 0, honest(TEST, BASE)), writer(TEST, B, 1, honest(TEST, now))],
      pendingNeedsSign: false,
    });
    const out = evaluate(sc);
    expect(out.candidates[0]!.tier).toBe(0);
    expect(out.candidates[1]!.tier).toBe(3);
    expect(out.action).toMatchObject({ kind: "select", writer: B });
    expect(out.alerts.some((a) => a.code === "R9_UNCHANGED_NOT_STRICT" && a.severity === "info")).toBe(true);
  });

  test("a changed record with no signable candidate raises R1_NO_CANDIDATE", () => {
    const thief = BASE.map((v, i) => (i === 2 ? 4_500_000 : v));
    const sc = scen({ log: flatLog(BASE), pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, thief))] });
    const out = evaluate(sc);
    expect(out.action.kind).toBe("none");
    expect(out.alerts.some((a) => a.code === "R1_NO_CANDIDATE")).toBe(true);
    expect(out.guardian.veto?.writer).toBe(A);
  });

  test("FIX-OK countersigns an incomplete pending record; the attester never selects an incomplete one", () => {
    const moved = BASE.map((v) => v + 600_000);
    const log = moved.map((v) => slotLog(TEST, D - 1, D + 1, (d) => (d >= D ? v : v - 600_000)));
    const sc = scen({ log, pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, moved), { skip: [7] }), writer(TEST, B, 1, honest(TEST, moved), { skip: [3] })] });
    const ctx = new RuleContext(sc);
    expect(strict(ctx, sc.pending!).ok).toBe(false);
    expect(fixOk(ctx, sc.pending!, true).ok).toBe(true);
    expect(fixOk(ctx, sc.candidates[0]!, false).ok).toBe(false);
    expect(evaluate(sc).action).toMatchObject({ kind: "attest", writer: A });
  });

  test("expected kinds come from the onchain pre-state (D1), expF and expN for class UNKNOWN", () => {
    const pre = steady(BASE);
    pre[4] = { e: 3_800_000, miss: 5, inMedian: true, wasIn: true };
    const log = BASE.map((v, i) => slotLog(TEST, D - 1, D + 1, (d, h) => (i === 4 ? (d === D && h < 5 ? v : d === D && h < 7 ? "MISSED" : "NO_ROW") : v)));
    const sc = scen({ log, pre, writers: [writer(TEST, A, 0, honest(TEST, BASE, [], (h, i, v) => (i === 4 && h >= 5 ? 0 : v)))] });
    const ctx = new RuleContext(sc);
    expect(ctx.cls(4)).toBe("UNKNOWN");
    expect(ctx.expected(4)).toEqual({ exp: Kind.FRESH, expAlt: Kind.OUT });
  });

  test("D6: two STRICT records that differ: the one nearer W(d) is selected", () => {
    // slot 2 (the median) steps mid-day; the watcher saw 3.40 before slice 6 and 4.00 after; A read the step one
    // slice late (3.65), B on time (3.70) = W(d)
    const base = [3_000_000, 3_200_000, 3_400_000, 4_600_000, 4_800_000];
    const log = base.map((v, i) => slotLog(TEST, D - 1, D + 1, (d, h) => (i === 2 && (d > D || (d === D && h >= 6)) ? 4_000_000 : v)));
    const a = writer(TEST, A, 0, honest(TEST, base, [], (h, i, v) => (i === 2 ? (h >= 7 ? 4_000_000 : 3_400_000) : v)));
    const b = writer(TEST, B, 1, honest(TEST, base, [], (h, i, v) => (i === 2 ? (h >= 6 ? 4_000_000 : 3_400_000) : v)));
    const sc = scen({ log, pre: steady(base), writers: [a, b], pendingNeedsSign: false });
    const out = evaluate(sc);
    expect(out.candidates.map((c) => c.tier)).toEqual([3, 3]);
    expect(out.candidates.map((c) => c.value)).toEqual([3_650_000, 3_700_000]);
    expect(out.W).toBe(3_700_000);
    expect(out.action).toMatchObject({ kind: "select", writer: B });
  });

  test("R1b (b): a lone typed FRESH on a blind slot never gates the honest record", () => {
    // slot 3 fails for the watcher all day (blind); the thief types it FRESH at 3.45 (no other writer agrees)
    const log = BASE.map((v, i) => slotLog(TEST, D - 1, D + 1, (d) => (i === 3 && d === D ? "FAILED" : v)));
    const thief = writer(TEST, A, 0, honest(TEST, BASE, [], (_h, i, v) => (i === 3 ? 3_450_000 : v)));
    const standby = writer(TEST, B, 1, honest(TEST, BASE, [], (_h, i, v) => (i === 3 ? 0 : v)));
    const pre = steady(BASE);
    const sc = scen({ log, pre, writers: [thief, standby], pendingNeedsSign: false });
    const ctx = new RuleContext(sc);
    expect(ctx.blind(3)).toBe(true);
    expect(gate(ctx, sc.candidates[0]!, [sc.pending!, sc.candidates[0]!]).ok).toBe(true);
    const out = evaluate(sc);
    expect(out.alerts.some((a) => a.code === "R9B_BLIND_SLOT_SPLIT")).toBe(true);
  });

  test("hand ranges: R11 judges at the candidate's own membership; R12 relaxes a held slot to its onchain value", () => {
    const pre = steady(BASE);
    pre[1] = { e: 3_100_000, miss: 1, inMedian: true, wasIn: true };
    // slot 1 dark for the writers (a writer-side block) while the watcher reads 3.20 all day
    const log = flatLog(BASE);
    const w = writer(TEST, A, 0, honest(TEST, BASE, [], (_h, i, v) => (i === 1 ? 0 : v)));
    const sc = scen({ log, pre, writers: [w], pendingNeedsSign: true });
    sc.looks = [{ slot: 1, interval: (D + 1) * 12 + 1, at: (D + 1) * 2400 + 300, cell: "FAILED", region: "writer", writerRegion: true }];
    const ctx = new RuleContext(sc);
    expect(hand(ctx, sc.pending!, false).slots[1]!.range).toEqual({ t: "int", lo: 3_200_000, hi: 3_200_000 });
    const r12 = hand(ctx, sc.pending!, true);
    expect(r12.slots[1]!.range).toEqual({ t: "int", lo: 3_100_000, hi: 3_200_000, open: false });
    expect(r12.ok).toBe(true);
  });

  test("NEAR: one unverifiable family is taken at any value; two are not", () => {
    const log = BASE.map((v, i) => slotLog(TEST, D - 1, D + 1, (d) => (i >= 3 && d >= D ? "MISSED" : d > D ? "MISSED" : v)));
    const w = writer(TEST, A, 0, honest(TEST, BASE.map((v, i) => (i === 4 ? 5_000_000 : v))));
    const sc = scen({ log, pre: steady(BASE), writers: [w] });
    const ctx = new RuleContext(sc);
    expect(near(ctx, sc.pending!).ok).toBe(false); // slots 3 and 4: two families unverifiable
    const log2 = BASE.map((v, i) => slotLog(TEST, D - 1, D + 1, (d) => (i === 4 && d >= D ? "MISSED" : d > D ? "MISSED" : v)));
    const sc2 = scen({ log: log2, pre: steady(BASE), writers: [w] });
    expect(near(new RuleContext(sc2), sc2.pending!).ok).toBe(true);
  });

  test("I30: making one slot's evidence UNKNOWN never changes another slot's check", () => {
    const w = writer(TEST, A, 0, honest(TEST, BASE));
    const sc1 = scen({ log: flatLog(BASE), pre: steady(BASE), writers: [w] });
    const log2 = flatLog(BASE);
    log2[1] = slotLog(TEST, D - 1, D + 1, () => "MISSED");
    const sc2 = scen({ log: log2, pre: steady(BASE), writers: [w] });
    const s1 = strict(new RuleContext(sc1), sc1.pending!).slots;
    const s2 = strict(new RuleContext(sc2), sc2.pending!).slots;
    for (const i of [0, 2, 3, 4]) expect(s2[i]).toEqual(s1[i]!);
  });

  test("remembered range: vouched anchor gives [e, e]; a planted anchor outside its day's range gives the mismatch range", () => {
    const pre = steady(BASE);
    pre[0] = { e: 4_500_000, miss: 1, inMedian: true, wasIn: true };
    const log = BASE.map((v) => slotLog(TEST, D - 2, D + 1, () => v));
    log[0] = slotLog(TEST, D - 2, D + 1, (d) => (d >= D ? "NO_ROW" : 3_000_000));
    const plant = writer(TEST, A, 0, (_h, i) => (i === 0 ? 4_500_000 : BASE[i]!));
    const hist = [{ day: D - 1, carried: false, source: A, value: 3_400_000, p: [4_500_000, ...BASE.slice(1)], kinds: [1, 1, 1, 1, 1] as Kind[], counts: [12, 12, 12, 12, 12], post: steady([4_500_000, ...BASE.slice(1)]), writers: [plant] }];
    const w = writer(TEST, A, 0, honest(TEST, BASE, [], (_h, i, v) => (i === 0 ? 0 : v)));
    const sc = scen({ log, pre, writers: [w], history: hist });
    const ctx = new RuleContext(sc);
    const rem = ctx.remembered(0);
    expect(rem.mismatch).toBe(true);
    expect(rem.range).toEqual({ t: "int", lo: 3_000_000, hi: 3_000_000 });
    expect(evaluate(sc).alerts.some((a) => a.code === "R9_HELD_MISMATCH")).toBe(true);
  });

  test("the formula self-check refuses a candidate whose digest does not match its readings", () => {
    const sc = scen({ log: flatLog(BASE), pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, BASE))] });
    sc.pending!.digest = `0x${"ab".repeat(32)}`;
    const out = evaluate(sc);
    expect(out.action.kind).toBe("none");
    expect(out.action.why).toContain("formula mismatch");
  });

  test("a malformed scenario throws instead of deciding", () => {
    const sc = scen({ log: flatLog(BASE), pre: steady(BASE), writers: [writer(TEST, A, 0, honest(TEST, BASE))] });
    sc.pre = sc.pre.slice(1);
    expect(() => evaluate(sc)).toThrow();
  });
});
