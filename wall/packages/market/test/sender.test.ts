// BOTS-SPEC 2.3: MarketSender's gas rule over a scriptable JSON-RPC endpoint and the real viem clients: simulate and
// estimate at `latest`, gasLimit = ceil(1.2 x estimate) under CAP = 1.5 x (LIMIT + 21,000 + calldataGas), GAS_CAP
// refused and alerted, provisional ceilings, the fee cap, the spend guard, costWei from the receipt, decoded
// reverts, and a dry run that signs nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeFunctionResult, encodeErrorResult, type Hex, parseTransaction, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AlertSink, RpcPool } from "@agate/watcher";
import { agateFactoryAbi, agateSeriesAbi, agateDollarAbi } from "../src/abi.ts";
import { calldataGas, LimitTable } from "../src/limits.ts";
import { MarketSender, type SpendGuard } from "../src/sender.ts";
import type { SendSpec } from "../src/types.ts";
import { FakeRpc } from "./fake/rpc-server.ts";

const KEY_ENV = "AGATE_TEST_PAYER_SENDER_KEY";
const key = generatePrivateKey();
process.env[KEY_ENV] = key;
const FROM = privateKeyToAccount(key).address;
const SERIES: Address = "0x00000000000000000000000000000000000005e1";
const FACTORY: Address = "0x0000000000000000000000000000000000000fac";
const T = new LimitTable();

let rpc: FakeRpc;
let pool: RpcPool;
let alerts: AlertSink;
const events: { event: string; data: Record<string, unknown> }[] = [];

function sender(o: Partial<{ dryRun: boolean; guard: SpendGuard; maxFeeGwei: number; noKey: boolean }> = {}) {
  return new MarketSender({ pool, role: "payer", ...(o.noKey ? { from: FROM } : { keyEnv: KEY_ENV }), dryRun: o.dryRun ?? false, limits: T, alerts, ...(o.maxFeeGwei ? { maxFeeGwei: o.maxFeeGwei } : {}), ...(o.guard ? { guard: o.guard } : {}), now: () => Math.floor(Date.now() / 1000), pollMs: 5, log: (event, data) => events.push({ event, data }) });
}

const claimSpec = (ids: bigint[], c = 1): SendSpec => ({ to: SERIES, abi: agateSeriesAbi, functionName: "claimMany", args: [ids], shape: "series.claimMany", c, n: ids.length });

beforeAll(async () => {
  rpc = new FakeRpc().start();
  pool = await RpcPool.create({ urls: [rpc.url, rpc.url2], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "test", now: () => 0 });
});
afterAll(() => rpc.stop());
beforeEach(() => {
  alerts = new AlertSink(join(mkdtempSync(join(tmpdir(), "agate-payer-sender-")), "alerts.jsonl"), { now: () => 0, print: false });
  rpc.raws = [];
  rpc.seen.length = 0;
  rpc.baseFee = 50_000_000_000n;
  rpc.priorityFee = 2_000_000_000n;
  rpc.noReceipt = false;
  rpc.call = (p) => (p.data.startsWith(toFunctionSelector("claimMany(uint256[])")) ? { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "claimMany", result: 123n }) } : { result: "0x" });
  rpc.estimate = () => 100_000n;
  events.length = 0;
});

describe("MarketSender (BOTS-SPEC 2.3)", () => {
  test("simulates and estimates at `latest`, signs gasLimit = ceil(1.2 x estimate), returns the decoded result, costWei and logs", async () => {
    rpc.estimate = () => 190_001n;
    const recorded: bigint[] = [];
    const s = sender({ guard: { canSpend: () => ({ ok: true }), record: (c) => recorded.push(c) } });
    const plan = await s.plan(claimSpec([1n, 2n]));
    expect(plan.ok).toBe(true);
    expect(plan.result).toBe(123n);
    expect(plan.gasLimit).toBe(228_002n); // ceil(1.2 x 190,001)
    const r = await s.send(claimSpec([1n, 2n]));
    expect(r.ok && r.sent).toBe(true);
    const tx = parseTransaction(rpc.raws[0]!);
    expect(tx.gas).toBe(228_002n);
    expect(tx.to!.toLowerCase()).toBe(SERIES);
    expect(tx.chainId).toBe(10143);
    expect(r.costWei).toBe(228_002n * rpc.effectiveGasPrice);
    expect(recorded).toEqual([228_002n * rpc.effectiveGasPrice]);
    for (const m of ["eth_call", "eth_estimateGas"]) {
      const tags = rpc.seen.filter((x) => x.method === m).map((x) => (m === "eth_call" ? x.params[1] : (x.params[1] ?? "latest")));
      expect(tags.every((t) => t === "latest")).toBe(true);
    }
  });

  test("GAS_CAP: 1.2 x estimate above 1.5 x (LIMIT + 21,000 + calldataGas) is never sent and raises GAS_CAP (action)", async () => {
    const spec = claimSpec([1n], 1);
    const cd = 4 * 16 + 3 * (31 * 4 + 16);
    const cap = Math.ceil(1.5 * (T.limitFor("series.claimMany", 1, 1) + 21_000 + cd));
    rpc.estimate = () => BigInt(Math.floor(cap / 1.2)); // just fits
    expect((await sender().plan(spec)).ok).toBe(true);
    rpc.estimate = () => BigInt(Math.floor(cap / 1.2) + 2); // just over
    const r = await sender().send(spec);
    expect(r).toMatchObject({ ok: false, sent: false, error: "GAS_CAP" });
    expect(rpc.raws).toEqual([]);
    const a = alerts.open().find((x) => (x.code as string) === "GAS_CAP")!;
    expect(a.severity).toBe("action");
    expect(a.message).toContain("series.claimMany");
    // a later plan for the same target that fits clears it
    rpc.estimate = () => 50_000n;
    expect((await sender().plan(spec)).ok).toBe(true);
    expect(alerts.open().find((x) => (x.code as string) === "GAS_CAP")).toBeUndefined();
  });

  test("the CAP counts the real calldata (16 per nonzero byte, 4 per zero byte)", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => BigInt(1_000_000 + i));
    const s = sender();
    const p = await s.plan(claimSpec(ids, 1));
    const cd = calldataGas(p.data!);
    expect(p.cap).toBe(BigInt(Math.ceil(1.5 * (T.limitFor("series.claimMany", 1, 50) + 21_000 + cd))));
  });

  test("an unmeasured shape uses its provisional ceiling: approve 120,000 x 1.5", async () => {
    const spec: SendSpec = { to: FACTORY, abi: agateDollarAbi, functionName: "approve", args: [SERIES, 2n ** 256n - 1n], shape: "erc20.approve" };
    rpc.call = () => ({ result: encodeFunctionResult({ abi: agateDollarAbi, functionName: "approve", result: true }) });
    rpc.estimate = () => 150_000n; // 180,000 = the cap exactly
    expect((await sender().plan(spec)).gasLimit).toBe(180_000n);
    rpc.estimate = () => 150_001n;
    expect((await sender().plan(spec)).error).toBe("GAS_CAP");
  });

  test("maxFeePerGas is capped by AGATE_MAX_FEE_GWEI (default 200 gwei)", async () => {
    rpc.baseFee = 900_000_000_000n;
    const p = await sender().plan(claimSpec([1n]));
    expect(p.maxFeePerGas).toBe(200_000_000_000n);
    expect(p.costMaxWei).toBe(p.gasLimit! * 200_000_000_000n);
    expect((await sender({ maxFeeGwei: 120 }).plan(claimSpec([1n]))).maxFeePerGas).toBe(120_000_000_000n);
    await sender().send(claimSpec([1n]));
    expect(parseTransaction(rpc.raws[0]!).maxFeePerGas).toBe(200_000_000_000n);
  });

  test("a revert is never sent; its error is decoded from the target's ABI", async () => {
    rpc.call = () => ({ revert: encodeErrorResult({ abi: agateFactoryAbi, errorName: "NotReady" }) });
    const spec: SendSpec = { to: FACTORY, abi: agateFactoryAbi, functionName: "list", args: ["0x" + "11".repeat(32), 24_322], shape: "factory.list" };
    const r = await sender().send(spec);
    expect(r).toMatchObject({ ok: false, sent: false, error: "NotReady()" });
    rpc.call = () => ({ revert: encodeErrorResult({ abi: agateFactoryAbi, errorName: "MonthNotOpen", args: [24_330, 24_321] }) });
    expect((await sender().simulate(spec)).error).toBe("MonthNotOpen(24330, 24321)");
    expect(rpc.raws).toEqual([]);
    expect(rpc.count("eth_estimateGas")).toBe(0);
  });

  test("the spend guard is asked with gasLimit x maxFeePerGas before signing; a refusal sends nothing", async () => {
    let asked = 0n;
    const s = sender({ guard: { canSpend: (c) => ((asked = c), { ok: false, why: "BUDGET" }), record: () => {} } });
    const p = await s.plan(claimSpec([1n]));
    const r = await s.send(claimSpec([1n]));
    expect(r).toMatchObject({ ok: false, sent: false, error: "BUDGET" });
    expect(p.gasLimit).toBe(120_000n);
    expect(asked).toBe(p.costMaxWei!);
    expect(asked).toBe(120_000n * p.maxFeePerGas!);
    expect(rpc.raws).toEqual([]);
  });

  test("AGATE_DRY_RUN: simulate, estimate and log; no nonce read, nothing signed or sent; no key needed", async () => {
    const s = sender({ dryRun: true, noKey: true });
    expect(s.from).toBe(FROM);
    const r = await s.send(claimSpec([1n, 2n], 1));
    expect(r).toMatchObject({ ok: false, sent: false, error: "DRY_RUN" });
    expect(rpc.raws).toEqual([]);
    expect(rpc.count("eth_getTransactionCount")).toBe(0);
    expect(rpc.count("eth_estimateGas")).toBe(1);
    const line = events.find((e) => e.event === "dry_run")!;
    expect(line.data).toMatchObject({ shape: "series.claimMany", c: 1, n: 2, gasLimit: "120000" });
  });

  test("sends are sequential with a local nonce", async () => {
    rpc.nonce = 7;
    const s = sender();
    const rs = await Promise.all([s.send(claimSpec([1n])), s.send(claimSpec([2n])), s.send(claimSpec([3n]))]);
    expect(rs.every((r) => r.ok && r.sent)).toBe(true);
    expect(rpc.raws.map((r) => parseTransaction(r).nonce)).toEqual([7, 8, 9]);
    expect(rpc.count("eth_getTransactionCount")).toBe(1);
  });

  test("a wake refreshes the nonce but never below the local counter (audit P-L3); an error resets it to the chain's", async () => {
    rpc.nonce = 3;
    const s = sender();
    expect((await s.send(claimSpec([1n]))).ok).toBe(true); // nonce 3, local counter 4
    rpc.nonce = 3; // Monad's `pending` still lags right after our own transaction
    s.refreshNonce();
    expect((await s.send(claimSpec([2n]))).ok).toBe(true);
    expect(parseTransaction(rpc.raws.at(-1)!).nonce).toBe(4); // not 3 ("nonce too low")
    rpc.nonce = 9; // a manual cast with the same key moved the chain on
    s.refreshNonce();
    expect((await s.send(claimSpec([3n]))).ok).toBe(true);
    expect(parseTransaction(rpc.raws.at(-1)!).nonce).toBe(9); // the chain's when it is ahead
    rpc.nonce = 2; // after an error the chain's answer is taken as it is (a dropped transaction)
    s.resetNonce();
    await s.send(claimSpec([4n]));
    expect(parseTransaction(rpc.raws.at(-1)!).nonce).toBe(2);
  });

  test("no signing key and not a dry run: refused at construction", () => {
    expect(() => new MarketSender({ pool, role: "payer", from: FROM, limits: T, now: () => 0 })).toThrow("no signing key");
  });
});

void ({} as Hex);
