// AgateFactory (static, from the deployments file): SeriesListed registers the series and its token, MarketRecorded
// the Kuru V1 book (BOTS-SPEC 5.5; MS 8.1).
import { indexer } from "envio";
import { forwardId, low, orNone } from "../lib/ids.ts";
import { BAND_GRADE, VENUE, enumOf, labelOfSymbol } from "../lib/labels.ts";
import { refreshBook, refreshForward } from "../lib/market.ts";
import { clockAnchor, monthLabel } from "../lib/math.ts";
import { account, factoryInfo, priceIndex, seen } from "../lib/store.ts";

const KURU_V1 = 1n;

indexer.contractRegister({ contract: "AgateFactory", event: "SeriesListed" }, async ({ event, context }) => {
  if (!factoryInfo(event.srcAddress)) return; // only the deployments file's factories
  context.chain.AgateSeries.add(event.params.series);
  context.chain.AgateToken.add(event.params.token);
});

indexer.onEvent({ contract: "AgateFactory", event: "SeriesListed" }, async ({ event, context }) => {
  seen(event, context);
  const info = factoryInfo(event.srcAddress);
  if (!info) {
    context.log.warn("SeriesListed from a factory not in the deployments file", { factory: event.srcAddress });
    return;
  }
  const p = event.params;
  const t = BigInt(event.block.timestamp);
  const factory = low(event.srcAddress);
  const series = low(p.series);
  const token = low(p.token);
  const gpuId = low(p.gpuId);
  const month = Number(p.month);
  const startDay = Number(p.startDay);
  const n = Number(p.n);
  const day = Number(p.day);

  const ix = await priceIndex(context, info.index);
  const fac = await context.Factory.getOrCreate({
    id: factory,
    name: info.name,
    tag: info.tag,
    index_id: low(info.index),
    dollar: low(info.dollar),
    router: low(info.router),
    clockAnchor: undefined,
    day: undefined,
  });
  if (fac.clockAnchor === undefined) context.Factory.set({ ...fac, clockAnchor: clockAnchor(p.startTs, startDay, day), day });

  const label = labelOfSymbol(p.symbol, info.tag);
  const fwd = forwardId(factory, gpuId);
  await context.MarketForward.getOrCreate({
    id: fwd,
    factory_id: factory,
    gpuId,
    label,
    currentMonth: undefined,
    nearSeries_id: undefined,
    nextSeries_id: undefined,
    nearMarkU: undefined,
    nextMarkU: undefined,
    updatedAt: t,
  });

  context.Series.set({
    id: series,
    factory_id: factory,
    index_id: ix?.id ?? low(info.index),
    gpuId,
    label,
    month,
    monthLabel: monthLabel(month),
    token_id: token,
    name: p.name,
    symbol: p.symbol,
    startDay,
    n,
    startTs: p.startTs,
    endTs: p.startTs + BigInt(n) * BigInt(day),
    day,
    lastResort: p.lastResort,
    floor: p.floor,
    cap: p.cap,
    x0: p.x0,
    bandGrade: enumOf(BAND_GRADE, p.bandGrade, "bandGrade"),
    anchorCarried: Number(p.anchorCarried),
    anchorMinFresh: Number(p.anchorMinFresh),
    anchorLate: p.anchorLate,
    k: 0,
    sum: 0n,
    state: "LISTED",
    lastFixDay: undefined,
    ledger: 0n,
    tokenSupply: 0n,
    shortSupply: 0n,
    openPositions: 0,
    qInPositionsLong: 0n,
    qInPositionsShort: 0n,
    market_id: undefined,
    venue: "NONE",
    pricePoint_id: series,
    listedAt: t,
    listedBlock: BigInt(event.block.number),
  });
  context.Token.set({ id: token, series_id: series, supply: 0n });
  context.PricePoint.set({
    id: series,
    series_id: series,
    market_id: undefined,
    forward_id: fwd,
    gpuId,
    month,
    monthLabel: monthLabel(month),
    lastTradePriceU: undefined,
    lastTradeAt: undefined,
    bestBidU: undefined,
    bestAskU: undefined,
    midU: undefined,
    markU: undefined,
    markSource: "NONE",
    updatedAt: t,
  });
  await refreshForward(context, fwd, t);
});

indexer.contractRegister({ contract: "AgateFactory", event: "MarketRecorded" }, async ({ event, context }) => {
  if (!factoryInfo(event.srcAddress)) return;
  if (event.params.venue === KURU_V1) context.chain.KuruOrderBook.add(event.params.market);
});

indexer.onEvent({ contract: "AgateFactory", event: "MarketRecorded" }, async ({ event, context }) => {
  seen(event, context);
  if (!factoryInfo(event.srcAddress)) return;
  const p = event.params;
  const t = BigInt(event.block.timestamp);
  const series = low(p.series);
  const market = low(p.market);
  const previous = orNone(p.previous);
  const venue = enumOf(VENUE, p.venue, "venue");
  await account(context, p.by, t);

  // a replaced market keeps its orders and trades as history (MS 8.1); the same address under another venue stays current
  if (previous !== undefined && previous !== market) {
    const old = await context.Market.get(previous);
    if (old) context.Market.set({ ...old, current: false });
  }
  const cur = await context.Market.get(market);
  context.Market.set({
    id: market,
    series_id: series,
    venue,
    created: p.created,
    by: low(p.by),
    previous,
    current: true,
    state: cur?.state ?? "ACTIVE",
    recordedAt: t,
  });
  const s = await context.Series.get(series);
  if (s) context.Series.set({ ...s, market_id: market, venue });
  const pp = await context.PricePoint.get(series);
  if (pp) {
    // a new market starts its own book; the last trade stays as the series' last price
    context.PricePoint.set({ ...pp, market_id: market, bestBidU: undefined, bestAskU: undefined, updatedAt: t });
    await refreshBook(context, market, t);
  }
});
