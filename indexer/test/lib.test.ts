// Pure helpers: MS 4.5's owed (the worked example of MS 12.1 and an exact rational reference), the calendar, the
// index clock, Kuru units, the label rules and the book's best bid, ask and mark.
import { describe, expect, it } from "vitest";
import { dayLabel, labelOfSymbol, splitFlags } from "../src/lib/labels.ts";
import { bestOf, markOf } from "../src/lib/market.ts";
import { clockAnchor, daysFromCivil, daysIn, dayIdAt, firstDayOf, floorDiv, isoOfDay, midU, monthLabel, monthOf, notionalU, owed, sizeToTokens, tradePriceU } from "../src/lib/math.ts";

const U = 1_000_000n;

describe("owed (MS 4.5)", () => {
  // MS 12.1 example 1: N = 30, F = 1.80, C = 7.20, one token
  const F = 1_800_000n;
  const C = 7_200_000n;
  it("reproduces the worked example", () => {
    expect([owed("LONG", U, 10, 36n * U, 30, F, C), owed("SHORT", U, 10, 36n * U, 30, F, C)]).toEqual([2_400_000n, 1_200_000n]);
    expect([owed("LONG", U, 20, 78n * U, 30, F, C), owed("SHORT", U, 20, 78n * U, 30, F, C)]).toEqual([3_200_000n, 2_200_000n]);
    expect([owed("LONG", U, 30, 120n * U, 30, F, C), owed("SHORT", U, 30, 120n * U, 30, F, C)]).toEqual([4_000_000n, 3_200_000n]);
    expect(owed("LONG", U, 0, 0n, 30, F, C)).toBe(F); // the floor at once
  });

  it("equals floor of the exact rational on 100,000 random inputs", () => {
    let seed = 0x6167617465n;
    const rnd = (m: bigint) => {
      seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
      return seed % m;
    };
    for (let j = 0; j < 100_000; j++) {
      const n = 28 + Number(rnd(4n));
      const f = (rnd(100n) + 1n) * 50_000n;
      const c = f + (rnd(200n) + 1n) * 50_000n;
      const k = Number(rnd(BigInt(n) + 1n));
      let s = 0n;
      for (let d = 0; d < k; d++) s += f + rnd(c - f + 1n);
      const q = rnd(10n ** 12n) + 1n;
      const long = owed("LONG", q, k, s, n, f, c);
      const short = owed("SHORT", q, k, s, n, f, c);
      // exact: q * G / (N U) with G = S + (N - k) F (long) or k C - S (short); floor <=> 0 <= G q - owed N U < N U
      const nu = BigInt(n) * U;
      const gl = q * (s + BigInt(n - k) * f) - long * nu;
      const gs = q * (BigInt(k) * c - s) - short * nu;
      if (gl < 0n || gl >= nu || gs < 0n || gs >= nu) throw new Error(`owed off at ${j}`);
      if (long + short > (q * c) / U + 1n) throw new Error(`a pair pays more than C at ${j}`);
    }
  });
});

describe("calendar and clock", () => {
  it("DateLib", () => {
    expect(isoOfDay(daysFromCivil(2026, 10, 1))).toBe("2026-10-01");
    expect(isoOfDay(20_727)).toBe("2026-10-01");
    expect(monthOf(daysFromCivil(2026, 11, 30))).toBe(2026 * 12 + 10);
    expect(firstDayOf(2026 * 12 + 10)).toBe(daysFromCivil(2026, 11, 1));
    expect([daysIn(2026 * 12 + 1), daysIn(2028 * 12 + 1), daysIn(2026 * 12 + 9), daysIn(2026 * 12 + 10)]).toEqual([28, 29, 31, 30]);
    expect(monthLabel(2026 * 12 + 10)).toBe("2026-11");
    expect(monthLabel(2027 * 12)).toBe("2027-01");
  });

  it("floorDiv and dayIdAt, before and after the anchor", () => {
    expect([floorDiv(7n, 2n), floorDiv(-7n, 2n), floorDiv(-6n, 2n), floorDiv(6n, -4n)]).toEqual([3n, -4n, -3n, -2n]);
    const anchor = clockAnchor(1_790_006_600n, daysFromCivil(2026, 10, 1), 600); // the demo clock of the local replay
    expect(dayIdAt(anchor, 600, 1_790_006_600n)).toBe(daysFromCivil(2026, 10, 1));
    expect(dayIdAt(anchor, 600, 1_790_006_599n)).toBe(daysFromCivil(2026, 9, 30));
    expect(dayIdAt(0n, 86_400, 1_790_000_000n)).toBe(Math.floor(1_790_000_000 / 86_400));
  });
});

describe("Kuru units", () => {
  it("Trade.price, sizes and notional", () => {
    expect(tradePriceU(2_050_000n * 10n ** 12n)).toBe(2_050_000n);
    expect(sizeToTokens(10_000n)).toBe(U); // KURU_MIN_SIZE is one token
    expect(notionalU(2_050_000n, 10_000n)).toBe(2_050_000n);
    expect(notionalU(2_050_000n, 25_000n)).toBe(5_125_000n);
    expect([midU(1_950_000n, 2_050_000n), midU(1_960_000n, 2_030_000n), midU(1_990_000n, 2_000_000n)]).toEqual([2_000_000n, 1_990_000n, 1_990_000n]);
  });

  it("best bid and ask ignore empty levels; the mark is the last trade, else the mid", () => {
    const levels = [
      { side: "BID", price: 1_950_000n, size: 5n },
      { side: "BID", price: 1_990_000n, size: 0n },
      { side: "ASK", price: 2_100_000n, size: 1n },
      { side: "ASK", price: 2_050_000n, size: 9n },
      { side: "BID", price: 1_900_000n, size: 9n },
    ];
    expect(bestOf(levels)).toEqual({ bid: 1_950_000n, ask: 2_050_000n });
    expect(bestOf([])).toEqual({ bid: undefined, ask: undefined });
    expect(markOf(undefined, 1_950_000n, 2_050_000n)).toEqual({ midU: 2_000_000n, markU: 2_000_000n, markSource: "MID" });
    expect(markOf(2_030_000n, 1_950_000n, 2_050_000n)).toEqual({ midU: 2_000_000n, markU: 2_030_000n, markSource: "TRADE" });
    // audit M-1: a last trade the live book has moved away from is no price anyone can trade at: the mid
    expect(markOf(2_070_000n, 1_950_000n, 2_050_000n)).toEqual({ midU: 2_000_000n, markU: 2_000_000n, markSource: "MID" });
    expect(markOf(1_900_000n, 1_950_000n, 2_050_000n)).toEqual({ midU: 2_000_000n, markU: 2_000_000n, markSource: "MID" });
    expect(markOf(1_950_000n, 1_950_000n, 2_050_000n).markSource).toBe("TRADE"); // at the bid is inside
    expect(markOf(2_070_000n, 1_950_000n, undefined)).toEqual({ midU: undefined, markU: 2_070_000n, markSource: "TRADE" }); // one side: the trade
    expect(markOf(undefined, 1_950_000n, undefined)).toEqual({ midU: undefined, markU: undefined, markSource: "NONE" });
  });
});

describe("labels", () => {
  it("the GPU label of a symbol, with or without a tag letter, even with a hyphen in it", () => {
    expect(labelOfSymbol("dH100-NOV26", "demo")).toBe("H100");
    expect(labelOfSymbol("H100-NOV26", "")).toBe("H100");
    expect(labelOfSymbol("pB200-DEC26", "pilot")).toBe("B200");
    expect(labelOfSymbol("dH-100-JAN27", "demo")).toBe("H-100");
  });

  it("FixApplied flags", () => {
    expect(splitFlags(63)).toEqual({ late: true, incomplete: true, forced: true, belowFloor: true, aboveCap: true, carried: true });
    expect(splitFlags(4)).toEqual({ late: false, incomplete: false, forced: true, belowFloor: false, aboveCap: false, carried: false });
  });

  it("the day label of every state (wall spec 9.6)", () => {
    const at = (state: string, finalAt?: bigint) => ({ state, finalAt });
    expect(dayLabel(null, 0n)).toBe("open");
    expect(dayLabel(undefined, 0n)).toBe("open");
    expect(dayLabel(at("SKIPPED"), 0n)).toBe("skipped");
    for (const s of ["NEEDS_SIGN", "VETOED", "DROPPED"]) expect(dayLabel(at(s), 10n ** 12n)).toBe("pending");
    expect(dayLabel(at("PENDING", 100n), 99n)).toBe("pending");
    expect(dayLabel(at("PENDING", 100n), 100n)).toBe("final");
    expect(dayLabel(at("PENDING"), 10n ** 12n)).toBe("pending");
    expect(dayLabel(at("FINAL", 100n), 0n)).toBe("final");
    expect(dayLabel(at("CARRIED", 5n), 5n)).toBe("carried");
    expect(dayLabel(at("CARRIED_UNVERIFIED", 5n), 5n)).toBe("carried, unverified");
  });
});
