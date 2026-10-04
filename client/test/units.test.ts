import { describe, expect, test } from "bun:test";
import { AmountError, dateOfDay, daysIn, firstDayOf, iso, minus, monthLabel, monthOfDay, monthOfLabel, parseDecimal, parseDollars, parseHours, parsePrice, plus, toNumber6, unitsToHours } from "../src/units.ts";

describe("parsing amounts (writes take no float)", () => {
  test("decimal strings to base units, exactly", () => {
    expect(parseDollars("12.34")).toBe(12_340_000n);
    expect(parseDollars("0.000001")).toBe(1n);
    expect(parseDollars("1000")).toBe(1_000_000_000n);
    expect(parseDollars(" 7 ")).toBe(7_000_000n);
    expect(parseDollars(5n)).toBe(5n);
    // 0.1 + 0.2 is not 0.3 in floats; as a string it is exact
    expect(parseDollars("0.3")).toBe(300_000n);
  });
  test("refuses floats, signs, exponents, separators and extra decimals", () => {
    for (const bad of [1.5 as unknown as string, "-1", "1e6", "1,000", "1.0000001", "", ".5", "01", "abc"]) {
      expect(() => parseDollars(bad)).toThrow(AmountError);
    }
    expect(() => parseDecimal(-1n, 6, "x")).toThrow(AmountError);
  });
  test("GPU-hours are whole LOTs (0.0001 GPU-hour)", () => {
    expect(parseHours("248.1389")).toBe(248_138_900n);
    expect(() => parseHours("0.00001")).toThrow(AmountError);
    expect(() => parseHours("1.000050")).toThrow(AmountError);
  });
  test("prices sit on the $0.01 tick", () => {
    expect(parsePrice("3.90")).toBe(3_900_000n);
    expect(() => parsePrice("3.905")).toThrow(AmountError);
    expect(() => parsePrice("0")).toThrow(AmountError);
  });
  test("slippage bounds round against the user", () => {
    expect(minus(1_000_000n, 100)).toBe(990_000n);
    expect(minus(999n, 100)).toBe(989n); // floor
    expect(plus(1_000_000n, 100)).toBe(1_010_000n);
    expect(plus(999n, 100)).toBe(1009n); // ceil of 1008.99
    expect(() => minus(1n, 10_000)).toThrow(AmountError);
    expect(() => minus(1n, 1.5)).toThrow(AmountError);
  });
});

describe("reading amounts", () => {
  test("u and base units to plain numbers through the exact decimal", () => {
    expect(toNumber6(3_990_000n)).toBe(3.99);
    expect(toNumber6(999_999_767n)).toBe(999.999767);
    expect(toNumber6(0n)).toBe(0);
    expect(unitsToHours(10_000_000n)).toBe(1000);
    expect(unitsToHours(2_481_389n)).toBe(248.1389);
  });
});

describe("calendar", () => {
  test("months and days as the contracts count them", () => {
    expect(monthLabel(24322)).toBe("2026-11");
    expect(monthOfLabel("2026-11")).toBe(24322);
    expect(() => monthOfLabel("2026-13")).toThrow(AmountError);
    expect(firstDayOf(24322)).toBe(20758);
    expect(firstDayOf(24321)).toBe(20727);
    expect(daysIn(24322)).toBe(30);
    expect(daysIn(24321)).toBe(31);
    expect(daysIn(2028 * 12 + 1)).toBe(29);
    expect(dateOfDay(20730)).toBe("2026-10-04");
    expect(monthOfDay(20730)).toBe(24321);
    expect(iso(1_791_158_400n)).toBe("2026-10-05T00:00:00Z");
  });
});
