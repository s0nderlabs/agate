import { describe, expect, test } from "bun:test";
import { gpuIdOf } from "@agate/report";
import { Kind, NEVER } from "@agate/report/types";
import { carryPost, cent, computeRecord, median } from "../src/formula.ts";
import { civilFromDays, daysFromCivil, firstDayOf, isFirstOfMonth, monthOf } from "../src/date.ts";
import { deriveClocks, PROFILES, wallClock } from "../src/clock.ts";

describe("formula (4.6) and carryPost (4.9)", () => {
  test("the spec's digest example (section 5)", () => {
    const vals = [3990000, 0, 4500000, 3600000, 2990000];
    const counts = [24, 0, 24, 23, 24];
    const pre = [0, 1, 2, 3, 4].map((i) => ({ e: i === 1 ? 3850000 : vals[i]!, miss: 0, inMedian: true, wasIn: true }));
    const r = computeRecord({
      params: { slices: 24, minReadings: 12, qMin: 3, signAll: false, tPend: 21600 },
      gpu: { nSlots: 5, family: [0, 1, 2, 3, 4], famQ: [1, 1, 1, 1, 1], liveFrom: [0, 0, 0, 0, 0], liveUntil: Array(5).fill(NEVER) },
      gpuId: gpuIdOf("H100-SXM/on-demand-list/neocloud/v1"),
      day: 20758,
      writer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      postedAt: 1000,
      pre,
      acc: { sums: vals.map((v, i) => v * counts[i]!), counts, sliceBits: 2 ** 24 - 1, late: false, anyValid: true },
      prev: { value: 3850000 },
      firstRecordDay: 20700,
      firstWriter: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    expect(r.kinds).toEqual([Kind.FRESH, Kind.HELD, Kind.FRESH, Kind.FRESH, Kind.FRESH]);
    expect(r.value).toBe(3850000);
    expect(r.post[1]!.miss).toBe(1);
    expect(r.changed).toBe(false);
    expect(r.needsSign).toBe(false);
    expect(r.finalAt).toBe(1000 + 21600);
    expect(r.digest).toBe("0xb9ccc0f98761cfda1ddc3c8dbd41e543e18fb95d49c26a726e135c94d363272c");
  });
  test("cent and median", () => {
    expect(cent(6155000)).toBe(6160000);
    expect(cent(6154999)).toBe(6150000);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([30000, 10000, 20000, 40000])).toBe(25000);
  });
  test("carryPost advances only on every eligible writer's evidence, never past HOLD_DAYS", () => {
    const gpu = { nSlots: 3, family: [0, 1, 2], famQ: [1, 1, 1], liveFrom: [0, 0, 0], liveUntil: [NEVER, NEVER, NEVER] };
    const pre = [{ e: 1, miss: 0, inMedian: true, wasIn: true }, { e: 1, miss: 5, inMedian: true, wasIn: true }, { e: 1, miss: 2, inMedian: true, wasIn: true }];
    expect(carryPost(pre, gpu, 10, 6, []).mask).toBe(0);
    const r = carryPost(pre, gpu, 10, 6, [[0, 0, 7], [0, 0, 0]]);
    expect(r.mask).toBe(1);
    expect(r.post.map((s) => s.miss)).toEqual([1, 5, 2]);
  });
});

describe("DateLib port and clocks", () => {
  test("round trips and the demo epoch days", () => {
    for (let d = 0; d < 47_482; d += 7) {
      const [y, m, dd] = civilFromDays(d);
      expect(daysFromCivil(y, m, dd)).toBe(d);
    }
    expect(daysFromCivil(2026, 10, 1)).toBe(20727);
    expect(daysFromCivil(2026, 11, 1)).toBe(20758);
    expect(isFirstOfMonth(20758)).toBe(true);
    expect(firstDayOf(monthOf(20760))).toBe(20758);
  });
  test("profiles of 2.2", () => {
    const P = wallClock(deriveClocks(PROFILES.PRODUCTION));
    expect([P.tPend, P.gap, P.pendFloor, P.margin, P.guardAct, P.lagMax, P.lagBound]).toEqual([21600, 3, 10860, 300, 21600, 172800, 151200]);
    const D = wallClock(deriveClocks(PROFILES.DEMO));
    expect([D.tPend, D.reopenWait, D.lagMax]).toEqual([210, 150, 1420]);
    const F = wallClock(deriveClocks(PROFILES.FAST));
    expect([F.tPend, F.signAll, F.lagMax]).toEqual([6, true, 64]);
    const T = wallClock(deriveClocks(PROFILES.TEST));
    expect([T.tPend, T.lagMax, T.lagBound, T.grace]).toEqual([600, 4800, 4400, 2400]);
    expect(() => deriveClocks({ day: 24, slices: 2, qMin: 1 })).toThrow();
  });
});
