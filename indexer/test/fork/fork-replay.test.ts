// The fork replay (BOTS-SPEC 5.7 item 5, E15): every raw log of the market fork e2e (wall/e2e, scripts/market-fork.ts)
// fed through Envio's simulate, and every entity compared with the chain's own views read at the run's last block:
// series state and supplies, token, short and dollar balances, positions and their payouts, the daily fixes of the
// real AgateIndex, every Kuru order the books created, each book's levels and the price points' best bid and ask.
// Runs only inside the configured copy that test/fork/run.ts makes (config.yaml and deployments.generated.ts of the
// fork's deployments file): AGATE_FORK_REPLAY=1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestIndexer } from "envio";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, type Hex } from "viem";
import { parseDeployments } from "../../scripts/config-gen.ts";
import { dayLabel, FIX_STATUS } from "../../src/lib/labels.ts";
import { abiOf, type RawLog } from "../ev.ts";
import { itemsFromLogs } from "../replay.ts";

const ON = process.env.AGATE_FORK_REPLAY === "1";
const DIR = process.env.AGATE_FORK_FIXTURE_DIR ?? join(import.meta.dirname, "fixtures");
const ZERO = "0x0000000000000000000000000000000000000000";

interface SeriesTruth {
  k: number;
  sum: string;
  ledger: string;
  shortSupply: string;
  token: string;
  tokenSupply: string;
  shorts: Record<string, string>;
  balances: Record<string, string>;
  positions: Record<string, { open: boolean; owner: string; payee: string; operator: string; side: number; q: string; paid: string; daily: boolean }>;
}
interface Fixture {
  forkBlock: number;
  indexStart: number;
  maker: string;
  payer: string;
  payees: string[];
  logs: RawLog[];
  truth: {
    block: number;
    series: Record<string, SeriesTruth>;
    dollar: Record<string, string>;
    markets: Record<string, string>;
    fixes: Record<string, { exists: boolean; isFinal: boolean; value: string; status: number; finalAt: string }>;
    orders: Record<string, { owner: string; remaining: string; price: string; isBuy: boolean; status: string }>;
    books: Record<string, { bestBid: string | null; bestAsk: string | null; bids: [string, string][]; asks: [string, string][] }>;
  };
}

type TI = ReturnType<typeof createTestIndexer>;

describe.skipIf(!ON)("fork replay of the market e2e (BOTS-SPEC 5.7 item 5)", () => {
  let indexer: TI;
  let fx: Fixture;
  let deployments: ReturnType<typeof parseDeployments>;
  let tEnd = 0n;

  beforeAll(async () => {
    fx = JSON.parse(readFileSync(join(DIR, "fork-lifecycle.json"), "utf8")) as Fixture;
    deployments = parseDeployments(JSON.parse(readFileSync(join(DIR, "fork-deployments.json"), "utf8")));
    tEnd = BigInt(fx.logs[fx.logs.length - 1]!.timestamp);
    indexer = createTestIndexer();
    const items = itemsFromLogs(deployments, fx.logs);
    expect(items.length).toBeGreaterThan(1_000);
    await indexer.process({ chains: { 10143: { simulate: items as never } } });
  }, 600_000);

  it("registers every series and token from SeriesListed and every Kuru V1 book from MarketRecorded", () => {
    const c = indexer.chains[10143];
    expect([...c.AgateSeries.addresses].sort()).toEqual(Object.keys(fx.truth.series).sort());
    expect([...c.AgateToken.addresses].sort()).toEqual(Object.values(fx.truth.series).map((s) => s.token).sort());
    expect([...c.KuruOrderBook.addresses].sort()).toEqual(Object.values(fx.truth.markets).sort());
  });

  it("every Series equals state(): k, sum, ledger, token and short supply, state, market", async () => {
    for (const [id, t] of Object.entries(fx.truth.series)) {
      const s = await indexer.Series.getOrThrow(id);
      expect({ id, k: s.k, sum: s.sum, ledger: s.ledger, tokenSupply: s.tokenSupply, shortSupply: s.shortSupply, market: s.market_id }).toEqual({
        id,
        k: t.k,
        sum: BigInt(t.sum),
        ledger: BigInt(t.ledger),
        tokenSupply: BigInt(t.tokenSupply),
        shortSupply: BigInt(t.shortSupply),
        market: fx.truth.markets[id],
      });
      expect(s.state).toBe(t.k === s.n ? "FINAL" : t.k === 0 ? "LISTED" : "ACCRUING");
      expect((await indexer.Token.getOrThrow(t.token)).supply).toBe(BigInt(t.tokenSupply));
    }
  });

  it("every token and short balance equals balanceOf and shortOf", async () => {
    const tbs = await indexer.TokenBalance.getAll();
    const sbs = await indexer.ShortBalance.getAll();
    for (const [id, t] of Object.entries(fx.truth.series)) {
      const tb = tbs.filter((b) => b.series_id === id && b.balance !== 0n);
      expect(Object.fromEntries(tb.map((b) => [b.account_id, b.balance.toString()]))).toEqual(t.balances);
      const sb = sbs.filter((b) => b.series_id === id && b.balance !== 0n);
      expect(Object.fromEntries(sb.map((b) => [b.account_id, b.balance.toString()]))).toEqual(t.shorts);
    }
  });

  it("every dollar balance equals the dollar's balanceOf", async () => {
    const db = (await indexer.DollarBalance.getAll()).filter((b) => b.dollar === deployments.dollar && b.balance !== 0n);
    expect(Object.fromEntries(db.map((b) => [b.account_id, b.balance.toString()]))).toEqual(fx.truth.dollar);
  });

  it("every position: owner, payee, operator, side, q, paid, daily and status; open counts per series", async () => {
    let open = 0;
    let closed = 0;
    for (const [id, t] of Object.entries(fx.truth.series)) {
      for (const [pid, p] of Object.entries(t.positions)) {
        const pos = await indexer.Position.getOrThrow(`${id}-${pid}`);
        if (p.open) {
          open++;
          expect({ pid, status: pos.status, owner: pos.owner_id, paid: pos.paid, payee: pos.payee_id, operator: pos.operator_id ?? ZERO, side: pos.side, q: pos.q, daily: pos.daily }).toEqual({
            pid,
            status: "OPEN",
            owner: p.owner,
            paid: BigInt(p.paid),
            payee: p.payee,
            operator: p.operator,
            side: p.side === 0 ? "LONG" : "SHORT",
            q: BigInt(p.q),
            daily: p.daily,
          });
        } else {
          closed++;
          expect(pos.status).not.toBe("OPEN");
        }
      }
      expect((await indexer.Series.getOrThrow(id)).openPositions).toBe(Object.values(t.positions).filter((p) => p.open).length);
    }
    expect(open).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(100);
  });

  it("payouts: each payee's claims add up to its dollar balance (the payees receive nothing else), and every claim row matches its event", async () => {
    const claims = await indexer.Claim.getAll();
    const byPayee = new Map<string, bigint>();
    for (const c of claims) byPayee.set(c.payee_id, (byPayee.get(c.payee_id) ?? 0n) + c.amount);
    for (const p of fx.payees) expect({ p, sum: byPayee.get(p) ?? 0n }).toEqual({ p, sum: BigInt(fx.truth.dollar[p] ?? "0") });
    const n = fx.logs.filter((l) => Object.keys(fx.truth.series).includes(l.address) && safeName("AgateSeries", l) === "Claimed").length;
    expect(claims.length).toBe(n);
    expect(n).toBeGreaterThan(1_000);
  });

  it("every daily fix the index closed: value, status and finalAt equal record(); the app's label is final exactly for the final days", async () => {
    const keys = Object.keys(fx.truth.fixes);
    expect(keys.length).toBeGreaterThan(90);
    for (const k of keys) {
      const t = fx.truth.fixes[k]!;
      const d = await indexer.DailyFix.getOrThrow(k);
      expect({ k, value: d.value, status: d.status, finalAt: d.finalAt }).toEqual({ k, value: BigInt(t.value), status: FIX_STATUS[t.status], finalAt: BigInt(t.finalAt) });
      expect({ k, label: dayLabel(d, tEnd) }).toEqual({ k, label: t.isFinal ? "final" : "pending" });
    }
    // the fork's index registers six GPUs (fork-demo.json, wall spec 18); the market's forward curves stay three (below)
    expect((await indexer.IndexGpu.getAll()).length).toBe(6);
  });

  it("every Kuru order the books created: status and remaining as s_orders says (a filled order whose slot a later cancel deleted is FILLED here)", async () => {
    const trades = await indexer.Trade.getAll();
    const filledByTrade = new Set(trades.filter((t) => t.makerRemaining === 0n).map((t) => `${t.market_id}-${t.orderId}`));
    let active = 0;
    for (const [id, o] of Object.entries(fx.truth.orders)) {
      const b = await indexer.BookOrder.getOrThrow(id);
      // Kuru deletes a cancelled order's slot (owner and price read 0), so only a live slot can be compared field by field
      if (o.status !== "CANCELED") expect({ id, owner: b.owner, price: b.price, isBuy: b.isBuy }).toEqual({ id, owner: o.owner, price: BigInt(o.price), isBuy: o.isBuy });
      if (o.status === "ACTIVE") {
        active++;
        expect({ id, status: b.status, remaining: b.remaining }).toEqual({ id, status: "ACTIVE", remaining: BigInt(o.remaining) });
      } else if (o.status === "FILLED") {
        expect({ id, status: b.status }).toEqual({ id, status: "FILLED" });
      } else {
        expect({ id, status: b.status }).toEqual({ id, status: filledByTrade.has(id) ? "FILLED" : "CANCELED" });
      }
    }
    expect(active).toBeGreaterThan(20);
  });

  it("each book's resting levels equal getL2Book, and every price point's best bid and ask equal the book's", async () => {
    const levels = await indexer.BookLevel.getAll();
    for (const [market, bk] of Object.entries(fx.truth.books)) {
      const mine = levels.filter((l) => l.market_id === market && l.size > 0n);
      const bids = mine.filter((l) => l.side === "BID").sort((a, b) => Number(b.price - a.price)).map((l) => [l.price.toString(), l.size.toString()]);
      const asks = mine.filter((l) => l.side === "ASK").sort((a, b) => Number(a.price - b.price)).map((l) => [l.price.toString(), l.size.toString()]);
      expect({ market, bids, asks }).toEqual({ market, bids: bk.bids, asks: bk.asks });
    }
    for (const [series, market] of Object.entries(fx.truth.markets)) {
      const pp = await indexer.PricePoint.getOrThrow(series);
      const bk = fx.truth.books[market]!;
      expect({ series, bid: pp.bestBidU ?? null, ask: pp.bestAskU ?? null }).toEqual({ series, bid: bk.bestBid === null ? null : BigInt(bk.bestBid), ask: bk.bestAsk === null ? null : BigInt(bk.bestAsk) });
    }
  });

  it("trades, candles and marks: one Trade row per Trade event, candles sum to them, a traded series is marked by its last trade while the live book holds it, else by the mid (audit M-1)", async () => {
    const books = new Set(Object.values(fx.truth.markets));
    const n = fx.logs.filter((l) => books.has(l.address) && safeName("KuruOrderBook", l) === "Trade").length;
    const trades = await indexer.Trade.getAll();
    expect(trades.length).toBe(n);
    expect(n).toBeGreaterThan(10);
    const candles = await indexer.DailyCandle.getAll();
    expect(candles.reduce((a, c) => a + c.trades, 0)).toBe(n);
    expect(candles.reduce((a, c) => a + c.volumeTokens, 0n)).toBe(trades.reduce((a, t) => a + t.tokens, 0n));
    for (const series of new Set(trades.map((t) => t.series_id))) {
      const last = trades.filter((t) => t.series_id === series).sort((a, b) => Number(a.block - b.block) || Number(BigInt(a.id.split("-")[1]!) - BigInt(b.id.split("-")[1]!))).pop()!;
      const pp = await indexer.PricePoint.getOrThrow(series);
      expect(pp.lastTradePriceU).toBe(last.priceU);
      const outside = pp.bestBidU !== undefined && pp.bestAskU !== undefined && (last.priceU < pp.bestBidU || last.priceU > pp.bestAskU);
      const want = outside ? { source: "MID", mark: (pp.bestBidU! + pp.bestAskU!) / 2n / 10_000n * 10_000n } : { source: "TRADE", mark: last.priceU };
      expect({ series, source: pp.markSource, mark: pp.markU }).toEqual({ series, ...want });
    }
  });

  it("the forward curve of each GPU: the open months (Nov near, Dec next) with the series' own marks", async () => {
    const fwds = await indexer.MarketForward.getAll();
    expect(fwds.length).toBe(3);
    const series = await indexer.Series.getAll();
    for (const f of fwds) {
      const mine = series.filter((s) => s.gpuId === f.gpuId);
      const nov = mine.find((s) => s.monthLabel === "2026-11")!;
      const dec = mine.find((s) => s.monthLabel === "2026-12")!;
      expect({ gpu: f.label, near: f.nearSeries_id, next: f.nextSeries_id, month: f.currentMonth }).toEqual({ gpu: f.label, near: nov.id, next: dec.id, month: nov.month });
      expect(f.nearMarkU).toBe((await indexer.PricePoint.getOrThrow(nov.id)).markU);
      expect(f.nextMarkU).toBe((await indexer.PricePoint.getOrThrow(dec.id)).markU);
    }
  });
});

function safeName(contract: "AgateSeries" | "KuruOrderBook", l: RawLog): string | null {
  try {
    return decodeEventLog({ abi: abiOf(contract), data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }).eventName ?? null;
  } catch {
    return null;
  }
}
