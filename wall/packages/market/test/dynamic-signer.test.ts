// Oct 5: the payer may sign with a Dynamic server wallet (AGATE_PAYER_SIGNER=dynamic). Only sign() changes: the
// signer answers with the same transaction signed by its address or the send stops with sent:false and the nonce
// unused; SIGNER_DOWN is raised on a failure and cleared by the next signature; a dry run never reads the token or
// the wallet file. The Node worker is replaced here by a local key that plays Dynamic's part.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeFunctionResult, type Hex, parseTransaction, type TransactionSerializableEIP1559, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AlertSink, RpcPool } from "@agate/watcher";
import { agateSeriesAbi } from "../src/abi.ts";
import { type DynamicWalletFile, dynamicSigner, readWalletFile, SignerDown, type TxSigner } from "../src/dynamic-signer.ts";
import { LimitTable } from "../src/limits.ts";
import { StartError, TOKEN_CMD, takeKey, WALLET_FILE } from "../src/runtime.ts";
import { MarketSender } from "../src/sender.ts";
import type { SendSpec } from "../src/types.ts";
import { FakeRpc } from "./fake/rpc-server.ts";

const mpc = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const wallet: DynamicWalletFile = { environmentId: "env-1", walletId: "w-1", address: mpc.address, walletMetadata: { walletId: "w-1" }, externalServerKeyShares: [{ share: "x" }] };
const tx: TransactionSerializableEIP1559 = { chainId: 10143, type: "eip1559", to: "0x00000000000000000000000000000000000005e1", value: 0n, nonce: 3, gas: 120_000n, maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, data: "0x1234" };
/** what the worker would answer: the asked transaction signed by `by`, optionally altered first */
const fakeRun =
  (by = mpc, alter: (t: TransactionSerializableEIP1559) => TransactionSerializableEIP1559 = (t) => t) =>
  async (req: Record<string, unknown>) =>
    JSON.stringify({ signed: await by.signTransaction(alter(req.transaction as TransactionSerializableEIP1559)), ms: 1 });

describe("dynamicSigner", () => {
  test("returns the asked transaction signed by the wallet; the request carries the token and shares, never more", async () => {
    let seen: Record<string, unknown> = {};
    const s = dynamicSigner({ wallet, token: "tok-123456789012345", run: async (req, t) => ((seen = req), fakeRun()(req)) });
    const raw = await s.signTransaction(tx);
    expect(parseTransaction(raw).nonce).toBe(3);
    expect(seen).toMatchObject({ op: "signTransaction", environmentId: "env-1", apiKey: "tok-123456789012345", externalServerKeyShares: [{ share: "x" }] });
    expect((seen.context as { evmTransaction: { to: string } }).evmTransaction.to).toBe(tx.to!);
  });
  test("a signature by another address, or a different transaction, is refused", async () => {
    await expect(dynamicSigner({ wallet, token: "t".repeat(20), run: fakeRun(other) }).signTransaction(tx)).rejects.toThrow("signed as");
    await expect(dynamicSigner({ wallet, token: "t".repeat(20), run: fakeRun(mpc, (t) => ({ ...t, nonce: 4 })) }).signTransaction(tx)).rejects.toThrow("different transaction");
    await expect(dynamicSigner({ wallet, token: "t".repeat(20), run: fakeRun(mpc, (t) => ({ ...t, to: "0x0000000000000000000000000000000000000bad" })) }).signTransaction(tx)).rejects.toThrow("different transaction");
  });
  test("a worker that fails or answers junk throws SignerDown", async () => {
    await expect(dynamicSigner({ wallet, token: "t".repeat(20), run: async () => Promise.reject(new SignerDown("Dynamic signer timed out after 10 s")) }).signTransaction(tx)).rejects.toThrow("timed out");
    await expect(dynamicSigner({ wallet, token: "t".repeat(20), run: async () => "not json" }).signTransaction(tx)).rejects.toBeInstanceOf(SignerDown);
  });
  test("the wallet file must be the owner's only", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-dyn-wallet-"));
    const f = join(dir, "payer-wallet.json");
    writeFileSync(f, JSON.stringify(wallet), { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(() => readWalletFile(f)).toThrow("chmod 600");
    chmodSync(f, 0o600);
    expect(readWalletFile(f).address).toBe(mpc.address);
    expect(() => readWalletFile(join(dir, "none.json"))).toThrow("no Dynamic wallet file");
  });
});

describe("takeKey with AGATE_PAYER_SIGNER=dynamic", () => {
  const o = { keyVar: "AGATE_T_PKEY", addressVar: "AGATE_T_PADDR", signerVar: "AGATE_T_SIGNER", role: "payer" };
  const file = () => {
    const f = join(mkdtempSync(join(tmpdir(), "agate-dyn-rt-")), "payer-wallet.json");
    writeFileSync(f, JSON.stringify(wallet), { mode: 0o600 });
    return f;
  };
  test("a dry run takes the address and never runs the token command or reads the wallet file", () => {
    let ran = false;
    const env: Record<string, string | undefined> = { AGATE_T_SIGNER: "dynamic", AGATE_T_PADDR: mpc.address, AGATE_DRY_RUN: "1", [TOKEN_CMD]: "echo x", [WALLET_FILE]: "/nonexistent" };
    expect(takeKey(o, env, undefined, () => ((ran = true), "t".repeat(20)))).toEqual({ keyVar: null, from: mpc.address });
    expect(ran).toBe(false);
    expect(env[TOKEN_CMD]).toBeUndefined();
  });
  test("live: the token command runs once, the wallet must match the address, a key alongside is refused", () => {
    const env: Record<string, string | undefined> = { AGATE_T_SIGNER: "dynamic", AGATE_T_PADDR: mpc.address, [TOKEN_CMD]: "print-token", [WALLET_FILE]: file() };
    const r = takeKey(o, env, undefined, () => "t".repeat(20));
    expect(r.keyVar).toBeNull();
    expect(r.from).toBe(mpc.address);
    expect(r.signer?.address).toBe(mpc.address);
    expect(env[TOKEN_CMD]).toBeUndefined();
    expect(() => takeKey(o, { AGATE_T_SIGNER: "dynamic", AGATE_T_PADDR: other.address, [TOKEN_CMD]: "x", [WALLET_FILE]: file() }, undefined, () => "t".repeat(20))).toThrow("not AGATE_T_PADDR");
    expect(() => takeKey(o, { AGATE_T_SIGNER: "dynamic", AGATE_T_PADDR: mpc.address, AGATE_T_PKEY: generatePrivateKey() })).toThrow(StartError);
    expect(() => takeKey(o, { AGATE_T_SIGNER: "dynamic", AGATE_T_PADDR: mpc.address, [WALLET_FILE]: file() })).toThrow(TOKEN_CMD);
  });
});

describe("MarketSender with a signer", () => {
  const SERIES: Address = "0x00000000000000000000000000000000000005e1";
  const spec = (ids: bigint[]): SendSpec => ({ to: SERIES, abi: agateSeriesAbi, functionName: "claimMany", args: [ids], shape: "series.claimMany", c: 1, n: ids.length });
  let rpc: FakeRpc;
  let pool: RpcPool;
  let alerts: AlertSink;
  beforeAll(async () => {
    rpc = new FakeRpc().start();
    pool = await RpcPool.create({ urls: [rpc.url, rpc.url2], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "test", now: () => 0 });
  });
  afterAll(() => rpc.stop());
  beforeEach(() => {
    alerts = new AlertSink(join(mkdtempSync(join(tmpdir(), "agate-dyn-sender-")), "alerts.jsonl"), { now: () => 0, print: false });
    rpc.raws = [];
    rpc.nonce = 5;
    rpc.call = (p) => (p.data.startsWith(toFunctionSelector("claimMany(uint256[])")) ? { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "claimMany", result: 1n }) } : { result: "0x" });
    rpc.estimate = () => 100_000n;
  });
  const mk = (signer: TxSigner) => new MarketSender({ pool, role: "payer", signer, from: signer.address, limits: new LimitTable(), alerts, now: () => Math.floor(Date.now() / 1000), pollMs: 5, log: () => {} });

  test("a failed signature sends nothing and keeps the nonce; SIGNER_DOWN is raised, then cleared by the next signature", async () => {
    let fail = true;
    const base = dynamicSigner({ wallet, token: "t".repeat(20), run: fakeRun() });
    const flaky: TxSigner = { address: base.address, signTransaction: (t) => (fail ? Promise.reject(new SignerDown("Dynamic signer timed out after 10 s")) : base.signTransaction(t)) };
    const s = mk(flaky);
    const r1 = await s.send(spec([1n]));
    expect(r1).toMatchObject({ ok: false, sent: false });
    expect(rpc.raws).toEqual([]);
    expect(alerts.open().map((a) => String(a.code))).toContain("SIGNER_DOWN");
    fail = false;
    const r2 = await s.send(spec([1n]));
    expect(r2.ok).toBe(true);
    const sent = rpc.raws.map((x: Hex) => parseTransaction(x));
    expect(sent.map((t) => t.nonce)).toEqual([5]);
    expect(alerts.open().map((a) => String(a.code))).not.toContain("SIGNER_DOWN");
  });

  test("a signer for another address than the configured one is refused at start; a signer and a key together too", () => {
    const s = dynamicSigner({ wallet, token: "t".repeat(20), run: fakeRun() });
    expect(() => new MarketSender({ pool, role: "payer", signer: s, from: other.address, limits: new LimitTable(), now: () => 0 })).toThrow("not the configured address");
    expect(() => new MarketSender({ pool, role: "payer", signer: s, keyEnv: "X", limits: new LimitTable(), now: () => 0 })).toThrow("not both");
  });
});
