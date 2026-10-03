// BOTS-SPEC 3.2: fair value on every k from 0 to N for N = 28 to 31, x outside the band, a missing index, the walk.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { clamp, FairBook, fairValue, latestFinal, todayOf, walkTop } from "../src/fair.ts";
import type { IndexRecordView } from "@agate/market";

const F = 1_800_000n;
const C = 7_200_000n;

function exact(sum: bigint, k: number, n: number, xc: bigint): bigint {
  // floor of the rational, by long division on numbers small enough to be exact as doubles
  return BigInt(Math.floor(Number(sum + BigInt(n - k) * xc) / n));
}

describe("fairValue", () => {
  test("every k from 0 to N, N = 28 to 31, against the exact rational", () => {
    for (let n = 28; n <= 31; n++) {
      for (let k = 0; k <= n; k++) {
        for (const x of [1_800_000n, 3_600_000n, 3_610_000n, 7_200_000n, 4_444_440n]) {
          const sum = BigInt(k) * 3_630_000n + BigInt(k % 7) * 10_000n;
          const f = fairValue(sum, k, n, x);
          expect(f).toBe(exact(sum, k, n, x));
          expect(f * BigInt(n) <= sum + BigInt(n - k) * x).toBe(true);
          expect((f + 1n) * BigInt(n) > sum + BigInt(n - k) * x).toBe(true);
        }
      }
    }
  });
  test("before the month it is xc itself; at k = N it is S / N rounded down", () => {
    expect(fairValue(0n, 0, 30, 3_600_000n)).toBe(3_600_000n);
    expect(fairValue(108_000_001n, 30, 30, 9_999_999n)).toBe(3_600_000n);
  });
  test("refuses k outside 0..N", () => {
    expect(() => fairValue(0n, 31, 30, 1n)).toThrow();
    expect(() => fairValue(0n, -1, 30, 1n)).toThrow();
  });
  test("x below F and above C are clamped", () => {
    expect(clamp(1_000_000n, F, C)).toBe(F);
    expect(clamp(9_000_000n, F, C)).toBe(C);
    expect(clamp(3_000_000n, F, C)).toBe(3_000_000n);
    expect(fairValue(0n, 0, 30, clamp(9_000_000n, F, C))).toBe(C);
  });
});

describe("the walk", () => {
  test("todayOf floors toward minus infinity", () => {
    expect(todayOf(1000n * 86_400n, 1000, 1000n * 86_400n, 86_400)).toBe(1000);
    expect(todayOf(1000n * 86_400n - 1n, 1000, 1000n * 86_400n, 86_400)).toBe(999);
    expect(todayOf(1000n * 86_400n - 86_401n, 1000, 1000n * 86_400n, 86_400)).toBe(998);
    expect(todayOf(1000n * 86_400n - 86_400n, 1000, 1000n * 86_400n, 86_400)).toBe(999);
    expect(todayOf(1000n * 86_400n + 86_399n, 1000, 1000n * 86_400n, 86_400)).toBe(1000);
  });
  test("the walk starts at min(today - 1, head - 1), or today - 1 without head", () => {
    expect(walkTop(100, null)).toBe(99);
    expect(walkTop(100, 100)).toBe(99);
    expect(walkTop(100, 95)).toBe(94);
    expect(walkTop(100, 120)).toBe(99);
  });

  const IX = "0x0000000000000000000000000000000000000001" as Address;
  const G = "0x01" as Hex;
  function reads(recs: Record<number, IndexRecordView>, head: number | null = null) {
    const calls: number[] = [];
    return {
      calls,
      async indexRecord(_i: Address, _g: Hex, day: number): Promise<IndexRecordView> {
        calls.push(day);
        return recs[day] ?? { exists: false, isFinal: false, value: 0n, status: 0 };
      },
      async indexHead(): Promise<number | null> {
        return head;
      },
    };
  }

  test("the newest record that exists and is final, skipping a pending one; none in 32 days: null", async () => {
    const r = reads({ 99: { exists: true, isFinal: false, value: 4_000_000n, status: 1 }, 98: { exists: true, isFinal: true, value: 3_650_000n, status: 1 } });
    expect(await latestFinal(r, IX, G, 99)).toBe(3_650_000n);
    expect(await latestFinal(reads({ 68: { exists: true, isFinal: true, value: 1n, status: 1 } }), IX, G, 99)).toBe(1n); // top - 31 = 68 is the last day looked at
    expect(await latestFinal(reads({ 67: { exists: true, isFinal: true, value: 1n, status: 1 } }), IX, G, 99)).toBe(null);
  });

  test("FairBook: head bounds the walk, one walk per (index, gpu, today) per tick", async () => {
    const r = reads({ 94: { exists: true, isFinal: true, value: 3_000_000n, status: 1 }, 99: { exists: true, isFinal: true, value: 5_000_000n, status: 1 } }, 95);
    const fb = new FairBook(r);
    const base = { t: 100n * 86_400n + 5n, startDay: 110, startTs: 110n * 86_400n, day: 86_400, n: 30, floor: F, cap: C, k: 0, sum: 0n };
    const a = await fb.fair(IX, G, base);
    expect(a?.fair).toBe(3_000_000n);
    const n = r.calls.length;
    await fb.fair(IX, G, base);
    expect(r.calls.length).toBe(n);
    fb.reset();
    await fb.fair(IX, G, base);
    expect(r.calls.length).toBe(2 * n);
    expect(await new FairBook(reads({})).fair(IX, G, base)).toBe(null);
    // at k = N the index is not needed
    expect((await new FairBook(reads({})).fair(IX, G, { ...base, k: 30, sum: 108_000_000n }))?.fair).toBe(3_600_000n);
  });

  test("recheck R1-M1: the band covers every newer public value (two pending records and an ended head day's previewFix)", async () => {
    // today 100; final 3.60 on day 96; days 97 and 98 closed and pending (3.20 and 4.00); head day 99 ended, not closed
    // by the wall, previewFix 3.90; a mid-month series (k 10, S 36.00) so each value's fair differs from the value
    const recs = {
      96: { exists: true, isFinal: true, value: 3_600_000n, status: 1 },
      97: { exists: true, isFinal: false, value: 3_200_000n, status: 2 },
      98: { exists: true, isFinal: false, value: 4_000_000n, status: 1 },
    };
    const r = { ...reads(recs, 99), indexPreviewFix: async () => ({ value: 3_900_000n }) };
    const base = { t: 100n * 86_400n + 5n, startDay: 90, startTs: 90n * 86_400n, day: 86_400, n: 30, floor: F, cap: C, k: 10, sum: 36_000_000n };
    const v = (await new FairBook(r).fair(IX, G, base))!;
    expect(v.fair).toBe(fairValue(36_000_000n, 10, 30, 3_600_000n));
    expect(v.lo).toBe(fairValue(36_000_000n, 10, 30, 3_200_000n));
    expect(v.hi).toBe(fairValue(36_000_000n, 10, 30, 4_000_000n));
    expect(v.pending.map((p) => [p.day, p.value, p.source])).toEqual([
      [99, 3_900_000n, "preview"],
      [98, 4_000_000n, "record"],
      [97, 3_200_000n, "record"],
    ]);
    // both pending records final together give a fair between their two fairs (each alone bounds the band)
    const both = fairValue(36_000_000n + 3_200_000n + 4_000_000n, 12, 30, 4_000_000n);
    expect(both >= v.lo && both <= v.hi).toBe(true);
  });
});
