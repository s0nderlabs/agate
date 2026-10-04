import { describe, expect, test } from "bun:test";
import { type Hex, numberToHex } from "viem";
import { buyCost, buyTokens, decodeL2Book, DepthError, sellProceeds, toBook } from "../src/book.ts";

const word = (x: bigint) => numberToHex(x, { size: 32 }).slice(2);
/** getL2Book's layout: block, bid pairs best first, a zero word, ask pairs best first. */
function l2(block: bigint, bids: [bigint, bigint][], asks: [bigint, bigint][]): Hex {
  return `0x${[block, ...bids.flat(), 0n, ...asks.flat()].map(word).join("")}` as Hex;
}

// the maker's ladder around fair 3.99 (BOTS-SPEC 3.3): sizes in Kuru units (10^4 per GPU-hour)
const BIDS: [bigint, bigint][] = [[3_950_000n, 10_000_000n], [3_940_000n, 20_000_000n], [3_930_000n, 40_000_000n]];
const ASKS: [bigint, bigint][] = [[4_030_000n, 10_000_000n], [4_040_000n, 20_000_000n], [4_050_000n, 40_000_000n]];

describe("getL2Book", () => {
  test("decodes the words and converts to the app's Book (dollars, GPU-hours)", () => {
    const raw = decodeL2Book(l2(123n, BIDS, ASKS));
    expect(raw.block).toBe(123n);
    expect(raw.bids).toEqual(BIDS);
    expect(raw.asks).toEqual(ASKS);
    const b = toBook(raw);
    expect(b.bids).toEqual([{ price: 3.95, size: 1000 }, { price: 3.94, size: 2000 }, { price: 3.93, size: 4000 }]);
    expect(b.asks).toEqual([{ price: 4.03, size: 1000 }, { price: 4.04, size: 2000 }, { price: 4.05, size: 4000 }]);
    expect(b.spread).toBe(0.08);
  });
  test("an empty book and a one-sided book", () => {
    expect(toBook(decodeL2Book(l2(1n, [], [])))).toEqual({ asks: [], bids: [], spread: 0 });
    const one = toBook(decodeL2Book(l2(1n, [], ASKS)));
    expect(one.bids).toEqual([]);
    expect(one.spread).toBe(0);
  });
});

describe("walking the book", () => {
  test("a sale pays price x units / 10^4 per level, exactly", () => {
    expect(sellProceeds(BIDS, 100_000_000n)).toEqual({ dollars: 395_000_000n, levels: 1 });
    // 1,500 GPU-hours: 1,000 at 3.95 and 500 at 3.94
    expect(sellProceeds(BIDS, 1_500_000_000n).dollars).toBe(3_950_000_000n + 1_970_000_000n);
    expect(() => sellProceeds(BIDS, 7_000_000_001n)).toThrow(DepthError);
    expect(() => sellProceeds(BIDS, 8_000_000_000n)).toThrow(DepthError);
  });
  test("Kuru's market buy (MS 6.5): one level loses under one unit's cost", () => {
    // $1,000 at 4.03: 2,481,389 units = 248.1389 GPU-hours
    expect(buyTokens(ASKS, 1_000_000_000n)).toBe(248_138_900n);
  });
  test("MS 6.5's worked case: the exact cost of 1,100 over two levels buys one unit less; one unit's cost more buys it all", () => {
    const asks: [bigint, bigint][] = [[3_640_000n, 10_000_000n], [3_650_000n, 1_000_000n]];
    expect(buyTokens(asks, 4_005_000_000n)).toBe(1_099_999_900n);
    expect(buyTokens(asks, 4_005_000_365n)).toBe(1_100_000_000n);
    // buyCost adds that unit's cost per level crossed after the first
    const c = buyCost(asks, 1_100_000_000n);
    expect(c.levels).toBe(2);
    expect(c.dollars).toBe(4_005_000_000n + 365n);
    expect(buyTokens(asks, c.dollars)).toBe(1_100_000_000n);
  });
  test("buyCost refuses a size deeper than the asks", () => {
    expect(() => buyCost(ASKS, 8_000_000_000n)).toThrow(DepthError);
  });
});
