// BOTS-SPEC 4.7: the payer's config (defaults of section 9, overrides, an unknown field refused).
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";

describe("payer config (BOTS-SPEC 4.7)", () => {
  test("defaults of section 9", () => {
    const c = parseConfig({});
    expect(c.factories).toBeNull();
    expect(c.claimThresholdU).toBe(10_000n);
    expect(c.maxIdsPerCall).toBe(50);
    expect(c.claimEveryDays).toEqual({ demo: 1, real: 1, pilot: 1 });
    expect(c.keepMon).toBe(15);
    expect(c.lowBalanceMon).toBe(60);
    expect(c.runUntil).toBe(Date.parse("2026-12-02T00:00:00Z") / 1000);
    expect(c.tickS).toBeNull();
    expect(c.logChunk).toBe(100);
    expect(c.lister && c.payer).toBe(true);
  });
  test("fields override; claimEveryDays merges per factory", () => {
    const c = parseConfig({ factories: ["demo"], claimEveryDays: { demo: 6 }, maxIdsPerCall: 10, tickS: 5, claimThresholdU: "20000" });
    expect(c.factories).toEqual(["demo"]);
    expect(c.claimEveryDays.demo).toBe(6);
    expect(c.claimEveryDays.real).toBe(1);
    expect(c.claimThresholdU).toBe(20_000n);
  });
  test("an unknown field and bad values are refused", () => {
    expect(() => parseConfig({ claimThreshold: 1 })).toThrow("unknown field claimThreshold");
    expect(() => parseConfig({ maxIdsPerCall: 51 })).toThrow("maxIdsPerCall");
    expect(() => parseConfig({ maxIdsPerCall: 0 })).toThrow("maxIdsPerCall");
    expect(() => parseConfig({ runUntil: "soon" })).toThrow("runUntil");
    expect(() => parseConfig({ factories: [] })).toThrow("factories");
    expect(() => parseConfig({ lister: "yes" })).toThrow("lister");
    expect(() => parseConfig({ claimEveryDays: { demo: 0 } })).toThrow("claimEveryDays.demo");
    expect(() => parseConfig([])).toThrow("not a JSON object");
  });
});
