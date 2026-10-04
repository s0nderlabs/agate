import { describe, expect, test } from "bun:test";
import { cent, fillOf, hourlyCandles, quoteOf, resolveGraphqlUrl, sortTrades, vwap } from "../src/client.ts";
import { DEFAULT_GRAPHQL_URL } from "../src/graphql.ts";
import type { TradeRow } from "../src/graphql.ts";

const T0 = 1_791_158_400; // 2026-10-05T00:00:00Z
const tr = (id: string, t: number, price: number, tokens: number, buy = true): TradeRow => ({ id, block: id.split("-")[0]!, timestamp: String(t), priceU: String(price), tokens: String(tokens), takerIsBuy: buy, maker: "0xm", taker: "0xt", txOrigin: "0xo", txHash: `0x${id}` });

describe("pure read helpers", () => {
  test("cent rounds half up to $0.01, as the index does", () => {
    expect(cent(3_994_999n)).toBe(3_990_000n);
    expect(cent(3_995_000n)).toBe(4_000_000n);
    expect(cent(0n)).toBe(0n);
  });

  test("the quote: top of book and the last trade; before a trade the mid on the tick, or the one side", () => {
    const book = { block: 1n, bids: [[3_950_000n, 1n]] as [bigint, bigint][], asks: [[4_030_000n, 1n]] as [bigint, bigint][] };
    expect(quoteOf(book, null, null)).toEqual({ bid: 3.95, ask: 4.03, last: 3.99, lastAt: null });
    expect(quoteOf(book, 4_030_000n, BigInt(T0))).toEqual({ bid: 3.95, ask: 4.03, last: 4.03, lastAt: "2026-10-05T00:00:00Z" });
    expect(quoteOf({ block: 1n, bids: [], asks: book.asks }, null, null)).toEqual({ bid: 0, ask: 4.03, last: 4.03, lastAt: null });
    expect(quoteOf(null, null, null)).toEqual({ bid: 0, ask: 0, last: 0, lastAt: null });
  });

  test("trades sort by block and log index (ids are <block>-<logIndex>, not lexicographic)", () => {
    const rows = [tr("100-10", T0, 1, 1), tr("100-9", T0, 1, 1), tr("99-20", T0, 1, 1)];
    expect(sortTrades(rows, "asc").map((r) => r.id)).toEqual(["99-20", "100-9", "100-10"]);
    expect(sortTrades(rows, "desc").map((r) => r.id)).toEqual(["100-10", "100-9", "99-20"]);
  });

  test("a fill: HH:MM UTC, the taker's side, dollars and GPU-hours", () => {
    expect(fillOf(tr("5-1", T0 + 3 * 3600 + 7 * 60, 4_030_000, 248_138_900))).toEqual({ time: "03:07", side: "buy", price: 4.03, size: 248.1389, at: "2026-10-05T03:07:00Z", txHash: "0x5-1" });
    expect(fillOf(tr("5-2", T0, 3_950_000, 1_000_000, false)).side).toBe("sell");
  });

  test("volume-weighted entry price", () => {
    expect(vwap([tr("1-0", T0, 4_000_000, 1_000_000), tr("1-1", T0, 4_100_000, 3_000_000)])).toBe(4.075);
    expect(vwap([])).toBe(0);
  });

  test("hourly candles from the first trade's hour to now; an hour without trades repeats the close with no volume", () => {
    const trades = [tr("1-0", T0 + 60, 4_030_000, 2_000_000), tr("1-1", T0 + 120, 4_050_000, 1_000_000), tr("2-0", T0 + 2 * 3600 + 5, 3_950_000, 500_000, false)];
    const c = hourlyCandles(trades, BigInt(T0 + 3 * 3600 + 10));
    expect(c).toEqual([
      { t: "2026-10-05T00:00:00Z", o: 4.03, h: 4.05, l: 4.03, c: 4.05, v: 3 },
      { t: "2026-10-05T01:00:00Z", o: 4.05, h: 4.05, l: 4.05, c: 4.05, v: 0 },
      { t: "2026-10-05T02:00:00Z", o: 3.95, h: 3.95, l: 3.95, c: 3.95, v: 0.5 },
      { t: "2026-10-05T03:00:00Z", o: 3.95, h: 3.95, l: 3.95, c: 3.95, v: 0 },
    ]);
    expect(hourlyCandles([], BigInt(T0))).toEqual([]);
  });

  test("the GraphQL URL: given, else NEXT_PUBLIC_AGATE_GRAPHQL_URL, else the local default; null reads the chain only", () => {
    const saved = process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
    delete process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
    expect(resolveGraphqlUrl()).toBe(DEFAULT_GRAPHQL_URL);
    expect(DEFAULT_GRAPHQL_URL).toBe("http://localhost:8080/v1/graphql");
    process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL = "https://indexer.example/v1/graphql";
    expect(resolveGraphqlUrl()).toBe("https://indexer.example/v1/graphql");
    expect(resolveGraphqlUrl("http://other/v1/graphql")).toBe("http://other/v1/graphql");
    expect(resolveGraphqlUrl(null)).toBeNull();
    if (saved === undefined) delete process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
    else process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL = saved;
  });
});
