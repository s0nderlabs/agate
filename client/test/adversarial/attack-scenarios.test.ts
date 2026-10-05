// Attack scenarios on fakes (no chain, no network), each against the client's real code: a slippage attack on
// buyLong, an approval left behind, a carried day shown as final, and a price-only GPU asked for a series. Each test
// states the property it holds the client to. The four that were `test.failing` (a buy beyond the asks under the
// band's top, three; a buy the wallet cannot pay, one) are plain tests since the client holds those properties.
//
// The write fakes model what the contracts do: the router pulls exactly what it is given and refunds what Kuru did not
// use (AgateRouter._pull / _buy), the series pulls ceil(q x C / U) for a mint, Kuru's margin account pulls a deposit,
// and Kuru's market buy walks the asks in order, buying whole size units at each level (MS 6.5).
import { describe, expect, test } from "bun:test";
import type { Hex, PublicClient } from "viem";
import { AgateClient, ReadError } from "../../src/client.ts";
import { PANELS, TESTNET_DEPLOYMENTS, TESTNET_PRELAUNCH } from "../../src/static.ts";
import { AmountError } from "../../src/units.ts";
import {
  buyLong,
  cancelLimit,
  claim,
  closeLongDaily,
  closeShort,
  mintPairs,
  openLongDaily,
  openShort,
  placeLimit,
  redeem,
  resetAllowance,
  sellLong,
  settle,
  withdrawMargin,
  WriteError,
} from "../../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const SERIES = A(0x11), TOKEN = A(0x22), MARKET = A(0x33), ROUTER = A(0x44), DOLLAR = A(0x55), MA = A(0x66), FACTORY = A(0x77);
const FLOOR = 1_950_000n;
const CAP = 8_000_000n;
const U = 1_000_000n;
type Lv = [bigint, bigint]; // [price u, size units]

/** Kuru's market buy of `quote` u into `asks` (MS 6.5): whole size units at each level. Tokens (base units) and u
 *  spent. */
function kuruBuy(asks: Lv[], quote: bigint): { tokens: bigint; spent: bigint } {
  let left = quote;
  let units = 0n;
  let spent = 0n;
  for (const [p, z] of asks) {
    const can = (left * 10_000n) / p;
    if (can === 0n) break;
    const take = can < z ? can : z;
    const cost = (p * take) / 10_000n;
    units += take;
    spent += cost;
    left -= cost;
    if (take < z) break;
  }
  return { tokens: units * 100n, spent };
}

const revertErr = (errorName: string) => Object.assign(new Error(`reverted: ${errorName}`), { name: "ContractFunctionRevertedError", data: { errorName } });

/** A client and a wallet over one listed month (N = 30, F 1.95, C 8.00) with the book `asks` / `bids` when the app
 *  quotes and `landing` asks when the user's transaction lands (default: the same). Allowances are kept and pulled as
 *  the contracts pull them. `simRevert` makes a function's simulation revert, `receiptRevert` its receipt, `decline`
 *  the wallet refuse to send it. */
function market(o: { asks: Lv[]; bids: Lv[]; landing?: Lv[]; k?: number; S?: bigint; balance?: bigint; allowance?: bigint; simRevert?: string[]; receiptRevert?: string[]; decline?: string[]; position?: { side: number; q: bigint } }) {
  const sent: { functionName: string; address: string; args: readonly unknown[] }[] = [];
  const allowance = new Map<string, bigint>();
  if (o.allowance !== undefined) allowance.set(`${DOLLAR}-${ROUTER}`, o.allowance);
  const key = (token: string, spender: string) => `${token}-${spender}`;
  const pull = (token: string, spender: string, amt: bigint, what: string) => {
    const have = allowance.get(key(token, spender)) ?? 0n;
    if (have < amt) throw revertErr(`ERC20InsufficientAllowance(${what})`);
    allowance.set(key(token, spender), have - amt);
  };
  let dollars = o.balance ?? 10n ** 12n;
  const terms = { series: SERIES, token: TOKEN, gpuId: `0x${"ab".repeat(32)}`, month: 2026 * 12 + 10, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: FLOOR, cap: CAP, name: "agate H100 Nov 2026", symbol: "H100-NOV26" };
  const s = { gpu: "H100", terms, market: MARKET, k: o.k ?? 0, S: o.S ?? 0n, tokenSupply: 0n, nextId: 1n, book: { block: 1n, asks: o.asks, bids: o.bids } };
  /** what lands: the router's flows against the landing book, with the router's own checks */
  const outcome: { openLong?: { tokens: bigint; spent: bigint; minOut: bigint } } = {};
  const pub = {
    async simulateContract(req: { functionName: string; args: readonly unknown[] }) {
      if (req.functionName === "placeAndExecuteMarketBuy") return { result: kuruBuy(o.asks, req.args[0] as bigint).tokens };
      if (o.simRevert?.includes(req.functionName)) throw revertErr(req.functionName === "openLong" ? "SlippageExceeded" : "MarketPaused");
      // the router's own pull, as its simulation would see it
      if (req.functionName === "openLong" || req.functionName === "openLongDaily") {
        const d = req.args[1] as bigint;
        if (dollars < d) throw revertErr("ERC20InsufficientBalance");
        if ((allowance.get(key(DOLLAR, ROUTER)) ?? 0n) < d) throw revertErr("ERC20InsufficientAllowance");
      }
      return { result: 1n };
    },
    async estimateContractGas() {
      return 100_000n;
    },
    async readContract(req: { functionName: string; address: string; args?: readonly unknown[] }) {
      if (req.functionName === "balanceOf") return req.address === DOLLAR ? dollars : 10n ** 12n;
      if (req.functionName === "allowance") return allowance.get(key(req.address, String(req.args?.[1]))) ?? 0n;
      return 0n; // Kuru margin balances
    },
    async waitForTransactionReceipt() {
      const last = sent[sent.length - 1]!;
      if (o.receiptRevert?.includes(last.functionName)) return { status: "reverted", gasUsed: 90_000n, blockNumber: 1n, logs: [] };
      // the transaction's effects, as the contracts apply them
      const f = last.functionName;
      if (f === "approve") allowance.set(key(last.address, String(last.args[0])), last.args[1] as bigint);
      if (f === "openLong" || f === "openLongDaily") {
        const d = last.args[1] as bigint;
        pull(DOLLAR, ROUTER, d, "router");
        const got = kuruBuy(o.landing ?? o.asks, d);
        const minOut = last.args[2] as bigint;
        if (got.tokens < minOut) return { status: "reverted", gasUsed: 90_000n, blockNumber: 1n, logs: [] }; // the router's SlippageExceeded
        dollars -= got.spent; // the rest is refunded
        outcome.openLong = { ...got, minOut };
      }
      if (f === "openShort") pull(DOLLAR, ROUTER, (((last.args[1] as bigint) * CAP + U - 1n) / U), "router mint");
      if (f === "closeLongDaily") pull(DOLLAR, ROUTER, ((o.position?.q ?? 24_000_000n) * CAP + U - 1n) / U, "router mint");
      if (f === "closeShort") pull(DOLLAR, ROUTER, last.args[2] as bigint, "router buy-back");
      if (f === "mint") pull(DOLLAR, SERIES, ((last.args[0] as bigint) * CAP + U - 1n) / U, "series");
      if (f === "deposit") pull(String(last.args[1]), MA, last.args[2] as bigint, "margin account");
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
    async getChainId() {
      return 10143;
    },
    async writeContract(req: { functionName: string; address: string; args: readonly unknown[] }) {
      if (o.decline?.includes(req.functionName)) throw Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" });
      sent.push({ functionName: req.functionName, address: req.address, args: req.args });
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { c, w: w as never, sent, allowance, outcome, routerAllowance: () => allowance.get(key(DOLLAR, ROUTER)) ?? 0n };
}
const outcomeOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as WriteError);
// the maker's ladder: 1,000 / 2,000 / 4,000 GPU-hours a tick apart, 1% around $3.99 (BOTS-SPEC)
const LADDER = { asks: [[4_030_000n, 10_000_000n], [4_040_000n, 20_000_000n], [4_050_000n, 40_000_000n]] as Lv[], bids: [[3_950_000n, 10_000_000n], [3_940_000n, 20_000_000n], [3_930_000n, 40_000_000n]] as Lv[] };
const avg = (spent: bigint, tokens: bigint) => Number((spent * U) / tokens) / 1e6;

// ================================================================== 1. a slippage attack on buyLong

describe("a slippage attack on buyLong", () => {
  test("a front-runner who takes the best ask and re-posts it higher moves the price at most the slippage (1%), or the buy reverts", async () => {
    // the app quotes on the ladder; before the buy lands the attacker takes the 1,000 at 4.03 and posts them at 4.07
    const landing: Lv[] = [[4_070_000n, 10_000_000n], [4_040_000n, 20_000_000n], [4_050_000n, 40_000_000n]];
    const f = market({ ...LADDER, landing });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    if (f.outcome.openLong) {
      // landed: the average is within 1% of the quote's 4.03
      expect(avg(f.outcome.openLong.spent, f.outcome.openLong.tokens)).toBeLessThanOrEqual(4.03 * 1.01 + 1e-6);
    } else {
      expect(e?.stage).toBe("receipt"); // the router's minimum out refused it on chain
    }
  });
  test("slippage 9,999 bps cannot open the door: the band (C = $8.00) still bounds the minimum out", async () => {
    const f = market(LADDER);
    await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", slippageBps: 9_999 }));
    const minOut = f.sent.find((x) => x.functionName === "openLong")!.args[2] as bigint;
    expect(minOut).toBeGreaterThanOrEqual((1000n * U * U) / CAP - 500n); // 125 GPU-hours less Kuru's dust
  });
  test("a shown price far worse than the book never loosens the bound below the fresh quote less slippage", async () => {
    const f = market(LADDER);
    await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", maxPrice: "7.99" }));
    const minOut = f.sent.find((x) => x.functionName === "openLong")!.args[2] as bigint;
    expect(minOut).toBe((248_138_900n * 9_900n) / 10_000n); // 248.1389 at 4.03, less 1%
  });
  test("bad guards are refused before anything is sent: a float slippage, a zero shown price, an off-LOT size", async () => {
    for (const p of [{ slippageBps: 0.5 }, { slippageBps: Number.NaN }, { maxPrice: "0" }, { minGpuHours: "0" }, { minGpuHours: "0.00001" }]) {
      const f = market(LADDER);
      const e = await buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", ...p }).then(() => null, (x: unknown) => x as Error);
      expect(e).toBeInstanceOf(AmountError);
      expect(f.sent).toEqual([]);
    }
  });
  test("control: with the app's shown ask too, the thin-book click is refused before anything is sent, naming what the asks hold", async () => {
    const f = market({ asks: [[4_030_000n, 1_488_800n]], bids: LADDER.bids });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", maxPrice: "4.03" }));
    // the depth refusal comes first (it says how much can be bought); the quote is what the asks hold, at their price
    expect(e?.reason).toBe("ThinBook");
    expect(e?.quote).toEqual({ gpuHours: 148.88, dollars: 599.9864, avgPrice: 4.03 });
    expect(e?.message).toContain("buy at most $599.9864");
    expect(f.sent).toEqual([]);
  });
  // A buy larger than the asks' depth: Kuru's market buy is not fill-or-kill, so a fresh simulation says "$1,000
  // buys 148.88 GPU-hours" (the rest of the quote unused) and a minimum out of 147.39 is met by the depth alone.
  // Whatever asks appear behind it before the transaction lands would take the unused $400 at any price: here 0.1
  // GPU-hour at $4,000, while the average stays under the band's top. The client now refuses a buy larger than the
  // asks at or under the top hold ("ThinBook"), so these three hold.
  test("a buy larger than the book's depth never spends the remainder above the quote (front-run: an ask at $4,000 posted behind it)", async () => {
    const f = market({ asks: [[4_030_000n, 1_488_800n]], bids: LADDER.bids, landing: [[4_030_000n, 1_488_800n], [4_000_000_000n, 1_000n]] });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    const landed = f.outcome.openLong;
    // safe: refused before sending (the depth is short of the spend), or landed within 1% of the quote's 4.03
    expect(landed === undefined ? e?.stage === "check" && f.sent.length === 0 : avg(landed.spent, landed.tokens) <= 4.03 * 1.01).toBe(true);
  });
  test("a buy never takes an ask above the band's top, even when the average stays under it (an ask at $4,000 resting behind a thin book)", async () => {
    const book: Lv[] = [[4_030_000n, 1_488_800n], [4_000_000_000n, 1_000n]];
    const f = market({ asks: book, bids: LADDER.bids });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    const landed = f.outcome.openLong;
    // the $400 above the cap buys 0.1 GPU-hour worth at most $0.80: refused, or never bought
    expect(landed === undefined ? e?.stage === "check" : landed.spent <= 600_000_000n).toBe(true);
  });
  test("openLongDaily is bounded as buyLong is (the same bound)", async () => {
    const f = market({ asks: [[4_030_000n, 1_488_800n]], bids: LADDER.bids, landing: [[4_030_000n, 1_488_800n], [4_000_000_000n, 1_000n]] });
    const e = await outcomeOf(openLongDaily(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000", parts: 1 }));
    const landed = f.outcome.openLong;
    expect(landed === undefined ? e?.stage === "check" : avg(landed.spent, landed.tokens) <= 4.03 * 1.01).toBe(true);
  });
});

// ================================================================== 2. an approval left behind

describe("an approval left behind", () => {
  test("a refused openLong puts the allowance back to what it was before (5 tUSD), not to 0 and not left at 1,000", async () => {
    const f = market({ ...LADDER, allowance: 5_000_000n, simRevert: ["openLong"] });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(f.sent.map((x) => [x.functionName, x.args[1]])).toEqual([
      ["approve", 1_000_000_000n],
      ["approve", 5_000_000n],
    ]);
    expect(f.routerAllowance()).toBe(5_000_000n);
    expect(e?.txs.length).toBe(2);
  });
  test("an openLong that simulated but reverted on chain also gets its approval put back", async () => {
    const f = market({ ...LADDER, receiptRevert: ["openLong"] });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e?.stage).toBe("receipt");
    expect(f.routerAllowance()).toBe(0n);
    expect(e?.txs.map((t) => t.label)).toEqual(["approve tUSD to the router", "put back: approve tUSD to the router"]);
  });
  test("when the user declines the main transaction no new prompt follows: the error says the allowance stays, and resetAllowance clears it", async () => {
    const f = market({ ...LADDER, decline: ["openLong"] });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e?.stage).toBe("send");
    expect(f.sent.map((x) => x.functionName)).toEqual(["approve"]);
    expect(e?.message).toContain("stays at 1000");
    const r = await resetAllowance(f.c, f.w, { token: DOLLAR, spender: ROUTER });
    expect(r.txs.length).toBe(1);
    expect(f.routerAllowance()).toBe(0n);
  });
  test("every router flow approves exactly what the router pulls: nothing is left once it lands, and no approval is unlimited", async () => {
    const flows: [string, string, (m: ReturnType<typeof market>) => Promise<unknown>, { side: number; q: bigint } | undefined][] = [
      ["buyLong", "openLong", (m) => buyLong(m.c, m.w, { gpu: "H100", month: "2026-11", dollars: "1000" }), undefined],
      ["openLongDaily", "openLongDaily", (m) => openLongDaily(m.c, m.w, { gpu: "H100", month: "2026-11", dollars: "500", parts: 2 }), undefined],
      ["openShort", "openShort", (m) => openShort(m.c, m.w, { gpu: "H100", month: "2026-11", gpuHours: "48", parts: 2 }), undefined],
      ["closeShort", "closeShort", (m) => closeShort(m.c, m.w, { gpu: "H100", month: "2026-11", positionIds: ["1"] }), { side: 1, q: 24_000_000n }],
      ["closeLongDaily", "closeLongDaily", (m) => closeLongDaily(m.c, m.w, { gpu: "H100", month: "2026-11", positionIds: ["1"] }), { side: 0, q: 24_000_000n }],
      ["mintPairs", "mint", (m) => mintPairs(m.c, m.w, { gpu: "H100", month: "2026-11", gpuHours: "10" }), undefined],
      ["placeLimit long", "addBuyOrder", (m) => placeLimit(m.c, m.w, { gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10" }), undefined],
      ["placeLimit short", "addSellOrder", (m) => placeLimit(m.c, m.w, { gpu: "H100", month: "2026-11", side: "short", price: "4.10", gpuHours: "10", mint: true }), undefined],
    ];
    for (const [name, main, run, position] of flows) {
      const m = market({ ...LADDER, ...(position ? { position } : {}) });
      const e = await outcomeOf(run(m));
      // the flow's own transaction landed (these fake receipts carry no event logs, so a router flow ends with "the
      // router emitted no Routed event" after it: an artifact of the fake, not a refusal)
      expect({ name, main: m.sent.at(-1)?.functionName }).toEqual({ name, main });
      expect({ name, ok: e === null || e.message.startsWith("the router emitted no Routed event") }).toEqual({ name, ok: true });
      const left = [...m.allowance.entries()].filter(([, v]) => v !== 0n);
      expect({ name, left }).toEqual({ name, left: [] });
      for (const a of m.sent.filter((x) => x.functionName === "approve")) expect(a.args[1] as bigint).toBeLessThan(2n ** 128n);
    }
  });
  test("a limit short refused at the order itself leaves no allowance (each was pulled) and says how to undo the mint and the deposit", async () => {
    const f = market({ ...LADDER, simRevert: ["addSellOrder"] });
    const e = await outcomeOf(placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "short", price: "4.10", gpuHours: "10", mint: true }));
    expect(f.sent.map((x) => x.functionName)).toEqual(["approve", "mint", "approve", "deposit"]);
    expect([...f.allowance.values()].every((v) => v === 0n)).toBe(true);
    expect(e?.txs.length).toBe(4);
    expect(e?.message).toContain("redeem(");
    expect(e?.message).toContain("withdrawMargin(");
    expect(e?.message).not.toContain("nothing was sent");
  });
  test("a buy the wallet cannot pay for leaves no allowance behind", async () => {
    const f = market({ ...LADDER, balance: 5_000_000n });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e).toBeInstanceOf(WriteError);
    expect(f.routerAllowance()).toBe(0n);
  });
  test("a buy the wallet cannot pay for is refused before any transaction (before: an approve and its put-back, two fees for nothing)", async () => {
    const f = market({ ...LADDER, balance: 5_000_000n });
    const e = await outcomeOf(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(e?.reason).toBe("InsufficientBalance");
    expect(f.sent).toEqual([]);
  });
});

// ================================================================== reads: a fake chain for getMarket

const OCT = 2026 * 12 + 9;
const NOV = OCT + 1;
const GPU_ID = Object.fromEntries(PANELS.map((p) => [p.gpu, p.gpuId.toLowerCase()])) as Record<string, string>;
const LABEL = Object.fromEntries(PANELS.map((p) => [p.gpuId.toLowerCase(), p.gpu])) as Record<string, string>;
const MARKET_GPUS = ["H100", "H200", "B200"];
const WRITER = A(0x99);
interface Rec {
  value: number;
  status: number; // 1 FULL, 4 CARRIED
  final: boolean;
  postedAt?: bigint;
  finalAt?: bigint;
}

/** A chain on the production clock (day 86,400 s, T_PEND 6 h, CLOSE_GRACE 1 h, epoch 0) with H100 November listed,
 *  index records per GPU and day, and chain time `now`. */
function fakeChain(o: { records: Record<string, Record<number, Rec>>; head: Record<string, number>; now: bigint }): PublicClient {
  const reverted = (n: string) => revertErr(n);
  const read = ({ functionName, args }: { functionName: string; args?: readonly unknown[] }): unknown => {
    const gid = String(args?.[0] ?? "").toLowerCase();
    const gpu = LABEL[gid] ?? "";
    switch (functionName) {
      case "clocks":
        return { day: 86_400, slice: 3_600, tPend: 21_600, closeGrace: 3_600, slices: 24, minReadings: 3, epochTs: 0n, epochDay: 0 };
      case "currentMonth":
        return OCT;
      case "gpuIds":
        return MARKET_GPUS.map((g) => GPU_ID[g]);
      case "labelOf":
        return LABEL[gid];
      case "head":
        return o.head[gpu] ?? 20730;
      case "gpu":
        return { recipeHash: `0x${"00".repeat(32)}`, nSlots: PANELS.find((p) => p.gpu === gpu)!.slots.length, nFamilies: 0, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head: o.head[gpu] ?? 20730 };
      case "record": {
        const r = o.records[gpu]?.[Number(args?.[1])];
        if (!r) return [false, false, { value: 0, status: 0, source: A(0), postedAt: 0n, finalAt: 0n, dropped: false }];
        const day = Number(args?.[1]);
        const posted = r.postedAt ?? BigInt((day + 1) * 86_400 + 3_600);
        return [true, r.final, { value: r.value, status: r.status, source: r.status === 4 ? A(0) : WRITER, postedAt: posted, finalAt: r.final ? (r.finalAt ?? posted + 21_600n) : 0n, dropped: false }];
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
        return gpu === "H100" && Number(args?.[1]) === NOV ? SERIES : A(0);
      case "previewListing":
        throw reverted(Number(args?.[1]) === OCT ? "IndexStartsAfterMonth" : "MonthNotOpen");
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
        return `0x${"00".repeat(31)}01${"00".repeat(32)}`;
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  };
  return {
    getCode: async () => undefined, // no Multicall3: the client reads call by call
    readContract: async (r: { functionName: string; args?: readonly unknown[] }) => read(r),
    getBlock: async () => ({ timestamp: o.now }),
    getBalance: async () => 0n,
  } as unknown as PublicClient;
}
/** An indexer that answers the History query with `rows` and refuses every other query (the reads fall back). */
function indexer(rows: unknown[]): typeof fetch {
  return (async (_u: string, init: { body: string }) => {
    const q = (JSON.parse(init.body) as { query: string }).query;
    if (/query History/.test(q)) return new Response(JSON.stringify({ data: { DailyFix: rows } }), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ message: "not in this fake" }] }), { status: 200 });
  }) as unknown as typeof fetch;
}
const dayTs = (d: number) => BigInt(d * 86_400);
const flat = (gpu: string, recs: Record<number, Rec>) => Object.fromEntries(PANELS.map((p) => [p.gpu, p.gpu === gpu ? recs : { 20730: { value: 3_990_000, status: 1, final: true } }]));

// ================================================================== 3. a carried day shown as final

describe("a carried day is never shown as final", () => {
  // Oct 4 final at $3.99; Oct 5 had no reading and was carried ($3.99, status CARRIED, final at once)
  const recs = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 3_990_000, status: 4, final: true } };
  const now = dayTs(20732) + 30_000n; // Oct 6, 08:20 UTC
  test("chain only: today's price is the carried day's, and the chart marks it carried", async () => {
    const c = new AgateClient({ publicClient: fakeChain({ records: flat("H100", recs), head: { H100: 20732 }, now }), graphqlUrl: null });
    const m = await c.getMarket("H100");
    expect(m.priceDate).toBe("2026-10-05");
    expect(m.price).toBe(3.99);
    expect(m.history.map((d) => [d.date, d.status, d.example])).toEqual([
      ["2026-10-04", "final", false],
      ["2026-10-05", "carried", false],
    ]);
  });
  test("an indexer that still holds the day's dropped post as a final-looking row ($4.20, PENDING, finalAt passed) does not override the chain's carried record", async () => {
    const stale = [
      { gpuId: GPU_ID.H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FULL", state: "FINAL", finalAt: String(dayTs(20731) + 25_200n) },
      { gpuId: GPU_ID.H100, day: 20731, date: "2026-10-05", value: "4200000", status: "FULL", state: "PENDING", finalAt: String(dayTs(20732) + 25_200n) },
    ];
    const c = new AgateClient({ publicClient: fakeChain({ records: flat("H100", recs), head: { H100: 20732 }, now }), graphqlUrl: "http://fake/v1/graphql", fetch: indexer(stale) });
    const h = (await c.getMarket("H100")).history;
    expect(h.at(-1)).toEqual({ date: "2026-10-05", price: 3.99, status: "carried", example: false });
  });
  test("a carried day older than the chain's newest two, which a lagging indexer has not reached, is read from the chain as carried", async () => {
    const r4 = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 3_990_000, status: 4, final: true }, 20732: { value: 3_800_000, status: 1, final: true }, 20733: { value: 3_810_000, status: 1, final: true } };
    const rows = [{ gpuId: GPU_ID.H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FULL", state: "FINAL", finalAt: "1" }];
    const c = new AgateClient({ publicClient: fakeChain({ records: flat("H100", r4), head: { H100: 20734 }, now: dayTs(20734) + 30_000n }), graphqlUrl: "http://fake/v1/graphql", fetch: indexer(rows) });
    const h = (await c.getMarket("H100")).history;
    expect(h.map((d) => [d.date, d.status])).toEqual([
      ["2026-10-04", "final"],
      ["2026-10-05", "carried"],
      ["2026-10-06", "final"],
      ["2026-10-07", "final"],
    ]);
  });
  test("the indexer's own carried labels (CARRIED, CARRIED_UNVERIFIED) read as carried", async () => {
    const r4 = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 3_990_000, status: 4, final: true }, 20732: { value: 3_990_000, status: 4, final: true }, 20733: { value: 3_810_000, status: 1, final: true }, 20734: { value: 3_820_000, status: 1, final: true } };
    const rows = [
      { gpuId: GPU_ID.H100, day: 20730, date: "2026-10-04", value: "3990000", status: "FULL", state: "FINAL", finalAt: "1" },
      { gpuId: GPU_ID.H100, day: 20731, date: "2026-10-05", value: "3990000", status: "CARRIED", state: "CARRIED", finalAt: "1" },
      { gpuId: GPU_ID.H100, day: 20732, date: "2026-10-06", value: "3990000", status: "CARRIED", state: "CARRIED_UNVERIFIED", finalAt: "1" },
    ];
    const c = new AgateClient({ publicClient: fakeChain({ records: flat("H100", r4), head: { H100: 20735 }, now: dayTs(20735) + 30_000n }), graphqlUrl: "http://fake/v1/graphql", fetch: indexer(rows) });
    const h = (await c.getMarket("H100")).history;
    expect(h.map((d) => d.status)).toEqual(["final", "carried", "carried", "final", "final"]);
  });
  test("a published record not final yet is neither today's price nor a day of the chart", async () => {
    const pend = { 20730: { value: 3_990_000, status: 1, final: true }, 20731: { value: 4_200_000, status: 1, final: false } };
    const c = new AgateClient({ publicClient: fakeChain({ records: flat("H100", pend), head: { H100: 20732 }, now: dayTs(20732) + 7_200n }), graphqlUrl: null });
    const m = await c.getMarket("H100");
    expect([m.price, m.priceDate, m.history.length]).toEqual([3.99, "2026-10-04", 1]);
    // final at postedAt (Oct 6 01:00) + T_PEND: 07:00 UTC
    expect(m.nextUpdateAt).toBe("2026-10-06T07:00:00Z");
  });
});

// ================================================================== 4. a price-only GPU asked for a series

describe("a price-only GPU asked for a series", () => {
  const base = { records: Object.fromEntries(PANELS.map((p) => [p.gpu, { 20730: { value: 3_990_000, status: 1, final: true } }])), head: Object.fromEntries(PANELS.map((p) => [p.gpu, 20731])), now: dayTs(20731) + 30_000n };
  const client = () => new AgateClient({ publicClient: fakeChain(base), graphqlUrl: null });
  test("B300, A100 and L40S have an index price and no market: tradable false, no series, never an error", async () => {
    const c = client();
    const ms = await c.getMarkets();
    expect(ms.map((m) => [m.gpu, m.tradable, m.series.length > 0])).toEqual([
      ["H100", true, true],
      ["H200", true, false],
      ["B200", true, false],
      ["B300", false, false],
      ["A100", false, false],
      ["L40S", false, false],
    ]);
    const b300 = await c.getMarket("B300");
    expect([b300.price, b300.panelSize, b300.series]).toEqual([3.99, 4, []]);
  });
  test("its series, book, fills and candles are empty: the app shows an empty market, not a crash", async () => {
    const c = client();
    for (const g of ["B300", "A100", "L40S"] as const) {
      expect(await c.getSeries(g)).toEqual([]);
      expect(await c.book(g, "2026-11")).toEqual({ asks: [], bids: [], spread: 0 });
      expect(await c.recentFills(g, "2026-11")).toEqual([]);
      expect(await c.candles(g, "2026-11")).toEqual([]);
      expect(await c.listedAt(g, "2026-11")).toBeNull();
    }
  });
  test("every write for a price-only GPU is refused before the wallet is asked for anything", async () => {
    const c = client();
    const asked: string[] = [];
    const w = {
      account: { address: ME, type: "local" },
      chain: { id: 10143 },
      getChainId: async () => 10143,
      writeContract: async (r: { functionName: string }) => {
        asked.push(r.functionName);
        return `0x${"cd".repeat(32)}` as Hex;
      },
    } as never;
    const m = { gpu: "B300" as const, month: "2026-11" };
    const writes: (() => Promise<unknown>)[] = [
      () => buyLong(c, w, { ...m, dollars: "100" }),
      () => sellLong(c, w, { ...m, gpuHours: "1" }),
      () => openShort(c, w, { ...m, gpuHours: "1" }),
      () => closeShort(c, w, { ...m, positionIds: ["1"] }),
      () => openLongDaily(c, w, { ...m, dollars: "100" }),
      () => closeLongDaily(c, w, { ...m, positionIds: ["1"] }),
      () => claim(c, w, { ...m, positionIds: ["1"] }),
      () => mintPairs(c, w, { ...m, gpuHours: "1" }),
      () => redeem(c, w, { ...m, gpuHours: "1" }),
      () => settle(c, w, m),
      () => placeLimit(c, w, { ...m, side: "long", price: "3.90", gpuHours: "1" }),
      () => cancelLimit(c, w, { ...m, orderIds: ["1"] }),
      () => withdrawMargin(c, w, { asset: m }),
    ];
    for (const run of writes) {
      const e = await run().then(() => null, (x: unknown) => x as Error);
      expect(e).toBeInstanceOf(ReadError);
      // B300, A100 and L40S never list: the message says so, not "not listed (yet)"
      expect(e?.message).toContain("B300 is price only");
    }
    expect(asked).toEqual([]);
  });
  test("an unknown GPU and a malformed month are refused, not read as a price-only GPU", async () => {
    const c = client();
    await expect(c.getMarket("H300" as never)).rejects.toBeInstanceOf(ReadError);
    await expect(c.book("H300" as never, "2026-11")).rejects.toBeInstanceOf(ReadError);
    await expect(c.book("H100", "2026-13")).rejects.toBeInstanceOf(AmountError);
    await expect(c.book("B300", "Nov 2026")).rejects.toBeInstanceOf(AmountError);
  });
});

// ================================================================== the pre-launch days (Oct 5)

describe("the pre-launch days are display only", () => {
  const base = { records: Object.fromEntries(PANELS.map((p) => [p.gpu, { 20730: { value: 3_990_000, status: 1, final: true } }])), head: Object.fromEntries(PANELS.map((p) => [p.gpu, 20731])), now: dayTs(20731) + 30_000n };
  test("the production index: Oct 1 to 3 per GPU, onchain false, never in history, the price or the change line", async () => {
    const ms = await new AgateClient({ publicClient: fakeChain(base), graphqlUrl: null }).getMarkets();
    for (const m of ms) {
      const pre = m.prelaunch ?? [];
      expect(pre.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
      expect(pre.every((d) => d.onchain === false && d.example === false && d.price > 0)).toBe(true);
      expect(pre.map((d) => d.price)).toEqual((TESTNET_PRELAUNCH.days[m.gpu] ?? []).map((d) => d.valueU / 1e6));
      expect(m.history.map((d) => d.date)).toEqual(["2026-10-04"]);
      expect(m.history.every((d) => d.onchain === undefined)).toBe(true);
      expect([m.price, m.prevPrice]).toEqual([3.99, 3.99]);
    }
  });
  test("any other index (the demo factory's), or the same address on another chain, has none", async () => {
    const ms = await new AgateClient({ publicClient: fakeChain(base), graphqlUrl: null, factory: "demo" }).getMarkets();
    expect(ms.map((m) => m.prelaunch)).toEqual(ms.map(() => []));
    const local = await new AgateClient({ publicClient: fakeChain(base), graphqlUrl: null, deployments: { ...TESTNET_DEPLOYMENTS, chainId: 31_337 } }).getMarkets();
    expect(local.map((m) => m.prelaunch)).toEqual(local.map(() => []));
  });
  test("a day at or after the GPU's registered firstDay is never shown as pre-launch", async () => {
    // an index registered with firstDay Oct 2: only Oct 1 is before it
    const chain = fakeChain(base) as unknown as { readContract: (r: { functionName: string }) => Promise<unknown> };
    const inner = chain.readContract;
    chain.readContract = async (r) => (r.functionName === "gpu" ? { ...((await inner(r)) as object), firstDay: 20728 } : inner(r));
    const m = await new AgateClient({ publicClient: chain as unknown as PublicClient, graphqlUrl: null }).getMarket("H100");
    expect((m.prelaunch ?? []).map((d) => d.date)).toEqual(["2026-10-01"]);
  });
});
