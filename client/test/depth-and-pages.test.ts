// The guards added after the final check, on fakes (no chain, no network):
//   1. a buy (buyLong, openLongDaily) spends no more than the asks at or under the band's top hold ("ThinBook"), its
//      minimum out is met only by a complete fill at those prices, a book that moved between its read and Kuru's
//      simulation is read again, and every refusal's quote is what the dollars actually fill;
//   2. a write the wallet's tUSD cannot pay is refused before its approval ("InsufficientBalance"), for every flow;
//   3. the indexer's pages: ordered by a unique key, each trade counted once, every page of a wallet read;
//   4. a price-only GPU's write says so.
// The fake Kuru market fills a buy as Kuru's `_marketBuyMatch` does (whole size units per level, the quote left
// re-derived when a level runs out, the taker fee taken from the tokens), written out here on its own.
import { describe, expect, test } from "bun:test";
import type { Hex, PublicClient } from "viem";
import { AgateClient, WALLET_PAGE } from "../src/client.ts";
import { Q } from "../src/graphql.ts";
import { PANELS, TESTNET_DEPLOYMENTS } from "../src/static.ts";
import { buyLong, closeLongDaily, closeShort, mintPairs, openLongDaily, openShort, placeLimit, WriteError } from "../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const SERIES = A(0x11), TOKEN = A(0x22), MARKET = A(0x33), ROUTER = A(0x44), DOLLAR = A(0x55), MA = A(0x66), FACTORY = A(0x77);
const CAP = 8_000_000n;
const U = 1_000_000n;
type Lv = [bigint, bigint]; // [price u, size units]
const GH = (n: number) => BigInt(Math.round(n * 10_000)); // GPU-hours to size units

/** Kuru's market buy (OrderBook._marketBuyMatch, taker fee in bps): tokens (base units) and the quote it uses. */
function kuru(asks: Lv[], quote: bigint, feeBps = 0n): { tokens: bigint; spent: bigint } {
  let q = quote;
  let units = 0n;
  for (const [p, z] of asks) {
    if (q === 0n) break;
    const fillable = (q * 10_000n) / p;
    const filled = fillable < z ? fillable : z;
    units += filled;
    q = (p * (fillable - filled)) / 10_000n;
  }
  let tokens = units * 100n;
  if (feeBps > 0n) tokens -= (tokens * feeBps + 9_999n) / 10_000n;
  return { tokens, spent: quote - q };
}

/** getL2Book's bytes: the block, the bids' (price, size) pairs, a zero word, the asks' pairs. */
function l2(asks: Lv[], bids: Lv[] = []): Hex {
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  return `0x${w(1n)}${bids.map(([p, z]) => w(p) + w(z)).join("")}${w(0n)}${asks.map(([p, z]) => w(p) + w(z)).join("")}` as Hex;
}

const revertErr = (errorName: string) => Object.assign(new Error(`reverted: ${errorName}`), { name: "ContractFunctionRevertedError", data: { errorName } });

/** One listed month (N = 30, F 1.95, C 8.00, k days applied with sum S). `asks` is the book the client read with the
 *  series; `sim` what Kuru's simulation sees (default: the same); `reread` what a new getL2Book returns (default: the
 *  simulation's book); `landing` the book when the transaction lands (default: the simulation's). The router pulls
 *  what it is given, buys on the landing book, refuses below its minimum out and refunds the rest. */
function market(o: { asks: Lv[]; bids?: Lv[]; sim?: Lv[]; reread?: Lv[]; landing?: Lv[]; k?: number; S?: bigint; fee?: bigint; balance?: bigint; position?: { side: number; q: bigint } }) {
  const bids = o.bids ?? [[3_950_000n, GH(1000)]];
  const sim = o.sim ?? o.asks;
  const sent: { functionName: string; args: readonly unknown[] }[] = [];
  const allowance = new Map<string, bigint>();
  let dollars = o.balance ?? 10n ** 12n;
  let simCalls = 0;
  const landed: { tokens: bigint; spent: bigint }[] = [];
  const terms = { series: SERIES, token: TOKEN, gpuId: `0x${"ab".repeat(32)}`, month: 2026 * 12 + 10, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000n, cap: CAP, name: "agate H100 Nov 2026", symbol: "H100-NOV26" };
  const s = { gpu: "H100", terms, market: MARKET, k: o.k ?? 0, S: o.S ?? 0n, tokenSupply: 0n, nextId: 2n, book: { block: 1n, asks: o.asks, bids } };
  const pub = {
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName === "placeAndExecuteMarketBuy") {
        simCalls++;
        return { result: kuru(sim, req.args[0] as bigint, o.fee).tokens };
      }
      if (req.functionName === "openLong" || req.functionName === "openLongDaily") {
        if (dollars < (req.args[1] as bigint)) throw revertErr("ERC20InsufficientBalance");
      }
      return { result: 1n };
    },
    async estimateContractGas() {
      return 100_000n;
    },
    async readContract(req: { functionName: string; address: string; args?: readonly unknown[] }) {
      if (req.functionName === "takerFeeBps") return o.fee ?? 0n;
      if (req.functionName === "getL2Book") return l2(o.reread ?? sim, bids);
      if (req.functionName === "balanceOf") return req.address === DOLLAR ? dollars : 10n ** 12n;
      if (req.functionName === "allowance") return allowance.get(`${req.address}-${String(req.args?.[1])}`) ?? 0n;
      return 0n; // Kuru margin balances
    },
    async waitForTransactionReceipt() {
      const last = sent[sent.length - 1]!;
      if (last.functionName === "approve") allowance.set(`${DOLLAR}-${String(last.args[0])}`, last.args[1] as bigint);
      if (last.functionName === "openLong" || last.functionName === "openLongDaily") {
        const got = kuru(o.landing ?? sim, last.args[1] as bigint, o.fee);
        if (got.tokens < (last.args[2] as bigint)) return { status: "reverted", gasUsed: 90_000n, blockNumber: 1n, logs: [] };
        // the router pulls the whole spend (its allowance used), buys, and refunds what Kuru did not use
        const k = `${DOLLAR}-${ROUTER}`;
        allowance.set(k, (allowance.get(k) ?? 0n) - (last.args[1] as bigint));
        dollars -= got.spent;
        landed.push(got);
      }
      return { status: "success", gasUsed: 90_000n, blockNumber: 1n, logs: [] };
    },
  };
  const c = {
    pub,
    chain: { id: 10143 },
    dollar: DOLLAR,
    router: ROUTER,
    marginAccount: MA,
    factory: FACTORY,
    deployments: { kuru: { marginAccount: MA, router: A(0x88) } },
    seriesAt: async () => s,
    chainTime: async () => 0n,
    mc: async (calls: unknown[]) => calls.map(() => ({ ok: true, value: { owner: ME, side: o.position?.side ?? 1, q: o.position?.q ?? 24_000_000n, operator: ROUTER } })),
  } as unknown as AgateClient;
  const w = {
    account: { address: ME, type: "local" },
    chain: { id: 10143 },
    getChainId: async () => 10143,
    async writeContract(req: { functionName: string; args: readonly unknown[] }) {
      sent.push({ functionName: req.functionName, args: req.args });
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { c, w: w as never, sent, landed, simCalls: () => simCalls, minOut: () => sent.find((x) => x.functionName === "openLong" || x.functionName === "openLongDaily")?.args[2] as bigint | undefined };
}
const outcome = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WriteError);
const NOV = { gpu: "H100" as const, month: "2026-11" };
const LADDER: Lv[] = [[4_030_000n, GH(1000)], [4_040_000n, GH(2000)], [4_050_000n, GH(4000)]];
const THIN: Lv[] = [[4_030_000n, GH(148.88)]];
const HIGH: Lv = [4_000_000_000n, GH(0.1)]; // $4,000 per GPU-hour, 500 x the cap

// ================================================================== 1. a buy and the asks' depth

describe("a buy spends no more than the asks at or under the band's top hold", () => {
  test("more dollars than those asks hold is refused before anything is sent, naming the most it may spend", async () => {
    const f = market({ asks: [...THIN, HIGH] });
    const e = await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "1000" }));
    expect(e?.reason).toBe("ThinBook");
    expect(e?.stage).toBe("check");
    expect(e?.quote).toEqual({ gpuHours: 148.88, dollars: 599.9864, avgPrice: 4.03 });
    expect(e?.message).toContain("buy at most $599.9864");
    expect(e?.txs).toEqual([]);
    expect(f.sent).toEqual([]);
  });
  test("that amount then buys every one of those asks and nothing behind them, even with an ask at $4,000 posted after the quote", async () => {
    const f = market({ asks: THIN, landing: [...THIN, HIGH] });
    await buyLong(f.c, f.w, { ...NOV, dollars: "599.9864" }).catch(() => undefined); // the fake's receipts carry no Routed event
    expect(f.landed).toEqual([{ tokens: 148_880_000n, spent: 599_986_400n }]);
    expect(f.minOut()).toBe((148_880_000n * 9_900n) / 10_000n);
  });
  test("the minimum out is a complete fill at the book's prices less the slippage (the ladder: 248.1389 at $4.03)", async () => {
    const f = market({ asks: LADDER });
    await buyLong(f.c, f.w, { ...NOV, dollars: "1000" }).catch(() => undefined);
    expect(f.minOut()).toBe((248_138_900n * 9_900n) / 10_000n);
  });
  test("a front-runner who takes some of the asks and posts $4,000 behind them gets at most the slippage of the spend, or the buy reverts", async () => {
    // the app quotes on 150 at 4.05 ($607.50); before the buy lands, 3 of them are taken and $4,000 is posted behind
    const book: Lv[] = [[4_050_000n, GH(150)]];
    const f = market({ asks: book, landing: [[4_050_000n, GH(147)], HIGH] });
    await buyLong(f.c, f.w, { ...NOV, dollars: "600" }).catch(() => undefined);
    const minOut = f.minOut()!;
    const fair = kuru(book, 600_000_000n).tokens;
    expect(minOut).toBe((fair * 9_900n) / 10_000n);
    // landed (147.0009 >= 146.67): the user lost at most 1% of the GPU-hours the quote promised
    expect(f.landed.length).toBe(1);
    expect(f.landed[0]!.tokens).toBeGreaterThanOrEqual(minOut);
  });
  test("no ask at or under the top: AboveBand, the quote what the dollars would fill (only the dollars that fill)", async () => {
    const f = market({ asks: [[20_000_000n, GH(10)]] });
    const e = await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "1000" }));
    expect(e?.reason).toBe("AboveBand");
    // $1,000 meets 10 GPU-hours at $20: $200 fill, the rest would come back
    expect(e?.quote).toEqual({ gpuHours: 10, dollars: 200, avgPrice: 20 });
    expect(f.sent).toEqual([]);
  });
  test("inside the month the top narrows with the days applied: only the asks under it count", async () => {
    // k = 10, S = 40: the top is (40 + 20 x 8) / 30 = 6.666666
    const asks: Lv[] = [[6_600_000n, GH(10)], [7_000_000n, GH(1000)]];
    const f = market({ asks, k: 10, S: 40_000_000n });
    const e = await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "100" }));
    expect(e?.reason).toBe("ThinBook");
    expect(e?.quote).toEqual({ gpuHours: 10, dollars: 66, avgPrice: 6.6 });
    const g = market({ asks, k: 10, S: 40_000_000n });
    await buyLong(g.c, g.w, { ...NOV, dollars: "50" }).catch(() => undefined);
    expect(g.landed[0]?.spent).toBe(50_000_000n);
  });
  test("empty asks: EmptyBook; a spend under one size unit's cost: too small; nothing sent", async () => {
    const f = market({ asks: [] });
    expect((await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "10" })))?.reason).toBe("EmptyBook");
    const g = market({ asks: LADDER });
    const e = await outcome(buyLong(g.c, g.w, { ...NOV, dollars: "0.0004" }));
    expect(e?.message).toContain("too small");
    expect([...f.sent, ...g.sent]).toEqual([]);
  });
  test("openLongDaily is held to the same depth", async () => {
    const f = market({ asks: [...THIN, HIGH] });
    const e = await outcome(openLongDaily(f.c, f.w, { ...NOV, dollars: "1000", parts: 2 }));
    expect(e?.reason).toBe("ThinBook");
    expect(f.sent).toEqual([]);
  });
});

describe("a book that moved between its read and Kuru's simulation", () => {
  test("is read again and the buy planned on it: thinned below the spend, it is refused as thin", async () => {
    // read: the ladder; meanwhile someone bought 900 of the 1,000 at 4.03 and the rest of the ladder, and $4,000 rests behind
    const now: Lv[] = [[4_030_000n, GH(100)], HIGH];
    const f = market({ asks: LADDER, sim: now });
    const e = await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "1000" }));
    expect(e?.reason).toBe("ThinBook");
    expect(e?.quote?.dollars).toBe(403);
    expect(f.simCalls()).toBe(2);
    expect(f.sent).toEqual([]);
  });
  test("moved but still deep enough: planned on the new book, the minimum out from it", async () => {
    const now: Lv[] = [[4_100_000n, GH(1000)]];
    const f = market({ asks: [[4_030_000n, GH(1000)]], sim: now });
    await buyLong(f.c, f.w, { ...NOV, dollars: "1000" }).catch(() => undefined);
    const fresh = kuru(now, 1_000_000_000n).tokens;
    expect(f.minOut()).toBe((fresh * 9_900n) / 10_000n);
  });
  test("a book that keeps disagreeing with the simulation is refused as moving, nothing sent", async () => {
    const f = market({ asks: [[4_030_000n, GH(1000)]], sim: [[4_200_000n, GH(1000)]], reread: [[4_030_000n, GH(1000)]] });
    const e = await outcome(buyLong(f.c, f.w, { ...NOV, dollars: "1000" }));
    expect(e?.reason).toBe("PriceMoved");
    expect(e?.message).toContain("the book is moving");
    expect(f.sent).toEqual([]);
  });
  test("a simulation a little short of the book (within the slippage) never lowers the minimum out below the book's complete fill less the slippage", async () => {
    // read at 4.03; the simulation sees 4.06 (0.74% worse): no second read, and the bound stays 1% under the read
    // book's complete fill, so whatever a thinner book leaves unfilled cannot add to the slippage
    const f = market({ asks: [[4_030_000n, GH(1000)]], sim: [[4_060_000n, GH(1000)]] });
    await buyLong(f.c, f.w, { ...NOV, dollars: "1000" }).catch(() => undefined);
    expect(f.simCalls()).toBe(1);
    expect(f.minOut()).toBe((248_138_900n * 9_900n) / 10_000n);
  });
  test("a simulation that finds more (cheaper asks arrived) raises the minimum out to it", async () => {
    const now: Lv[] = [[3_990_000n, GH(1000)]];
    const f = market({ asks: [[4_030_000n, GH(1000)]], sim: now });
    await buyLong(f.c, f.w, { ...NOV, dollars: "1000" }).catch(() => undefined);
    expect(f.minOut()).toBe((kuru(now, 1_000_000_000n).tokens * 9_900n) / 10_000n);
  });
});

describe("Kuru's taker fee", () => {
  test("is taken from the plan's tokens, so a market with a fee is neither refused nor bounded above what it pays", async () => {
    const f = market({ asks: LADDER, fee: 30n });
    await buyLong(f.c, f.w, { ...NOV, dollars: "1000" }).catch(() => undefined);
    const net = kuru(LADDER, 1_000_000_000n, 30n).tokens;
    expect(net).toBe(248_138_900n - 744_417n);
    expect(f.minOut()).toBe((net * 9_900n) / 10_000n);
    expect(f.landed[0]?.tokens).toBe(net);
  });
});

// ================================================================== 2. the wallet's tUSD

describe("a write the wallet's tUSD cannot pay is refused before its approval", () => {
  const flows: [string, (m: ReturnType<typeof market>) => Promise<unknown>, { side: number; q: bigint } | undefined][] = [
    ["buyLong $100", (m) => buyLong(m.c, m.w, { ...NOV, dollars: "100" }), undefined],
    ["openLongDaily $100", (m) => openLongDaily(m.c, m.w, { ...NOV, dollars: "100", parts: 2 }), undefined],
    ["openShort 24 (collateral $192)", (m) => openShort(m.c, m.w, { ...NOV, gpuHours: "24", parts: 2 }), undefined],
    ["closeShort 24 (buy-back about $97)", (m) => closeShort(m.c, m.w, { ...NOV, positionIds: ["1"] }), { side: 1, q: 24_000_000n }],
    ["closeLongDaily 24 (mint $192)", (m) => closeLongDaily(m.c, m.w, { ...NOV, positionIds: ["1"] }), { side: 0, q: 24_000_000n }],
    ["mintPairs 10 ($80)", (m) => mintPairs(m.c, m.w, { ...NOV, gpuHours: "10" }), undefined],
    ["placeLimit long 10 at 3.90 ($39 deposit)", (m) => placeLimit(m.c, m.w, { ...NOV, side: "long", price: "3.90", gpuHours: "10" }), undefined],
    ["placeLimit short 10 at 4.10, minted ($80)", (m) => placeLimit(m.c, m.w, { ...NOV, side: "short", price: "4.10", gpuHours: "10", mint: true }), undefined],
  ];
  for (const [name, run, position] of flows) {
    test(`${name}: InsufficientBalance with $5, nothing sent`, async () => {
      const m = market({ asks: LADDER, balance: 5_000_000n, ...(position ? { position } : {}) });
      const e = await outcome(run(m));
      expect(e?.reason).toBe("InsufficientBalance");
      expect(e?.message).toContain("the wallet holds $5 tUSD");
      expect(e?.message).toContain("nothing was sent");
      expect(m.sent).toEqual([]);
    });
  }
  test("the price checks come first: a thin-book buy names the depth even when the wallet is short too", async () => {
    const m = market({ asks: THIN, balance: 5_000_000n });
    expect((await outcome(buyLong(m.c, m.w, { ...NOV, dollars: "1000" })))?.reason).toBe("ThinBook");
  });
  test("a wallet that can pay exactly the spend is not refused", async () => {
    const m = market({ asks: LADDER, balance: 100_000_000n });
    await buyLong(m.c, m.w, { ...NOV, dollars: "100" }).catch(() => undefined);
    expect(m.sent.map((x) => x.functionName)).toEqual(["approve", "openLong"]);
  });
});

// ================================================================== 3. the indexer's pages

const H100 = PANELS.find((p) => p.gpu === "H100")!.gpuId as Hex;
const OCT = 2026 * 12 + 9;
const NOW = 1_791_158_400n; // 2026-10-05T00:00:00Z
const f0 = TESTNET_DEPLOYMENTS.factories.real!;
const lc = (s: string) => s.toLowerCase();
const LSERIES = "0x1111111111111111111111111111111111111111";
const LTOKEN = "0x2222222222222222222222222222222222222222";
const USER = lc(ME);

/** A chain with H100 November listed (an empty book), the user holding 80 tokens, nothing else. */
function chain(): PublicClient {
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
        return Number(args?.[1]) === OCT + 1 ? LSERIES : "0x0000000000000000000000000000000000000000";
      case "terms":
        return { gpuId: H100, month: OCT + 1, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000, cap: 8_000_000 };
      case "token":
        return LTOKEN;
      case "name":
        return "agate H100 Nov 2026";
      case "symbol":
        return "H100-NOV26";
      case "marketOf":
        return [A(0x33), 1];
      case "previewSync":
        return [0, 0n];
      case "state":
        return [0, 0n, 0, false, false, 0n, 1n, 0n];
      case "totalSupply":
        return 80_000_000n;
      case "getL2Book":
        return l2([]);
      case "balanceOf":
        return lc(address) === lc(f0.dollar) ? 1_000_000_000n : 80_000_000n;
      case "nextDripAt":
        return 0n;
      case "dripPeriod":
        return 86_400n;
      case "getBalance":
      case "shortOf":
        return 0n;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  return {
    getCode: async () => undefined,
    readContract: async (r: { address: string; functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: NOW }),
    getBalance: async () => 10n ** 18n,
  } as unknown as PublicClient;
}
const row = (block: number, log: number, o: { price?: number; tx?: string; series?: string; maker?: string } = {}) => ({
  id: `${block}-${log}`,
  block: String(block),
  timestamp: String(Number(NOW) - 7_200 + block),
  priceU: String(o.price ?? 4_000_000),
  tokens: "1000000",
  takerIsBuy: true,
  maker: o.maker ?? "0xbot",
  taker: lc(f0.router),
  txOrigin: USER,
  txHash: o.tx ?? `0x${block}`,
  series_id: o.series ?? LSERIES,
});

describe("the indexer's pages", () => {
  test("every paged query orders by a unique key last (rows of one block keep one order across pages)", () => {
    expect(Q.tradesSince).toContain("order_by: [{block: asc}, {id: asc}]");
    expect(Q.trades).toContain("order_by: [{block: $desc}, {id: $desc}]");
    expect(Q.tradesBefore).toContain("order_by: [{block: desc}, {id: desc}]");
    for (const q of [Q.wallet, Q.moreFlows, Q.moreTrades]) expect(q).toContain("{block: asc}, {id: asc}");
    for (const q of [Q.wallet, Q.morePositions]) expect(q).toContain("order_by: [{id: asc}]");
  });
  test("a candle counts each trade once, even when two pages overlap", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => row(100 + Math.floor(i / 4), i % 4));
    const page2 = [...page1.slice(-5), row(400, 0), row(400, 1)]; // the last 5 of page 1 again, then 2 new
    const fake = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { query: string; variables: { offset?: number } };
      if (!b.query.includes("query TradesSince")) return new Response(JSON.stringify({ errors: [{ message: "not in this fake" }] }), { status: 200 });
      return new Response(JSON.stringify({ data: { Trade: b.variables.offset === 0 ? page1 : page2 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new AgateClient({ publicClient: chain(), fetch: fake, graphqlUrl: "http://fake/v1/graphql" });
    const candles = await c.candles("H100", "2026-11");
    expect(candles.reduce((a, k) => a + k.v, 0)).toBe(1002);
  });
  test("getWallet reads every page of a wallet's flows and trades: a buy past the first page still sets the entry", async () => {
    // the first page of each is full of another month's rows; the user's openLong of the held tokens is on page 2
    const other = "0x9999999999999999999999999999999999999999";
    const flows1 = Array.from({ length: WALLET_PAGE }, (_, i) => ({ id: `${i + 1}-0`, flow: "OPEN_LONG", series_id: other, tokens: "1", dollarsIn: "1", dollarsOut: "0", refund: "0", positionIds: [], txHash: `0xo${i}`, timestamp: "1" }));
    const trades1 = Array.from({ length: WALLET_PAGE }, (_, i) => row(i + 1, 0, { series: other, tx: `0xo${i}` }));
    const flows2 = [{ id: "5000-0", flow: "OPEN_LONG", series_id: LSERIES, tokens: "80000000", dollarsIn: "320000000", dollarsOut: "0", refund: "0", positionIds: [], txHash: "0xa", timestamp: "2" }];
    const trades2 = [row(5000, 1, { tx: "0xa", price: 4_000_000 })];
    const asked: string[] = [];
    const fake = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { query: string; variables: { offset?: number; limit?: number } };
      const name = /query (\w+)/.exec(b.query)?.[1] ?? "?";
      asked.push(`${name}@${b.variables.offset ?? 0}`);
      const page = (rows: unknown[]) => ((b.variables.offset ?? 0) >= WALLET_PAGE * 2 ? [] : rows);
      const data =
        name === "Wallet" ? { Position: [], RouterFlow: flows1, Trade: trades1 }
        : name === "MoreFlows" ? { RouterFlow: page(flows2) }
        : name === "MoreTrades" ? { Trade: page(trades2) }
        : name === "MorePositions" ? { Position: [] }
        : b.query.includes("s0: Position") ? { s0: [] }
        : null;
      if (!data) return new Response(JSON.stringify({ errors: [{ message: `no fake for ${name}` }] }), { status: 200 });
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new AgateClient({ publicClient: chain(), fetch: fake, graphqlUrl: "http://fake/v1/graphql" });
    const w = await c.getWallet(USER);
    const held = w.positions.find((p) => p.kind === "tokens");
    expect(held?.q).toBe(80);
    expect(held?.entry).toBe(4);
    expect(asked).toContain(`MoreFlows@${WALLET_PAGE}`);
    expect(asked).toContain(`MoreTrades@${WALLET_PAGE}`);
    expect(asked.some((x) => x.startsWith("MorePositions"))).toBe(false); // a short first page needs no second
  });
  test("a page that fails mid-way leaves the wallet on the chain alone, never entries from a partial list", async () => {
    const trades1 = Array.from({ length: WALLET_PAGE }, (_, i) => row(i + 1, 0));
    const fake = (async (_u: string, init: { body: string }) => {
      const name = /query (\w+)/.exec((JSON.parse(init.body) as { query: string }).query)?.[1] ?? "?";
      if (name === "Wallet") return new Response(JSON.stringify({ data: { Position: [], RouterFlow: [], Trade: trades1 } }), { status: 200 });
      return new Response("upstream down", { status: 502 });
    }) as unknown as typeof fetch;
    const c = new AgateClient({ publicClient: chain(), fetch: fake, graphqlUrl: "http://fake/v1/graphql" });
    const w = await c.getWallet(USER);
    expect(w.positions.find((p) => p.kind === "tokens")).toMatchObject({ q: 80, entry: 0 });
  });
});

// ================================================================== 4. a price-only GPU

describe("a price-only GPU", () => {
  test("seriesAt says the GPU has no market (not 'not listed', which reads as 'not yet'); a market GPU's unlisted month says not listed", async () => {
    const c = new AgateClient({ publicClient: chain(), graphqlUrl: null });
    await expect(c.seriesAt("B300", "2026-11")).rejects.toThrow("B300 is price only");
    await expect(c.seriesAt("H100", "2026-12")).rejects.toThrow("H100 2026-12 is not listed");
  });
});
