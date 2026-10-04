// The market bots' sender through a send route (Oct 4), over two scriptable JSON-RPC endpoints: one stands in for the
// send endpoint (Alchemy), one for the public reads. The transaction, its pending nonce, its gas estimate and its
// receipt go to the send endpoint; the simulation and the fees stay on the read endpoint; with the read endpoints down
// nothing but the send path ever reaches the send endpoint and nothing is sent; the runtime builds the route and the
// meter only when the list has send: entries.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeFunctionResult, toFunctionSelector } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { RpcMeter } from "@agate/report/meter";
import { RpcPool, SendRoute } from "@agate/watcher";
import { agateSeriesAbi } from "../src/abi.ts";
import { LimitTable } from "../src/limits.ts";
import { MarketSender } from "../src/sender.ts";
import type { SendSpec } from "../src/types.ts";
import { FakeRpc } from "./fake/rpc-server.ts";

const KEY_ENV = "AGATE_TEST_MARKET_ROUTE_KEY";
process.env[KEY_ENV] = generatePrivateKey();
const SERIES: Address = "0x00000000000000000000000000000000000005e1";
const SEND_PATH = new Set(["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt"]);
const T = new LimitTable();
const claim: SendSpec = { to: SERIES, abi: agateSeriesAbi, functionName: "claimMany", args: [[1n, 2n]], shape: "series.claimMany", c: 1, n: 2 };

let send: FakeRpc;
let pub: FakeRpc;
let home = "";
beforeAll(() => {
  send = new FakeRpc().start();
  pub = new FakeRpc().start();
  home = mkdtempSync(join(tmpdir(), "agate-market-route-"));
});
afterAll(() => {
  send.stop();
  pub.stop();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  for (const r of [send, pub]) {
    r.seen.length = 0;
    r.raws = [];
    r.call = (p) => (p.data.startsWith(toFunctionSelector("claimMany(uint256[])")) ? { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "claimMany", result: 7n }) } : { result: "0x" });
  }
});

const methods = (r: FakeRpc) => [...new Set(r.seen.map((x) => x.method))].sort();

async function rig(pubUrls: string[], meter?: RpcMeter) {
  const pool = await RpcPool.create({ urls: pubUrls, expectChainId: 10143, timeoutMs: 1_000, staleS: 10 ** 9, role: "payer", now: () => 0 });
  const route = await SendRoute.create(pool, { urls: [send.url], role: "payer", timeoutMs: 1_000, ...(meter ? { meter } : {}) });
  const s = new MarketSender({ pool, send: route, role: "payer", keyEnv: KEY_ENV, limits: T, now: () => Math.floor(Date.now() / 1000), pollMs: 5 });
  return { pool, route, s };
}

describe("MarketSender through a send route", () => {
  test("the send, its nonce, its estimate and its receipt: the send endpoint; the simulation and the fees: the read endpoint", async () => {
    const meter = new RpcMeter({ home, role: "payer", scope: "market", dailyCu: 1_000_000 });
    const { s } = await rig([pub.url, pub.url2], meter);
    const r = await s.send(claim);
    expect(r.ok && r.sent).toBe(true);
    expect(send.raws.length).toBe(1);
    expect(pub.raws.length).toBe(0);
    expect(methods(send).every((m) => SEND_PATH.has(m))).toBe(true);
    expect(methods(send)).toEqual(["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_sendRawTransaction"]);
    const pm = methods(pub);
    expect(pm).toContain("eth_call");
    expect(pm).toContain("eth_getBlockByNumber"); // the fees
    for (const m of ["eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_sendRawTransaction"]) expect({ m, pub: pm.includes(m) }).toEqual({ m, pub: false });
    // the meter counted every call to the send endpoint, by method
    const want: Record<string, number> = {};
    for (const x of send.seen) want[x.method] = (want[x.method] ?? 0) + 1;
    expect(meter.snapshot().methods).toEqual(want);
  });

  test("with every read endpoint down: no read reaches the send endpoint and nothing is sent", async () => {
    const { pool, s } = await rig(["http://127.0.0.1:1", "http://localhost:1"]);
    send.seen.length = 0;
    const r = await s.send(claim);
    expect(r).toMatchObject({ ok: false, sent: false });
    await expect(s.fees()).rejects.toThrow();
    await expect(pool.call((c) => c.getBlockNumber())).rejects.toThrow("every RPC URL failed");
    expect(send.seen).toEqual([]);
    expect(send.raws).toEqual([]);
  });

  test("a dry run plans through the route (the estimate on the send endpoint) and sends nothing", async () => {
    const pool = await RpcPool.create({ urls: [pub.url], expectChainId: 10143, timeoutMs: 1_000, staleS: 10 ** 9, role: "payer", now: () => 0 });
    const route = await SendRoute.create(pool, { urls: [send.url], role: "payer", timeoutMs: 1_000 });
    send.seen.length = 0;
    const s = new MarketSender({ pool, send: route, role: "payer", from: "0x00000000000000000000000000000000000000d1", dryRun: true, limits: T, now: () => 0 });
    expect((await s.send(claim)).error).toBe("DRY_RUN");
    expect(methods(send)).toEqual(["eth_estimateGas"]);
    expect(send.raws).toEqual([]);
  });
});
