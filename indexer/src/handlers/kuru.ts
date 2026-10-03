// Kuru V1 OrderBook markets (dynamic, registered by MarketRecorded with venue KURU_V1): the resting book, trades,
// daily candles and the series' price point (BOTS-SPEC 5.5; MS 8.5). Best effort by design: the live book is
// getL2Book(); Kuru's AMM vault has no orders here, so a Trade on an unknown order id only adds the row and the candle.
import { indexer, type Entity } from "envio";
import { candleId, eventId, low, orderKey } from "../lib/ids.ts";
import { KURU_STATE, enumOr } from "../lib/labels.ts";
import { moveLevel, refreshBook } from "../lib/market.ts";
import { U, dayIdAt, clockAnchor, notionalU, sizeToTokens, tradePriceU } from "../lib/math.ts";
import { account, seen, type Ctx } from "../lib/store.ts";

type BookOrder = Entity<"BookOrder">;

async function marketOf(context: Ctx, src: string) {
  const m = await context.Market.get(low(src));
  if (!m) context.log.warn("event from a market that was never recorded", { market: src });
  return m;
}

/** Sets an order's remaining and status, moving its level by the change (signed, so an update that grows a flip
 *  order is followed too). Only an ACTIVE order moves the book. */
async function updateOrder(context: Ctx, o: BookOrder, remaining: bigint, status: BookOrder["status"], t: bigint): Promise<void> {
  if (o.status !== "ACTIVE") return;
  const left = status === "ACTIVE" ? remaining : 0n;
  await moveLevel(context, o.market_id, o.isBuy, o.price, left - o.remaining, status === "ACTIVE" ? 0 : -1);
  context.BookOrder.set({ ...o, remaining: left, status, updatedAt: t });
}

async function cancelIds(context: Ctx, market: string, ids: readonly bigint[], t: bigint, withFlipped: boolean): Promise<void> {
  for (const id of ids) {
    if (id === 0n) continue;
    const o = await context.BookOrder.get(orderKey(market, id));
    if (!o) continue;
    await updateOrder(context, o, 0n, "CANCELED", t);
    if (withFlipped && o.flippedId !== undefined && o.flippedId !== 0n) {
      const f = await context.BookOrder.get(orderKey(market, o.flippedId));
      if (f) await updateOrder(context, f, 0n, "CANCELED", t);
    }
  }
}

async function created(
  context: Ctx,
  ev: { srcAddress: string; block: { timestamp: number } },
  p: { orderId: bigint; owner: string; size: bigint; price: bigint; isBuy: boolean; flippedId?: bigint; flippedPrice?: bigint },
  isFlip: boolean,
): Promise<void> {
  const m = await marketOf(context, ev.srcAddress);
  if (!m) return;
  const t = BigInt(ev.block.timestamp);
  await account(context, p.owner, t);
  const id = orderKey(m.id, p.orderId);
  if (await context.BookOrder.get(id)) return; // an order id is created once
  context.BookOrder.set({
    id,
    market_id: m.id,
    series_id: m.series_id,
    orderId: p.orderId,
    owner: low(p.owner),
    isBuy: p.isBuy,
    price: p.price,
    size: p.size,
    remaining: p.size,
    status: "ACTIVE",
    isFlip,
    flippedId: p.flippedId,
    flippedPrice: p.flippedPrice,
    createdAt: t,
    updatedAt: t,
  });
  await moveLevel(context, m.id, p.isBuy, p.price, p.size, 1);
  await refreshBook(context, m.id, t);
}

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCreated" }, async ({ event, context }) => {
  seen(event, context);
  await created(context, event, event.params, false);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "FlipOrderCreated" }, async ({ event, context }) => {
  seen(event, context);
  await created(context, event, event.params, true);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "FlippedOrderCreated" }, async ({ event, context }) => {
  seen(event, context);
  await created(context, event, event.params, true);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "OrderCanceled" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  const t = BigInt(event.block.timestamp);
  await cancelIds(context, m.id, [event.params.orderId], t, false);
  await refreshBook(context, m.id, t);
});

// The deployed implementation emits OrderCanceled per order and OrdersCanceled per call: each id is cancelled once.
indexer.onEvent({ contract: "KuruOrderBook", event: "OrdersCanceled" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  const t = BigInt(event.block.timestamp);
  await cancelIds(context, m.id, event.params.orderId, t, false);
  await refreshBook(context, m.id, t);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "FlipOrdersCanceled" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  const t = BigInt(event.block.timestamp);
  await cancelIds(context, m.id, event.params.orderIds, t, true);
  await refreshBook(context, m.id, t);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "FlipOrderUpdated" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  const t = BigInt(event.block.timestamp);
  const o = await context.BookOrder.get(orderKey(m.id, event.params.orderId));
  if (!o) return;
  const size = event.params.size;
  await updateOrder(context, o, size, size === 0n ? "FILLED" : "ACTIVE", t);
  await refreshBook(context, m.id, t);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "Trade" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  const t = BigInt(event.block.timestamp);
  const p = event.params;
  const priceU = tradePriceU(p.price);
  const tokens = sizeToTokens(p.filledSize);
  const notional = notionalU(priceU, p.filledSize);
  for (const a of [p.makerAddress, p.takerAddress, p.txOrigin]) await account(context, a, t);
  const s = await context.Series.get(m.series_id);
  const dayId = s ? dayIdAt(clockAnchor(s.startTs, s.startDay, s.day), s.day, t) : 0;

  context.Trade.set({
    id: eventId(event.block.number, event.logIndex),
    market_id: m.id,
    series_id: m.series_id,
    orderId: p.orderId,
    maker: low(p.makerAddress),
    taker: low(p.takerAddress),
    txOrigin: low(p.txOrigin),
    takerIsBuy: p.isBuy,
    priceU,
    tokens,
    notionalU: notional,
    makerRemaining: p.updatedSize,
    dayId,
    timestamp: t,
    block: BigInt(event.block.number),
    txHash: event.transaction.hash,
  });

  const o = await context.BookOrder.get(orderKey(m.id, p.orderId));
  if (o) await updateOrder(context, o, p.updatedSize, p.updatedSize === 0n ? "FILLED" : "ACTIVE", t);

  // the candles follow the series' current market only, as its price point does (audit L-3): a replaced book's late
  // fills stay in Trade, never in the chart
  if (!m.current) {
    await refreshBook(context, m.id, t, priceU);
    return;
  }
  const cid = candleId(m.series_id, dayId);
  const c = await context.DailyCandle.get(cid);
  const volumeTokens = (c?.volumeTokens ?? 0n) + tokens;
  const sumNotional = (c?.notionalU ?? 0n) + notional;
  context.DailyCandle.set({
    id: cid,
    series_id: m.series_id,
    dayId,
    open: c?.open ?? priceU,
    high: c === undefined || priceU > c.high ? priceU : c.high,
    low: c === undefined || priceU < c.low ? priceU : c.low,
    close: priceU,
    volumeTokens,
    notionalU: sumNotional,
    vwapU: volumeTokens === 0n ? priceU : (sumNotional * U) / volumeTokens,
    trades: (c?.trades ?? 0) + 1,
  });
  await refreshBook(context, m.id, t, priceU);
});

indexer.onEvent({ contract: "KuruOrderBook", event: "MarketStateUpdated" }, async ({ event, context }) => {
  seen(event, context);
  const m = await marketOf(context, event.srcAddress);
  if (!m) return;
  // Kuru's markets are proxies Kuru can upgrade: a state this table does not know is read as HARD_PAUSED (nothing
  // trades) and logged, never a throw that would halt indexing for every market (audit L-5)
  const st = enumOr(KURU_STATE, event.params.newState, "HARD_PAUSED");
  if (!st.known) context.log.warn("unknown Kuru market state, read as HARD_PAUSED", { market: m.id, state: event.params.newState.toString() });
  context.Market.set({ ...m, state: st.name });
});
