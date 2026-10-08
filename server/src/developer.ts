// The developer API (v1): agate's market data as stable, read-only JSON for anyone, no key. Prices with every source,
// each GPU's daily history, the months on sale with their order books, trades, hourly candles and a status line.
// Prices are dollars per GPU-hour, sizes GPU-hours, times ISO UTC. Built on the markets snapshot (one chain read for
// every caller, snapshot.ts) and, for trades and candles, the indexer through @agate/client behind a short cache.
// Open CORS, GET only, a per-IP limit. Field names are the contract: add fields, never rename or remove them in v1.
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type AgateClient, type Book, type Candle, type Fill, GPUS, type Gpu, type IndexDay, type Market, type MarketsSnapshot, type Series } from "@agate/client";
import { openapi, V1_LIMIT_PER_MIN } from "./openapi.ts";
import { clientIp, RateLimiter } from "./ratelimit.ts";
import type { SnapshotCache } from "./snapshot.ts";

export { V1_LIMIT_PER_MIN };
/** the app's address shares one bucket per Vercel egress address among its callers: this many times the limit */
export const V1_APP_FACTOR = 10;
export const TRADES_TTL_MS = 15_000;
export const CANDLES_TTL_MS = 60_000;
export const TRADES_MAX = 200;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const ZERO = "0x0000000000000000000000000000000000000000";
const addrOrNull = (a: string | null) => (!a || a.toLowerCase() === ZERO ? null : a);

export function priceView(m: Market) {
  // the client repeats today's price as prevPrice when there is no day before it: that is no previous price
  const prev = m.priceDate && m.history.length >= 2;
  return {
    gpu: m.gpu,
    price: m.priceDate ? m.price : null,
    date: m.priceDate,
    previousPrice: prev ? m.prevPrice : null,
    change: prev ? r4(m.price - m.prevPrice) : null,
    finalAt: m.updatedAt || null,
    nextCloseAt: m.nextCloseAt,
    nextFinalAt: m.nextUpdateAt,
    sourcesCounted: m.liveCount,
    panelSize: m.panelSize,
    sources: m.panel.map((s) => ({ company: s.family, price: s.price, counted: s.live, reserve: s.reserve })),
    tradable: m.tradable,
  };
}

const dayView = (d: IndexDay) => ({ date: d.date, price: d.price, status: d.status });

export function monthView(s: Series, book?: Book) {
  // an upcoming month has no range and no contracts yet (the client fills 0 and the zero address)
  const listed = s.phase !== "upcoming";
  return {
    gpu: s.gpu,
    month: s.month,
    symbol: s.symbol,
    name: s.name,
    phase: s.phase,
    ...(s.opensOn ? { opensOn: s.opensOn } : {}),
    floor: listed ? s.floor : null,
    ceiling: listed ? s.cap : null,
    days: s.n,
    startsAt: s.startsAt,
    closesAt: s.closesAt,
    listedAt: s.listedAt || null,
    bid: s.quote && s.quote.bid > 0 ? s.quote.bid : null,
    ask: s.quote && s.quote.ask > 0 ? s.quote.ask : null,
    last: s.quote?.lastAt ? s.quote.last : null,
    lastTradeAt: s.quote?.lastAt ?? null,
    openInterest: s.openInterest,
    contracts: { series: addrOrNull(s.address), token: addrOrNull(s.token), kuruMarket: addrOrNull(s.market) },
    ...(book ? { book: { bids: book.bids, asks: book.asks, spread: book.spread } } : {}),
  };
}

const fillView = (f: Fill) => ({ at: f.at, side: f.side, price: f.price, size: f.size, txHash: f.txHash });
const candleView = (k: Candle) => ({ t: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v });

/** Through the app's address (agate.elpabl0.xyz/api/v1, a Vercel rewrite) a request reaches us from Vercel's egress,
 *  so its bucket is that egress address, shared by every caller behind it: it gets the larger limit. The bucket is
 *  always the address the proxy saw (clientIp), never a header a caller can set, so forging Vercel's header buys at
 *  most the larger limit on the caller's own address, not a new bucket per request. */
export const viaApp = (c: Context): boolean => c.req.header("x-vercel-forwarded-for") !== undefined;

/** "h100" -> "H100"; null when not a GPU of the index */
export function gpuOf(raw: string | undefined): Gpu | null {
  const g = (raw ?? "").toUpperCase();
  return (GPUS as readonly string[]).includes(g) ? (g as Gpu) : null;
}

/** one read per key at a time, kept for ttl; a failed read is not kept */
function ttlCache<T>(ttlMs: number, now: () => number) {
  const m = new Map<string, { at: number; p: Promise<T> }>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = read();
    m.set(key, { at: now(), p });
    p.catch(() => {
      if (m.get(key)?.p === p) m.delete(key);
    });
    return p;
  };
}

export type DeveloperDeps = {
  snapshots: SnapshotCache;
  client: () => AgateClient;
  log?: (e: Record<string, unknown>) => void;
  now?: () => number;
  /** requests per IP per minute (tests set it low) */
  limitPerMin?: number;
};

export function developerApi(deps: DeveloperDeps): Hono {
  const now = deps.now ?? Date.now;
  const app = new Hono();
  const perMin = deps.limitPerMin ?? V1_LIMIT_PER_MIN;
  const limiter = new RateLimiter(perMin, 60_000);
  const appLimiter = new RateLimiter(perMin * V1_APP_FACTOR, 60_000);
  const trades = ttlCache<Fill[]>(TRADES_TTL_MS, now);
  const candles = ttlCache<Candle[]>(CANDLES_TTL_MS, now);

  app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET"], maxAge: 86_400 }));
  app.use("/v1/*", async (c, next) => {
    const fromApp = viaApp(c);
    if (!(fromApp ? appLimiter : limiter).allow(clientIp(c), now())) return c.json({ error: `over ${fromApp ? perMin * V1_APP_FACTOR : perMin} requests a minute; wait a minute` }, 429, { "retry-after": "60" });
    await next();
  });

  /** The client answers [] when the indexer cannot be read (the app shows an empty list), so a read here is only
   *  trusted, and cached, when the indexer answered before and after it; otherwise it throws (503, not cached). A
   *  candle read that loses a later page between two good probes can still come back short (client allTrades). */
  const fromIndexer = async <T>(read: (cl: AgateClient) => Promise<T>): Promise<T> => {
    const cl = deps.client();
    if (!(await cl.indexerUp())) throw new Error("indexer unreachable");
    const out = await read(cl);
    if (!(await cl.indexerUp())) throw new Error("indexer unreachable");
    return out;
  };

  const snap = async (c: Context): Promise<MarketsSnapshot | Response> =>
    (await deps.snapshots.get()) ?? c.json({ error: "the markets could not be read right now; try again shortly" }, 503, { "retry-after": "10" });
  const cached = (sec: number) => ({ "cache-control": `public, max-age=${sec}` });
  const stamp = (s: MarketsSnapshot) => ({ readAt: s.readAt, ageMs: s.ageMs });

  /** the path's GPU and month, checked before anything is read, or the 400 to answer */
  const paramsOf = (c: Context): { gpu: Gpu; month: string } | Response => {
    const gpu = gpuOf(c.req.param("gpu"));
    if (!gpu) return c.json({ error: `gpu must be one of ${GPUS.join(", ")}` }, 400);
    const month = c.req.param("month") ?? "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: "month is YYYY-MM, for example 2026-11" }, 400);
    return { gpu, month };
  };
  /** the month's series and book: the params first (400), then the snapshot (503), then the month (404) */
  const monthOf = async (c: Context): Promise<{ s: MarketsSnapshot; series: Series; book?: Book } | Response> => {
    const p = paramsOf(c);
    if (p instanceof Response) return p;
    const s = await snap(c);
    if (s instanceof Response) return s;
    const { gpu, month } = p;
    const series = s.markets.find((m) => m.gpu === gpu)?.series.find((x) => x.month === month);
    if (!series) return c.json({ error: `${gpu} has no ${month} market on sale (see /v1/markets)` }, 404);
    return { s, series, book: s.books[`${gpu} ${month}`] };
  };

  app.get("/v1", async (c) => {
    const s = await deps.snapshots.get();
    return c.json(
      {
        name: "agate developer API",
        version: 1,
        chainId: s?.chainId ?? null,
        index: s?.index ?? null,
        units: { price: "US dollars per GPU-hour", size: "GPU-hours", time: "ISO 8601, UTC" },
        endpoints: [
          "GET /v1/prices",
          "GET /v1/prices/{gpu}",
          "GET /v1/markets",
          "GET /v1/markets/{gpu}/{month}",
          "GET /v1/markets/{gpu}/{month}/trades?limit=50",
          "GET /v1/markets/{gpu}/{month}/candles",
          "GET /v1/status",
          "GET /v1/openapi.json",
        ],
        limits: `${deps.limitPerMin ?? V1_LIMIT_PER_MIN} requests a minute per IP, no key`,
        network: "Monad testnet: test assets with no monetary value",
      },
      200,
      // without a read the chain and index are null: never let a cache keep that
      s ? cached(60) : { "cache-control": "no-store" },
    );
  });

  app.get("/v1/openapi.json", (c) => c.json(openapi, 200, cached(3600)));

  app.get("/v1/prices", async (c) => {
    const s = await snap(c);
    if (s instanceof Response) return s;
    return c.json({ ...stamp(s), prices: s.markets.map(priceView) }, 200, cached(5));
  });

  app.get("/v1/prices/:gpu", async (c) => {
    const gpu = gpuOf(c.req.param("gpu"));
    if (!gpu) return c.json({ error: `gpu must be one of ${GPUS.join(", ")}` }, 400);
    const s = await snap(c);
    if (s instanceof Response) return s;
    const m = s.markets.find((x) => x.gpu === gpu);
    if (!m) return c.json({ error: `no ${gpu} price yet` }, 404);
    return c.json({ ...stamp(s), ...priceView(m), history: m.history.map(dayView), beforeOnchain: (m.prelaunch ?? []).map(dayView) }, 200, cached(5));
  });

  app.get("/v1/markets", async (c) => {
    const s = await snap(c);
    if (s instanceof Response) return s;
    return c.json({ ...stamp(s), markets: s.markets.flatMap((m) => m.series.map((x) => monthView(x))) }, 200, cached(5));
  });

  app.get("/v1/markets/:gpu/:month", async (c) => {
    const m = await monthOf(c);
    if (m instanceof Response) return m;
    return c.json({ ...stamp(m.s), ...monthView(m.series, m.book ?? { bids: [], asks: [], spread: 0 }) }, 200, cached(5));
  });

  app.get("/v1/markets/:gpu/:month/trades", async (c) => {
    const m = await monthOf(c);
    if (m instanceof Response) return m;
    const raw = c.req.query("limit");
    const n = raw ? Math.floor(Number(raw)) : 50;
    const limit = Number.isFinite(n) ? Math.max(1, Math.min(TRADES_MAX, n)) : 50;
    const { gpu, month } = m.series;
    try {
      const all = await trades(`${gpu} ${month}`, () => fromIndexer((cl) => cl.recentFills(gpu, month, TRADES_MAX)));
      return c.json({ gpu, month, trades: all.slice(0, limit).map(fillView) }, 200, cached(15));
    } catch (e) {
      deps.log?.({ event: "v1.trades.failed", gpu, month, error: String(e).slice(0, 200) });
      return c.json({ error: "trades could not be read right now; try again shortly" }, 503, { "retry-after": "15" });
    }
  });

  app.get("/v1/markets/:gpu/:month/candles", async (c) => {
    const m = await monthOf(c);
    if (m instanceof Response) return m;
    const { gpu, month } = m.series;
    try {
      const all = await candles(`${gpu} ${month}`, () => fromIndexer((cl) => cl.candles(gpu, month)));
      return c.json({ gpu, month, interval: "1h", candles: all.map(candleView) }, 200, cached(60));
    } catch (e) {
      deps.log?.({ event: "v1.candles.failed", gpu, month, error: String(e).slice(0, 200) });
      return c.json({ error: "candles could not be read right now; try again shortly" }, 503, { "retry-after": "60" });
    }
  });

  app.get("/v1/status", async (c) => {
    const s = await deps.snapshots.get();
    if (!s) return c.json({ ok: false, error: "the markets could not be read right now" }, 503, { "retry-after": "10" });
    return c.json(
      {
        ok: true,
        ...stamp(s),
        chainId: s.chainId,
        index: s.index,
        gpus: s.markets.map((m) => ({ gpu: m.gpu, date: m.priceDate, finalAt: m.updatedAt || null, nextCloseAt: m.nextCloseAt, nextFinalAt: m.nextUpdateAt, sourcesCounted: m.liveCount, panelSize: m.panelSize })),
      },
      200,
      cached(5),
    );
  });

  return app;
}
