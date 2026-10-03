// BOTS-SPEC 2.4: the LIMIT table, its rules between points, the override and the CAP of 2.3 step 3.
import { describe, expect, test } from "bun:test";
import { encodeFunctionData } from "viem";
import { agateSeriesAbi } from "../src/abi.ts";
import { calldataGas, capFor, FRESH_PAYEE_GAS, LimitTable, LimitsError, provisionalCeiling } from "../src/limits.ts";

const T = new LimitTable();

describe("LIMIT table", () => {
  test("measured rows are returned exactly", () => {
    expect(T.limitFor("series.sync", 0)).toBe(3_590);
    expect(T.limitFor("series.sync", 1)).toBe(135_249);
    expect(T.limitFor("series.sync", 31)).toBe(508_719);
    expect(T.limitFor("series.settle", 30)).toBe(496_245);
    expect(T.limitFor("series.claimMany", 1, 8)).toBe(237_948 + 8 * FRESH_PAYEE_GAS);
    expect(T.limitFor("series.claimMany", 0, 8)).toBe(222_670 + 8 * FRESH_PAYEE_GAS);
    expect(T.limitFor("factory.list")).toBe(3_609_379);
    expect(T.limitFor("factory.createMarket")).toBe(1_247_597);
    expect(T.limitFor("series.mint")).toBe(142_000); // a series' first mint, not MS 9.2's 90,406 (2.4 v2)
    expect(T.limitFor("series.redeem")).toBe(52_975);
  });
  test("linear between measured c; above the last row the 5-to-30 slope", () => {
    expect(T.limitFor("series.sync", 3)).toBe(Math.ceil(135_249 + ((187_235 - 135_249) * 2) / 4));
    const slope = (496_353 - 187_235) / 25;
    expect(T.limitFor("series.sync", 35)).toBe(Math.ceil(508_719 + slope * 4));
    expect(T.limitFor("series.claimMany", 40, 8)).toBe(Math.ceil(596_269 + ((596_269 - 287_382) / 25) * 10) + 8 * FRESH_PAYEE_GAS);
  });
  test("claimMany: 25,450 per id from the 8-id row (50 ids at c 1 = 1,306,848, measured 1,306,874), plus 17,100 per payee new to the dollar", () => {
    expect(FRESH_PAYEE_GAS).toBe(17_100);
    expect(T.limitFor("series.claimMany", 1, 50) - 50 * FRESH_PAYEE_GAS).toBe(1_306_848);
    expect(Math.abs(T.limitFor("series.claimMany", 1, 50) - 50 * FRESH_PAYEE_GAS - 1_306_874)).toBeLessThan(100);
    expect(T.limitFor("series.claimMany", 1, 16)).toBe(237_948 + 8 * 25_450 + 16 * FRESH_PAYEE_GAS);
    expect(T.limitFor("series.claimMany", 0, 7)).toBe(222_670 - 25_450 + 7 * FRESH_PAYEE_GAS);
  });
  test("the one-id floor: c 1 is the measured 135,369; c 0 a single claim's row", () => {
    expect(T.limitFor("series.claimMany", 1, 1)).toBe(135_369 + FRESH_PAYEE_GAS);
    expect(T.limitFor("series.claimMany", 1, 2)).toBe(135_369 + 2 * FRESH_PAYEE_GAS); // 237,948 - 6 x 25,450 = 85,248 < the floor
    expect(T.limitFor("series.claimMany", 0, 1)).toBe(52_657 + FRESH_PAYEE_GAS);
  });
  test("unmeasured shapes have no LIMIT, only a provisional ceiling", () => {
    expect(() => T.limitFor("kuru.deposit")).toThrow(LimitsError);
    expect(provisionalCeiling("erc20.approve")).toBe(120_000);
    expect(provisionalCeiling("kuru.batchUpdate", 6, 3)).toBe(400_000 + 6 * 350_000 + 3 * 120_000);
  });
  test("AGATE_MARKET_GAS_LIMITS overrides a shape whole or per c, and refuses an unknown shape", () => {
    const o = LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify({ "factory.createMarket": 1_900_000, "series.sync": { 0: 5_000, 1: 200_000 }, "kuru.deposit": 90_000 }) });
    expect(o.limitFor("factory.createMarket")).toBe(1_900_000);
    expect(o.limitFor("series.sync", 1)).toBe(200_000);
    expect(o.limitFor("series.sync", 0)).toBe(5_000);
    expect(o.limitFor("kuru.deposit")).toBe(90_000);
    expect(o.measured("kuru.deposit")).toBe(true);
    expect(() => LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify({ "factory.nope": 1 }) })).toThrow("unknown shape");
    expect(() => LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: "{nope" })).toThrow("not JSON");
    expect(() => LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify({ "series.sync": { x: 1 } }) })).toThrow("bad entry");
  });
});

describe("CAP (BOTS-SPEC 2.3 step 3)", () => {
  test("1.5 x (LIMIT + 21,000 + calldataGas), the calldata counted 16 per nonzero and 4 per zero byte", () => {
    const data = encodeFunctionData({ abi: agateSeriesAbi, functionName: "claimMany", args: [[1n, 2n, 3n]] });
    const cd = calldataGas(data);
    // selector 4 nonzero bytes; offset, length and three ids: 31 zero bytes and one nonzero each
    expect(cd).toBe(4 * 16 + 5 * (31 * 4 + 16));
    const want = Math.ceil(1.5 * (T.limitFor("series.claimMany", 1, 3) + 21_000 + cd));
    expect(capFor(T, "series.claimMany", data, { c: 1, n: 3 })).toBe(BigInt(want));
  });
  test("an unmeasured shape: 1.5 x its provisional ceiling", () => {
    expect(capFor(T, "kuru.batchUpdate", "0x", { adds: 6, cancels: 6 })).toBe(BigInt(1.5 * (400_000 + 6 * 350_000 + 6 * 120_000)));
    expect(capFor(T, "erc20.approve", "0x")).toBe(180_000n);
    expect(capFor(T, "kuru.deposit", "0x")).toBe(450_000n);
  });
  test("an overridden (measured) shape drops its provisional ceiling", () => {
    const o = LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify({ "kuru.batchUpdate": 900_000 }) });
    expect(o.measured("kuru.batchUpdate")).toBe(true);
    expect(capFor(o, "kuru.batchUpdate", "0x", { adds: 6 })).toBe(((900_000n + 21_000n) * 3n + 1n) / 2n);
  });
  test("the first mint of a series fits the CAP: receipt 163,174 on the Kuru V1 fork, 1.2 x its estimate under 1.5 x LIMIT", () => {
    const data = encodeFunctionData({ abi: agateSeriesAbi, functionName: "mint", args: [7_000_000_000n, "0x00000000000000000000000000000000000000d1"] });
    const cap = capFor(T, "series.mint", data);
    expect(196_302n).toBeLessThanOrEqual(cap); // the fork's 1.2 x estimate (P1, Oct 3)
    const old = BigInt(Math.ceil(1.5 * (90_406 + 21_000 + calldataGas(data))));
    expect(196_302n).toBeGreaterThan(old); // what MS 9.2's 90,406 refused GAS_CAP
  });
});
