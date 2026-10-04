// The send route (Oct 4) with the watcher's TxSender, on a local anvil behind three counting proxies: one stands in for
// the send endpoint (Alchemy), two for the public read endpoints. The transaction, its pending nonce, its gas estimate
// and its receipts go to the send endpoint first; the simulation, the fees and every other read never reach it, not
// even when both read endpoints are down; a send endpoint that is down passes the send on to the read endpoints; the
// day's spent budget turns it off. Keys: Anvil's default account 4, on a local chain only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address, PublicClient } from "viem";
import { RpcMeter } from "@agate/report/meter";
import { AlertSink } from "../src/alerts.ts";
import { RpcDown, RpcPool } from "../src/chain/rpc.ts";
import { SendRoute } from "../src/chain/send-route.ts";
import { TxSender } from "../src/chain/sender.ts";
import { meterFor } from "../src/config.ts";
import { spawnAnvil } from "../../../scripts/anvil.ts";
import { type CountingProxy, startCountingProxy } from "../../../scripts/counting-proxy.ts";

const KEY_ENV = "AGATE_TEST_SEND_ROUTE_KEY";
process.env[KEY_ENV] = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // anvil #4, local only
const PING: Abi = [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }];
const EOA: Address = "0x00000000000000000000000000000000000000E4";
/** what may ever reach a send endpoint */
const SEND_PATH = new Set(["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt"]);
const nowS = () => Math.floor(Date.now() / 1000);

let anvil: Bun.Subprocess | null = null;
let available = true;
let S: CountingProxy;
let A: CountingProxy;
let B: CountingProxy;
let home = "";

beforeAll(async () => {
  try {
    const a = await spawnAnvil(["--silent", "--chain-id", "31337"]);
    anvil = a.proc;
    S = startCountingProxy({ upstream: a.rpc });
    A = startCountingProxy({ upstream: a.rpc });
    B = startCountingProxy({ upstream: a.rpc });
  } catch {
    available = false;
  }
  home = mkdtempSync(join(tmpdir(), "agate-send-route-"));
}, 120_000);

afterAll(() => {
  for (const p of [S, A, B]) p?.stop();
  anvil?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

const reset = () => {
  for (const p of [S, A, B]) {
    p.mode = "forward";
    p.reset();
  }
};
const pubMethods = () => new Set([...A.methods(), ...B.methods()]);

async function rig(o: { meter?: RpcMeter; alerts?: AlertSink } = {}) {
  const pool = await RpcPool.create({ urls: [A.url, B.url], timeoutMs: 2_000, staleS: 600, role: "test", now: nowS });
  const route = await SendRoute.create(pool, { urls: [S.url], role: "test", timeoutMs: 2_000, ...(o.meter ? { meter: o.meter } : {}), ...(o.alerts ? { alerts: o.alerts } : {}) });
  const sender = new TxSender({ pool, send: route, to: EOA, keyEnv: KEY_ENV, role: "test", abi: PING, now: nowS, pollMs: 20 });
  return { pool, route, sender };
}

describe("the watcher's TxSender through a send route", () => {
  test("the send, its nonce, its estimate and its receipt go to the send endpoint; the simulation and the fees to the read endpoints", async () => {
    if (!available) return;
    reset();
    const meter = new RpcMeter({ home, role: "attest", scope: "aaaaaaaa", dailyCu: 1_000_000 });
    const { route, sender } = await rig({ meter });
    const r = await sender.send("ping", []);
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(S.methods().every((m) => SEND_PATH.has(m))).toBe(true);
    for (const m of ["eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt"]) expect({ m, send: S.counts.get(m) ?? 0 }).not.toEqual({ m, send: 0 });
    // the reads: never on the send endpoint, all on the read endpoints
    const pub = pubMethods();
    expect(pub.has("eth_call")).toBe(true);
    for (const m of ["eth_sendRawTransaction", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt"]) expect({ m, pub: pub.has(m) }).toEqual({ m, pub: false });
    // the meter counted exactly what reached the send endpoint
    expect(meter.snapshot().methods).toEqual(Object.fromEntries(S.http));
    expect(route.answered).toBeGreaterThan(0);
    expect(route.passedOn).toBe(0);
  });

  test("reads never reach a send endpoint, even with every read endpoint down: nothing is sent", async () => {
    if (!available) return;
    reset();
    const { pool, route, sender } = await rig();
    S.reset();
    A.mode = "error";
    B.mode = "error";
    await expect(pool.call((c) => c.getBlockNumber())).rejects.toBeInstanceOf(RpcDown);
    await expect(pool.call((c: PublicClient) => c.getBalance({ address: EOA }))).rejects.toBeInstanceOf(RpcDown);
    expect((await sender.simulate("ping", [])).ok).toBe(false);
    const r = await sender.send("ping", []);
    expect(r).toMatchObject({ ok: false, sent: false });
    await pool.tick(nowS()); // the head check and the RPC_DOWN bookkeeping read too
    expect(S.methods()).toEqual([]);
    expect(route.clients().length).toBe(3); // a rebroadcast still reaches every endpoint
  });

  test("a send endpoint that is down passes the send on to the read endpoints", async () => {
    if (!available) return;
    reset();
    const { route, sender } = await rig();
    S.mode = "error";
    const r = await sender.send("ping", []);
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(S.counts.get("eth_sendRawTransaction")).toBe(1); // tried first
    expect(pubMethods().has("eth_sendRawTransaction")).toBe(true);
    expect(route.passedOn).toBeGreaterThan(0);
  });

  test("the day's spent budget turns the send endpoint off (the read endpoints take the sends), the next UTC day on", async () => {
    if (!available) return;
    reset();
    const clock = { t: Date.parse("2026-10-04T23:59:00Z") };
    const meter = new RpcMeter({ home, role: "keep", scope: "bbbbbbbb", dailyCu: 50, nowMs: () => clock.t });
    meter.count("eth_sendRawTransaction", 2); // 80 CU: over the budget
    expect(meter.allowed()).toBe(false);
    const { sender } = await rig({ meter });
    S.reset();
    expect((await sender.send("ping", [])).ok).toBe(true);
    expect(S.methods()).toEqual([]);
    expect(pubMethods().has("eth_sendRawTransaction")).toBe(true);
    clock.t = Date.parse("2026-10-05T00:00:30Z");
    sender.resetNonce();
    expect((await sender.send("ping", [])).ok).toBe(true);
    expect(S.counts.get("eth_sendRawTransaction")).toBe(1);
  });

  test("a send endpoint on another chain is dropped at start with an action alert", async () => {
    if (!available) return;
    reset();
    const alerts = new AlertSink(null, { now: nowS, print: false });
    const pool = await RpcPool.create({ urls: [A.url, B.url], timeoutMs: 2_000, staleS: 600, role: "test", now: nowS });
    const fake = { getChainId: async () => 1 } as unknown as PublicClient;
    const route = await SendRoute.create(pool, { urls: ["https://monad-testnet.g.alchemy.com/v2/FAKEKEYFAKEKEYFAKE"], role: "test", timeoutMs: 2_000, alerts, clientFor: () => fake });
    expect(route.clients().length).toBe(2);
    expect(route.redactedUrls()).toEqual([]);
    expect(alerts.raised.map((a) => [a.code, a.severity])).toEqual([["RPC_FAILOVER", "action"]]);
    expect(alerts.raised[0]!.message).toContain("https://monad-testnet.g.alchemy.com/...");
    expect(alerts.raised[0]!.message).not.toContain("FAKEKEY");
  });

  test("meterFor: a meter only for a process with send endpoints or a websocket; its budget alert is ALCHEMY_BUDGET", () => {
    const home = mkdtempSync(join(tmpdir(), "agate-meter-for-"));
    const alerts = new AlertSink(null, { now: nowS, print: false });
    expect(meterFor({ home, role: "health", scope: "cccccccc", endpoints: { http: ["https://a.test"], ws: [] }, alerts })).toBeUndefined();
    const m = meterFor({ home, role: "attest", scope: "cccccccc", endpoints: { http: ["https://a.test"], ws: [], send: ["https://s.test"] }, alerts, env: { AGATE_ALCHEMY_DAILY_CU: "100" } })!;
    expect(m.dailyCu).toBe(100);
    expect(meterFor({ home, role: "keep", scope: "cccccccc", endpoints: { http: ["https://a.test"], ws: ["wss://w.test"] }, alerts, env: {} })!.dailyCu).toBe(400_000);
    expect(() => meterFor({ home, role: "keep", scope: "cccccccc", endpoints: { http: ["https://a.test"], ws: ["wss://w.test"] }, alerts, env: { AGATE_ALCHEMY_DAILY_CU: "lots" } })).toThrow("AGATE_ALCHEMY_DAILY_CU");
    m.count("eth_sendRawTransaction", 3);
    expect(m.allowed()).toBe(false);
    expect(alerts.raised.map((a) => [a.code, a.severity])).toEqual([
      ["ALCHEMY_BUDGET", "info"],
      ["ALCHEMY_BUDGET", "action"],
    ]);
    rmSync(home, { recursive: true, force: true });
  });
});
