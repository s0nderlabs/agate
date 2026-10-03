// The local replay (BOTS-SPEC 5.7 item 4): every log of a scripted month on a local anvil (scripts/capture-local.ts)
// replayed through simulate; every Series ledger, k, sum and supply, every token, short and dollar balance, and every
// position's paid, payee and status must equal the chain's views at the last block.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestIndexer } from "envio";
import { beforeAll, describe, expect, it } from "vitest";
import { parseDeployments } from "../scripts/config-gen.ts";
import type { RawLog } from "./ev.ts";
import { itemsFromLogs } from "./replay.ts";

const FIX = join(import.meta.dirname, "fixtures");
const deployments = parseDeployments(JSON.parse(readFileSync(join(FIX, "deployments.test.json"), "utf8")));
const fixture = JSON.parse(readFileSync(join(FIX, "local-lifecycle.json"), "utf8")) as {
  logs: RawLog[];
  truth: {
    block: number;
    series: Record<
      string,
      {
        k: number;
        sum: string;
        ledger: string;
        shortSupply: string;
        token: string;
        tokenSupply: string;
        shorts: Record<string, string>;
        balances: Record<string, string>;
        positions: Record<string, { open: boolean; payee: string; operator: string; side: number; q: string; paid: string; daily: boolean }>;
      }
    >;
    dollar: Record<string, string>;
    markets: Record<string, string>;
  };
};
const truth = fixture.truth;
const ZERO = "0x0000000000000000000000000000000000000000";

type TI = ReturnType<typeof createTestIndexer>;
let indexer: TI;

describe("local replay of a scripted month", () => {
  beforeAll(async () => {
    indexer = createTestIndexer();
    const items = itemsFromLogs(deployments, fixture.logs);
    expect(items.length).toBeGreaterThan(300);
    await indexer.process({ chains: { 10143: { simulate: items as never } } });
  }, 120_000);

  it("registers every series, token and Kuru V1 market, and nothing else", () => {
    const c = indexer.chains[10143];
    const series = Object.keys(truth.series);
    expect([...c.AgateSeries.addresses].sort()).toEqual([...series].sort());
    expect([...c.AgateToken.addresses].sort()).toEqual(series.map((s) => truth.series[s]!.token).sort());
    const kuru = Object.values(truth.markets).filter((m) => m !== deployments.kuru.router); // the pilot's OTHER market is not a book
    expect([...c.KuruOrderBook.addresses].sort()).toEqual([...kuru].sort());
  });

  it("every Series equals state(): ledger, k, sum, token and short supply", async () => {
    for (const [id, t] of Object.entries(truth.series)) {
      const s = await indexer.Series.getOrThrow(id);
      expect({ id, k: s.k, sum: s.sum, ledger: s.ledger, tokenSupply: s.tokenSupply, shortSupply: s.shortSupply }).toEqual({
        id,
        k: t.k,
        sum: BigInt(t.sum),
        ledger: BigInt(t.ledger),
        tokenSupply: BigInt(t.tokenSupply),
        shortSupply: BigInt(t.shortSupply),
      });
      expect((await indexer.Token.getOrThrow(t.token)).supply).toBe(BigInt(t.tokenSupply));
      expect(s.state).toBe(t.k === s.n ? "FINAL" : t.k === 0 ? "LISTED" : "ACCRUING");
      expect(s.market_id).toBe(truth.markets[id] ?? undefined);
    }
  });

  it("every token and short balance equals balanceOf and shortOf", async () => {
    for (const [id, t] of Object.entries(truth.series)) {
      const tb = (await indexer.TokenBalance.getAll()).filter((b) => b.series_id === id && b.balance !== 0n);
      expect(Object.fromEntries(tb.map((b) => [b.account_id, b.balance.toString()]))).toEqual(t.balances);
      const sb = (await indexer.ShortBalance.getAll()).filter((b) => b.series_id === id && b.balance !== 0n);
      expect(Object.fromEntries(sb.map((b) => [b.account_id, b.balance.toString()]))).toEqual(t.shorts);
    }
  });

  it("every dollar balance equals the dollar's balanceOf", async () => {
    const db = (await indexer.DollarBalance.getAll()).filter((b) => b.dollar === deployments.dollar && b.balance !== 0n);
    expect(Object.fromEntries(db.map((b) => [b.account_id, b.balance.toString()]))).toEqual(truth.dollar);
  });

  it("every position: paid, payee, operator, daily and status", async () => {
    let n = 0;
    for (const [id, t] of Object.entries(truth.series)) {
      for (const [pid, p] of Object.entries(t.positions)) {
        const pos = await indexer.Position.getOrThrow(`${id}-${pid}`);
        n++;
        if (p.open) {
          expect({ status: pos.status, paid: pos.paid, payee: pos.payee_id, operator: pos.operator_id ?? ZERO, daily: pos.daily }).toEqual({
            status: "OPEN",
            paid: BigInt(p.paid),
            payee: p.payee,
            operator: p.operator,
            daily: p.daily,
          });
        } else {
          expect(pos.status).not.toBe("OPEN");
        }
      }
      const s = await indexer.Series.getOrThrow(id);
      expect(s.openPositions).toBe(Object.values(t.positions).filter((p) => p.open).length);
    }
    expect(n).toBeGreaterThanOrEqual(11);
  });

  it("the month ran end to end: 31 applied days, every close kind, a claim of 0, trades and candles", async () => {
    const oct = Object.entries(truth.series).find(([, t]) => t.k === 31)![0];
    const days = (await indexer.SeriesDay.getAll()).filter((d) => d.series_id === oct);
    expect(days.length).toBe(31);
    expect(days.some((d) => d.belowFloor) && days.some((d) => d.aboveCap) && days.some((d) => d.late) && days.some((d) => d.carried)).toBe(true);
    const positions = (await indexer.Position.getAll()).filter((p) => p.series_id === oct);
    for (const k of ["CLOSED_FINAL", "CLOSED_WITH_TOKEN", "UNSTREAMED"]) expect(positions.some((p) => p.status === k)).toBe(true);
    expect((await indexer.Claim.getAll()).some((c) => c.amount === 0n)).toBe(true);
    const flows = new Set((await indexer.RouterFlow.getAll()).map((f) => f.flow));
    expect([...flows].sort()).toEqual(["CLOSE_LONG", "CLOSE_LONG_DAILY", "CLOSE_SHORT", "OPEN_LONG", "OPEN_LONG_DAILY", "OPEN_SHORT"]);
    expect((await indexer.Settle.getAll()).length).toBe(4);
    expect((await indexer.Redeem.getAll()).length).toBe(1);
    expect((await indexer.Drip.getAll()).length).toBe(5);
    const trades = (await indexer.Trade.getAll()).filter((t) => t.series_id === oct);
    expect(trades.length).toBeGreaterThan(5);
    const candles = (await indexer.DailyCandle.getAll()).filter((c) => c.series_id === oct);
    expect(candles.reduce((a, c) => a + c.trades, 0)).toBe(trades.length);
    expect(candles.reduce((a, c) => a + c.volumeTokens, 0n)).toBe(trades.reduce((a, t) => a + t.tokens, 0n));
    const pp = await indexer.PricePoint.getOrThrow(oct);
    expect(pp.markSource).toBe("TRADE");
    expect(pp.lastTradePriceU).toBe([...trades].sort((a, b) => Number(a.block - b.block))[trades.length - 1]!.priceU);
  });

  it("factories, indexes and forward curves", async () => {
    const facs = await indexer.Factory.getAll();
    expect(facs.map((f) => f.name).sort()).toEqual(["demo", "pilot", "real"]);
    for (const f of facs) expect(f.clockAnchor).toBeDefined();
    const real = deployments.factories.find((f) => f.name === "real")!;
    expect((await indexer.PriceIndex.getOrThrow(real.index)).names).toEqual(["real", "pilot"]);
    const pilotSeries = (await indexer.Series.getAll()).find((s) => s.factory_id === deployments.factories.find((f) => f.name === "pilot")!.factory)!;
    expect(pilotSeries.venue).toBe("OTHER");
    expect(pilotSeries.symbol.startsWith("p")).toBe(true);
    expect(pilotSeries.label).toBe("H100");
    const fwds = await indexer.MarketForward.getAll();
    expect(fwds.length).toBe(4); // demo H100 and H200, real H100, pilot H100
    const demo = deployments.factories.find((f) => f.name === "demo")!;
    const h100 = fwds.find((f) => f.factory_id === demo.factory && f.label === "H100")!;
    // the last clock run (block 207 of 269) fell in the demo clock's October: near = October, next = November
    expect(h100.currentMonth).toBe(2026 * 12 + 9);
    const near = (await indexer.Series.getAll()).find((s) => s.factory_id === demo.factory && s.label === "H100" && s.month === 2026 * 12 + 9)!;
    const next = (await indexer.Series.getAll()).find((s) => s.factory_id === demo.factory && s.label === "H100" && s.month === 2026 * 12 + 10)!;
    expect([h100.nearSeries_id, h100.nextSeries_id]).toEqual([near.id, next.id]);
    expect(h100.nearMarkU).toBe((await indexer.PricePoint.getOrThrow(near.id)).markU);
    expect(h100.nextMarkU).toBe((await indexer.PricePoint.getOrThrow(next.id)).markU);
    expect(h100.nextMarkU).toBeDefined();
  });
});
