// The read and write guards added after the independent checks, on fakes (no chain, no network): price bounds by the
// band (before, during and after the month) and by the price the app showed, landed transactions reported and unused
// allowances put back, the receipt timeout, empty reads for a month not listed, the ticker's 24 h baseline, history
// gaps filled from the chain, open orders above the indexer's newest id, and the GraphQL default on a hosted page.
import { afterEach, describe, expect, test } from "bun:test";
import { BaseError, ContractFunctionRevertedError, type Hex, type PublicClient, WaitForTransactionReceiptTimeoutError } from "viem";
import { kuruOrderBookAbi } from "../src/abi.ts";
import { AgateClient, resolveGraphqlUrl } from "../src/client.ts";
import { DEFAULT_GRAPHQL_URL } from "../src/graphql.ts";
import { PANELS } from "../src/static.ts";
import { band, buyLong, closeLongDaily, closeShort, openShort, placeLimit, sellLong, WriteError } from "../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const SERIES = A(0x11), TOKEN = A(0x22), MARKET = A(0x33), ROUTER = A(0x44), DOLLAR = A(0x55), MA = A(0x66);
const FLOOR = 1_950_000n;
const CAP = 8_000_000n;
type Lv = [bigint, bigint];

/** A client and a wallet over one listed month (N = 30) with the book `asks` / `bids` ([price u, size units]), k days
 *  applied with sum S. Allowances are kept (approve sets them, a router flow uses them); `revert` makes a function's
 *  simulation revert; `noReceipt` makes the receipt wait time out. */
function world(o: { asks: Lv[]; bids: Lv[]; k?: number; S?: bigint; revert?: Record<string, Hex>; noReceipt?: boolean; position?: { side: number; q: bigint } }) {
  const sent: { functionName: string; args: readonly unknown[] }[] = [];
  const allowance = new Map<string, bigint>();
  const terms = { series: SERIES, token: TOKEN, gpuId: `0x${"ab".repeat(32)}`, month: 2026 * 12 + 10, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: FLOOR, cap: CAP, name: "agate H100 Nov 2026", symbol: "H100-NOV26" };
  const s = { gpu: "H100", terms, market: MARKET, k: o.k ?? 0, S: o.S ?? 0n, tokenSupply: 0n, nextId: 1n, book: { block: 1n, asks: o.asks, bids: o.bids } };
  const marketBuy = (quote: bigint) => {
    let left = quote;
    let got = 0n;
    for (const [p, z] of o.asks) {
      const units = (left * 10_000n) / p;
      if (units <= z) return (got + units) * 100n;
      got += z;
      left -= (p * z) / 10_000n;
    }
    return got * 100n;
  };
  const kuruRevert = (fn: string, sig: Hex) => new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: kuruOrderBookAbi, functionName: fn, data: sig }) });
  const pub = {
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName === "placeAndExecuteMarketBuy") return { result: marketBuy(req.args[0] as bigint) };
      const sig = o.revert?.[req.functionName];
      if (sig) throw kuruRevert(req.functionName, sig);
      return { result: 1n };
    },
    async estimateContractGas() {
      return 100_000n;
    },
    async readContract(req: { functionName: string; address: string; args?: readonly unknown[] }) {
      if (req.functionName === "balanceOf") return 10n ** 12n;
      if (req.functionName === "allowance") return allowance.get(`${req.address}-${String(req.args?.[1])}`) ?? 0n;
      return 0n; // Kuru margin balances
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      if (o.noReceipt) throw new WaitForTransactionReceiptTimeoutError({ hash });
      return { status: "success", gasUsed: 90_000n, blockNumber: 1n, logs: [] };
    },
  };
  const c = {
    pub,
    chain: { id: 10143 },
    dollar: DOLLAR,
    router: ROUTER,
    marginAccount: MA,
    factory: A(0x77),
    deployments: { kuru: { marginAccount: MA, router: A(0x88) } },
    seriesAt: async () => s,
    chainTime: async () => 0n,
    mc: async (calls: unknown[]) => calls.map(() => ({ ok: true, value: { owner: ME, side: o.position?.side ?? 1, q: o.position?.q ?? 24_000_000n, operator: ROUTER } })),
  } as unknown as AgateClient;
  const w = {
    account: { address: ME, type: "local" },
    chain: { id: 10143 },
    async getChainId() {
      return 10143;
    },
    async writeContract(req: { functionName: string; address: string; args: readonly unknown[] }) {
      sent.push({ functionName: req.functionName, args: req.args });
      if (req.functionName === "approve") allowance.set(`${req.address}-${String(req.args[0])}`, req.args[1] as bigint);
      return `0x${"cd".repeat(32)}` as Hex;
    },
  };
  return { c, w: w as never, sent, s, allowance };
}
const outcome = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WriteError);
const MAKER: { asks: Lv[]; bids: Lv[] } = { asks: [[4_030_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]] };

describe("the band: what a token can still pay at the month's end", () => {
  test("before the month [F, C]; inside it narrower as days are applied; settled S / N", () => {
    expect(band(world(MAKER).s as never)).toMatchObject({ lo: 1.95, hi: 8 });
    const mid = band(world({ ...MAKER, k: 10, S: 40_000_000n }).s as never);
    expect(mid.lo).toBe(2.633333);
    expect(mid.hi).toBe(6.666666);
    expect(band(world({ ...MAKER, k: 30, S: 120_000_000n }).s as never)).toMatchObject({ lo: 4, hi: 4 });
  });
  test("mid-month a buy below the cap but above what the month can still pay is refused", async () => {
    const f = world({ asks: [[7_000_000n, 10_000_000n]], bids: MAKER.bids, k: 10, S: 40_000_000n });
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "100" }));
    expect(e?.reason).toBe("AboveBand");
    expect(e?.quote?.avgPrice).toBeCloseTo(7, 4); // 100 / 14.2857: Kuru buys whole size units
    expect(f.sent).toEqual([]);
  });
  test("mid-month a sale above the floor but below what the month pays at least is refused", async () => {
    const f = world({ asks: MAKER.asks, bids: [[2_500_000n, 10_000_000n]], k: 10, S: 40_000_000n });
    const e = await outcome(sellLong(f.c, f.w, { gpu: "H100", month: "2026-11", gpuHours: "10" }));
    expect(e?.reason).toBe("BelowBand");
    expect(f.sent).toEqual([]);
  });
  test("settled: a buy above S / N is refused", async () => {
    const f = world({ ...MAKER, k: 30, S: 120_000_000n });
    expect((await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "100" })))?.reason).toBe("AboveBand");
  });
  test("closeShort refuses a buy-back above the cap (holding pays more)", async () => {
    const f = world({ asks: [[20_000_000n, 10_000_000n]], bids: MAKER.bids });
    const e = await outcome(closeShort(f.c, f.w, { gpu: "H100", month: "2026-11", positionIds: ["1"] }));
    expect(e?.stage).toBe("check");
    expect(e?.reason).toBe("AboveBand");
    expect(f.sent).toEqual([]);
  });
  test("closeShort spends at most q x C plus Kuru's rounding, whatever the slippage allows", async () => {
    const f = world({ asks: [[7_990_000n, 10_000_000n]], bids: MAKER.bids });
    await outcome(closeShort(f.c, f.w, { gpu: "H100", month: "2026-11", positionIds: ["1"], slippageBps: 5_000 }));
    const sent = f.sent.find((x) => x.functionName === "closeShort");
    expect(sent?.args[2] as bigint).toBeLessThanOrEqual(24n * CAP + 3n * 800n);
  });
  test("openShort and closeLongDaily refuse a sale below the floor", async () => {
    const f = world({ asks: MAKER.asks, bids: [[500_000n, 10_000_000n]] });
    expect((await outcome(openShort(f.c, f.w, { gpu: "H100", month: "2026-11", gpuHours: "24" })))?.reason).toBe("BelowBand");
    const g = world({ asks: MAKER.asks, bids: [[500_000n, 10_000_000n]], position: { side: 0, q: 24_000_000n } });
    expect((await outcome(closeLongDaily(g.c, g.w, { gpu: "H100", month: "2026-11", positionIds: ["1"] })))?.reason).toBe("BelowBand");
    expect([...f.sent, ...g.sent]).toEqual([]);
  });
  test("a limit order outside what the month can still pay is refused before anything is sent", async () => {
    const f = world({ ...MAKER, k: 10, S: 40_000_000n });
    const e = await placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "long", price: "7.00", gpuHours: "10" }).catch((x: Error) => x);
    expect((e as Error).message).toContain("band 2.64 to 6.66");
    expect(f.sent).toEqual([]);
  });
  test("a post-only ask at or below the best bid is refused before the mint and deposit", async () => {
    const f = world(MAKER);
    const e = await outcome(placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "short", price: "3.95", gpuHours: "10", mint: true }));
    expect(e?.reason).toBe("PostOnlyError");
    expect(f.sent).toEqual([]);
  });
});

describe("the price the app showed", () => {
  test("a buy whose fresh quote is worse than shown by more than the slippage is refused, with the new quote", async () => {
    const f = world(MAKER);
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", maxPrice: "3.50" }));
    expect(e?.stage).toBe("check");
    expect(e?.reason).toBe("PriceMoved");
    expect(e?.quote).toEqual({ gpuHours: 248.1389, dollars: 1000, avgPrice: 4.03 });
    expect(e?.txs).toEqual([]);
    expect(f.sent).toEqual([]);
  });
  test("within the slippage it sends, the minimum out the stricter of the fresh quote and the shown one", async () => {
    const f = world(MAKER);
    await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", maxPrice: "4.00", slippageBps: 100 }));
    const open = f.sent.find((x) => x.functionName === "openLong")!;
    // fresh 248.1389 less 1% = 245.657511; shown 1000 / 4.00 = 250 less 1% = 247.5: the stricter
    expect(open.args[2]).toBe(247_500_000n);
  });
  test("a sale below the shown price less the slippage is refused", async () => {
    const f = world(MAKER);
    const e = await outcome(sellLong(f.c, f.w, { gpu: "H100", month: "2026-11", gpuHours: "10", minPrice: "4.10" }));
    expect(e?.reason).toBe("PriceMoved");
    expect(e?.quote?.avgPrice).toBe(3.95);
  });
  test("a buy-back costlier than shown plus the slippage is refused", async () => {
    const f = world(MAKER);
    const e = await outcome(closeShort(f.c, f.w, { gpu: "H100", month: "2026-11", positionIds: ["1"], maxPrice: "3.90" }));
    expect(e?.reason).toBe("PriceMoved");
  });
});

describe("a write refused after some transactions landed", () => {
  test("the unused approval is put back, and the error carries every landed transaction", async () => {
    // the main transaction's simulation reverts after the approval landed (the book moved: Kuru's SlippageExceeded)
    const f = world({ ...MAKER, revert: { openLong: "0x8199f5f3" } });
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(f.sent.map((x) => x.functionName)).toEqual(["approve", "approve"]);
    expect(f.sent[1]!.args).toEqual([ROUTER, 0n]);
    expect(f.allowance.get(`${DOLLAR}-${ROUTER}`)).toBe(0n);
    expect(e?.txs.map((t) => t.label)).toEqual(["approve tUSD to the router", "put back: approve tUSD to the router"]);
    expect(e?.reason).toBe("SlippageExceeded");
    expect(e?.message).not.toContain("nothing was sent");
    expect(e?.message).toContain("put back");
  });
  test("a receipt that does not come in time is a WriteError carrying the hash", async () => {
    const f = world({ ...MAKER, noReceipt: true });
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "10" }));
    expect(e).toBeInstanceOf(WriteError);
    expect(e?.stage).toBe("receipt");
    expect(e?.hash).toBe(`0x${"cd".repeat(32)}`);
    expect(e?.reason).toBe("NoReceipt");
  });
});

// ------------------------------------------------------------------ reads

const H100 = PANELS.find((p) => p.gpu === "H100")!.gpuId as Hex;
const OCT = 2026 * 12 + 9;
const NOV = OCT + 1;
const NOW = 1_791_158_400n; // 2026-10-05T00:00:00Z

/** A chain with H100 Nov listed (or not), its market's order counter and orders, and index records. */
function fakeChain(o: { listed?: boolean; counter?: number; orders?: Record<number, { owner: string; isBuy: boolean; price: number; size: bigint }>; records?: Record<number, number> } = {}): PublicClient {
  const read = ({ functionName, args }: { functionName: string; args?: readonly unknown[] }): unknown => {
    switch (functionName) {
      case "currentMonth":
        return OCT;
      case "gpuIds":
        return [H100];
      case "labelOf":
        return "H100";
      case "gpu":
        return { recipeHash: `0x${"00".repeat(32)}`, nSlots: 6, nFamilies: 6, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head: 20734 };
      case "seriesOf":
        return o.listed !== false && Number(args?.[1]) === NOV ? SERIES : "0x0000000000000000000000000000000000000000";
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
        return [0, 0n, 0, false, false, 0n, 1n, 0n];
      case "totalSupply":
        return 0n;
      case "getL2Book":
        return `0x${"00".repeat(31)}01${"00".repeat(32)}`;
      case "s_orderIdCounter":
        return o.counter ?? 0;
      case "s_orders": {
        const x = o.orders?.[Number(args?.[0])];
        return x ? [x.owner, x.size, 0, 0, 0, x.price, 0, x.isBuy] : ["0x0000000000000000000000000000000000000000", 0n, 0, 0, 0, 0, 0, false];
      }
      case "s_buyPricePoints":
      case "s_sellPricePoints":
        return [1, 1]; // head 1: every id >= 1 still rests
      case "record": {
        const v = o.records?.[Number(args?.[1])];
        return [v !== undefined, v !== undefined, { value: v ?? 0, status: 1, source: A(0x99), postedAt: 1n, finalAt: 2n, dropped: false }];
      }
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  return {
    getCode: async () => undefined, // no Multicall3: the client reads call by call
    readContract: async (r: { functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: NOW }),
    getBalance: async () => 0n,
  } as unknown as PublicClient;
}
/** An indexer answering each query by its operation name (or the first alias of an aliased query). */
function fakeIndexer(answers: Record<string, unknown>): typeof fetch {
  return (async (_u: string, init: { body: string }) => {
    const q = (JSON.parse(init.body) as { query: string }).query;
    const key = /query (\w+)/.exec(q)?.[1] ?? /\{\s*(\w+):/.exec(q)?.[1] ?? "?";
    if (!(key in answers)) return new Response(JSON.stringify({ errors: [{ message: `no fake answer for ${key}` }] }), { status: 200 });
    return new Response(JSON.stringify({ data: answers[key] }), { status: 200 });
  }) as unknown as typeof fetch;
}
const trade = (id: string, t: bigint, priceU: number) => ({ id, block: id.split("-")[0], timestamp: String(t), priceU: String(priceU), tokens: "1000000", takerIsBuy: true, maker: "0xm", taker: "0xt", txOrigin: "0xo", txHash: "0x1" });

describe("reads after the checks", () => {
  test("book, fills and candles of a month not listed are empty, not an error", async () => {
    const c = new AgateClient({ publicClient: fakeChain({ listed: false }), graphqlUrl: null });
    expect(await c.book("H100", "2026-11")).toEqual({ asks: [], bids: [], spread: 0 });
    expect(await c.recentFills("H100", "2026-11")).toEqual([]);
    expect(await c.candles("H100", "2026-11")).toEqual([]);
    expect(await c.book("B300", "2026-11")).toEqual({ asks: [], bids: [], spread: 0 }); // a price-only GPU
    await expect(c.seriesAt("H100", "2026-11")).rejects.toThrow("not listed");
  });

  test("a month's price 24 h earlier is its last trade before then (the newest by log index), not the first in the window", async () => {
    const c = new AgateClient({ publicClient: fakeChain(), fetch: fakeIndexer({ TradesBefore: { Trade: [trade("90-1", NOW - 90_000n, 4_000_000), trade("90-3", NOW - 90_000n, 4_100_000), trade("80-9", NOW - 100_000n, 3_000_000)] } }), graphqlUrl: "http://fake/v1/graphql" });
    expect(await c.priceBefore(SERIES, NOW)).toBe(4_100_000n);
  });
  test("a month younger than 24 h falls back to its first trade; one that never traded has none", async () => {
    const young = new AgateClient({ publicClient: fakeChain(), fetch: fakeIndexer({ TradesBefore: { Trade: [] }, TradesSince: { Trade: [trade("95-2", NOW - 3_600n, 4_500_000), trade("95-1", NOW - 3_600n, 4_400_000)] } }), graphqlUrl: "http://fake/v1/graphql" });
    expect(await young.priceBefore(SERIES, NOW)).toBe(4_400_000n);
    const none = new AgateClient({ publicClient: fakeChain(), fetch: fakeIndexer({ TradesBefore: { Trade: [] }, TradesSince: { Trade: [] } }), graphqlUrl: "http://fake/v1/graphql" });
    expect(await none.priceBefore(SERIES, NOW)).toBeNull();
  });

  test("history: the days a lagging indexer has not reached are read from the chain", async () => {
    const c = new AgateClient({ publicClient: fakeChain({ records: { 20731: 3_980_000, 20732: 3_970_000 } }), fetch: fakeIndexer({ History: { DailyFix: [{ gpuId: H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FRESH", state: "FINAL", finalAt: "1" }] } }), graphqlUrl: "http://fake/v1/graphql" });
    const rec = (value: bigint) => ({ exists: true, isFinal: true, value, status: 1, source: A(0x99), postedAt: 1n, finalAt: 2n, dropped: false });
    const view = { gpu: "H100", gpuId: H100, panel: PANELS[0]!, nSlots: 6, firstDay: 20730, head: 20734, latest: { day: 20733, rec: rec(3_960_000n) }, prev: null, next: null };
    const h = (await c.history([view as never], NOW)).get("H100")!;
    expect(h.map((d) => [d.date, d.price])).toEqual([
      ["2026-10-04", 3.99],
      ["2026-10-05", 3.98],
      ["2026-10-06", 3.97],
      ["2026-10-07", 3.96],
    ]);
  });

  test("open orders: ids above the indexer's newest are scanned on chain, so a fresh order is never missed", async () => {
    const me = ME.toLowerCase();
    const chain = fakeChain({ counter: 12, orders: { 12: { owner: ME, isBuy: true, price: 3_900_000, size: 100_000n }, 11: { owner: A(0xbb), isBuy: true, price: 3_950_000, size: 100_000n } } });
    const c = new AgateClient({ publicClient: chain, fetch: fakeIndexer({ OpenOrders: { BookOrder: [] }, m0: { m0: [{ orderId: "10" }] } }), graphqlUrl: "http://fake/v1/graphql" });
    const r = await c.openOrdersResult(me);
    expect(r.source).toBe("indexer");
    expect(r.complete).toBe(true);
    expect(r.orders.map((x) => [x.id, x.side, x.price, x.q])).toEqual([["12", "long", 3.9, 10]]);
  });
  test("open orders without the indexer say when the scan could not reach every id", async () => {
    const chain = fakeChain({ counter: 2_000, orders: { 1_999: { owner: ME, isBuy: false, price: 4_100_000, size: 100_000n } } });
    const r = await new AgateClient({ publicClient: chain, graphqlUrl: null }).openOrdersResult(ME);
    expect(r).toMatchObject({ source: "chain", complete: false });
    expect(r.orders.map((x) => [x.id, x.side])).toEqual([["1999", "short"]]);
  });
});

describe("the GraphQL default on a hosted page", () => {
  const g = globalThis as { location?: unknown };
  const saved = process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
  afterEach(() => {
    delete g.location;
    if (saved === undefined) delete process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
    else process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL = saved;
  });
  test("a page served from elsewhere with no URL set reads the chain only, never the visitor's own localhost", () => {
    delete process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL;
    g.location = { hostname: "agate.example" };
    expect(resolveGraphqlUrl()).toBeNull();
    g.location = { hostname: "localhost" };
    expect(resolveGraphqlUrl()).toBe(DEFAULT_GRAPHQL_URL);
    g.location = { hostname: "agate.example" };
    process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL = "https://indexer.example/v1/graphql";
    expect(resolveGraphqlUrl()).toBe("https://indexer.example/v1/graphql");
  });
});

describe("no put-back while the outcome is unknown", () => {
  test("a main transaction whose receipt did not come leaves the approval as it is and says so", async () => {
    // the approval's receipt comes, the openLong's does not
    const f = world(MAKER);
    let n = 0;
    const wait = f.c.pub.waitForTransactionReceipt.bind(f.c.pub);
    (f.c.pub as unknown as { waitForTransactionReceipt: (x: { hash: Hex }) => Promise<unknown> }).waitForTransactionReceipt = async (x) => {
      if (++n === 2) throw new WaitForTransactionReceiptTimeoutError({ hash: x.hash });
      return wait(x as never);
    };
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "100" }));
    expect(f.sent.map((x) => x.functionName)).toEqual(["approve", "openLong"]);
    expect(e?.reason).toBe("NoReceipt");
    expect(e?.txs.map((t) => t.label)).toEqual(["approve tUSD to the router"]);
    expect(e?.message).toContain("once nothing is pending");
  });
});
