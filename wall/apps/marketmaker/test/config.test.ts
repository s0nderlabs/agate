// BOTS-SPEC 3.11: the config (unknown field refused, perFactory, the null defaults). The MON budget (2.6) and the
// deployments file (section 1) are tested with the shared layer, wall/packages/market/test.
import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { bookConfig, ConfigError, DEFAULTS, parseConfig, stopBeforeEnd, tickSeconds } from "../src/config.ts";

describe("config", () => {
  test("defaults (section 9)", () => {
    const c = parseConfig(null);
    expect(c.factories).toEqual(["demo", "real"]);
    expect(c.spreadBps).toBe(100);
    expect(c.sizesTokens).toEqual([1000, 2000, 4000]);
    expect(c.requoteMoveU).toBe(10_000n);
    expect(c.maxLossU).toBe(500_000_000_000n);
    expect(c.keepWei).toBe(parseEther("20"));
    expect(c.runUntil).toBe(Date.parse("2026-12-02T00:00:00Z") / 1000);
    expect(Object.keys(DEFAULTS).length).toBe(22); // the 20 fields of 3.11, plus kuruV2 (Oct 10 2026) and headStartS (Oct 12)
    expect(c.kuruV2).toBeNull();
  });
  test("headStartS: 4 hours by default (the 00:00 requote of every book), configurable within a day", () => {
    expect(parseConfig("{}").headStartS).toBe(14_400);
    expect(parseConfig(JSON.stringify({ headStartS: 3_600 })).headStartS).toBe(3_600);
    expect(() => parseConfig(JSON.stringify({ headStartS: 90_000 }))).toThrow("headStartS is over 86400");
    expect(() => parseConfig(JSON.stringify({ headStartS: -1 }))).toThrow("headStartS is under 0");
  });

  test("an unknown field is refused, at the top and in perFactory", () => {
    expect(() => parseConfig('{"spredBps": 50}')).toThrow("unknown field spredBps");
    expect(() => parseConfig('{"perFactory": {"demo": {"keepMon": 1}}}')).toThrow("unknown field perFactory.demo.keepMon");
    expect(() => parseConfig("[1]")).toThrow(ConfigError);
    expect(() => parseConfig('{"levels": 4}')).toThrow("fewer entries than levels");
    expect(() => parseConfig('{"runUntil": "soon"}')).toThrow("runUntil");
    expect(() => parseConfig('{"sizesTokens": [0, 1, 2]}')).toThrow("sizesTokens[0]");
  });
  test("perFactory overrides the ladder for one factory", () => {
    const c = parseConfig('{"perFactory": {"demo": {"levels": 1, "requoteMoveU": 50000}}}');
    expect(bookConfig(c, "demo").levels).toBe(1);
    expect(bookConfig(c, "demo").requoteMoveU).toBe(50_000n);
    expect(bookConfig(c, "real").levels).toBe(3);
  });
  test("stopBeforeEndS null: max(60, DAY / 24); tickS null: clamp(DAY / 20, 10, 60)", () => {
    const c = parseConfig(null);
    expect(stopBeforeEnd(c, 86_400)).toBe(3_600);
    expect(stopBeforeEnd(c, 600)).toBe(60);
    expect(tickSeconds(c, [600, 86_400])).toBe(30);
    expect(tickSeconds(c, [86_400])).toBe(60);
    expect(tickSeconds(c, [24])).toBe(10);
    expect(tickSeconds(parseConfig('{"tickS": 5}'), [600])).toBe(5);
  });
});
