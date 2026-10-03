// Kuru V1 book handlers: orders and levels, best bid and ask after each change, cancels (OrderCanceled plus
// OrdersCanceled idempotence), partial and full fills, flip orders, a Trade with an unknown order id, candles across
// a day boundary, market state.
import { createTestIndexer } from "envio";
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_DAY, SEP20, demoTs, listed, recorded } from "./build.ts";
import { ev } from "./ev.ts";
import { market, series, token, user } from "./world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const M = market(1);
const S = series(1);
const V = 10n ** 12n; // Trade.price = u per token x 10^12
let blk = 200;
let ts = demoTs(SEP20) + 1_000;
const k = (name: string, args: Record<string, unknown>, o: { ts?: number } = {}) => ev("KuruOrderBook", name, args, { src: M, block: blk++, ts: o.ts ?? (ts += 2) });
const create = (orderId: number, isBuy: boolean, price: number, size: bigint, owner = user(1)) => k("OrderCreated", { orderId, owner, size, price, isBuy });
const trade = (orderId: number, makerIsBid: boolean, price: number, updatedSize: bigint, filledSize: bigint, o: { ts?: number } = {}) =>
  k("Trade", { orderId, makerAddress: user(1), isBuy: !makerIsBid, price: BigInt(price) * V, updatedSize, takerAddress: user(2), txOrigin: user(3), filledSize }, o);

let i: TI;
async function book() {
  const pp = await i.PricePoint.getOrThrow(S);
  return { bid: pp.bestBidU, ask: pp.bestAskU, mid: pp.midU, mark: pp.markU, src: pp.markSource };
}
const level = async (side: "bid" | "ask", price: number) => i.BookLevel.get(`${M}-${side}-${price}`);

beforeEach(async () => {
  i = createTestIndexer();
  blk = 200;
  ts = demoTs(SEP20) + 1_000;
  await run(i, [listed({ series: S, token: token(1), block: 100 }), recorded({ series: S, market: M, block: 101 })]);
});

describe("the resting book", () => {
  it("OrderCreated: the order, its level, best bid and ask and the mid after each change", async () => {
    await run(i, [create(1, true, 1_950_000, 20_000_000n)]);
    expect(await i.BookOrder.getOrThrow(`${M}-1`)).toMatchObject({ market_id: M, series_id: S, owner: user(1), isBuy: true, price: 1_950_000n, size: 20_000_000n, remaining: 20_000_000n, status: "ACTIVE", isFlip: false });
    expect(await level("bid", 1_950_000)).toMatchObject({ side: "BID", size: 20_000_000n, orders: 1 });
    expect(await book()).toEqual({ bid: 1_950_000n, ask: undefined, mid: undefined, mark: undefined, src: "NONE" });
    await run(i, [create(2, false, 2_050_000, 10_000n)]);
    expect(await book()).toEqual({ bid: 1_950_000n, ask: 2_050_000n, mid: 2_000_000n, mark: 2_000_000n, src: "MID" });
    await run(i, [create(3, true, 1_960_000, 10_000n), create(4, true, 1_960_000, 30_000n), create(5, false, 2_030_000, 10_000n)]);
    expect(await level("bid", 1_960_000)).toMatchObject({ size: 40_000n, orders: 2 });
    expect(await book()).toEqual({ bid: 1_960_000n, ask: 2_030_000n, mid: 1_990_000n, mark: 1_990_000n, src: "MID" }); // 1.995 floored to the tick
  });

  it("OrderCanceled then OrdersCanceled for the same id moves the level once; id 0 is ignored", async () => {
    await run(i, [create(1, true, 1_950_000, 50_000n), create(2, true, 1_950_000, 20_000n), create(3, true, 1_900_000, 10_000n)]);
    await run(i, [
      k("OrderCanceled", { orderId: 1, owner: user(1), price: 1_950_000, size: 50_000n, isBuy: true }),
      k("OrdersCanceled", { orderId: [1n, 0n], owner: user(1) }),
    ]);
    expect((await i.BookOrder.getOrThrow(`${M}-1`)).status).toBe("CANCELED");
    expect((await i.BookOrder.getOrThrow(`${M}-1`)).remaining).toBe(0n);
    expect(await level("bid", 1_950_000)).toMatchObject({ size: 20_000n, orders: 1 });
    await run(i, [k("OrdersCanceled", { orderId: [2n, 3n], owner: user(1) })]);
    expect(await level("bid", 1_950_000)).toBeUndefined(); // an emptied level is deleted
    expect(await book()).toMatchObject({ bid: undefined, src: "NONE" });
  });

  it("partial then full fills: remaining, FILLED, the level, the trade row and the mark", async () => {
    await run(i, [create(1, false, 2_050_000, 30_000n), create(2, false, 2_100_000, 10_000n), create(3, true, 1_950_000, 10_000n)]);
    await run(i, [trade(1, false, 2_050_000, 20_000n, 10_000n)]);
    expect(await i.BookOrder.getOrThrow(`${M}-1`)).toMatchObject({ remaining: 20_000n, status: "ACTIVE" });
    expect(await level("ask", 2_050_000)).toMatchObject({ size: 20_000n, orders: 1 });
    const [t] = await i.Trade.getAll();
    expect(t).toMatchObject({ market_id: M, series_id: S, orderId: 1n, maker: user(1), taker: user(2), txOrigin: user(3), takerIsBuy: true, priceU: 2_050_000n, tokens: 1_000_000n, notionalU: 2_050_000n, makerRemaining: 20_000n });
    expect(await book()).toEqual({ bid: 1_950_000n, ask: 2_050_000n, mid: 2_000_000n, mark: 2_050_000n, src: "TRADE" });
    for (const a of [user(1), user(2), user(3)]) expect(await i.Account.get(a)).toBeDefined(); // maker, taker, txOrigin
    await run(i, [trade(1, false, 2_050_000, 0n, 20_000n), trade(2, false, 2_100_000, 0n, 10_000n)]);
    expect((await i.BookOrder.getOrThrow(`${M}-1`)).status).toBe("FILLED");
    expect(await level("ask", 2_050_000)).toBeUndefined();
    expect(await level("ask", 2_100_000)).toBeUndefined();
    expect(await book()).toEqual({ bid: 1_950_000n, ask: undefined, mid: undefined, mark: 2_100_000n, src: "TRADE" });
    expect((await i.PricePoint.getOrThrow(S)).lastTradePriceU).toBe(2_100_000n);
  });

  it("a Trade with an unknown order id (Kuru's vault) adds only the row and the candle", async () => {
    await run(i, [create(1, true, 1_950_000, 10_000n)]);
    await run(i, [trade(99, true, 1_990_000, 0n, 50_000n)]);
    expect((await i.Trade.getAll()).length).toBe(1);
    expect(await level("bid", 1_950_000)).toMatchObject({ size: 10_000n, orders: 1 });
    expect((await i.DailyCandle.getAll()).length).toBe(1);
    expect(await book()).toMatchObject({ bid: 1_950_000n, mark: 1_990_000n, src: "TRADE" });
  });

  it("flip orders: created, updated (level follows), the flipped order, and FlipOrdersCanceled with its flipped id", async () => {
    await run(i, [
      k("FlipOrderCreated", { orderId: 1, flippedId: 0, owner: user(4), size: 40_000n, price: 1_900_000, flippedPrice: 2_000_000, isBuy: true }),
      k("FlipOrderUpdated", { orderId: 1, size: 25_000n }),
      k("FlippedOrderCreated", { orderId: 2, flippedId: 1, owner: user(4), size: 15_000n, price: 2_000_000, flippedPrice: 1_900_000, isBuy: false }),
    ]);
    expect(await i.BookOrder.getOrThrow(`${M}-1`)).toMatchObject({ isFlip: true, remaining: 25_000n, flippedId: 0n, flippedPrice: 2_000_000n });
    expect(await level("bid", 1_900_000)).toMatchObject({ size: 25_000n, orders: 1 });
    expect(await level("ask", 2_000_000)).toMatchObject({ size: 15_000n, orders: 1 });
    await run(i, [k("FlipOrdersCanceled", { orderIds: [2n], owner: user(4) })]);
    expect((await i.BookOrder.getOrThrow(`${M}-2`)).status).toBe("CANCELED");
    expect((await i.BookOrder.getOrThrow(`${M}-1`)).status).toBe("CANCELED"); // order 2's flipped id
    expect(await i.BookLevel.getAll()).toEqual([]);
    await run(i, [k("FlipOrderCreated", { orderId: 3, flippedId: 0, owner: user(4), size: 10_000n, price: 1_800_000, flippedPrice: 1_900_000, isBuy: true }), k("FlipOrderUpdated", { orderId: 3, size: 0n })]);
    expect((await i.BookOrder.getOrThrow(`${M}-3`)).status).toBe("FILLED");
  });

  it("MarketStateUpdated", async () => {
    await run(i, [k("MarketStateUpdated", { previousState: 0, newState: 1 })]);
    expect((await i.Market.getOrThrow(M)).state).toBe("SOFT_PAUSED");
    await run(i, [k("MarketStateUpdated", { previousState: 1, newState: 2 })]);
    expect((await i.Market.getOrThrow(M)).state).toBe("HARD_PAUSED");
  });
});

describe("daily candles", () => {
  it("open, high, low, close, volume, vwap per series clock day, across a day boundary", async () => {
    const d0 = SEP20 + 3;
    const inDay = (d: number, s: number) => demoTs(d) + s;
    await run(i, [
      trade(50, true, 2_000_000, 0n, 10_000n, { ts: inDay(d0, 10) }), // 1 token at 2.00
      trade(51, true, 2_100_000, 0n, 30_000n, { ts: inDay(d0, 20) }), // 3 tokens at 2.10
      trade(52, true, 1_900_000, 0n, 10_000n, { ts: inDay(d0, DEMO_DAY - 1) }), // last second of the day
      trade(53, false, 2_200_000, 0n, 20_000n, { ts: inDay(d0 + 1, 0) }), // first second of the next
    ]);
    const c0 = await i.DailyCandle.getOrThrow(`${S}-${d0}`);
    expect(c0).toMatchObject({ dayId: d0, open: 2_000_000n, high: 2_100_000n, low: 1_900_000n, close: 1_900_000n, volumeTokens: 5_000_000n, notionalU: 10_200_000n, vwapU: 2_040_000n, trades: 3 });
    const c1 = await i.DailyCandle.getOrThrow(`${S}-${d0 + 1}`);
    expect(c1).toMatchObject({ open: 2_200_000n, high: 2_200_000n, low: 2_200_000n, close: 2_200_000n, volumeTokens: 2_000_000n, trades: 1 });
    expect((await i.Trade.getAll()).map((t) => t.dayId).sort()).toEqual([d0, d0, d0, d0 + 1]);
  });
});
