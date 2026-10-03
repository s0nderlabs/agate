// BOTS-SPEC 3.4: exposure, the token and dollar plans with the cancel-first credit, the pairs cap, redeem, the mark.
import { describe, expect, test } from "bun:test";
import { U } from "@agate/market";
import { exposure, markSeries, planDollars, planTokens, redeemable } from "../src/inventory.ts";
import { lockOf, UNITS_PER_TOKEN } from "../src/ladder.ts";

const T = UNITS_PER_TOKEN;
const C = 7_200_000n;
const asks = [
  { price: 3_640_000n, size: 1_000n * T },
  { price: 3_650_000n, size: 2_000n * T },
  { price: 3_660_000n, size: 4_000n * T },
];
const bids = [
  { price: 3_560_000n, size: 1_000n * T },
  { price: 3_550_000n, size: 2_000n * T },
];

describe("exposure and the mark", () => {
  test("a pair adds nothing to E and is worth C whatever fair is", () => {
    expect(exposure({ Tw: 5n * U, Tm: 3n * U, Tr: 2n * U, Sh: 10n * U })).toBe(0n);
    expect(exposure({ Tw: 0n, Tm: 0n, Tr: 0n, Sh: 10n * U })).toBe(-10n * U);
    for (const fair of [1_800_000n, 3_600_000n, 7_200_000n]) expect(markSeries(10n * U, 10n * U, fair, C)).toBe(10n * C);
  });
});

describe("planTokens", () => {
  test("nothing to do when the margin account and the current asks' locks cover the target", () => {
    const p = planTokens(asks, { Tw: 0n, Tm: 3_000n * U, Tr: 4_000n * U, Sh: 7_000n * U }, { cap: C, maxPairsBase: 30_000n * U, walletDollars: 0n });
    expect(p).toMatchObject({ mintQ: 0n, depositT: 0n, capped: false });
    expect(p.asks).toEqual(asks);
  });
  test("the wallet first, then whole tokens minted for the rest; the cost rounds up", () => {
    const p = planTokens(asks, { Tw: 500n * U + 50n, Tm: 0n, Tr: 0n, Sh: 0n }, { cap: C, maxPairsBase: 30_000n * U, walletDollars: 10n ** 12n });
    expect(p.mintQ).toBe(6_500n * U); // 7,000 - 500.00005 -> 6,499.99995 -> 6,500 whole tokens
    expect(p.mintCost).toBe(6_500n * C);
    expect(p.depositT).toBe(7_000n * U);
    expect(p.asks).toEqual(asks);
  });
  test("the pairs cap cuts the mint and the asks from the outermost level", () => {
    const p = planTokens(asks, { Tw: 0n, Tm: 0n, Tr: 0n, Sh: 28_000n * U }, { cap: C, maxPairsBase: 30_000n * U, walletDollars: 10n ** 12n });
    expect(p.mintQ).toBe(2_000n * U);
    expect(p.capped).toBe(true);
    expect(p.asks).toEqual([
      { price: 3_640_000n, size: 1_000n * T },
      { price: 3_650_000n, size: 1_000n * T },
    ]);
  });
  test("the wallet's dollars cap the mint", () => {
    const p = planTokens(asks, { Tw: 0n, Tm: 0n, Tr: 0n, Sh: 0n }, { cap: C, maxPairsBase: 30_000n * U, walletDollars: 1_500n * C + 1n });
    expect(p.mintQ).toBe(1_500n * U);
    expect(p.asks.reduce((s, a) => s + a.size, 0n)).toBe(1_500n * T);
  });
});

describe("planDollars", () => {
  const lock = bids.reduce((s, b) => s + lockOf(b), 0n);
  test("one deposit for every due book: the positive needs minus the pool, plus the buffer", () => {
    const p = planDollars(
      [
        { market: "a", bids, currentBidLock: 0n },
        { market: "b", bids, currentBidLock: lock },
      ],
      { marginDollars: 0n, walletDollars: 10n ** 13n, mintCosts: 0n, bufferU: 100n },
    );
    expect(p.deposit).toBe(lock + 100n);
    expect(p.short).toBe(false);
    expect(p.bids.get("a")).toEqual(bids);
  });
  test("a book that frees dollars after one that needs them still works in that order (cancel-first per book)", () => {
    const big = [{ price: 3_000_000n, size: 3_000n * T }];
    const p = planDollars(
      [
        { market: "needs", bids: big, currentBidLock: 0n },
        { market: "frees", bids: [], currentBidLock: lockOf(big[0]!) },
      ],
      { marginDollars: 0n, walletDollars: 10n ** 13n, mintCosts: 0n, bufferU: 0n },
    );
    expect(p.deposit).toBe(lockOf(big[0]!)); // the freed lock comes only after the first book's batch
    expect(p.bids.get("needs")).toEqual(big);
  });
  test("not enough in the wallet after the mints: the bids are cut from the outermost level", () => {
    const p = planDollars([{ market: "a", bids, currentBidLock: 0n }], { marginDollars: 0n, walletDollars: lockOf(bids[0]!) + 1_000n * C, mintCosts: 1_000n * C, bufferU: 10n ** 9n });
    expect(p.deposit).toBe(lockOf(bids[0]!));
    expect(p.short).toBe(true);
    expect(p.bids.get("a")).toEqual([bids[0]]);
  });
});

test("redeemable is min(Tw, Sh) floored to LOT", () => {
  expect(redeemable(1_050n, 2_000n)).toBe(1_000n);
  expect(redeemable(5_000n, 299n)).toBe(200n);
  expect(redeemable(0n, 10n)).toBe(0n);
});
