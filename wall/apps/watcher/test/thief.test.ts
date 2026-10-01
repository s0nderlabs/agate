// BUILD-SPEC 12.6: the thief round on v4.2 (T1 to T8) and the F findings, ported from thief_v42.py's scenarios
// (A, A2, A2demo, B, C, D, E, F, G) with v4.3's pass conditions. Profile TEST unless stated.
import { describe, expect, test } from "bun:test";
import { AlertCode } from "@agate/report/types";
import { cent, median } from "../src/formula.ts";
import { GUARDIAN, Pages, W_ADDR, World, type WorldOptions } from "../src/sim/world.ts";

const OCT1 = 20_727;
const NOV1 = 20_758;
const T = 2_400;
const SL = 200;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const ds = (d: number) => d * T;
const ss = (d: number, h: number) => d * T + h * SL;
const med = (xs: number[]) => cent(median(xs));
const ZERO = "0x0000000000000000000000000000000000000000";
const GUARD = { delay: SL, looks: true };

function world(o: Partial<WorldOptions> & Pick<WorldOptions, "pages">): World {
  return new World({ firstDay: OCT1, writers: [{ net: "w1" }, { net: "w2" }], guardian: null, ...o });
}
function wrong(w: World, from: number, to: number, truth: (d: number) => number): string[] {
  return w.days(from, to).filter((r) => r.final && !r.carried && r.value !== truth(r.day)).map((r) => `${r.day - OCT1}: ${r.value} vs ${truth(r.day)}`);
}
function allFinal(w: World, from: number, to: number): boolean {
  return w.days(from, to).every((r) => r.final);
}
function l1(w: World, from: number, to: number): string[] {
  return w.days(from, to).filter((r) => !r.final || r.lag > w.c.lagMax).map((r) => `${r.day - OCT1}: final ${r.final} lag ${r.lag}`);
}
const rec = (w: World, d: number) => w.m.g(w.panel.gpuId).records.get(d)!;

describe("T1 (A): a page dark mid-day then gone", () => {
  const D = OCT1 + 3;
  const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(D + 8), v: b + 600_000 })), [{ slot: 4, from: ss(D, 5) + 5, to: ds(D + 30), state: "NR" }]);
  const truth = (d: number) => {
    const live = BASE.map((b) => b + (d >= D + 8 ? 600_000 : 0));
    return med(d >= D + 5 ? live.slice(0, 4) : live);
  };
  test("class UNKNOWN on D; D..D+4 held; the exit on D+5 signed by the attester; 0 drops; follows the move; nobody acting", async () => {
    const w = world({ pages: pages.fn });
    await w.run(ds(D + 14));
    const ev = w.evaluations.find((e) => e.ev.day === D);
    expect(ev?.ev.slots[4]!.cls).toBe("UNKNOWN");
    expect(wrong(w, OCT1, D + 11, truth)).toEqual([]);
    expect(allFinal(w, OCT1, D + 11)).toBe(true);
    expect(w.drops()).toEqual([]);
    expect(rec(w, D + 5).attestedBy).toBe(w.m.attester);
    expect(l1(w, OCT1, D + 11)).toEqual([]);
  });
});

describe("T1 (A2): a watcher gap of 7 of 12 slices during an existing dark spell", () => {
  const U = OCT1 + 12;
  const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(U + 2), v: b + 600_000 })), [{ slot: 4, from: ds(OCT1 + 2), to: ds(OCT1 + 99), state: "DARK" }]);
  const truth = (d: number) => (d < OCT1 + 7 ? 3_400_000 : med(BASE.slice(0, 4).map((b) => b + (d >= U + 2 ? 600_000 : 0))));
  test("TEST: the gap day STRICT or signed, no later day refused, 0 drops, nobody acting", async () => {
    const kU = U * 12;
    const w = world({ pages: pages.fn, watcherMissed: (k) => k >= kU && k < kU + 7 });
    await w.run(ds(U + 10));
    expect(wrong(w, OCT1, U + 8, truth)).toEqual([]);
    expect(allFinal(w, OCT1, U + 8)).toBe(true);
    expect(w.drops()).toEqual([]);
    expect(l1(w, OCT1, U + 8)).toEqual([]);
  });
  test("DEMO (A2demo): a 7.5-minute watcher gap; L1 with the scripted guardian", async () => {
    const P = { day: 600, slices: 4, qMin: 1 };
    const pagesD = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: (U + 2) * 600, v: b + 600_000 })), [{ slot: 4, from: (OCT1 + 2) * 600, to: (OCT1 + 99) * 600, state: "DARK" }]);
    const kU = U * 4;
    const w = world({ profile: P, pages: pagesD.fn, watcherMissed: (k) => k >= kU && k < kU + 3, guardian: { delay: 75, looks: true }, step: 5 });
    await w.run((U + 12) * 600);
    const days = w.days(OCT1, U + 9);
    expect(days.filter((r) => !r.final)).toEqual([]);
    expect(w.drops()).toEqual([]);
    expect(Math.max(...days.map((r) => r.lag))).toBeLessThanOrEqual(w.c.lagMax);
    expect(days.filter((r) => !r.carried && r.value !== truth(r.day)).map((r) => r.day)).toEqual([]);
  });
});

describe("T2 (G): both writers blocked from a slot one day before its page dies", () => {
  test("X FIX-OK; R9_MISS_MISMATCH from X+1; the exit on X+5 STRICT and signed; follows the move; 0 drops", async () => {
    const X = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(X + 9), v: b + 600_000 })), [
      { slot: 3, from: ds(X + 1), to: ds(X + 60), state: "DARK" },
      { slot: 3, from: ds(X), to: ds(X + 1), state: "FAIL", nets: ["w1", "w2"] },
    ]);
    const w = world({ pages: pages.fn });
    await w.run(ds(X + 14));
    const evX = w.evaluations.filter((e) => e.ev.day === X).at(-1)!.ev;
    expect(evX.candidates[0]!.tier).toBe(2);
    expect(w.raised(AlertCode.R9_MISS_MISMATCH, X + 1)).toBe(true);
    expect(rec(w, X + 5).changed).toBe(true);
    expect(rec(w, X + 5).attestedBy).toBe(w.m.attester);
    const truth = (d: number) => {
      const live = BASE.map((b) => b + (d >= X + 9 ? 600_000 : 0));
      return med(d >= X + 5 ? [live[0]!, live[1]!, live[2]!, live[4]!] : live);
    };
    expect(wrong(w, OCT1, X + 12, truth)).toEqual([]);
    expect(w.drops()).toEqual([]);
  });
});

describe("T3 (D): the queued-slot plant", () => {
  const start = NOV1 - 8;
  const base = [3_000_000, 3_200_000, 3_600_000, 3_800_000, 3_400_000];
  const plant = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 4 && d < NOV1 && x ? 4_500_000 : x));
  const mk = (o: { standby: boolean; block: "w2" | "all" | null; guardian?: boolean }) => {
    // the guardian of the no-standby case starts on Nov 1: nobody acted on the shadow days (residual 1's premise)
    const out = o.block ? [{ slot: 4, from: ds(NOV1), to: ds(NOV1 + 1), state: "DARK" as const, ...(o.block === "w2" ? { nets: ["w2"] } : {}) }] : [];
    const pages = new Pages(base, [], out);
    return world({
      firstDay: start,
      pages: pages.fn,
      liveMask: 0b01111,
      windows: [{ slot: 4, liveFrom: NOV1 }],
      writers: o.standby ? [{ net: "w1", values: plant }, { net: "w2" }] : [{ net: "w1", values: plant }],
      guardian: o.guardian ? { ...GUARD, from: ds(NOV1) } : null,
    });
  };
  test("honest standby: no shadow day STRICT for the thief, the standby selected, slot 4 enters at 3.40", async () => {
    for (const block of [null, "w2", "all"] as const) {
      const w = mk({ standby: true, block });
      await w.run(ds(NOV1 + 6));
      for (let d = NOV1 - 5; d < NOV1; d++) {
        const ev = w.evaluations.filter((e) => e.ev.day === d).at(-1)!.ev;
        expect([block, d, ev.candidates.find((c) => c.source === W_ADDR[0])!.strict.ok]).toEqual([block, d, false]);
        expect(rec(w, d).source).toBe(W_ADDR[1]!);
      }
      expect(rec(w, NOV1 - 1).post[4]!.e).toBe(3_400_000);
      expect(allFinal(w, start, NOV1 + 4)).toBe(true);
      expect(wrong(w, start, NOV1 + 4, (d) => (d >= NOV1 ? med(base) : med(base.slice(0, 4))))).toEqual([]);
    }
  });
  test("no standby: the plant lands (residual 1), R9_HELD_MISMATCH on Nov 1, R12 signs within GUARD_ACT; nobody acting ends within HOLD_DAYS drops", async () => {
    const w = mk({ standby: false, block: "all", guardian: true });
    await w.run(ds(NOV1 + 6));
    expect(rec(w, NOV1 - 1).post[4]!.e).toBe(4_500_000);
    expect(w.raised(AlertCode.R9_HELD_MISMATCH, NOV1)).toBe(true);
    const r = rec(w, NOV1);
    expect(r.attestedBy).toBe(GUARDIAN);
    expect(w.guardianActs.some((a) => a.day === NOV1 && a.act === "R12 signed")).toBe(true);
    expect(l1(w, start, NOV1 + 4)).toEqual([]);
    const nobody = mk({ standby: false, block: "all" });
    await nobody.run(ds(NOV1 + 40));
    expect(nobody.l1b().why).toEqual([]);
    expect(nobody.drops().length).toBeLessThanOrEqual(5);
    expect(allFinal(nobody, start, NOV1 + 20)).toBe(true);
  });
});

describe("T4", () => {
  test("B: a frozen median on a day with an unclassifiable slot: the honest standby STRICT and selected", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }], [{ slot: 4, from: ss(D, 5) + 5, to: ds(D + 1), state: "NR" }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D && x ? BASE[2]! : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: freeze }, { net: "w2" }] });
    await w.run(ds(D + 4));
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    expect(wrong(w, OCT1, D + 2, (d) => (d >= D ? 3_600_000 : 3_400_000))).toEqual([]);
  });

  test("E: a stolen standby while the honest primary misses one slice: the primary is the source and signed", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? BASE[2]! : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", skip: (d, h) => d === D && h === 7 }, { net: "w2", values: freeze, close: "earliest" }] });
    await w.run(ds(D + 4));
    expect(rec(w, D).source).toBe(W_ADDR[0]!);
    expect(w.m.isFinal(rec(w, D), w.now)).toBe(true);
    expect(wrong(w, OCT1, D + 2, (d) => (d >= D ? 3_600_000 : 3_400_000))).toEqual([]);
  });

  test("E variant: the primary below quorum: the thief's record needsSign, never signed (not by R12 either)", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }], [0, 1, 2, 3, 4].map((i) => ({ slot: i, from: ss(D, 1), to: ds(D + 1), state: "FAIL" as const, nets: ["w1"] })));
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? BASE[2]! : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1" }, { net: "w2", values: freeze, close: "earliest" }], guardian: GUARD });
    await w.run(ds(D + 4));
    const closed = w.m.events.find((e) => e.name === "DayClosed" && e.day === D);
    expect(closed?.args.source).toBe(W_ADDR[1]!);
    expect(closed?.args.needsSign).toBe(true);
    const r = rec(w, D);
    expect(r.source === W_ADDR[1]! && r.attestedAt !== 0).toBe(false);
    expect(w.guardianActs.filter((a) => a.day === D && a.act.startsWith("R12 signed") && a.writer === W_ADDR[1]!)).toEqual([]);
  });

  test("F: a lone typed FRESH on a page failing for the watcher and the standby: the standby is not gated and is selected; R9B", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }], [{ slot: 3, from: ds(D), to: ds(D + 1), state: "FAIL", nets: ["watch", "w2"] }]);
    const thief = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (d !== D ? x : i === 2 ? BASE[2]! : i === 3 ? 3_450_000 : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: thief }, { net: "w2" }] });
    await w.run(ds(D + 4));
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    expect(w.raised(AlertCode.R9B_BLIND_SLOT_SPLIT, D)).toBe(true);
    expect(wrong(w, OCT1, D + 2, (d) => (d >= D ? 3_600_000 : 3_400_000))).toEqual([]);
  });
});

describe("T5 (C): shading inside the complete range", () => {
  test("a typed value outside the range is always replaced; inside, the thief wins only when nearer W(d) (residual 11)", async () => {
    const D = OCT1 + 3;
    const ts = ss(D, 6) + SL / 2;
    const fails = [{ slot: 2, from: ss(D, 5), to: ss(D, 6), state: "FAIL" as const, nets: ["watch"] }, { slot: 2, from: ss(D, 7), to: ss(D, 8), state: "FAIL" as const, nets: ["watch"] }];
    let replaced = 0;
    let outside = 0;
    const thiefWins: number[] = [];
    for (let target = 3_400_000; target <= 4_000_000; target += 50_000) {
      const pages = new Pages(BASE, [{ slot: 2, at: ts, v: 4_000_000 }], fails);
      const typed = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? target : x));
      const w = world({ pages: pages.fn, writers: [{ net: "w1", values: typed }, { net: "w2" }] });
      await w.run(ds(D + 2));
      const ev = w.evaluations.filter((e) => e.ev.day === D).at(-1)!.ev;
      const thief = ev.candidates[0]!;
      const sb = ev.candidates[1]!;
      const r = rec(w, D);
      const inside = thief.strict.ok;
      if (!inside) {
        outside++;
        if (r.source === W_ADDR[1]) replaced++;
      } else if (r.source === W_ADDR[0]) {
        thiefWins.push(target);
        // residual 11: only when at least as near W(d) as the standby (ties go to r)
        expect(thief.dist).toBeLessThanOrEqual(sb.dist);
      }
    }
    expect(replaced).toBe(outside);
    expect(outside).toBeGreaterThan(0);
  });
});

describe("T6: hand signatures with the attester off", () => {
  test("A with the scripted guardian: the exit signed by hand at its own membership; nothing dropped", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(D + 8), v: b + 600_000 })), [{ slot: 4, from: ss(D, 5) + 5, to: ds(D + 30), state: "NR" }]);
    const w = world({ pages: pages.fn, attester: { down: () => true }, guardian: GUARD });
    await w.run(ds(D + 12));
    expect(w.drops()).toEqual([]);
    expect(rec(w, D + 5).attestedBy).toBe(GUARDIAN);
    expect(allFinal(w, OCT1, D + 10)).toBe(true);
    expect(l1(w, OCT1, D + 10)).toEqual([]);
  });
  test("G with the scripted guardian: the early exit signed by hand", async () => {
    const X = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(X + 9), v: b + 600_000 })), [
      { slot: 3, from: ds(X + 1), to: ds(X + 60), state: "DARK" },
      { slot: 3, from: ds(X), to: ds(X + 1), state: "FAIL", nets: ["w1", "w2"] },
    ]);
    const w = world({ pages: pages.fn, attester: { down: () => true }, guardian: GUARD });
    await w.run(ds(X + 12));
    expect(rec(w, X + 5).attestedBy).toBe(GUARDIAN);
    expect(w.drops()).toEqual([]);
    expect(l1(w, OCT1, X + 10)).toEqual([]);
  });
  test("B with a thief primary: no freeze through a step is signed by hand; the standby is selected", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }], [{ slot: 4, from: ss(D, 5) + 5, to: ds(D + 1), state: "NR" }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D && x ? BASE[2]! : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: freeze }, { net: "w2" }], attester: { down: () => true }, guardian: GUARD });
    await w.run(ds(D + 4));
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    expect(rec(w, D).value).toBe(3_600_000);
  });
});

describe("T7 and T8", () => {
  test("T7: the day after a full-day watcher outage is STRICT", async () => {
    const U = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(U + 1), v: b + 300_000 })));
    const w = world({ pages: pages.fn, watcherMissed: (k) => k >= U * 12 && k < (U + 1) * 12 });
    await w.run(ds(U + 4));
    const ev = w.evaluations.filter((e) => e.ev.day === U + 1).at(-1)!.ev;
    expect(ev.candidates[0]!.tier).toBe(3);
    expect(rec(w, U + 1).attestedBy).toBe(w.m.attester);
  });

  test("T8 DEMO: the thief closes at the first legal second with a freeze; the select lands at least 60 s before finality", async () => {
    const P = { day: 600, slices: 4, qMin: 1 };
    const D = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: D * 600, v: b + 600_000 })));
    const freeze = (_d: number, _h: number, _t: number, _v: number[]) => [...BASE];
    const w = world({ profile: P, pages: pages.fn, writers: [{ net: "w1", values: freeze, close: "earliest" }, { net: "w2" }], watcherOffset: (_i, k) => (k === (D + 1) * 4 + 1 ? 149 : undefined), step: 1 });
    await w.run((D + 3) * 600);
    const replaced = w.m.events.find((e) => e.name === "RecordReplaced" && e.day === D);
    const closed = w.m.events.find((e) => e.name === "DayClosed" && e.day === D)!;
    expect(replaced).toBeDefined();
    expect(closed.at + w.c.tPend - replaced!.at).toBeGreaterThanOrEqual(60);
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    expect(w.m.isFinal(rec(w, D), w.now)).toBe(true);
  });

  test("T8 FAST (signAll): a freeze is never final without a signature", async () => {
    const P = { day: 24, slices: 2, qMin: 1, signAll: true };
    const D = OCT1 + 3;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: D * 24, v: b + 600_000 })));
    const freeze = (_d: number, _h: number, _t: number, _v: number[]) => [...BASE];
    const w = world({ profile: P, pages: pages.fn, writers: [{ net: "w1", values: freeze, close: "earliest" }, { net: "w2" }], step: 1 });
    await w.run((D + 8) * 24);
    for (let d = OCT1; d <= D + 5; d++) {
      const r = rec(w, d);
      if (r && !r.carried && w.m.isFinal(r, w.now)) expect(r.attestedAt).toBeGreaterThan(0);
    }
    expect(rec(w, D).value).toBe(4_000_000);
  });
});

describe("F1 to F4", () => {
  test("F1 (V1): the thief closes at the earliest second; the standby's last slice lands 5 s after midnight and is selected", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? BASE[2]! : x));
    const w = world({
      pages: pages.fn,
      writers: [{ net: "w1", values: freeze, close: "earliest" }, { net: "w2", rpcDown: (t) => t >= ss(D, 11) && t < ds(D + 1) + 5 }],
    });
    await w.run(ds(D + 1) + w.c.closeGrace - 20);
    expect(w.m.g(w.panel.gpuId).head).toBe(D);
    expect(() => w.m.closeDay(w.panel.gpuId, W_ADDR[0]!, ds(D + 1) + w.c.closeGrace - 1)).toThrow("C1_DayNotOver");
    await w.run(ds(D + 3));
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    expect(rec(w, D).incomplete).toBe(false);
  });

  test("F2 (V2): a veto that lands after the select is VetoStale; the selected record stays", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? BASE[2]! : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: freeze }, { net: "w2" }] });
    await w.run(ds(D + 1) + 600);
    const closed = w.m.events.find((e) => e.name === "DayClosed" && e.day === D)!;
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
    const g = w.chain.sender(GUARDIAN);
    const res = await g.send("veto", [w.panel.gpuId, D, closed.args.source, closed.args.digest]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("VetoStale");
    expect(rec(w, D).source).toBe(W_ADDR[1]!);
  });

  test("F3 (V3): blocked for the watcher then dark for everyone, a thief plant: not FIX-OK, R9B, the guardian keeps 0 wrong days", async () => {
    const pages = new Pages(BASE, [], [
      { slot: 0, from: ds(OCT1 + 1), to: ds(OCT1 + 3), state: "FAIL", nets: ["watch"] },
      { slot: 0, from: ds(OCT1 + 3), to: ds(OCT1 + 6), state: "DARK" },
    ]);
    const plant = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 0 && d >= OCT1 + 1 && d <= OCT1 + 2 ? 3_400_000 : x));
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: plant }, { net: "w2" }], guardian: GUARD });
    await w.run(ds(OCT1 + 10));
    for (const d of [OCT1 + 1, OCT1 + 2]) {
      const ev = w.evaluations.filter((e) => e.ev.day === d).at(-1)!.ev;
      expect(ev.candidates.find((c) => c.source === W_ADDR[0])!.fixOk.ok).toBe(false);
      expect(w.raised(AlertCode.R9B_BLIND_SLOT_SPLIT, d)).toBe(true);
      expect(rec(w, d).p[0]).toBe(3_000_000);
    }
    expect(rec(w, OCT1 + 2).post[0]!.e).toBe(3_000_000);
    expect(allFinal(w, OCT1, OCT1 + 8)).toBe(true);
    expect(wrong(w, OCT1, OCT1 + 8, () => 3_400_000)).toEqual([]);
  });

  test("F4 (V4) on PRODUCTION: an honest writer blocked on a moving slot for slices 12 to 19: FIX-OK on its own slices, signed", async () => {
    const DAY = 86_400;
    const S = 3_600;
    const DM = OCT1 + 3;
    const pages = new Pages(BASE, [...[0, 1, 2, 3].map((i) => ({ slot: i, at: DM * DAY, v: BASE[i]! + 600_000 })), { slot: 4, at: DM * DAY + 12 * S + 1_800, v: 4_400_000 }], [
      { slot: 4, from: DM * DAY + 12 * S, to: DM * DAY + 20 * S, state: "FAIL", nets: ["w1"] },
    ]);
    const w = world({ profile: { day: DAY, slices: 24 }, pages: pages.fn, writers: [{ net: "w1" }], step: 120 });
    await w.run((DM + 3) * DAY);
    const ev = w.evaluations.filter((e) => e.ev.day === DM).at(-1)!.ev;
    expect(ev.candidates[0]!.fixOk.ok).toBe(true);
    expect(rec(w, DM).attestedBy).toBe(w.m.attester);
    expect(w.days(DM, DM)[0]!.lag).toBeLessThan(DAY);
  }, 60_000);
});
