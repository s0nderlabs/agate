// BUILD-SPEC 12.5 and 12.6: the scenario map on the harness (in-memory index from formula.ts, the real attester and
// keeper, a scripted guardian). Profile TEST unless stated. Each test states its pass condition from the spec.
import { describe, expect, test } from "bun:test";
import { AlertCode } from "@agate/report/types";
import { cent, median } from "../src/formula.ts";
import { Pages, W_ADDR, World, type WorldOptions } from "../src/sim/world.ts";

const OCT1 = 20_727;
const NOV1 = 20_758;
const T = 2_400; // TEST day
const SL = 200; // TEST slice
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000]; // median 3.40
const ds = (d: number) => d * T;
const ss = (d: number, h: number) => d * T + h * SL;
const med = (xs: number[]) => cent(median(xs));
const GUARD = { delay: SL, looks: true };

function world(o: Partial<WorldOptions> & Pick<WorldOptions, "pages">): World {
  return new World({ firstDay: OCT1, writers: [{ net: "w1" }, { net: "w2" }], guardian: null, ...o });
}

function wrong(w: World, from: number, to: number, truth: (d: number) => number): number[] {
  return w.days(from, to).filter((r) => r.final && !r.carried && r.value !== truth(r.day)).map((r) => r.day);
}

function report(w: World, from: number, to: number): string {
  return w.days(from, to).map((r) => `${r.day - OCT1}: ${w.status(r.day)} lag ${r.lag}`).join("\n");
}

describe("12.5 scenarios", () => {
  test("Honest month: every day final at the true median, the step day attested, nothing selected or vetoed", async () => {
    const step = OCT1 + 11;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(step), v: b + 600_000 })));
    const w = world({ pages: pages.fn });
    await w.run(ds(OCT1 + 31));
    const days = w.days(OCT1, OCT1 + 29);
    expect(days.every((r) => r.final && !r.carried)).toBe(true);
    expect(wrong(w, OCT1, OCT1 + 29, (d) => med(BASE.map((b) => b + (d >= step ? 600_000 : 0))))).toEqual([]);
    expect([w.selects(), w.vetoes(), w.suspensions(), w.drops().length]).toEqual([0, 0, 0, 0]);
    expect(Math.max(...days.map((r) => r.lag))).toBeLessThanOrEqual(T + 600);
    const r = w.m.g(w.panel.gpuId).records.get(step)!;
    expect(r.attestedBy).not.toBe("0x0000000000000000000000000000000000000000");
    // attested within one interval of the settle point (end of interval k(d,11) + 1 + GAP)
    const settleEnd = ss(step, 11) + (2 + 1) * SL;
    expect(r.attestedAt).toBeLessThanOrEqual(settleEnd + SL);
  });

  test("HF-1 (A4) on PRODUCTION: a mid-day step plus a watcher timeout; both writers inside the widened range, signed", async () => {
    const DAY = 86_400;
    const S = 3_600;
    const D4 = OCT1 + 4;
    const base = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
    const pages = new Pages(base, [
      ...[0, 1, 2, 3].map((i) => ({ slot: i, at: D4 * DAY, v: base[i]! + 600_000 })),
      { slot: 4, at: D4 * DAY + 12 * S + 1_800, v: 4_400_000 },
    ], [{ slot: 4, from: D4 * DAY + 13 * S + 1_500, to: D4 * DAY + 13 * S + 1_560, state: "FAIL", nets: ["watch"] }]);
    const w = world({ profile: { day: DAY, slices: 24 }, pages: pages.fn, step: 120 });
    await w.run((D4 + 3) * DAY);
    const r = w.m.g(w.panel.gpuId).records.get(D4)!;
    expect(w.m.isFinal(r, w.now)).toBe(true);
    expect(r.attestedBy).not.toBe("0x0000000000000000000000000000000000000000");
    expect(w.drops()).toEqual([]);
    expect(w.days(D4, D4)[0]!.lag).toBeLessThan(DAY);
  }, 60_000);

  test("HF-2 (A2, A3): the primary loses slot 4 for 4 hours on the move day; its record is FIX-OK and signed", async () => {
    const DAY = 86_400;
    const S = 3_600;
    const DM = OCT1 + 3;
    const base = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
    const pages = new Pages(base, [...[0, 1, 2, 3].map((i) => ({ slot: i, at: DM * DAY, v: base[i]! + 600_000 })), { slot: 4, at: DM * DAY + 12 * S + 1_800, v: 4_400_000 }], [
      { slot: 4, from: DM * DAY + 13 * S, to: DM * DAY + 17 * S, state: "FAIL", nets: ["w1"] },
    ]);
    for (const standby of ["skips a slice", "absent"] as const) {
      const writers = standby === "absent" ? [{ net: "w1" }] : [{ net: "w1" }, { net: "w2", skip: (d: number, h: number) => d === DM && h === 5 }];
      const w = world({ profile: { day: DAY, slices: 24 }, pages: pages.fn, writers, step: 120 });
      await w.run((DM + 3) * DAY);
      const r = w.m.g(w.panel.gpuId).records.get(DM)!;
      expect([standby, w.m.isFinal(r, w.now), r.source]).toEqual([standby, true, W_ADDR[0]!]);
      expect(r.attestedBy).not.toBe("0x0000000000000000000000000000000000000000");
      expect(w.drops()).toEqual([]);
    }
  }, 60_000);

  test("HF-3: a page dark for the watcher only, a regional price for the primary only, stock flicker: no veto, no suspension", async () => {
    const pages = new Pages(BASE, [{ slot: 1, at: ds(OCT1 + 3), v: 3_250_000, nets: ["w1", "look"] }], [
      { slot: 0, from: ds(OCT1 + 3), to: ds(OCT1 + 5), state: "DARK", nets: ["watch"] },
      ...Array.from({ length: 40 }, (_, j) => ({ slot: 3, from: ds(OCT1 + 6) + j * 97, to: ds(OCT1 + 6) + j * 97 + 40, state: "NR" as const })),
    ]);
    const w = world({ pages: pages.fn, guardian: GUARD });
    await w.run(ds(OCT1 + 10));
    expect([w.vetoes(), w.suspensions()]).toEqual([0, 0]);
    expect(w.raised(AlertCode.R8_SUSPEND_REASON)).toBe(false);
    expect(w.days(OCT1, OCT1 + 8).every((r) => r.final)).toBe(true);
  });

  test("HF-4 (C1): slot 4 behind a regional cache for the watcher on its step day: the primary's record signed, no veto reason", async () => {
    const DS = OCT1 + 3;
    const pages = new Pages(BASE, [
      { slot: 4, at: ss(DS, 6) + 100, v: 4_400_000, nets: ["w1", "w2", "look"] },
      { slot: 4, at: ds(DS + 1), v: 4_400_000 },
    ]);
    const w = world({ pages: pages.fn, guardian: GUARD });
    await w.run(ds(DS + 4));
    const r = w.m.g(w.panel.gpuId).records.get(DS)!;
    expect(w.m.isFinal(r, w.now)).toBe(true);
    expect(w.vetoes()).toBe(0);
    expect(w.raised(AlertCode.R3_VETO_REASON, DS)).toBe(false);
  });

  test("HF-5 (D1): a price flash at one writer's reads: no suspension reason on a single day, one on two days running", async () => {
    const run = async (days: number[], standby: boolean) => {
      const flashes = days.flatMap((d) => Array.from({ length: 12 }, (_, h) => [
        { slot: 4, at: ss(d, h) + 10, v: 4_400_000, nets: ["w1"] },
        { slot: 4, at: ss(d, h) + 100, v: 3_800_000, nets: ["w1"] },
      ]).flat());
      const pages = new Pages(BASE, flashes.sort((a, b) => a.at - b.at));
      const w = world({ pages: pages.fn, guardian: GUARD, writers: standby ? [{ net: "w1" }, { net: "w2" }] : [{ net: "w1" }] });
      await w.run(ds(Math.max(...days) + 4));
      return w;
    };
    const DF = OCT1 + 3;
    const one = await run([DF], false);
    expect(one.raised(AlertCode.R8_SUSPEND_REASON)).toBe(false);
    expect(one.suspensions()).toBe(0);
    const two = await run([DF, DF + 1], false);
    expect(two.raised(AlertCode.R8_SUSPEND_REASON, DF + 1)).toBe(true);
    // with a STRICT standby the flashed record is replaced by a select each day: a slot reason never suspends then
    const sel = await run([DF, DF + 1], true);
    expect(sel.suspensions()).toBe(0);
    expect(sel.selects()).toBeGreaterThanOrEqual(2);
  });
});

describe("thief and liveness scenarios (12.5, 12.6)", () => {
  const thiefPlant = (slot: number, v: number, days: (d: number) => boolean) => (d: number, _h: number, _t: number, vals: number[]) => vals.map((x, i) => (i === slot && days(d) ? v : x));

  test("B1 (S7): a stolen primary plants slot 0 at the median days 1-4, slot 0 dark days 5-7, slot 3 moves: the standby wins every day", async () => {
    const d1 = OCT1 + 1;
    const pages = new Pages(BASE, [{ slot: 3, at: ds(OCT1 + 6), v: 3_000_000 }], [{ slot: 0, from: ds(OCT1 + 5), to: ds(OCT1 + 8), state: "DARK" }]);
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: thiefPlant(0, 3_400_000, (d) => d >= d1 && d <= d1 + 3) }, { net: "w2" }], guardian: GUARD });
    await w.run(ds(OCT1 + 14));
    const truth = (d: number) => {
      const live = BASE.map((b, i) => (i === 3 && d >= OCT1 + 6 ? 3_000_000 : b));
      return med(live);
    };
    const bad = wrong(w, OCT1, OCT1 + 12, truth);
    expect(bad).toEqual([]);
    expect(w.days(OCT1, OCT1 + 12).every((r) => r.final)).toBe(true);
  });

  test("Freeze: a stolen primary repeats day-0 prices through a 0.60 step; with the standby 0 wrong days", async () => {
    const step = OCT1 + 4;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: ds(step), v: b + 600_000 })));
    const freeze = (_d: number, _h: number, _t: number, _vals: number[]) => [...BASE];
    const w = world({ pages: pages.fn, writers: [{ net: "w1", values: freeze }, { net: "w2" }] });
    await w.run(ds(OCT1 + 12));
    expect(wrong(w, OCT1, OCT1 + 10, (d) => med(BASE.map((b) => b + (d >= step ? 600_000 : 0))))).toEqual([]);
    expect(w.days(OCT1, OCT1 + 10).every((r) => r.final)).toBe(true);
  });

  test("Carry and drop: no writer for 3 days, then a change only the writer sees: carried at GRACE, dropped, L1b", async () => {
    const off = (d: number) => d >= OCT1 + 3 && d <= OCT1 + 5;
    const pages = new Pages(BASE, [{ slot: 2, at: ds(OCT1 + 6), v: 4_500_000, nets: ["w1"] }]);
    const w = world({ pages: pages.fn, writers: [{ net: "w1", skip: (d) => off(d) }] });
    await w.run(ds(OCT1 + 24));
    const g = w.m.g(w.panel.gpuId);
    for (const d of [OCT1 + 3, OCT1 + 4, OCT1 + 5]) {
      const r = g.records.get(d)!;
      expect(r.carried && !r.dropped).toBe(true);
      // at graceStart + GRACE (one DAY), plus at most one keeper period and STEP spacing between carries
      expect(r.postedAt - (ds(d + 1) + T)).toBeLessThanOrEqual(w.c.keeperPeriod + 2 * w.c.step);
    }
    const r6 = g.records.get(OCT1 + 6)!;
    expect(r6.carried && r6.dropped).toBe(true);
    expect(r6.postedAt - (ds(OCT1 + 7) + w.c.holdMove)).toBeLessThanOrEqual(w.c.keeperPeriod);
    expect(w.drops().length).toBeGreaterThanOrEqual(2);
    const l1b = w.l1b();
    expect(l1b.why).toEqual([]);
    // lag flat after the first drop: each later day drops about HOLD_MOVE after it ends
    const lags = w.days(OCT1 + 6, OCT1 + 8).filter((r) => r.final).map((r) => r.lag);
    expect(Math.max(...lags) - Math.min(...lags)).toBeLessThanOrEqual(T);
  });
});
