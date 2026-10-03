// BOTS-SPEC 4.8: owed against MS 12.1's worked numbers and an exact rational reference; fair, ticks, day ids, c.
import { describe, expect, test } from "bun:test";
import { ceilTick, claimable, dayIdAt, fair, floorTick, indexCalls, owed, quoteLocked, units } from "../src/math.ts";

const U = 1_000_000n;
const ex1 = { n: 30, floor: 1_800_000n, cap: 7_200_000n }; // MS 12.1 example 1: November, F 1.80, C 7.20

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("owed (MS 4.5) on MS 12.1 example 1", () => {
  test("k = 10, S = 36.00: 2.40 long, 1.20 short per token", () => {
    expect(owed(0, U, 10, 36_000_000n, ex1)).toBe(2_400_000n);
    expect(owed(1, U, 10, 36_000_000n, ex1)).toBe(1_200_000n);
  });
  test("k = 20, S = 78.00: 3.20 and 2.20", () => {
    expect(owed(0, U, 20, 78_000_000n, ex1)).toBe(3_200_000n);
    expect(owed(1, U, 20, 78_000_000n, ex1)).toBe(2_200_000n);
  });
  test("final k = 30, S = 120.00: 4.00 and 3.20, together C", () => {
    expect(owed(0, U, 30, 120_000_000n, ex1)).toBe(4_000_000n);
    expect(owed(1, U, 30, 120_000_000n, ex1)).toBe(3_200_000n);
  });
  test("k = 0: a long is paid its floor at once, a short nothing", () => {
    expect(owed(0, 720n * U, 0, 0n, ex1)).toBe(720n * 1_800_000n);
    expect(owed(1, 720n * U, 0, 0n, ex1)).toBe(0n);
  });
  test("example 1's streams: 8 x 720 tokens, days 1 to 10 at 3.60 then 4.20", () => {
    // renter's daily stream 5,760 x (c - 1.80) / 30 = 345.60 on days 1 to 10
    const q = 5_760n * U;
    expect(owed(0, q, 1, 3_600_000n, ex1) - owed(0, q, 0, 0n, ex1)).toBe(345_600_000n);
    // owner's stream 5,760 x (7.20 - c) / 30 = 691.20
    expect(owed(1, q, 1, 3_600_000n, ex1)).toBe(691_200_000n);
  });
  test("claimable never negative", () => {
    expect(claimable(0, U, 5_000_000n, 1, 3_600_000n, ex1)).toBe(0n);
    expect(claimable(0, U, 1_800_000n, 1, 3_600_000n, ex1)).toBe(60_000n);
  });
});

describe("owed against an exact rational reference", () => {
  test("100,000 random (N, F, C, k, S, q): floor(q G / (N U)) satisfies its defining inequality on both sides", () => {
    const r = rng(0x6167617465);
    const big = (max: number) => BigInt(Math.floor(r() * max));
    let checked = 0;
    for (let i = 0; i < 100_000; i++) {
      const n = 28 + Math.floor(r() * 4);
      const f = (1n + big(2_000)) * 50_000n;
      const c = f + (1n + big(2_000)) * 50_000n;
      const k = Math.floor(r() * (n + 1));
      let S = 0n;
      for (let d = 0; d < k; d++) S += f + big(Number(c - f) + 1);
      const q = (1n + big(1_000_000_000)) * 100n;
      const t = { n, floor: f, cap: c };
      const N = BigInt(n);
      for (const side of [0, 1] as const) {
        const G = side === 0 ? S + (N - BigInt(k)) * f : BigInt(k) * c - S;
        const o = owed(side, q, k, S, t);
        // o is the floor of the exact rational q G / (N U): o N U <= q G < (o + 1) N U
        expect(o * N * U <= q * G).toBe(true);
        expect(q * G < (o + 1n) * N * U).toBe(true);
        checked++;
      }
      // the two sides never pay more than a pair: owed(L) + owed(S) <= q (S + (N - k) F + k C - S) / (N U) <= q C / U
      expect(owed(0, q, k, S, t) + owed(1, q, k, S, t) <= (q * c) / U).toBe(true);
    }
    expect(checked).toBe(200_000);
  });
});

describe("fair value (BOTS-SPEC 3.2), ticks, units", () => {
  test("before the month fair is x clamped; at k = N it is S / N", () => {
    expect(fair(0n, 0, 3_600_000n, ex1)).toBe(3_600_000n);
    expect(fair(0n, 0, 9_000_000n, ex1)).toBe(7_200_000n);
    expect(fair(0n, 0, 1_000n, ex1)).toBe(1_800_000n);
    expect(fair(120_000_000n, 30, 1n, ex1)).toBe(4_000_000n);
  });
  test("floorTick / ceilTick at exact multiples and between", () => {
    expect(floorTick(3_600_000n)).toBe(3_600_000n);
    expect(ceilTick(3_600_000n)).toBe(3_600_000n);
    expect(floorTick(3_609_999n)).toBe(3_600_000n);
    expect(ceilTick(3_600_001n)).toBe(3_610_000n);
    expect(floorTick(-1n)).toBe(-10_000n);
  });
  test("Kuru units and the dollars a bid locks", () => {
    expect(units(1_000n * U)).toBe(10_000_000n);
    expect(quoteLocked(3_640_000n, 10_000_000n)).toBe(3_640_000_000n);
  });
});

describe("day ids and index calls", () => {
  const t = { startDay: 20_758, startTs: 1_000_000n, day: 600, n: 30 };
  test("dayIdAt floors toward minus infinity", () => {
    expect(dayIdAt(t, 1_000_000n)).toBe(20_758);
    expect(dayIdAt(t, 1_000_599n)).toBe(20_758);
    expect(dayIdAt(t, 1_000_600n)).toBe(20_759);
    expect(dayIdAt(t, 999_999n)).toBe(20_757);
  });
  test("c = pending days plus one when the next day has ended and is not final", () => {
    expect(indexCalls(t, 0, 0, 1_000_100n)).toBe(0); // day 1 running
    expect(indexCalls(t, 0, 0, 1_000_600n)).toBe(1); // day 1 ended, not final
    expect(indexCalls(t, 0, 1, 1_000_700n)).toBe(1); // day 1 final, day 2 running
    expect(indexCalls(t, 0, 1, 1_001_200n)).toBe(2); // day 2 ended too
    expect(indexCalls(t, 3, 30, 9_999_999n)).toBe(27); // the month over: no further day
  });
});
