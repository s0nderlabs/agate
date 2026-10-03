// The derived market views (BOTS-SPEC 5.5, 5.6): resting levels, a series' price point and a GPU's forward curve.
// The pure parts are exported for unit tests; the context wrappers read and write the entities.
import { levelKey } from "./ids.ts";
import { dayIdAt, midU, monthOf } from "./math.ts";
import type { Ctx } from "./store.ts";

type Mark = { midU: bigint | undefined; markU: bigint | undefined; markSource: "TRADE" | "MID" | "NONE" };

/** Best bid (highest resting bid) and best ask (lowest resting ask) among levels with size > 0. */
export function bestOf(levels: readonly { side: string; price: bigint; size: bigint }[]): { bid: bigint | undefined; ask: bigint | undefined } {
  let bid: bigint | undefined;
  let ask: bigint | undefined;
  for (const l of levels) {
    if (l.size <= 0n) continue;
    if (l.side === "BID") bid = bid === undefined || l.price > bid ? l.price : bid;
    else ask = ask === undefined || l.price < ask ? l.price : ask;
  }
  return { bid, ask };
}

/** mid floored to the tick when both sides exist; mark = the last trade while it lies inside the live book (or a side
 *  is missing), else the mid, else none. A trade the book has moved away from is no price anyone can trade at (audit
 *  M-1: after the maker requotes on a new final day the last trade can sit outside the book for hours), so the forward
 *  curve ("the market's own" prices, Oct 2 13:55) shows the book's mid until someone trades again. */
export function markOf(lastTradePriceU: bigint | undefined, bid: bigint | undefined, ask: bigint | undefined): Mark {
  const mid = bid !== undefined && ask !== undefined ? midU(bid, ask) : undefined;
  const outside = lastTradePriceU !== undefined && bid !== undefined && ask !== undefined && (lastTradePriceU < bid || lastTradePriceU > ask);
  if (lastTradePriceU !== undefined && !outside) return { midU: mid, markU: lastTradePriceU, markSource: "TRADE" };
  if (mid !== undefined) return { midU: mid, markU: mid, markSource: "MID" };
  return { midU: undefined, markU: undefined, markSource: "NONE" };
}

/** The current and next month's series of one forward curve, at month m. */
export function forwardView(points: readonly { series_id: string; month: number; markU: bigint | undefined }[], m: number) {
  const near = points.find((p) => p.month === m);
  const next = points.find((p) => p.month === m + 1);
  return {
    currentMonth: m,
    nearSeries_id: near?.series_id,
    nextSeries_id: next?.series_id,
    nearMarkU: near?.markU,
    nextMarkU: next?.markU,
  };
}

/** Adds dSize resting units and dOrders orders to one level; an emptied level is deleted. */
export async function moveLevel(context: Ctx, market: string, isBuy: boolean, price: bigint, dSize: bigint, dOrders: number): Promise<void> {
  if (dSize === 0n && dOrders === 0) return;
  const id = levelKey(market, isBuy, price);
  const cur = await context.BookLevel.get(id);
  let size = (cur?.size ?? 0n) + dSize;
  let orders = (cur?.orders ?? 0) + dOrders;
  if (size < 0n) size = 0n;
  if (orders < 0) orders = 0;
  if (size === 0n && orders === 0) {
    if (cur) context.BookLevel.deleteUnsafe(id);
    return;
  }
  context.BookLevel.set({ id, market_id: market, side: isBuy ? "BID" : "ASK", price, size, orders });
}

/** Recomputes the price point of a market's series from its levels (only for the series' current market), then the
 *  marks of its forward curve. lastTrade: a trade just seen on this market. */
export async function refreshBook(context: Ctx, market: string, t: bigint, lastTrade?: bigint): Promise<void> {
  const m = await context.Market.get(market);
  if (!m || !m.current) return;
  const pp = await context.PricePoint.get(m.series_id);
  if (!pp) return;
  const { bid, ask } = bestOf(await context.BookLevel.getWhere({ market_id: { _eq: market } }));
  const lastTradePriceU = lastTrade ?? pp.lastTradePriceU;
  const next = {
    ...pp,
    market_id: market,
    lastTradePriceU,
    lastTradeAt: lastTrade !== undefined ? t : pp.lastTradeAt,
    bestBidU: bid,
    bestAskU: ask,
    ...markOf(lastTradePriceU, bid, ask),
    updatedAt: t,
  };
  context.PricePoint.set(next);
  await markForward(context, next.forward_id, next.series_id, next.markU, t);
}

/** Copies one series' mark into its forward curve when it is the near or next month there. */
export async function markForward(context: Ctx, forward: string, series: string, markU: bigint | undefined, t: bigint): Promise<void> {
  const f = await context.MarketForward.get(forward);
  if (!f) return;
  if (f.nearSeries_id === series && f.nearMarkU !== markU) context.MarketForward.set({ ...f, nearMarkU: markU, updatedAt: t });
  else if (f.nextSeries_id === series && f.nextMarkU !== markU) context.MarketForward.set({ ...f, nextMarkU: markU, updatedAt: t });
}

/** Recomputes a forward curve's months at chain time t from its factory's clock (5.6). */
export async function refreshForward(context: Ctx, forward: string, t: bigint): Promise<void> {
  const f = await context.MarketForward.get(forward);
  if (!f) return;
  const fac = await context.Factory.get(f.factory_id);
  if (!fac || fac.clockAnchor === undefined || fac.day === undefined) return;
  const view = forwardView(await context.PricePoint.getWhere({ forward_id: { _eq: forward } }), monthOf(dayIdAt(fac.clockAnchor, fac.day, t)));
  if (
    view.currentMonth === f.currentMonth &&
    view.nearSeries_id === f.nearSeries_id &&
    view.nextSeries_id === f.nextSeries_id &&
    view.nearMarkU === f.nearMarkU &&
    view.nextMarkU === f.nextMarkU
  ) {
    return;
  }
  context.MarketForward.set({ ...f, ...view, updatedAt: t });
}
