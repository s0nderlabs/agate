// Adversarial checks of the write path on fakes (no chain): the defects these found are fixed, and each test now
// guards its fix. The same cases run on a fork with the live deployment: test/adversarial/fork-adversarial.ts.
import { describe, expect, test } from "bun:test";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { agateRouterAbi, agateSeriesAbi, kuruOrderBookAbi } from "../../src/abi.ts";
import { AgateClient, errorName } from "../../src/client.ts";
import { parseDollars, parseHours, parsePrice } from "../../src/units.ts";
import { buyLong, placeLimit, sellLong, WriteError } from "../../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const SERIES = A(0x11), TOKEN = A(0x22), MARKET = A(0x33), ROUTER = A(0x44), DOLLAR = A(0x55), MA = A(0x66);
const FLOOR = 1_950_000n;
const CAP = 8_000_000n;

const kuruRevert = (fn: string, sig: Hex) => new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: kuruOrderBookAbi, functionName: fn, data: sig }) });

/** A client and wallet over one listed month whose book is `asks` / `bids` ([price u, size units], best first).
 *  Kuru's market buy simulation fills the asks at their prices; `revert` makes a function's simulation revert. */
function world(o: { asks: [bigint, bigint][]; bids: [bigint, bigint][]; revert?: Record<string, Hex> }) {
  const sent: { functionName: string; address: string }[] = [];
  const terms = { series: SERIES, token: TOKEN, gpuId: `0x${"ab".repeat(32)}`, month: 2026 * 12 + 10, startDay: 20758, n: 30, startTs: 1_793_491_200n, day: 86_400, floor: FLOOR, cap: CAP, name: "agate H100 Nov 2026", symbol: "H100-NOV26" };
  const live = { gpu: "H100", terms, market: MARKET, k: 0, S: 0n, tokenSupply: 0n, nextId: 1n, book: { block: 1n, asks: o.asks, bids: o.bids } };
  const marketBuy = (quote: bigint) => {
    let left = quote;
    let got = 0n;
    for (const [p, s] of o.asks) {
      const units = (left * 10_000n) / p;
      if (units <= s) return (got + units) * 100n;
      got += s;
      left -= (p * s) / 10_000n;
    }
    return got * 100n;
  };
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
    async readContract(req: { functionName: string }) {
      if (req.functionName === "balanceOf") return 10n ** 12n;
      return 0n; // allowance, Kuru margin balances
    },
    async waitForTransactionReceipt() {
      return { status: "success", gasUsed: 90_000n, blockNumber: 1n, logs: [] };
    },
  };
  const c = { pub, chain: { id: 10143 }, dollar: DOLLAR, router: ROUTER, marginAccount: MA, factory: A(0x77), deployments: { kuru: { marginAccount: MA, router: A(0x88) } }, seriesAt: async () => live, chainTime: async () => 0n } as unknown as AgateClient;
  const w = {
    account: { address: ME, type: "local" },
    chain: { id: 10143 },
    async getChainId() {
      return 10143;
    },
    async writeContract(req: { functionName: string; address: string }) {
      sent.push({ functionName: req.functionName, address: req.address });
      return `0x${"cd".repeat(32)}` as Hex;
    },
  };
  return { c, w: w as never, sent };
}

const outcome = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

describe("market writes are bounded by the band, not only by a fresh quote", () => {
  // the book at the click: only an ask at $20, 2.5 x the cap (a token pays at most the cap)
  test("buyLong refuses to buy above the cap, before anything is sent", async () => {
    const f = world({ asks: [[20_000_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]] });
    const e = await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(f.sent).toEqual([]);
    expect(e).toBeInstanceOf(WriteError);
    expect((e as WriteError).stage).toBe("check");
  });
  // the book at the click: only a bid at $0.50, under the floor (a token pays at least the floor)
  test("sellLong refuses to sell below the floor, before anything is sent", async () => {
    const f = world({ asks: [[4_030_000n, 10_000_000n]], bids: [[500_000n, 1_000_000n]] });
    const e = await outcome(sellLong(f.c, f.w, { gpu: "H100", month: "2026-11", gpuHours: "20" }));
    expect(f.sent).toEqual([]);
    expect((e as WriteError).stage).toBe("check");
  });
  test("control: the same buyLong sends on a book inside the band (the fake works)", async () => {
    const f = world({ asks: [[4_030_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]] });
    await outcome(buyLong(f.c, f.w, { gpu: "H100", month: "2026-11", dollars: "1000" }));
    expect(f.sent.map((s) => s.functionName)).toEqual(["approve", "openLong"]);
  });
});

describe("multi-transaction writes", () => {
  test("placeLimit refuses a post-only order that would cross the book before any approve or deposit", async () => {
    const f = world({ asks: [[4_030_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]], revert: { addBuyOrder: "0x06e6da4d" } });
    const e = await outcome(placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "long", price: "4.03", gpuHours: "10" }));
    expect(e).toBeInstanceOf(WriteError);
    expect(f.sent).toEqual([]); // before the fix: approve tUSD to the margin account, deposit, then PostOnlyError
  });
  test("a later step's refusal reports the transactions that already landed (and never says nothing was sent)", async () => {
    // a resting price, but the market refuses the order (paused): the approve and the deposit have landed
    const f = world({ asks: [[4_030_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]], revert: { addBuyOrder: "0x004b65ba" } });
    const e = await outcome(placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "long", price: "3.90", gpuHours: "10" }));
    expect(f.sent.map((s) => s.functionName)).toEqual(["approve", "deposit"]);
    expect(e?.message).not.toContain("nothing was sent");
    expect((e as unknown as { txs?: unknown[] }).txs?.length).toBe(2);
  });
});

describe("revert names", () => {
  test("a Kuru error bubbling up through the router is named (openLong reverting with Kuru's SlippageExceeded())", () => {
    const e = new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi: agateRouterAbi, functionName: "openLong", data: "0x8199f5f3" }) });
    expect(errorName(e)).toBe("SlippageExceeded");
  });
});

// The app passes its own viem public client (README: `publicClient`, "bring your own"); with file:../client the app's
// viem and the client's are separate module copies, so `instanceof` fails across them. Another copy of viem 2.57.2 is
// in the repo's node_modules (the wall's market package), standing in for the app's.
const OTHER_VIEM = join(import.meta.dir, "../../../wall/packages/market/node_modules/viem/_esm/index.js");
describe("a public client from another copy of viem", () => {
  const call = { address: A(0x99), abi: agateSeriesAbi, functionName: "previewSync" } as const;
  const pubWith = (err: unknown) =>
    ({
      async getCode() {
        return "0x6080" as Hex;
      },
      async multicall() {
        return [{ status: "failure", error: err }];
      },
    }) as never;
  test("control: a revert from the client's own viem is a revert ({ok: false}), at once", async () => {
    const c = new AgateClient({ publicClient: pubWith(kuruRevert("addBuyOrder", "0x06e6da4d")), graphqlUrl: null });
    const r = await c.mc([call as never]);
    expect(r[0]?.ok).toBe(false);
  });
  test(
    "a revert from another viem copy is still a revert, not a transport failure retried and thrown",
    async () => {
      if (!existsSync(OTHER_VIEM)) throw new Error("no second viem copy here");
      const other = (await import(OTHER_VIEM)) as typeof import("viem");
      const err = new other.BaseError("reverted", { cause: new other.ContractFunctionRevertedError({ abi: kuruOrderBookAbi, functionName: "addBuyOrder", data: "0x06e6da4d" }) });
      const c = new AgateClient({ publicClient: pubWith(err), graphqlUrl: null });
      const r = await c.mc([call as never]); // before the fix: 4 retries over 6 s, then ReadError "the RPC failed"
      expect(r[0]?.ok).toBe(false);
    },
    20_000,
  );
});

describe("guards that hold", () => {
  test("amounts: numbers, exponents, signs, separators and extra decimals are refused", () => {
    for (const bad of [1000 as unknown as string, "1e3", "-1", "1,000", "0.0000001", "12.", ".5", "0x10", " "]) expect(() => parseDollars(bad)).toThrow();
    expect(() => parseHours("0.00005")).toThrow(); // under one LOT
    expect(() => parsePrice("3.905")).toThrow(); // off the cent tick
    expect(parseDollars("1000.5")).toBe(1_000_500_000n);
  });
  test("placeLimit refuses a price outside the band before anything is sent", async () => {
    const f = world({ asks: [[4_030_000n, 10_000_000n]], bids: [[3_950_000n, 10_000_000n]] });
    const e = await outcome(placeLimit(f.c, f.w, { gpu: "H100", month: "2026-11", side: "short", price: "20.00", gpuHours: "10", mint: true }));
    expect(e).toBeTruthy();
    expect(f.sent).toEqual([]);
  });
});
