import { describe, expect, test } from "bun:test";
import { DAILY_TRADES, DAILY_VOLUME, type DayState, decide, DUST_DOLLARS, IDLE_MIN, MAX_DOLLARS, MAX_SPREAD_PCT, type MarketView, maySent, MIN_DOLLARS, rollDay, saleUnits } from "../scripts/test-trader.ts";
import { WriteError } from "../src/writes.ts";
import { hoursOf, LOT, parseDollars, parseHours, U } from "../src/units.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const TODAY = "2026-10-12";
const HOUR = 3_600_000;
/** GPU-hours as token base units, and dollars per GPU-hour as u (exact for the decimal strings these tests use) */
const h = (hours: string) => parseHours(hours);
const usd = (dollars: string) => parseDollars(dollars);

const day = (o: Partial<DayState> = {}): DayState => ({ day: TODAY, trades: 0, volume: 0, lastTrade: {}, ...o });
const market = (o: Partial<MarketView> = {}): MarketView => ({ gpu: "H100", held: 0n, lastTradeAt: NOW - 2 * HOUR, bid: usd("3.95"), ask: usd("4.03"), ...o });
const mid = () => 0.5;

describe("the test trader's decision (one market, one pass)", () => {
  test("buys whole dollars from $10 to $20 at the best ask when it holds nothing and nobody traded for an hour", () => {
    const p = decide(market(), day(), NOW, mid);
    expect(p.action).toBe("buy");
    expect(p.dollars).toBe(15);
    expect(p.maxPrice).toBe(usd("4.03"));
    expect(decide(market(), day(), NOW, () => 0).dollars).toBe(MIN_DOLLARS);
    // the top of the range is reachable, and never passed
    expect(decide(market(), day(), NOW, () => 0.999_999).dollars).toBe(MAX_DOLLARS);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(decide(market(), day(), NOW, () => i / 1000).dollars!);
    expect([...seen].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  test("sells everything it holds at the best bid, so the position stays near zero", () => {
    const p = decide(market({ held: h("3.7221") }), day(), NOW, mid);
    expect(p.action).toBe("sell");
    expect(p.units).toBe(h("3.7221"));
    expect(p.minPrice).toBe(usd("3.95"));
  });

  test("every sale is a whole number of lots the writes take, never more than it holds", () => {
    for (const bid of ["3.95", "4.03", "4.07", "2.17", "5.5", "3", "7.45", "5.14"].map(usd)) {
      for (const held of [h("5.2"), h("100"), 3_722_147n, 4_914_004n, h("2.002"), h("2.0018")]) {
        const p = decide(market({ held, bid, ask: bid + usd("0.08") }), day(), NOW, mid);
        if (p.action !== "sell") continue;
        expect(p.units! % LOT).toBe(0n);
        expect(() => parseHours(p.units!)).not.toThrow();
        expect(p.units!).toBeLessThanOrEqual(held);
      }
    }
  });

  test("a holding already on the lot grid is sold whole (exact, no float rounding)", () => {
    // 2.002 * 10000 is 20019.999... as a float: a float floor would leave one lot behind
    for (const s of ["2.002", "2.0018", "2.0037", "4.9367"]) expect(saleUnits(h(s), usd("3.95"))).toBe(h(s));
    // off the grid: floored to the lot below
    expect(saleUnits(3_722_147n, usd("3.95"))).toBe(3_722_100n);
  });

  test("a sale is never above $20: a larger holding sells in parts", () => {
    const p = decide(market({ held: h("100") }), day(), NOW, mid);
    expect(p.action).toBe("sell");
    const value = hoursOf(p.units!) * 3.95;
    expect(value).toBeLessThanOrEqual(MAX_DOLLARS);
    expect(value).toBeGreaterThan(MAX_DOLLARS - 0.01);
  });

  test("dust under $2 is not sold: it buys instead (a holding is valued at the higher side of the book)", () => {
    expect(decide(market({ held: h("0.4") }), day(), NOW, mid).action).toBe("buy");
    expect(DUST_DOLLARS).toBe(2);
    // $2 exactly is a holding: it sells
    expect(decide(market({ held: h("0.5"), bid: usd("3.95"), ask: usd("4") }), day(), NOW, mid).action).toBe("sell");
    expect(decide(market({ held: h("0.4999"), bid: usd("3.95"), ask: usd("4") }), day(), NOW, mid).action).toBe("buy");
    // $1.975 at the bid but $2.015 at the ask: a holding, never bought on top of
    expect(decide(market({ held: h("0.5") }), day(), NOW, mid).action).toBe("sell");
  });

  test("a book far wider than the maker's quotes (a stray order at the top) is not traded", () => {
    expect(MAX_SPREAD_PCT).toBe(10);
    const stray = decide(market({ bid: usd("0.79") }), day(), NOW, mid);
    expect(stray.action).toBe("skip");
    expect(stray.reason).toContain("wider than 10%");
    expect(decide(market({ held: h("2.5"), bid: usd("0.79") }), day(), NOW, mid).action).toBe("skip");
    // the maker's own width (about 2%) and up to 10% trade
    expect(decide(market({ bid: usd("3.63"), ask: usd("4.03") }), day(), NOW, mid).action).toBe("buy");
  });

  test("a sale needs only bids and a buy only asks", () => {
    // holding, no ask: still sells to the bids
    expect(decide(market({ held: h("4"), ask: 0n }), day(), NOW, mid).action).toBe("sell");
    // holding, no bid: waits (it never buys more on top of a holding it cannot sell)
    expect(decide(market({ held: h("4"), bid: 0n }), day(), NOW, mid).reason).toBe("no bid to sell to");
    // holding nothing, no bid: still buys from the asks
    expect(decide(market({ bid: 0n }), day(), NOW, mid).action).toBe("buy");
    // holding nothing, no ask: waits
    expect(decide(market({ ask: 0n }), day(), NOW, mid).reason).toBe("no ask to buy from");
  });

  test("stays quiet when anyone traded in the last hour, itself included", () => {
    const p = decide(market({ lastTradeAt: NOW - 59 * 60_000 }), day(), NOW, mid);
    expect(p.action).toBe("skip");
    expect(p.reason).toContain("59m ago");
    expect(decide(market({ lastTradeAt: NOW - IDLE_MIN * 60_000 }), day(), NOW, mid).action).toBe("buy");
  });

  test("a month that has never traded is idle: it makes the first trade", () => {
    expect(decide(market({ lastTradeAt: null }), day(), NOW, mid).action).toBe("buy");
  });

  test("daily caps: 72 trades and $1,000 a UTC day, on buys and sales alike", () => {
    expect(decide(market(), day({ trades: DAILY_TRADES }), NOW, mid).action).toBe("skip");
    expect(decide(market(), day({ volume: DAILY_VOLUME }), NOW, mid).action).toBe("skip");
    // a buy that would cross the volume cap is skipped, not shrunk
    expect(decide(market(), day({ volume: DAILY_VOLUME - 12 }), NOW, mid).action).toBe("skip");
    expect(decide(market(), day({ volume: DAILY_VOLUME - 16 }), NOW, mid).action).toBe("buy");
    // a sale of ~$19.50 with $5 of room left is skipped too
    expect(decide(market({ held: h("4.9367") }), day({ volume: DAILY_VOLUME - 5 }), NOW, mid).action).toBe("skip");
    expect(decide(market({ held: h("4.9367") }), day({ volume: DAILY_VOLUME - 25 }), NOW, mid).action).toBe("sell");
  });

  test("a new UTC day resets the counts and keeps each market's last trade (the hour gate) and an unknown send's time", () => {
    const last = { H100: NOW - 30 * 60_000 };
    const r = rollDay({ day: "2026-10-11", trades: 72, volume: 999, lastTrade: last, uncertainAt: NOW - 60_000 }, NOW);
    expect(r).toEqual({ day: TODAY, trades: 0, volume: 0, lastTrade: last, uncertainAt: NOW - 60_000 });
    const same = day({ trades: 3 });
    expect(rollDay(same, NOW)).toBe(same);
  });
});

describe("a failed write: did it send?", () => {
  test("only a send, a missing receipt or a landed step may have sent something", () => {
    expect(maySent(new WriteError("price moved", "check", "PriceMoved"))).toBe(false);
    expect(maySent(new WriteError("reverts", "simulate"))).toBe(false);
    expect(maySent(new WriteError("no gas", "estimate"))).toBe(false);
    expect(maySent(new WriteError("timeout", "send"))).toBe(true);
    expect(maySent(new WriteError("sent, it may still land", "receipt", "NoReceipt"))).toBe(true);
    // a check after an approval landed: something was sent
    expect(maySent(new WriteError("refused", "check", undefined, undefined, { txs: [{} as never] }))).toBe(true);
    // a read or an amount refused before the write's first send (the client throws WriteError from its first send on)
    expect(maySent(new Error("The request took too long to respond."))).toBe(false);
  });
});
