import { describe, expect, test } from "bun:test";
import { dayIdAt, dayStart, expectedClose, expectedFinal, type IndexClocks } from "../src/clock.ts";
import { iso } from "../src/units.ts";

// the live index's clocks (Monad testnet, Oct 4 2026): a UTC day, 24 slices, CLOSE_GRACE one slice, T_PEND 6 h
const PROD: IndexClocks = { day: 86_400, slice: 3_600, tPend: 21_600, closeGrace: 3_600, slices: 24, minReadings: 12, epochTs: 0n, epochDay: 0 };
// a demo clock: 600 s days, day 20758 (Nov 1) starts at the deploy second
const DEMO: IndexClocks = { day: 600, slice: 25, tPend: 210, closeGrace: 25, slices: 24, minReadings: 12, epochTs: 1_800_000_000n, epochDay: 20_758 };
const OCT4 = 20_730;

describe("the index clock", () => {
  test("day ids and starts", () => {
    expect(dayStart(PROD, OCT4)).toBe(1_791_072_000n);
    expect(iso(dayStart(PROD, OCT4))).toBe("2026-10-04T00:00:00Z");
    expect(dayIdAt(PROD, 1_791_072_000n + 86_399n)).toBe(OCT4);
    expect(dayIdAt(PROD, 1_791_072_000n + 86_400n)).toBe(OCT4 + 1);
    expect(dayStart(DEMO, 20_760)).toBe(1_800_001_200n);
    expect(dayIdAt(DEMO, 1_799_999_999n)).toBe(20_758);
  });
});

describe("when a day's price closes and turns final (production)", () => {
  const before = dayStart(PROD, OCT4) + 3_600n; // Oct 4, 01:00 UTC
  test("before the close: the day's end plus CLOSE_GRACE (01:00 UTC) and that plus T_PEND (07:00 UTC)", () => {
    expect(iso(expectedClose(PROD, OCT4, null, before))).toBe("2026-10-05T01:00:00Z");
    expect(iso(expectedFinal(PROD, OCT4, null, before))).toBe("2026-10-05T07:00:00Z");
  });
  test("a close that has not happened by its time moves both: the close never before now, final T_PEND after it", () => {
    const late = dayStart(PROD, OCT4 + 1) + 10_000n;
    expect(expectedClose(PROD, OCT4, null, late)).toBe(late);
    expect(expectedFinal(PROD, OCT4, null, late)).toBe(late + 21_600n);
  });
  test("closed and waiting for the countersign: postedAt + T_PEND at the earliest", () => {
    const postedAt = dayStart(PROD, OCT4 + 1) + 3_700n;
    const rec = { exists: true, isFinal: false, postedAt, finalAt: 0n };
    expect(expectedClose(PROD, OCT4, rec, postedAt)).toBe(postedAt);
    expect(expectedFinal(PROD, OCT4, rec, postedAt + 60n)).toBe(postedAt + 21_600n);
    // the countersign is later than T_PEND: final at the countersign, so "now" until it lands
    expect(expectedFinal(PROD, OCT4, rec, postedAt + 30_000n)).toBe(postedAt + 30_000n);
  });
  test("finalAt once known", () => {
    const rec = { exists: true, isFinal: false, postedAt: 5n, finalAt: 99n };
    expect(expectedFinal(PROD, OCT4, rec, 10n)).toBe(99n);
  });
});
