// The v4.3 thief round (thief_v43.py: I, H, N1, J, K) on the TS harness, with the pass conditions of fix round 1
// (BUILD-SPEC 6.7 change note). Profile TEST.
import { describe, expect, test } from "bun:test";
import { AlertCode } from "@agate/report/types";
import { cent, median } from "../src/formula.ts";
import { Pages, W_ADDR, World, type WorldOptions } from "../src/sim/world.ts";

const OCT1 = 20_727;
const T = 2_400;
const SL = 200;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const ds = (d: number) => d * T;
const ss = (d: number, h: number) => d * T + h * SL;
const GUARD = { delay: SL, looks: true };

function world(o: Partial<WorldOptions> & Pick<WorldOptions, "pages">): World {
  return new World({ firstDay: OCT1, writers: [{ net: "w1" }, { net: "w2" }], guardian: null, ...o });
}
const rec = (w: World, d: number) => w.m.g(w.panel.gpuId).records.get(d)!;

describe("I: a watcher gap over a step no longer biases W(d) towards a freeze", () => {
  const D = OCT1 + 3;
  const kD = D * 12;
  // the watcher (and the attester with it) asleep for slices 6 to 11 of D; slot 2 steps 3.40 -> 3.90 at slice 6
  const opts = (thief: 0 | 1) => {
    const pages = new Pages(BASE, [{ slot: 2, at: ss(D, 6), v: 3_900_000 }]);
    const freeze = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? 3_400_000 : x));
    const writers = [{ net: "w1" }, { net: "w2" }].map((w, j) => (j === thief ? { ...w, values: freeze } : w));
    return { pages: pages.fn, writers, watcherMissed: (k: number) => k >= kD + 6 && k < kD + 12, attester: { down: (t: number) => t >= ss(D, 6) && t < ds(D + 1) } };
  };
  const honest = cent(median([3_000_000, 3_200_000, 3_650_000, 3_600_000, 3_800_000]));

  for (const [label, thief] of [["stolen primary", 0], ["stolen standby", 1]] as const) {
    test(`${label}: W(D) is the partial midpoint, the honest record is final, R9B raised`, async () => {
      const w = world(opts(thief));
      await w.run(ds(D + 3));
      const ev = w.evaluations.filter((e) => e.ev.day === D).at(-1)!.ev;
      const s2 = ev.slots[2]!;
      expect(s2.complete.t).toBe("unknown");
      expect(s2.partial).toMatchObject({ t: "int", lo: 3_400_000, hi: 3_900_000 });
      expect(ev.W).toBe(cent(median([3_000_000, 3_200_000, 3_650_000, 3_600_000, 3_800_000])));
      expect(rec(w, D).value).toBe(honest);
      expect(rec(w, D).source).toBe(W_ADDR[1 - thief]!);
      expect(w.raised(AlertCode.R9B_BLIND_SLOT_SPLIT, D)).toBe(true);
    });
  }
});

describe("H: an honest primary that missed a slice is not displaced by a thief standby's STRICT shading on tier alone", () => {
  const D = OCT1 + 3;
  const ts = ss(D, 6) + SL / 2;
  const fails = [{ slot: 2, from: ss(D, 5), to: ss(D, 6), state: "FAIL" as const, nets: ["watch"] }, { slot: 2, from: ss(D, 7), to: ss(D, 8), state: "FAIL" as const, nets: ["watch"] }];
  test("typed 3.55 to 3.70: the thief's record never replaces the incomplete honest one unless strictly nearer W(d)", async () => {
    const won: number[] = [];
    for (let target = 3_550_000; target <= 3_700_000; target += 50_000) {
      const pages = new Pages(BASE, [{ slot: 2, at: ts, v: 4_000_000 }], fails);
      const typed = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? target : x));
      const w = world({ pages: pages.fn, writers: [{ net: "w1", skip: (d, h) => d === D && h === 9 }, { net: "w2", values: typed }] });
      await w.run(ds(D + 2));
      const ev = w.evaluations.filter((e) => e.ev.day === D).at(-1)!.ev;
      const r = ev.candidates.find((c) => c.isPending)!;
      expect(r.complete).toBe(false);
      expect(r.tier).toBe(3); // incomplete and FIX-OK: ranked with STRICT (H)
      const b = ev.candidates.find((c) => !c.isPending)!;
      if (rec(w, D).source === W_ADDR[1]!) {
        won.push(target);
        expect(b.dist).toBeLessThan(r.dist);
      }
    }
    // the honest primary's own value is 3.60, nearest W(d): before the fix 3.55 to 3.70 all won on tier (thief_v43 H)
    expect(won).toEqual([]);
  });
});

describe("N1: the liveness veto (6.6 step 3b)", () => {
  test("no standby, a changed thief record no rule signs and no R3 reason: vetoed by name within GUARD_ACT, carried within LAG_MAX", async () => {
    const D = OCT1 + 3;
    // one isolated watcher failure on every slot: every per-slot VETO range is 'any value' (R3 has no reason), while
    // the complete ranges stay closed and refuse the typed values (R11, R12)
    const pages = new Pages(BASE, [], [0, 1, 2, 3, 4].map((slot) => ({ slot, from: ss(D, 3), to: ss(D, 4), state: "FAIL" as const, nets: ["watch"] })));
    const plant = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (d === D && x ? (i === 0 ? 3_580_000 : i === 1 ? 3_590_000 : x) : x));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", values: plant }], guardian: GUARD });
    await w.run(ds(D + 4));
    const vetoed = w.guardianActs.filter((a) => a.day === D && a.act === "veto done" && (a.why ?? "").startsWith("liveness"));
    const r = rec(w, D);
    expect(r.carried && !r.dropped).toBe(true);
    expect(r.value).toBe(rec(w, D - 1).value);
    expect(vetoed.length).toBeGreaterThan(0);
    expect(w.days(OCT1, D + 1).filter((x) => !x.final || x.lag > w.c.lagMax)).toEqual([]);
    expect(w.guardianActs.filter((a) => a.act.startsWith("suspend"))).toEqual([]);
  });
});

describe("G (fix round 2): R7's fix test does not gate the liveness veto", () => {
  const D = OCT1 + 3;
  // a real step on the median slot (every record of D needsSign); the watcher fails once on slots 0 and 4 in slice 3,
  // so their VETO ranges are 'any value' (no R3 reason); each writer catches a different one-slice pulse there (A3 fails)
  const opts = (w2: WorldOptions["writers"][number] | null) => {
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_600_000 }], [0, 4].map((slot) => ({ slot, from: ss(D, 3), to: ss(D, 4), state: "FAIL" as const, nets: ["watch"] })));
    const pulse = (slot: number, val: number) => (d: number, h: number, _t: number, v: number[]) => v.map((x, i) => (d === D && h === 3 && i === slot && x ? val : x));
    const w1 = { net: "w1", values: pulse(4, 6_000_000) };
    return { firstDay: OCT1, pages: pages.fn, writers: w2 ? [w1, w2] : [w1], guardian: GUARD };
  };
  const cases: [string, WorldOptions["writers"][number] | null][] = [
    ["two honest writers, same fix, both fail R12", { net: "w2", values: (d: number, h: number, _t: number, v: number[]) => v.map((x, i) => (d === D && h === 3 && i === 0 && x ? 1_000_000 : x)) }],
    ["a stolen standby copies the honest fix with another slot value", { net: "w2", values: (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (d === D && i === 4 && x ? 3_900_000 : x)) }],
    ["control: no standby", null],
  ];
  for (const [label, w2] of cases) {
    test(`${label}: never dropped at HOLD_MOVE, every day final within LAG_MAX, nobody suspended`, async () => {
      const w = new World(opts(w2));
      await w.run(ds(D + 10));
      const r = rec(w, D);
      expect(r.dropped).toBe(false);
      expect(w.days(OCT1, D + 1).filter((x) => !x.final || x.lag > w.c.lagMax)).toEqual([]);
      expect(w.guardianActs.filter((a) => a.act.startsWith("suspend"))).toEqual([]);
    });
  }
});

describe("J (stated residual): a withholding freeze without a standby is final and not suspendable", () => {
  test("the stolen primary withholds the median slot on a step day; nothing vetoes or suspends it", async () => {
    const D = OCT1 + 3;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(D), v: 3_900_000 }]);
    const withhold = (d: number, _h: number, _t: number, v: number[]) => v.map((x, i) => (i === 2 && d === D ? 0 : x));
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", values: withhold }], guardian: GUARD });
    await w.run(ds(D + 3));
    const r = rec(w, D);
    expect(r.value).toBe(3_400_000); // held: residual 1
    expect(w.m.isFinal(r, w.now)).toBe(true);
    expect(w.guardianActs.filter((a) => a.act.startsWith("suspend"))).toEqual([]);
    expect(w.raised(AlertCode.R9_UNCHANGED_NOT_STRICT, D)).toBe(true);
  });
});

describe("K: a stolen first writer below quorum", () => {
  test("two days running the honest standby's unchanged record needs the countersign: WRITER_GAP raised", async () => {
    const pages = new Pages(BASE);
    const one = (d: number, h: number, _t: number, v: number[]) => (d >= OCT1 + 2 ? v.map((x, i) => (h === 0 && i === 0 ? x : 0)) : v);
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: one }, { net: "w2" }] });
    await w.run(ds(OCT1 + 6));
    expect(w.raised(AlertCode.WRITER_GAP)).toBe(true);
    expect(w.days(OCT1, OCT1 + 4).every((x) => x.final && !x.dropped)).toBe(true);
  });
});
