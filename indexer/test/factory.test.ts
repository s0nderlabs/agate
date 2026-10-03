// AgateFactory handlers: SeriesListed (registration, the series, its token, price point and forward curve) and
// MarketRecorded (registration of KURU_V1 books only, replaced markets).
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { DEMO_ANCHOR, DEMO_DAY, NOV, OCT, SEP20, demoTs, listed, recorded } from "./build.ts";
import { ev } from "./ev.ts";
import { DEMO, H200, PILOT, REAL, market, series, token, user } from "./world.ts";

const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });

describe("SeriesListed", () => {
  it("registers the series and its token and writes every term", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [listed({ series: series(1), token: token(1), block: 100 })]);
    expect(indexer.chains[10143].AgateSeries.addresses).toContain(series(1));
    expect(indexer.chains[10143].AgateToken.addresses).toContain(token(1));
    const s = await indexer.Series.getOrThrow(series(1));
    expect(s).toMatchObject({
      factory_id: DEMO.factory,
      index_id: DEMO.index,
      label: "H100",
      symbol: "dH100-NOV26",
      name: "agate H100 Nov 2026 demo",
      month: NOV,
      monthLabel: "2026-11",
      n: 30,
      day: DEMO_DAY,
      floor: 1_000_000n,
      cap: 4_000_000n,
      bandGrade: "RULE",
      k: 0,
      sum: 0n,
      state: "LISTED",
      ledger: 0n,
      tokenSupply: 0n,
      shortSupply: 0n,
      openPositions: 0,
      venue: "NONE",
      market_id: undefined,
      token_id: token(1),
      pricePoint_id: series(1),
      listedBlock: 100n,
    });
    expect(s.endTs - s.startTs).toBe(30n * BigInt(DEMO_DAY));
    expect(await indexer.Token.getOrThrow(token(1))).toEqual({ id: token(1), series_id: series(1), supply: 0n });
    const pp = await indexer.PricePoint.getOrThrow(series(1));
    expect(pp).toMatchObject({ markSource: "NONE", markU: undefined, forward_id: `${DEMO.factory}-${s.gpuId}`, month: NOV, monthLabel: "2026-11" });
    const f = await indexer.Factory.getOrThrow(DEMO.factory);
    expect(f).toMatchObject({ name: "demo", tag: "demo", index_id: DEMO.index, router: DEMO.router, clockAnchor: DEMO_ANCHOR, day: DEMO_DAY });
    expect(await indexer.PriceIndex.getOrThrow(DEMO.index)).toEqual({ id: DEMO.index, names: ["demo"], tPend: DEMO.tPend });
    // listed on the demo clock's Sep 20: the curve's months are September (nothing) and October (nothing): November is beyond
    const fw = await indexer.MarketForward.getOrThrow(pp.forward_id);
    expect(fw).toMatchObject({ factory_id: DEMO.factory, label: "H100", currentMonth: OCT - 1, nearSeries_id: undefined, nextSeries_id: undefined });
  });

  it("puts the current and the next month on the forward curve", async () => {
    const indexer = createTestIndexer();
    const t = demoTs(SEP20 + 15); // Oct 5 on the demo clock
    await run(indexer, [
      listed({ series: series(1), token: token(1), block: 100, month: OCT, ts: t }),
      listed({ series: series(2), token: token(2), block: 101, month: NOV, ts: t + 1 }),
      listed({ series: series(3), token: token(3), block: 102, month: OCT, gpu: H200, label: "H200", ts: t + 2 }),
    ]);
    const fw = await indexer.MarketForward.getOrThrow(`${DEMO.factory}-${(await indexer.Series.getOrThrow(series(1))).gpuId}`);
    expect(fw).toMatchObject({ currentMonth: OCT, nearSeries_id: series(1), nextSeries_id: series(2) });
    expect((await indexer.MarketForward.getAll()).length).toBe(2);
    expect((await indexer.Series.getOrThrow(series(3))).label).toBe("H200");
  });

  it("labels: no tag on the real factory, a pilot tag letter", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [
      listed({ series: series(1), token: token(1), block: 100, factory: REAL, month: OCT }),
      listed({ series: series(2), token: token(2), block: 101, factory: PILOT, month: OCT }),
    ]);
    expect(await indexer.Series.getOrThrow(series(1))).toMatchObject({ symbol: "H100-OCT26", label: "H100", index_id: REAL.index });
    expect(await indexer.Series.getOrThrow(series(2))).toMatchObject({ symbol: "pH100-OCT26", label: "H100", index_id: PILOT.index });
    expect((await indexer.PriceIndex.getOrThrow(REAL.index)).names).toEqual(["real", "pilot"]);
    expect((await indexer.Factory.getOrThrow(REAL.factory)).clockAnchor).toBe(0n);
  });

  it("a series event is handled only after its SeriesListed", async () => {
    const indexer = createTestIndexer();
    const mint = (block: number) => ev("AgateSeries", "Minted", { payer: user(1), to: user(1), q: 1_000_000n, cost: 4_000_000n }, { src: series(1), block, ts: demoTs(SEP20) + block });
    await expect(run(indexer, [mint(100)])).rejects.toThrow(/never reached a handler/);
    const fresh = createTestIndexer();
    await run(fresh, [listed({ series: series(1), token: token(1), block: 100 }), mint(101)]);
    expect((await fresh.Series.getOrThrow(series(1))).ledger).toBe(4_000_000n);
    expect((await fresh.Mint.getAll()).length).toBe(1);
  });
});

describe("MarketRecorded", () => {
  it("records a KURU_V1 market and registers its book", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [listed({ series: series(1), token: token(1), block: 100 }), recorded({ series: series(1), market: market(1), block: 101, by: user(9) })]);
    expect(indexer.chains[10143].KuruOrderBook.addresses).toContain(market(1));
    expect(await indexer.Market.getOrThrow(market(1))).toMatchObject({ series_id: series(1), venue: "KURU_V1", created: true, by: user(9), previous: undefined, current: true, state: "ACTIVE" });
    expect(await indexer.Series.getOrThrow(series(1))).toMatchObject({ market_id: market(1), venue: "KURU_V1" });
    expect((await indexer.PricePoint.getOrThrow(series(1))).market_id).toBe(market(1));
    expect(await indexer.Account.get(user(9))).toBeDefined();
  });

  it("an OTHER venue is recorded but never registered as a Kuru book", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [
      listed({ series: series(1), token: token(1), block: 100, factory: PILOT, month: OCT }),
      recorded({ series: series(1), market: market(7), block: 101, venue: 2, created: false, factory: PILOT }),
    ]);
    expect(indexer.chains[10143].KuruOrderBook.addresses).not.toContain(market(7));
    expect(await indexer.Series.getOrThrow(series(1))).toMatchObject({ market_id: market(7), venue: "OTHER" });
  });

  it("a replaced market keeps its history and the series follows the new one", async () => {
    const indexer = createTestIndexer();
    const t = demoTs(SEP20) + 300;
    const book = (n: number, kind: string, args: Record<string, unknown>, block: number) => ev("KuruOrderBook", kind, args, { src: market(n), block, ts: t + block });
    await run(indexer, [
      listed({ series: series(1), token: token(1), block: 100 }),
      recorded({ series: series(1), market: market(1), block: 101 }),
      book(1, "OrderCreated", { orderId: 1, owner: user(1), size: 10_000n, price: 2_000_000, isBuy: true }, 102),
      book(1, "OrderCreated", { orderId: 2, owner: user(1), size: 10_000n, price: 2_100_000, isBuy: false }, 103),
      book(1, "Trade", { orderId: 2, makerAddress: user(1), isBuy: true, price: 2_100_000n * 10n ** 12n, updatedSize: 5_000n, takerAddress: user(2), txOrigin: user(2), filledSize: 5_000n }, 104),
      recorded({ series: series(1), market: market(2), block: 105, created: false, previous: market(1) }),
      book(1, "Trade", { orderId: 1, makerAddress: user(1), isBuy: false, price: 2_000_000n * 10n ** 12n, updatedSize: 0n, takerAddress: user(2), txOrigin: user(2), filledSize: 10_000n }, 106),
    ]);
    expect((await indexer.Market.getOrThrow(market(1))).current).toBe(false);
    expect(await indexer.Market.getOrThrow(market(2))).toMatchObject({ current: true, previous: market(1), created: false });
    expect((await indexer.Series.getOrThrow(series(1))).market_id).toBe(market(2));
    const pp = await indexer.PricePoint.getOrThrow(series(1));
    // the new book is empty; the last price stays the old market's last trade while it was current
    expect(pp).toMatchObject({ market_id: market(2), bestBidU: undefined, bestAskU: undefined, lastTradePriceU: 2_100_000n, markU: 2_100_000n, markSource: "TRADE" });
    expect((await indexer.Trade.getAll()).length).toBe(2); // the old market's later fill is still history
    expect((await indexer.BookOrder.getOrThrow(`${market(1)}-1`)).status).toBe("FILLED");
  });
});
