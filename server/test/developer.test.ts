import { describe, expect, test } from "bun:test";
import type { AgateClient, Candle, Fill, Market, MarketsSnapshot } from "@agate/client";
import { publicApp } from "../src/app.ts";
import { developerApi } from "../src/developer.ts";
import type { Fingerprints } from "../src/fingerprints.ts";
import { openapi } from "../src/openapi.ts";
import type { SnapshotCache } from "../src/snapshot.ts";
import { Store } from "../src/store.ts";

const H100: Market = {
  gpu: "H100",
  price: 3.99,
  prevPrice: 3.95,
  updatedAt: "2026-10-08T07:02:46Z",
  sources: [{ family: "Lambda", price: 3.99, live: true }],
  history: [
    { date: "2026-10-06", price: 3.95, status: "final", example: false },
    { date: "2026-10-07", price: 3.99, status: "final", example: false },
  ],
  prelaunch: [{ date: "2026-10-03", price: 3.99, status: "final", example: false, onchain: false }],
  series: [
    {
      gpu: "H100",
      month: "2026-11",
      name: "agate H100 Nov 2026",
      symbol: "H100-NOV26",
      n: 30,
      floor: 1.95,
      cap: 8,
      phase: "trading",
      k: 0,
      S: 0,
      quote: { bid: 3.95, ask: 4.03, last: 4.03, lastAt: "2026-10-08T04:22:06Z" },
      openInterest: 8364,
      listedAt: "2026-10-05T08:55:46Z",
      closesAt: "2026-12-01T00:00:00Z",
      startsAt: "2026-11-01T00:00:00Z",
      address: "0xbc28",
      token: "0x0fbf",
      market: "0xf245",
    },
  ],
  nextUpdateAt: "2026-10-09T07:00:00Z",
  liveCount: 1,
  panelSize: 2,
  priceDate: "2026-10-07",
  nextCloseAt: "2026-10-09T01:00:00Z",
  tradable: true,
  panel: [
    { family: "Lambda", live: true, reserve: false, price: 3.99 },
    { family: "Hyperstack", live: false, reserve: true, price: null },
  ],
};
const A100: Market = { ...H100, gpu: "A100", series: [], tradable: false, priceDate: null, updatedAt: "" };

const snapshot: MarketsSnapshot = {
  v: 1,
  chainId: 10143,
  index: "0x4193",
  readAt: "2026-10-08T14:20:36.461Z",
  ageMs: 120,
  markets: [H100, A100],
  books: { "H100 2026-11": { bids: [{ price: 3.95, size: 1000 }], asks: [{ price: 4.03, size: 1000 }], spread: 0.08 } },
};

const snaps = (s: MarketsSnapshot | null = snapshot): SnapshotCache => ({ get: async () => s, stop: () => {} });
const fills: Fill[] = [
  { time: "04:22", side: "buy", price: 4.03, size: 10, at: "2026-10-08T04:22:06Z", txHash: "0xaa" },
  { time: "03:10", side: "sell", price: 3.95, size: 5, at: "2026-10-08T03:10:00Z", txHash: "0xbb" },
];
const candles: Candle[] = [{ t: "2026-10-08T04:00:00Z", o: 3.95, h: 4.03, l: 3.95, c: 4.03, v: 15 }];

function counting(o: { fail?: boolean; down?: boolean } = {}) {
  const calls = { fills: 0, candles: 0 };
  const c = {
    // the real client answers [] when the indexer is down; indexerUp is how the API tells
    indexerUp: async () => !o.down,
    recentFills: async () => {
      calls.fills++;
      if (o.fail) throw new Error("indexer down");
      return fills;
    },
    candles: async () => {
      calls.candles++;
      return candles;
    },
  } as unknown as AgateClient;
  return { client: () => c, calls };
}

const api = (o: { s?: MarketsSnapshot | null; fail?: boolean; down?: boolean; limitPerMin?: number; now?: () => number } = {}) => {
  const k = counting({ fail: o.fail, down: o.down });
  return { app: developerApi({ snapshots: snaps(o.s === undefined ? snapshot : o.s), client: k.client, log: () => {}, limitPerMin: o.limitPerMin, now: o.now }), calls: k.calls };
};
const get = async (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, ip = "1.2.3.4") => {
  const r = await app.request(path, { headers: { "x-forwarded-for": ip } });
  return { r, j: (await r.json()) as Record<string, any> };
};

describe("developer API v1", () => {
  test("prices: every GPU with its sources, the reserve marked, open CORS and a short public cache", async () => {
    const { app } = api();
    const r = await app.request("/v1/prices", { headers: { origin: "https://example.dev" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("cache-control")).toBe("public, max-age=5");
    const j = (await r.json()) as any;
    expect(j.readAt).toBe(snapshot.readAt);
    expect(j.prices[0]).toMatchObject({ gpu: "H100", price: 3.99, date: "2026-10-07", previousPrice: 3.95, change: 0.04, sourcesCounted: 1, panelSize: 2, tradable: true });
    expect(j.prices[0].sources).toEqual([
      { company: "Lambda", price: 3.99, counted: true, reserve: false, page: null },
      { company: "Hyperstack", price: null, counted: false, reserve: true, page: null },
    ]);
    // before a GPU's first final day there is no price, not a 0
    expect(j.prices[1]).toMatchObject({ gpu: "A100", price: null, date: null, change: null, finalAt: null });
  });

  test("each priced source row carries the page behind its price; a reserve and a GPU before its first final day carry none", async () => {
    const asked: unknown[] = [];
    const fp = { sha256: "ab".repeat(32), fetchedAt: "2026-10-07T23:18:04Z", price: 3.99 };
    const pages: Fingerprints = {
      page: (q) => {
        asked.push(q);
        return fp;
      },
    };
    const app = developerApi({ snapshots: snaps(), client: counting().client, log: () => {}, pages });
    const all = (await get(app, "/v1/prices")).j;
    expect(all.prices[0].sources.map((r: { page: unknown }) => r.page)).toEqual([fp, null]);
    expect(all.prices[1].sources.map((r: { page: unknown }) => r.page)).toEqual([null, null]);
    expect(asked).toEqual([{ gpu: "H100", date: "2026-10-07", slot: 0, company: "Lambda" }]);
    expect((await get(app, "/v1/prices/H100")).j.sources[0].page).toEqual(fp);
    // the real server app passes them through
    const pub = publicApp({ store: new Store(":memory:"), log: () => {}, agateClient: counting().client, snapshots: snaps(), pages });
    expect((await get(pub, "/v1/prices")).j.prices[0].sources[0].page).toEqual(fp);
  });

  test("one GPU: case-insensitive, with onchain history and the logger's days apart; unknown GPU is a 400", async () => {
    const { app } = api();
    const { r, j } = await get(app, "/v1/prices/h100");
    expect(r.status).toBe(200);
    expect(j.history).toEqual([
      { date: "2026-10-06", price: 3.95, status: "final" },
      { date: "2026-10-07", price: 3.99, status: "final" },
    ]);
    expect(j.beforeOnchain).toEqual([{ date: "2026-10-03", price: 3.99, status: "final" }]);
    expect((await get(app, "/v1/prices/RTX4090")).r.status).toBe(400);
  });

  test("markets: each month with floor, ceiling, quote and contracts; one month adds its book", async () => {
    const { app } = api();
    const { j } = await get(app, "/v1/markets");
    expect(j.markets).toHaveLength(1);
    expect(j.markets[0]).toMatchObject({ gpu: "H100", month: "2026-11", floor: 1.95, ceiling: 8, bid: 3.95, ask: 4.03, last: 4.03, contracts: { series: "0xbc28", token: "0x0fbf", kuruMarket: "0xf245" } });
    expect(j.markets[0].book).toBeUndefined();
    const one = await get(app, "/v1/markets/H100/2026-11");
    expect(one.r.status).toBe(200);
    expect(one.j.book).toEqual(snapshot.books["H100 2026-11"]);
    expect((await get(app, "/v1/markets/H100/2026-12")).r.status).toBe(404);
    expect((await get(app, "/v1/markets/H100/nov")).r.status).toBe(400);
    expect((await get(app, "/v1/markets/XYZ/2026-11")).r.status).toBe(400);
  });

  test("a month with no trade yet shows null last, not the mid", async () => {
    const quiet = { ...snapshot, markets: [{ ...H100, series: [{ ...H100.series[0]!, quote: { bid: 0, ask: 4.03, last: 4.03, lastAt: null } }] }] };
    const { j } = await get(api({ s: quiet }).app, "/v1/markets");
    expect(j.markets[0]).toMatchObject({ bid: null, ask: 4.03, last: null, lastTradeAt: null });
  });

  test("trades: newest first, the limit clamped, one indexer read per 15 s for every caller", async () => {
    let t = 1_000_000;
    const { app, calls } = api({ now: () => t });
    const a = await get(app, "/v1/markets/H100/2026-11/trades?limit=1");
    expect(a.j.trades).toEqual([{ at: "2026-10-08T04:22:06Z", side: "buy", price: 4.03, size: 10, txHash: "0xaa" }]);
    expect((await get(app, "/v1/markets/H100/2026-11/trades?limit=9999")).j.trades).toHaveLength(2);
    expect(calls.fills).toBe(1);
    t += 16_000;
    await get(app, "/v1/markets/H100/2026-11/trades");
    expect(calls.fills).toBe(2);
  });

  test("trades: an indexer failure is a 503 and is not cached", async () => {
    const { app, calls } = api({ fail: true });
    expect((await get(app, "/v1/markets/H100/2026-11/trades")).r.status).toBe(503);
    expect((await get(app, "/v1/markets/H100/2026-11/trades")).r.status).toBe(503);
    expect(calls.fills).toBe(2);
  });

  test("an unreachable indexer is a 503 for trades and candles, not an empty 200", async () => {
    const { app, calls } = api({ down: true });
    expect((await get(app, "/v1/markets/H100/2026-11/trades")).r.status).toBe(503);
    expect((await get(app, "/v1/markets/H100/2026-11/candles")).r.status).toBe(503);
    expect(calls.fills + calls.candles).toBe(0);
  });

  test("an empty ?limit= falls back to the default", async () => {
    expect((await get(api().app, "/v1/markets/H100/2026-11/trades?limit=")).j.trades).toHaveLength(2);
  });

  test("a bad GPU or month is a 400 even while the markets cannot be read", async () => {
    const down = api({ s: null }).app;
    expect((await get(down, "/v1/markets/XYZ/2026-11")).r.status).toBe(400);
    expect((await get(down, "/v1/markets/H100/nov/trades")).r.status).toBe(400);
    expect((await get(down, "/v1/markets/H100/2026-11")).r.status).toBe(503);
  });

  test("one final day only: no previous price; an upcoming month has no range or contracts yet", async () => {
    const s1 = {
      ...snapshot,
      markets: [{ ...H100, history: [H100.history[1]!], series: [{ ...H100.series[0]!, phase: "upcoming" as const, opensOn: "2026-11-05T00:00:00Z", floor: 0, cap: 0, address: "0x0000000000000000000000000000000000000000", token: "0x0000000000000000000000000000000000000000", market: null, quote: null }] }],
    };
    const app = api({ s: s1 }).app;
    expect((await get(app, "/v1/prices/H100")).j).toMatchObject({ price: 3.99, previousPrice: null, change: null });
    expect((await get(app, "/v1/markets")).j.markets[0]).toMatchObject({ phase: "upcoming", opensOn: "2026-11-05T00:00:00Z", floor: null, ceiling: null, bid: null, ask: null, last: null, contracts: { series: null, token: null, kuruMarket: null } });
  });

  test("the index is not cached while the markets cannot be read", async () => {
    const { r, j } = await get(api({ s: null }).app, "/v1");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(j.chainId).toBeNull();
    expect((await get(api().app, "/v1")).r.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("candles: open/high/low/close/volume", async () => {
    const { j } = await get(api().app, "/v1/markets/H100/2026-11/candles");
    expect(j).toEqual({ gpu: "H100", month: "2026-11", interval: "1h", candles: [{ t: "2026-10-08T04:00:00Z", open: 3.95, high: 4.03, low: 3.95, close: 4.03, volume: 15 }] });
  });

  test("status, and 503 everywhere when the markets cannot be read", async () => {
    const { j } = await get(api().app, "/v1/status");
    expect(j).toMatchObject({ ok: true, chainId: 10143, index: "0x4193" });
    expect(j.gpus[0]).toMatchObject({ gpu: "H100", date: "2026-10-07", sourcesCounted: 1, panelSize: 2 });
    const down = api({ s: null }).app;
    for (const p of ["/v1/prices", "/v1/prices/H100", "/v1/markets", "/v1/markets/H100/2026-11", "/v1/status"]) expect((await get(down, p)).r.status).toBe(503);
  });

  test("the per-IP limit answers 429 with retry-after, per address", async () => {
    const { app } = api({ limitPerMin: 2 });
    expect((await get(app, "/v1/status")).r.status).toBe(200);
    expect((await get(app, "/v1/status")).r.status).toBe(200);
    const over = await get(app, "/v1/status");
    expect(over.r.status).toBe(429);
    expect(over.r.headers.get("retry-after")).toBe("60");
    expect((await get(app, "/v1/status", "5.6.7.8")).r.status).toBe(200);
  });

  test("a forged Vercel header gets no new bucket: the proxy's address is counted, with the app's larger limit", async () => {
    const { app } = api({ limitPerMin: 1 });
    const via = (who: string) => app.request("/v1/status", { headers: { "x-forwarded-for": "9.9.9.9", "x-vercel-forwarded-for": who } });
    for (let i = 0; i < 10; i++) expect((await via(`1.1.1.${i}`)).status).toBe(200); // 10 x the limit for the app's address
    expect((await via("2.2.2.2")).status).toBe(429); // another header value is still the same bucket
    expect((await app.request("/v1/status", { headers: { "x-forwarded-for": "8.8.8.8" } })).status).toBe(200);
  });

  test("a path or method the API does not have is a JSON 404 on the real server app, with open CORS", async () => {
    const app = publicApp({ store: new Store(":memory:"), log: () => {}, agateClient: counting().client, snapshots: snaps() });
    const { r, j } = await get(app, "/v1/price");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(j).toEqual({ error: "no such endpoint: GET /v1/price (see /v1 for the list)" });
    expect((await get(app, "/v1/markets/H100/2026-11/book")).r.status).toBe(404);
    const post = await app.request("/v1/prices", { method: "POST", headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(post.status).toBe(404);
    expect(((await post.json()) as { error: string }).error).toBe("no such endpoint: POST /v1/prices (see /v1 for the list)");
    // the known endpoints still answer
    expect((await get(app, "/v1")).r.status).toBe(200);
    expect((await get(app, "/v1/prices")).r.status).toBe(200);
  });

  test("every path in the OpenAPI spec answers on the real server app, and the index lists them", async () => {
    const app = publicApp({ store: new Store(":memory:"), log: () => {}, agateClient: counting().client, snapshots: snaps() });
    const spec = (await get(app, "/v1/openapi.json")).j;
    expect(spec.openapi).toBe("3.1.0");
    const listed = (await get(app, "/v1")).j.endpoints as string[];
    for (const p of Object.keys(openapi.paths)) {
      const path = p.replace("{gpu}", "H100").replace("{month}", "2026-11");
      const { r } = await get(app, path);
      expect([p, r.status]).toEqual([p, 200]);
      expect(listed.some((e) => e.startsWith(`GET ${p}`))).toBe(true);
    }
  });
});
