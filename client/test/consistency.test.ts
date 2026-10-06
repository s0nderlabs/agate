// Reads that take more than one indexer query, on fakes (no chain, no network): the fake indexer answers as Hasura
// does (filters, its own order including text ids, limits and offsets), and can ingest rows between two of the
// client's queries, as a live indexer does.
//   1. getWallet and openOrdersResult: a position or order indexed between the client's reads is never dropped;
//   2. trades inside one block are cut by log index, not by the text id ("B-9" sorts after "B-12");
//   3. open orders past one page are read page by page, and a list cut at the cap says it is incomplete;
//   4. an upcoming month's name, symbol and length.
import { describe, expect, test } from "bun:test";
import type { Hex, PublicClient } from "viem";
import { AgateClient, WALLET_MAX, WALLET_PAGE } from "../src/client.ts";
import { PANELS, TESTNET_DEPLOYMENTS } from "../src/static.ts";

const USER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const OTHER = "0x00000000000000000000000000000000000000aa";
const SERIES = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const MARKET = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const H100 = PANELS.find((p) => p.gpu === "H100")!.gpuId as Hex;
const OCT = 2026 * 12 + 9;
const NOV = OCT + 1;
const NOW = 1_791_158_400n; // 2026-10-05T00:00:00Z
const f = TESTNET_DEPLOYMENTS.factories.real!;
const lc = (s: string) => s.toLowerCase();

interface ChainPosition {
  owner: string;
  side: number;
  q: bigint;
}
interface ChainOrder {
  owner: string;
  isBuy: boolean;
  price: number;
  size: bigint;
}

/** H100 November listed with a Kuru market (or nothing listed), its positions and its orders. */
function fakeChain(o: { listed?: boolean; positions?: Record<number, ChainPosition>; nextId?: number; counter?: number; orders?: (id: number) => ChainOrder | undefined } = {}): PublicClient {
  const read = ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }): unknown => {
    switch (functionName) {
      case "currentMonth":
        return OCT;
      case "gpuIds":
        return [H100];
      case "labelOf":
        return "H100";
      case "gpu":
        return { recipeHash: `0x${"00".repeat(32)}`, nSlots: 6, nFamilies: 6, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head: 20731 };
      case "seriesOf":
        return o.listed !== false && Number(args?.[1]) === NOV ? SERIES : ZERO;
      case "terms":
        return { gpuId: H100, month: NOV, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000, cap: 8_000_000 };
      case "token":
        return TOKEN;
      case "name":
        return "agate H100 Nov 2026";
      case "symbol":
        return "H100-NOV26";
      case "marketOf":
        return [MARKET, 1];
      case "previewSync":
        return [0, 0n];
      case "state":
        return [0, 0n, 0, false, false, 0n, BigInt(o.nextId ?? 1), 0n];
      case "totalSupply":
        return 0n;
      case "getL2Book":
        return `0x${"00".repeat(31)}01${"00".repeat(32)}`;
      case "balanceOf":
        return lc(address) === lc(f.dollar) ? 1_000_000_000n : 0n;
      case "nextDripAt":
        return 0n;
      case "dripPeriod":
        return 86_400n;
      case "getBalance":
      case "shortOf":
      case "claimable":
        return 0n;
      case "position": {
        const p = o.positions?.[Number(args?.[0])];
        return { owner: p?.owner ?? ZERO, side: p?.side ?? 0, daily: false, openedK: 0, payee: p?.owner ?? ZERO, q: p?.q ?? 0n, operator: f.router, paid: 0n };
      }
      case "s_orderIdCounter":
        return o.counter ?? 0;
      case "s_orders": {
        const x = o.orders?.(Number(args?.[0]));
        return x ? [x.owner, x.size, 0, 0, 0, x.price, 0, x.isBuy] : [ZERO, 0n, 0, 0, 0, 0, 0, false];
      }
      case "s_buyPricePoints":
      case "s_sellPricePoints":
        return [1, 1]; // head 1: every id >= 1 still rests
      case "clocks":
        return { day: 86_400, slice: 3_600, tPend: 21_600, closeGrace: 3_600, slices: 24, minReadings: 2, epochTs: 0n, epochDay: 0 };
      case "previewListing":
        return [0n, 0n];
      case "firstRecordDay":
        // read beside the months' listing state (an upcoming month whose preview fails needs it)
        return [true, 20730];
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  return {
    getCode: async () => undefined, // no Multicall3: the client reads call by call
    readContract: async (r: { address: string; functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: NOW }),
    getBalance: async () => 10n ** 18n,
  } as unknown as PublicClient;
}

// ------------------------------------------------------------------ a fake Hasura over the indexer's rows

interface TradeRec {
  id: string;
  block: string;
  timestamp: string;
  priceU: string;
  tokens: string;
  takerIsBuy: boolean;
  maker: string;
  taker: string;
  txOrigin: string;
  txHash: string;
  series_id: string;
}
interface OrderRec {
  id: string;
  orderId: string;
  market_id: string;
  series_id: string;
  owner: string;
  isBuy: boolean;
  price: string;
  size: string;
  remaining: string;
  createdAt: string;
  status: string;
}
interface PositionRec {
  id: string;
  positionId: string;
  openedAt: string;
  series_id: string;
  owner_id: string;
  side: string;
  q: string;
  status: string;
}
interface Rows {
  Trade: TradeRec[];
  BookOrder: OrderRec[];
  Position: PositionRec[];
}

/** Hasura's text order (byte order, as Postgres' C collation; en_US orders these ids the same way). */
const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const num = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
/** Hasura's order of trades: block (numeric), then the id (text). */
const tradeOrder = (dir: "asc" | "desc") => (a: TradeRec, b: TradeRec) => (dir === "asc" ? 1 : -1) * (num(a.block, b.block) || text(a.id, b.id));

/** The limit a query asks for: its $limit variable, else the literal in its text. */
function limitOf(q: string, v: Record<string, unknown>): number {
  if (typeof v.limit === "number") return v.limit;
  const m = /limit: (\d+)/.exec(q);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** A fake indexer over `rows`. `ingest` runs once, right after the first query is answered (an indexer that took in a
 *  new block between two of the client's reads). `asked` lists each query's operation name (or first alias). */
function fakeIndexer(rows: Rows, ingest?: (r: Rows) => void) {
  const asked: string[] = [];
  const answer = (q: string, v: Record<string, unknown>): unknown => {
    const name = /query (\w+)/.exec(q)?.[1];
    const lim = limitOf(q, v);
    const off = typeof v.offset === "number" ? v.offset : 0;
    const page = <T>(xs: T[]) => xs.slice(off, off + lim);
    const series = String(v.series ?? "");
    switch (name) {
      case "Trades":
        return { Trade: page(rows.Trade.filter((t) => t.series_id === series).sort(tradeOrder(v.desc === "desc" ? "desc" : "asc"))) };
      case "TradesBefore":
        return { Trade: page(rows.Trade.filter((t) => t.series_id === series && BigInt(t.timestamp) < BigInt(String(v.before))).sort(tradeOrder("desc"))) };
      case "TradesSince":
        return { Trade: page(rows.Trade.filter((t) => t.series_id === series && BigInt(t.timestamp) >= BigInt(String(v.since))).sort(tradeOrder("asc"))) };
      case "TradesInBlock":
        return { Trade: page(rows.Trade.filter((t) => t.series_id === series && t.block === String(v.block)).sort((a, b) => text(a.id, b.id))) };
      case "OpenOrders": {
        const mine = rows.BookOrder.filter((o) => o.owner === v.a && o.status === "ACTIVE" && (typeof v.after !== "string" || o.id > v.after));
        const sorted = /order_by: \{createdAt: desc\}/.test(q) ? mine.sort((a, b) => -num(a.createdAt, b.createdAt)) : mine.sort((a, b) => text(a.id, b.id));
        return { BookOrder: page(sorted) };
      }
      case "Wallet":
        return { Position: rows.Position.filter((p) => p.owner_id === v.a && p.status === "OPEN").sort((a, b) => text(a.id, b.id)).slice(0, lim), RouterFlow: [], Trade: [] };
      case "MorePositions":
        return { Position: page(rows.Position.filter((p) => p.owner_id === v.a && p.status === "OPEN").sort((a, b) => text(a.id, b.id))) };
      case "MoreFlows":
        return { RouterFlow: [] };
      case "MoreTrades":
        return { Trade: [] };
    }
    // the aliased newest-id queries: m<i>: BookOrder(... market_id ...), s<i>: Position(... series_id ...)
    const out: Record<string, unknown[]> = {};
    for (const m of q.matchAll(/(m\d+): BookOrder\(where: \{market_id: \{_eq: "(0x[0-9a-f]+)"\}\}/g)) {
      const ids = rows.BookOrder.filter((o) => o.market_id === m[2]).map((o) => BigInt(o.orderId));
      out[m[1]!] = ids.length ? [{ orderId: ids.reduce((a, b) => (b > a ? b : a)).toString() }] : [];
    }
    for (const m of q.matchAll(/(s\d+): Position\(where: \{series_id: \{_eq: "(0x[0-9a-f]+)"\}\}/g)) {
      const ids = rows.Position.filter((p) => p.series_id === m[2]).map((p) => BigInt(p.positionId));
      out[m[1]!] = ids.length ? [{ positionId: ids.reduce((a, b) => (b > a ? b : a)).toString() }] : [];
    }
    return Object.keys(out).length ? out : null;
  };
  const fetch = (async (_u: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as { query: string; variables?: Record<string, unknown> };
    asked.push(/query (\w+)/.exec(b.query)?.[1] ?? /\{\s*(\w+):/.exec(b.query)?.[1] ?? "?");
    const data = answer(b.query, b.variables ?? {});
    const res = data ? new Response(JSON.stringify({ data }), { status: 200 }) : new Response(JSON.stringify({ errors: [{ message: "not in this fake" }] }), { status: 200 });
    if (ingest && asked.length === 1) ingest(rows);
    return res;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

const empty = (): Rows => ({ Trade: [], BookOrder: [], Position: [] });
const order = (id: number, owner = USER, createdAt = 1_000 + id): OrderRec => ({ id: `${MARKET}-${id}`, orderId: String(id), market_id: MARKET, series_id: SERIES, owner, isBuy: true, price: "3900000", size: "100000", remaining: "100000", createdAt: String(createdAt), status: "ACTIVE" });
const position = (id: number, side: "LONG" | "SHORT", q: bigint): PositionRec => ({ id: `${SERIES}-${id}`, positionId: String(id), openedAt: String(Number(NOW) - 3_600 + id), series_id: SERIES, owner_id: USER, side, q: q.toString(), status: "OPEN" });
const trade = (block: number, log: number, priceU: number, t = NOW - 3_600n): TradeRec => ({ id: `${block}-${log}`, block: String(block), timestamp: String(t), priceU: String(priceU), tokens: "1000000", takerIsBuy: true, maker: "0xm", taker: "0xt", txOrigin: "0xo", txHash: `0x${block}${log}`, series_id: SERIES });
const client = (chain: PublicClient, fetch: typeof globalThis.fetch) => new AgateClient({ publicClient: chain, fetch, graphqlUrl: "http://fake/v1/graphql" });

// ================================================================== 1. rows indexed between two reads

describe("a row the indexer takes in between the client's reads is never dropped", () => {
  test("getWallet: a position indexed after the first read is still listed (once)", async () => {
    const chain = fakeChain({ nextId: 3, positions: { 1: { owner: USER, side: 0, q: 10_000_000n }, 2: { owner: USER, side: 1, q: 20_000_000n } } });
    const rows = empty();
    rows.Position.push(position(1, "LONG", 10_000_000n));
    const ix = fakeIndexer(rows, (r) => r.Position.push(position(2, "SHORT", 20_000_000n)));
    const w = await client(chain, ix.fetch).getWallet(USER);
    const ps = w.positions.filter((p) => p.kind === "position");
    expect(ps.map((p) => [p.positionId, p.side, p.q])).toEqual([
      ["1", "long", 10],
      ["2", "short", 20],
    ]);
    // the second came from the indexer's list (its open time), not only from the chain scan
    expect(ps[1]!.openedAt).not.toBe("");
  });
  test("openOrdersResult: an order indexed after the first read is still listed (once)", async () => {
    const chainOrders: Record<number, ChainOrder> = { 11: { owner: OTHER, isBuy: true, price: 3_950_000, size: 100_000n }, 12: { owner: USER, isBuy: true, price: 3_900_000, size: 100_000n }, 13: { owner: USER, isBuy: false, price: 4_100_000, size: 50_000n } };
    const chain = fakeChain({ counter: 13, orders: (id) => chainOrders[id] });
    const rows = empty();
    rows.BookOrder.push(order(11, OTHER), order(12));
    const ix = fakeIndexer(rows, (r) => r.BookOrder.push({ ...order(13), isBuy: false, price: "4100000", size: "50000", remaining: "50000" }));
    const r = await client(chain, ix.fetch).openOrdersResult(USER);
    expect(r.source).toBe("indexer");
    expect(r.complete).toBe(true);
    expect(r.orders.map((o) => [o.id, o.side, o.price, o.q])).toEqual([
      ["13", "short", 4.1, 5],
      ["12", "long", 3.9, 10],
    ]);
  });
});

// ================================================================== 2. trades inside one block

describe("trades inside one block are ordered by log index, also where a page ends", () => {
  test("recentFills: log 12 is newer than log 9 of the same block, wherever the limit cuts", async () => {
    const rows = empty();
    rows.Trade.push(trade(99, 3, 3_900_000), trade(100, 9, 4_000_000), trade(100, 12, 4_200_000));
    const c = client(fakeChain(), fakeIndexer(rows).fetch);
    expect((await c.recentFills("H100", "2026-11", 1)).map((x) => x.price)).toEqual([4.2]);
    expect((await c.recentFills("H100", "2026-11", 2)).map((x) => x.price)).toEqual([4.2, 4]);
    expect((await c.recentFills("H100", "2026-11", 3)).map((x) => x.price)).toEqual([4.2, 4, 3.9]);
    // a newer block above: the cut falls inside block 100 again
    rows.Trade.push(trade(101, 3, 4_300_000));
    expect((await c.recentFills("H100", "2026-11", 2)).map((x) => x.price)).toEqual([4.3, 4.2]);
  });
  test("priceBefore: the newest block's last trade by log index, even with more trades in it than one page", async () => {
    const rows = empty();
    // block 100, 24 h and more before now: 150 trades at log 900 to 1049 (the text ids "100-900" ... "100-999" fill a
    // page of 100 before "100-1000" ... "100-1049"); the true last is log 1049
    for (let l = 900; l < 1050; l++) rows.Trade.push(trade(100, l, 3_000_000 + l * 1_000, NOW - 90_000n));
    rows.Trade.push(trade(200, 0, 9_000_000, NOW - 3_600n)); // inside the 24 h: not the base
    expect(await client(fakeChain(), fakeIndexer(rows).fetch).priceBefore(SERIES, NOW)).toBe(4_049_000n);
  });
  test("priceBefore of a month younger than 24 h: its first trade by log index, even with more in its first block than one page", async () => {
    const rows = empty();
    // block 200, inside the 24 h: log 95 to 205; the text ids "200-100" ... "200-199" come first; the true first is log 95
    for (let l = 95; l <= 205; l++) rows.Trade.push(trade(200, l, 4_000_000 + l * 1_000, NOW - 3_600n));
    expect(await client(fakeChain(), fakeIndexer(rows).fetch).priceBefore(SERIES, NOW)).toBe(4_095_000n);
  });
});

// ================================================================== 3. open orders past one page

describe("open orders past one page", () => {
  test("every page is read: 1,200 resting orders of the wallet's are all listed, complete", async () => {
    const chainOrder = (id: number): ChainOrder | undefined => (id >= 1 && id <= 1_200 ? { owner: USER, isBuy: true, price: 3_900_000, size: 100_000n } : undefined);
    const rows = empty();
    for (let id = 1; id <= 1_200; id++) rows.BookOrder.push(order(id));
    const r = await client(fakeChain({ counter: 1_200, orders: chainOrder }), fakeIndexer(rows).fetch).openOrdersResult(USER);
    expect(r.orders.length).toBe(1_200);
    expect(new Set(r.orders.map((o) => o.id)).size).toBe(1_200);
    expect(r.complete).toBe(true);
    expect(r.orders[0]!.id).toBe("1200"); // newest first
  });
  test("a list cut at the cap says it is incomplete", async () => {
    // an indexer that holds more of the wallet's orders than the client reads (WALLET_MAX)
    const rows = empty();
    for (let id = 1; id <= WALLET_MAX + WALLET_PAGE; id++) rows.BookOrder.push(order(id));
    const r = await client(fakeChain({ counter: WALLET_MAX + WALLET_PAGE, orders: () => ({ owner: USER, isBuy: true, price: 3_900_000, size: 100_000n }) }), fakeIndexer(rows).fetch).openOrdersResult(USER);
    expect(r.complete).toBe(false);
    expect(r.orders.length).toBeGreaterThanOrEqual(WALLET_MAX);
  }, 60_000);
});

// ================================================================== 4. an upcoming month

describe("an upcoming month", () => {
  test("name, symbol and length from the month (February 2027: 28 days)", async () => {
    const c = new AgateClient({ publicClient: fakeChain({ listed: false }), graphqlUrl: null });
    const s = await c.seriesFor("H100", [2027 * 12 + 1, 2028 * 12 + 1, NOV], NOW);
    expect(s.map((x) => [x.month, x.name, x.symbol, x.n, x.phase])).toEqual([
      ["2027-02", "agate H100 Feb 2027", "H100-FEB27", 28, "upcoming"],
      ["2028-02", "agate H100 Feb 2028", "H100-FEB28", 29, "upcoming"],
      ["2026-11", "agate H100 Nov 2026", "H100-NOV26", 30, "upcoming"],
    ]);
  });
});
