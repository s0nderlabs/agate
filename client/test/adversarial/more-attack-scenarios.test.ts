// More attack scenarios on fakes (no chain, no network) against the client's real code, each from an angle
// attack-scenarios.test.ts does not take. Four groups: a slippage attack on buyLong, an approval left behind, a carried
// day shown as final, a price-only GPU asked for a series.
//
// The write fake is stateful and includes each transaction when the wallet sends it (in send order), so two writes
// running at once interleave as they would on one account: the router pulls exactly what it is given (AgateRouter
// _pull), buys with Kuru's walk (MS 6.5: book.ts buyFill, checked against Kuru's simulation on the fork elsewhere),
// reverts below its minimum out with nothing changed, and a book can be replaced just before the buy lands (a
// front-run). A `test.failing` documents a known gap: it passes while the client does not hold the property and turns
// red once it does (then make it a plain `test`).
import { describe, expect, test } from "bun:test";
import type { Hex, PublicClient } from "viem";
import { buyFill } from "../../src/book.ts";
import { AgateClient, ReadError } from "../../src/client.ts";
import { PANELS } from "../../src/static.ts";
import { buyLong, openLongDaily, placeLimit, resetAllowance, WriteError } from "../../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const SERIES = A(0x11), TOKEN = A(0x22), MARKET = A(0x33), ROUTER = A(0x44), DOLLAR = A(0x55), MA = A(0x66), FACTORY = A(0x77);
const U = 1_000_000n;
const CAP = 8_000_000n;
type Lv = [bigint, bigint]; // [price u, size units]
const LADDER_ASKS: Lv[] = [[4_030_000n, 10_000_000n], [4_040_000n, 20_000_000n], [4_050_000n, 40_000_000n]];
const LADDER_BIDS: Lv[] = [[3_950_000n, 10_000_000n], [3_940_000n, 20_000_000n], [3_930_000n, 40_000_000n]];
const LADDER_DOLLARS = 28_310_000_000n; // 1,000 x 4.03 + 2,000 x 4.04 + 4,000 x 4.05

const word = (x: bigint) => x.toString(16).padStart(64, "0");
/** getL2Book's bytes: block, the bids, a zero word, the asks */
const l2 = (bids: Lv[], asks: Lv[]): Hex => `0x${word(1n)}${bids.map(([p, s]) => word(p) + word(s)).join("")}${word(0n)}${asks.map(([p, s]) => word(p) + word(s)).join("")}` as Hex;
const revertErr = (errorName: string) => Object.assign(new Error(`reverted: ${errorName}`), { name: "ContractFunctionRevertedError", data: { errorName } });

/** Kuru's market buy of `quote` u into `asks` (buyFill), and the asks left after it. */
function kuruBuy(asks: Lv[], quote: bigint): { tokens: bigint; spent: bigint; left: Lv[] } {
  const f = buyFill(asks, quote);
  let units = f.tokens / 100n;
  const left: Lv[] = [];
  for (const [p, s] of asks) {
    const take = units < s ? units : s;
    units -= take;
    if (s - take > 0n) left.push([p, s - take]);
  }
  return { tokens: f.tokens, spent: f.spent, left };
}

interface WriteWorld {
  /** the book the app quoted from (seriesAt's book) */
  quoted: Lv[];
  /** the asks on chain when the client simulates or reads again (default: the quoted ones) */
  live?: Lv[];
  /** the asks a front-runner leaves just before the first router buy lands (default: no front-run) */
  landing?: Lv[];
  balance?: bigint;
  allowance?: bigint;
  simRevert?: string[];
  /** the wallet refuses the n-th (1-based) request of a function */
  declineNth?: Record<string, number>;
}

/** A stateful chain and wallet over one listed month (N 30, F 1.95, C 8.00): every transaction is included as the
 *  wallet sends it, in order, and its receipt reports what happened. */
function writeWorld(o: WriteWorld) {
  const key = (token: string, spender: string) => `${token.toLowerCase()}-${spender.toLowerCase()}`;
  const st = { dollars: o.balance ?? 10n ** 12n, tokens: 0n, asks: [...(o.live ?? o.quoted)] as Lv[], frontRun: o.landing !== undefined, allowance: new Map<string, bigint>() };
  if (o.allowance !== undefined) st.allowance.set(key(DOLLAR, ROUTER), o.allowance);
  const sent: { functionName: string; args: readonly unknown[]; status: "success" | "reverted" }[] = [];
  const asked = new Map<string, number>();
  const receipts = new Map<string, { status: "success" | "reverted" }>();
  const terms = { series: SERIES, token: TOKEN, gpuId: `0x${"ab".repeat(32)}`, month: 2026 * 12 + 10, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000n, cap: CAP, name: "agate H100 Nov 2026", symbol: "H100-NOV26" };
  const series = { gpu: "H100", terms, market: MARKET, k: 0, S: 0n, tokenSupply: 0n, nextId: 1n, book: { block: 1n, asks: o.quoted, bids: LADDER_BIDS } };
  const routerBuy = (d: bigint, minOut: bigint, apply: boolean): string | null => {
    if ((st.allowance.get(key(DOLLAR, ROUTER)) ?? 0n) < d) return "ERC20InsufficientAllowance";
    if (st.dollars < d) return "ERC20InsufficientBalance";
    const b = kuruBuy(st.asks, d);
    if (b.tokens < minOut) return "SlippageExceeded";
    if (apply) {
      st.allowance.set(key(DOLLAR, ROUTER), (st.allowance.get(key(DOLLAR, ROUTER)) ?? 0n) - d);
      st.dollars -= b.spent;
      st.tokens += b.tokens;
      st.asks = b.left;
    }
    return null;
  };
  const pub = {
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName === "placeAndExecuteMarketBuy") return { result: kuruBuy(st.asks, req.args[0] as bigint).tokens };
      if (o.simRevert?.includes(req.functionName)) throw revertErr("MarketPaused");
      if (req.functionName === "openLong" || req.functionName === "openLongDaily") {
        const why = routerBuy(req.args[1] as bigint, req.args[2] as bigint, false);
        if (why) throw revertErr(why);
      }
      return { result: 1n };
    },
    async estimateContractGas() {
      return 100_000n;
    },
    async readContract(req: { functionName: string; address: string; args?: readonly unknown[] }) {
      if (req.functionName === "balanceOf") return req.address === DOLLAR ? st.dollars : st.tokens;
      if (req.functionName === "allowance") return st.allowance.get(key(req.address, String(req.args?.[1]))) ?? 0n;
      if (req.functionName === "getL2Book") return l2(LADDER_BIDS, st.asks);
      if (req.functionName === "takerFeeBps") return 0n;
      return 0n; // Kuru margin balances
    },
    async waitForTransactionReceipt({ hash }: { hash: Hex }) {
      const r = receipts.get(hash)!;
      return { status: r.status, gasUsed: 90_000n, blockNumber: 1n, logs: [] };
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
    seriesAt: async () => series,
    chainTime: async () => 0n,
    mc: async (calls: unknown[]) => calls.map(() => ({ ok: true, value: 0n })),
  } as unknown as AgateClient;
  const w = {
    account: { address: ME, type: "local" },
    chain: { id: 10143 },
    async getChainId() {
      return 10143;
    },
    async writeContract(req: { functionName: string; address: string; args: readonly unknown[] }) {
      const n = (asked.get(req.functionName) ?? 0) + 1;
      asked.set(req.functionName, n);
      if (o.declineNth?.[req.functionName] === n) throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
      // included now, in send order: an approve sets the allowance, a router buy meets whatever book stands then
      let status: "success" | "reverted" = "success";
      if (req.functionName === "approve") st.allowance.set(key(req.address, String(req.args[0])), req.args[1] as bigint);
      if (req.functionName === "openLong" || req.functionName === "openLongDaily") {
        if (st.frontRun) {
          st.asks = [...o.landing!];
          st.frontRun = false;
        }
        if (routerBuy(req.args[1] as bigint, req.args[2] as bigint, true)) status = "reverted";
      }
      sent.push({ functionName: req.functionName, args: req.args, status });
      const hash = `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
      receipts.set(hash, { status });
      return hash;
    },
  };
  return { c, w: w as never, st, sent, routerAllowance: () => st.allowance.get(key(DOLLAR, ROUTER)) ?? 0n };
}
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WriteError);

// ================================================================== 1. a slippage attack on buyLong

describe("more: a slippage attack on buyLong", () => {
  test("every fair ask taken after the quote and the book re-posted at the cap: the buy reverts on chain at its minimum out, nothing is bought, the approval is put back", async () => {
    const f = writeWorld({ quoted: LADDER_ASKS, landing: [[CAP, 100_000_000n]] });
    const e = await failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e?.stage).toBe("receipt");
    expect(f.st.tokens).toBe(0n);
    expect(f.st.dollars).toBe(10n ** 12n);
    expect(f.sent.map((x) => [x.functionName, x.status])).toEqual([
      ["approve", "success"],
      ["openLong", "reverted"],
      ["approve", "success"],
    ]);
    expect(f.routerAllowance()).toBe(0n);
  });

  test("at 9,999 bps the same front-run can push the fill up to the band's top and never past it: an ask one tick above the cap reverts", async () => {
    const atCap = writeWorld({ quoted: LADDER_ASKS, landing: [[CAP, 100_000_000n]] });
    await failure(buyLong(atCap.c, atCap.w, { gpu: "H100", month: "2026-11", dollars: "1000", slippageBps: 9_999 })); // lands (the fake's receipts carry no Routed event)
    expect(atCap.sent.map((x) => [x.functionName, x.status]).at(-1)).toEqual(["openLong", "success"]);
    expect(atCap.st.tokens).toBe(125_000_000n); // 125 GPU-hours at $8.00: the most a token can pay, not above it
    const above = writeWorld({ quoted: LADDER_ASKS, landing: [[CAP + 10_000n, 100_000_000n]] });
    const e = await failure(buyLong(above.c, above.w, { gpu: "H100", month: "2026-11", dollars: "1000", slippageBps: 9_999 }));
    expect(e?.stage).toBe("receipt");
    expect(above.st.tokens).toBe(0n);
    expect(above.routerAllowance()).toBe(0n);
  });

  test("a buy of the whole fair depth, front-run (the best level taken, an ask at $4,000 posted behind): at the default slippage it reverts; the $4,000 ask is never reached", async () => {
    const landing: Lv[] = [[4_040_000n, 20_000_000n], [4_050_000n, 40_000_000n], [4_000_000_000n, 1_000_000n]];
    const f = writeWorld({ quoted: LADDER_ASKS, landing });
    const e = await failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: LADDER_DOLLARS }));
    expect(e?.stage).toBe("receipt");
    expect(f.st.asks.at(-1)).toEqual([4_000_000_000n, 1_000_000n]); // untouched
    expect(f.st.dollars).toBe(10n ** 12n);
    expect(f.routerAllowance()).toBe(0n);
  });

  test("the book jumped between the app's quote and the click (the client reads it again): with the shown price passed, the buy is refused with the new quote, nothing sent", async () => {
    // the app showed $4.03; the chain now holds asks at $7.50 only (still under the cap, so the band alone allows them)
    const f = writeWorld({ quoted: LADDER_ASKS, live: [[7_500_000n, 100_000_000n]] });
    const e = await failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", maxPrice: "4.03" }));
    expect(e?.reason).toBe("PriceMoved");
    expect(e?.quote?.avgPrice).toBeCloseTo(7.5, 5); // $1,000 / 133.3333 GPU-hours (whole size units)
    expect(f.sent).toEqual([]);
    // control: without the shown price the client buys at the book it reads now (the documented default), within the band
    const g = writeWorld({ quoted: LADDER_ASKS, live: [[7_500_000n, 100_000_000n]] });
    const r = await buyLong(g.c, g.w, { gpu: "H100", month: "2026-11", dollars: "1000" }).catch((x: Error) => x);
    expect(g.st.tokens).toBe(133_333_300n);
    expect(r instanceof Error ? r.message : "").toContain("Routed"); // the fake's receipts carry no events
  });
});

// ================================================================== 2. an approval left behind

describe("more: an approval left behind", () => {
  test("two buys sent at once from one wallet (a double click): whatever lands, no allowance is left to the router and no dollar is lost", async () => {
    const f = writeWorld({ quoted: LADDER_ASKS });
    const [a, b] = await Promise.all([failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" })), failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "500" }))]);
    expect(f.routerAllowance()).toBe(0n);
    // what left the wallet bought tokens at the book's prices (4.03 to 4.05), never more
    const spent = 10n ** 12n - f.st.dollars;
    expect(spent * U <= f.st.tokens * 4_050_000n).toBe(true);
    // each outcome is either a landed buy (the fake's receipts carry no Routed event) or a refusal naming what landed
    for (const e of [a, b]) if (e && !e.message.startsWith("the router emitted no Routed event")) expect(e).toBeInstanceOf(WriteError);
  });

  test("the user refuses the put-back prompt: the error says the allowance stays and at how much, lists only the landed approval, and resetAllowance clears it", async () => {
    const f = writeWorld({ quoted: LADDER_ASKS, simRevert: ["openLong"], declineNth: { approve: 2 } });
    const e = await failure(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e?.stage).toBe("simulate");
    expect(e?.message).toContain("stays at 1000");
    expect(e?.txs.map((t) => t.label)).toEqual(["approve tUSD to the router"]);
    expect(f.routerAllowance()).toBe(1_000_000_000n);
    await resetAllowance(f.c, f.w, { token: DOLLAR, spender: ROUTER });
    expect(f.routerAllowance()).toBe(0n);
  });

  test("an allowance the user already had is put back to that value after a refusal, never raised for good nor zeroed", async () => {
    // 300 tUSD standing (another app's), a pay-me-daily buy of 1,000 refused at its simulation
    const f = writeWorld({ quoted: LADDER_ASKS, allowance: 300_000_000n, simRevert: ["openLongDaily"] });
    await failure(openLongDaily(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", parts: 2 }));
    expect(f.routerAllowance()).toBe(300_000_000n);
    expect(f.sent.map((x) => [x.functionName, x.args[1]])).toEqual([
      ["approve", 1_000_000_000n],
      ["approve", 300_000_000n],
    ]);
  });
});

// ================================================================== reads: a fake chain that records every call

const OCT = 2026 * 12 + 9;
const NOV = OCT + 1;
const GPU_ID = Object.fromEntries(PANELS.map((p) => [p.gpu, p.gpuId.toLowerCase()])) as Record<string, string>;
const LABEL = Object.fromEntries(PANELS.map((p) => [p.gpuId.toLowerCase(), p.gpu])) as Record<string, string>;
const WRITER = A(0x99);
interface Rec {
  value: number;
  status: number; // 1 FULL, 4 CARRIED
  final: boolean;
  postedAt?: bigint;
  finalAt?: bigint;
}
const dayTs = (d: number) => BigInt(d * 86_400);

/** The production clock (day 86,400 s, T_PEND 6 h, CLOSE_GRACE 1 h, epoch 0), H100 November listed with the
 *  maker's ladder, index records per GPU and day, chain time `now`. `calls` records every read. */
function chain(o: { records: Record<string, Record<number, Rec>>; head: Record<string, number>; now: bigint }) {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const read = ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }): unknown => {
    calls.push({ functionName, args });
    const gid = String(args[0] ?? "").toLowerCase();
    const gpu = LABEL[gid] ?? "";
    switch (functionName) {
      case "clocks":
        return { day: 86_400, slice: 3_600, tPend: 21_600, closeGrace: 3_600, slices: 24, minReadings: 3, epochTs: 0n, epochDay: 0 };
      case "currentMonth":
        return OCT;
      case "gpuIds":
        return ["H100", "H200", "B200"].map((g) => GPU_ID[g]);
      case "labelOf":
        return LABEL[gid];
      case "head":
        return o.head[gpu] ?? 20730;
      case "gpu":
        return { recipeHash: `0x${"00".repeat(32)}`, nSlots: PANELS.find((p) => p.gpu === gpu)!.slots.length, nFamilies: 0, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head: o.head[gpu] ?? 20730 };
      case "record": {
        const r = o.records[gpu]?.[Number(args[1])];
        if (!r) return [false, false, { value: 0, status: 0, source: A(0), postedAt: 0n, finalAt: 0n, dropped: false }];
        const posted = r.postedAt ?? dayTs(Number(args[1]) + 1) + 3_600n;
        return [true, r.final, { value: r.value, status: r.status, source: r.status === 4 ? A(0) : WRITER, postedAt: posted, finalAt: r.final ? (r.finalAt ?? posted + 21_600n) : (r.finalAt ?? 0n), dropped: false }];
      }
      case "slotState":
        return { e: 3_990_000, inMedian: true };
      case "slotWindow":
        return [20730, 0xffffffff];
      case "readings":
        return { sums: [], counts: [] };
      case "firstRecordDay":
        return [true, 20730];
      case "seriesOf":
        return gpu === "H100" && Number(args[1]) === NOV ? SERIES : A(0);
      case "previewListing":
        throw revertErr(Number(args[1]) === OCT ? "IndexStartsAfterMonth" : "MonthNotOpen");
      case "terms":
        return { gpuId: GPU_ID.H100, month: NOV, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: 1_950_000, cap: 8_000_000 };
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
        return l2(LADDER_BIDS, LADDER_ASKS);
      case "balanceOf":
      case "nextDripAt":
      case "getBalance":
      case "shortOf":
      case "s_orderIdCounter":
        return 0n;
      case "dripPeriod":
        return 86_400n;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  const pub = {
    getCode: async () => undefined, // no Multicall3: the client reads call by call
    readContract: async (r: { functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: o.now }),
    getBalance: async () => 0n,
  } as unknown as PublicClient;
  return { pub, calls };
}
/** An indexer that answers the History query with `rows` and refuses every other query (those reads fall back). */
function indexer(rows: unknown[]): typeof fetch {
  return (async (_u: string, init: { body: string }) => {
    const q = (JSON.parse(init.body) as { query: string }).query;
    if (/query History/.test(q)) return new Response(JSON.stringify({ data: { DailyFix: rows } }), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ message: "not in this fake" }] }), { status: 200 });
  }) as unknown as typeof fetch;
}
const everyGpu = (h100: Record<number, Rec>, others: Record<number, Rec> = { 20730: { value: 3_990_000, status: 1, final: true } }) => Object.fromEntries(PANELS.map((p) => [p.gpu, p.gpu === "H100" ? h100 : others]));

// ================================================================== 3. a carried day shown as final

describe("more: a carried day (or any day not final on chain) is never shown as final", () => {
  // Known gap (LOW). Oct 5's first post ($4.50, final at 07:00 Oct 6 unless stopped) was vetoed before
  // 07:00 and the day posted again ($4.10, waiting for its countersign). An indexer that has not processed the veto
  // still holds the $4.50 row as PENDING with its finalAt passed, which the client counts as final: the chart shows a
  // vetoed price as a final day after the chain's newest final day (Oct 4, today's price). The chain is the source of
  // truth for which days are final: an indexer day after the chain's newest final day should be dropped.
  test("a vetoed post a lagging indexer still holds (PENDING, finalAt passed) is not a final chart day after the chain's newest final day", async () => {
    const recs = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 4_100_000, status: 1, final: false, postedAt: dayTs(20732) + 25_000n } };
    const rows = [
      { gpuId: GPU_ID.H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FULL", state: "FINAL", finalAt: String(dayTs(20731) + 25_200n) },
      { gpuId: GPU_ID.H100, day: 20731, date: "2026-10-05", value: "4500000", status: "FULL", state: "PENDING", finalAt: String(dayTs(20732) + 25_200n) },
    ];
    const { pub } = chain({ records: everyGpu(recs), head: { H100: 20732 }, now: dayTs(20732) + 30_000n });
    const m = await new AgateClient({ publicClient: pub, graphqlUrl: "http://fake/v1/graphql", fetch: indexer(rows) }).getMarket("H100");
    expect([m.price, m.priceDate]).toEqual([3.99, "2026-10-04"]);
    expect(m.history.every((d) => d.date <= m.priceDate!)).toBe(true);
    expect(m.history.some((d) => d.price === 4.5)).toBe(false);
  });

  test("a carried newest day after a vetoed one (indexer CARRIED_UNVERIFIED): today's price, the chart and the ticker all say carried, never a fresh final", async () => {
    const recs = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 3_990_000, status: 4, final: true } };
    const rows = [
      { gpuId: GPU_ID.H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FULL", state: "FINAL", finalAt: "1" },
      { gpuId: GPU_ID.H100, day: 20731, date: "2026-10-05", value: "3990000", status: "CARRIED", state: "CARRIED_UNVERIFIED", finalAt: String(dayTs(20732) + 30_000n) },
    ];
    const { pub } = chain({ records: everyGpu(recs), head: { H100: 20732 }, now: dayTs(20732) + 40_000n });
    const c = new AgateClient({ publicClient: pub, graphqlUrl: "http://fake/v1/graphql", fetch: indexer(rows) });
    const all = await c.getMarkets();
    const one = await c.getMarket("H100");
    for (const m of [all.find((x) => x.gpu === "H100")!, one]) {
      expect([m.price, m.priceDate, m.prevPrice]).toEqual([3.99, "2026-10-05", 3.99]);
      expect(m.history.map((d) => [d.date, d.status, d.example])).toEqual([
        ["2026-10-04", "final", false],
        ["2026-10-05", "carried", false],
      ]);
    }
    const t = await c.ticker();
    expect(t.find((x) => x.label === "H100")).toEqual({ label: "H100", price: 3.99, change: 0 });
  });
});

// ================================================================== 4. a price-only GPU asked for a series

describe("more: a price-only GPU asked for a series", () => {
  const base = () => chain({ records: everyGpu({ 20730: { value: 3_990_000, status: 1, final: true } }), head: Object.fromEntries(PANELS.map((p) => [p.gpu, 20731])), now: dayTs(20731) + 30_000n });

  test("getSeries() for every GPU and the ticker never carry a month of B300, A100 or L40S; the ticker lists their index prices", async () => {
    const c = new AgateClient({ publicClient: base().pub, graphqlUrl: null });
    const all = await c.getSeries();
    expect(all.every((s) => s.gpu === "H100" || s.gpu === "H200" || s.gpu === "B200")).toBe(true);
    expect(all.some((s) => s.gpu === "H100" && s.month === "2026-11" && s.phase === "trading")).toBe(true);
    const t = await c.ticker();
    expect(t.map((x) => x.label)).toEqual(["H100", "H200", "B200", "B300", "A100", "L40S", "H100 Nov"]);
  });

  test("the wallet and its open orders search only the market GPUs' months: no series lookup is ever made for a price-only GPU", async () => {
    const { pub, calls } = base();
    const c = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const w = await c.getWallet(ME);
    const oo = await c.openOrdersResult(ME);
    expect([w.positions, oo.orders, oo.complete]).toEqual([[], [], true]);
    const priceOnly = new Set(["B300", "A100", "L40S"].map((g) => GPU_ID[g]));
    expect(calls.filter((x) => x.functionName === "seriesOf" && priceOnly.has(String(x.args[0]).toLowerCase()))).toEqual([]);
  });

  test("a price-only GPU written another way (\"b300\", \" B300\") is an unknown GPU, never an empty market, and no write asks the wallet", async () => {
    const c = new AgateClient({ publicClient: base().pub, graphqlUrl: null });
    const asked: string[] = [];
    const w = { account: { address: ME, type: "local" }, chain: { id: 10143 }, getChainId: async () => 10143, writeContract: async (r: { functionName: string }) => (asked.push(r.functionName), `0x${"cd".repeat(32)}`) } as never;
    for (const g of ["b300", " B300", "B300 "]) {
      await expect(c.getMarket(g as never)).rejects.toBeInstanceOf(ReadError);
      await expect(c.book(g as never, "2026-11")).rejects.toBeInstanceOf(ReadError);
      await expect(c.candles(g as never, "2026-11")).rejects.toBeInstanceOf(ReadError);
      await expect(buyLong(c, w, { gpu: g as never, month: "2026-11", dollars: "10" })).rejects.toBeInstanceOf(ReadError);
      await expect(placeLimit(c, w, { gpu: g as never, month: "2026-11", side: "long", price: "3.90", gpuHours: "1" })).rejects.toBeInstanceOf(ReadError);
    }
    expect(asked).toEqual([]);
  });
});
