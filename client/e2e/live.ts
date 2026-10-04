// Every read of the client against the LIVE Monad testnet (the public, key-free RPC) and an indexer (read only):
// what each returns today, and that the early states (no final day yet, no series yet) come back without an error.
// Sends nothing: no key, no wallet, eth_call and GraphQL reads only.
import { createAgateClient, type Gpu } from "../src/index.ts";
import { big } from "./flows.ts";

export interface LiveCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
}

export async function liveReads(o: { rpcUrl?: string; graphqlUrl: string | null; address: string; log: (s: string) => void }): Promise<{ checks: LiveCheck[]; out: Record<string, unknown> }> {
  const c = createAgateClient({ ...(o.rpcUrl ? { rpcUrl: o.rpcUrl } : {}), graphqlUrl: o.graphqlUrl });
  const checks: LiveCheck[] = [];
  const out: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, detail });
    o.log(`  ${ok ? "pass" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${big(detail)}` : ""}`);
  };
  const time = async <T>(name: string, f: () => Promise<T>): Promise<T | undefined> => {
    const t0 = Date.now();
    try {
      const v = await f();
      out[name] = v;
      check(`${name}() answers (${Date.now() - t0} ms)`, true);
      return v;
    } catch (e) {
      check(`${name}() answers`, false, (e as Error).message);
      return undefined;
    }
  };
  const now = await c.chainTime();
  out.chainTime = new Date(Number(now) * 1000).toISOString();
  out.indexerUp = await c.indexerUp();
  o.log(`chain time ${out.chainTime}; indexer ${o.graphqlUrl ?? "(none)"} ${out.indexerUp ? "answers" : "does not answer"}`);
  const ms = await time("getMarkets", () => c.getMarkets());
  if (ms) {
    check("six GPUs, the three price-only ones not tradable", ms.length === 6 && ms.filter((m) => !m.tradable).length === 3);
    check("each GPU's panel lists every registered slot (panelSize) with its cloud, the reserve marked", ms.every((m) => m.panel.length === m.panelSize && m.panel.every((p) => p.family.length > 0)), ms.map((m) => ({ gpu: m.gpu, panel: m.panel })));
    for (const m of ms) {
      const before = m.priceDate === null;
      check(`${m.gpu}: ${before ? "no final day yet: price 0, updatedAt empty, no sources, no history" : `final ${m.priceDate} at $${m.price}`}; ${m.liveCount} of ${m.panelSize} clouds; next price final ${m.nextUpdateAt} (closes ${m.nextCloseAt})`, before ? m.price === 0 && m.updatedAt === "" && m.sources.length === 0 && m.history.length === 0 : m.price > 0, { price: m.price, history: m.history.length });
      for (const s of m.series) check(`${m.gpu} ${s.month}: ${s.phase}${s.opensOn ? `, expected to list ${s.opensOn}` : ""}${s.quote ? `, bid ${s.quote.bid} ask ${s.quote.ask}` : ""}`, s.phase !== "upcoming" || (!!s.opensOn && s.quote === null && s.address === "0x0000000000000000000000000000000000000000"));
    }
  }
  const series = await time("getSeries", () => c.getSeries());
  if (series) check(`getSeries: ${series.length} months (${series.map((s) => `${s.symbol} ${s.phase}`).join(", ")})`, series.every((s) => s.gpu === "H100" || s.gpu === "H200" || s.gpu === "B200"));
  const listed = series?.filter((s) => s.phase !== "upcoming") ?? [];
  for (const s of listed.slice(0, 3)) {
    await time(`book ${s.symbol}`, () => c.book(s.gpu as Gpu, s.month));
    await time(`recentFills ${s.symbol}`, () => c.recentFills(s.gpu as Gpu, s.month, 20));
    await time(`candles ${s.symbol}`, () => c.candles(s.gpu as Gpu, s.month));
  }
  if (listed.length === 0) {
    // before the listing the month's market reads are empty, not errors (the app shows an empty book)
    const b = await time("book H100 2026-11 (upcoming)", () => c.book("H100", "2026-11"));
    const f = await time("recentFills H100 2026-11 (upcoming)", () => c.recentFills("H100", "2026-11"));
    const k = await time("candles H100 2026-11 (upcoming)", () => c.candles("H100", "2026-11"));
    check("book, fills and candles of the upcoming month are empty", !!b && b.asks.length === 0 && b.bids.length === 0 && b.spread === 0 && f?.length === 0 && k?.length === 0, { b, f, k });
  }
  await time("ticker", () => c.ticker());
  const w = await time("getWallet", () => c.getWallet(o.address));
  if (w) check(`getWallet(${o.address}): balance ${w.balance} tUSD, ${w.positions.length} positions, canDrip ${w.canDrip}`, w.signedIn && Number.isFinite(w.balance));
  const oo = await time("openOrdersResult", () => c.openOrdersResult(o.address));
  if (oo) check(`openOrdersResult(${o.address}): ${oo.orders.length} orders, from the ${oo.source}, complete ${oo.complete}`, Array.isArray(oo.orders) && (oo.source === "indexer" || oo.source === "chain"));
  return { checks, out };
}
