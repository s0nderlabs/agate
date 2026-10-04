// The writer's send route (Oct 4) on a local anvil behind three counting proxies: one stands in for the send endpoint
// (Alchemy), two for the public read endpoints. The transaction, its nonce, its gas estimate and its receipts go to the
// send endpoint first; the eth_call check and the fees never reach it, not even when both read endpoints are down; a
// send endpoint down passes the send on; a rebroadcast reaches every endpoint; a send endpoint on another chain is
// dropped; the day's spent budget turns it off. Keys: Anvil's default account 5, on a local chain only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcMeter } from "@agate/report/meter";
import type { Address, Hex } from "@agate/report/types";
import { privateKeyToAccount } from "viem/accounts";
import { ReadingLog } from "../src/pipeline/log.ts";
import { type AlertInput, RpcDownError, RpcPool, SendRoute } from "../src/pipeline/rpc.ts";
import { type SenderTiming, TxSender } from "../src/pipeline/sender.ts";
import { rpcEndpointsFromEnv } from "../src/pipeline/setup.ts";
import { spawnAnvil } from "../../../scripts/anvil.ts";
import { type CountingProxy, startCountingProxy } from "../../../scripts/counting-proxy.ts";

const KEY: Hex = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5, local only
const TO: Address = "0x00000000000000000000000000000000000000E5";
const SEND_PATH = new Set(["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
const FAST: SenderTiming = { pollMs: 20, rebroadcastMs: 300, replaceMs: 60_000, waitMs: 3_000, lockWaitMs: 300 };

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
  home = mkdtempSync(join(tmpdir(), "agate-writer-send-route-"));
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

async function rig(o: { meter?: RpcMeter; sendUrls?: string[] } = {}) {
  const alerts: AlertInput[] = [];
  const events: { e: string; d?: Record<string, unknown> }[] = [];
  const pool = new RpcPool({ urls: [A.url, B.url], timeoutMs: 2_000, staleS: 10_000_000, alert: (x) => void alerts.push(x) });
  await pool.init();
  const route = new SendRoute(pool, { urls: o.sendUrls ?? [S.url], ...(o.meter ? { meter: o.meter } : {}), alert: (x) => void alerts.push(x), say: (e, d) => void events.push({ e, ...(d ? { d } : {}) }) });
  await route.verify();
  const sender = new TxSender({ pool, send: route, account: privateKeyToAccount(KEY), index: TO, journal: new ReadingLog(home, "standby"), timing: FAST, alert: (x) => void alerts.push(x) });
  return { pool, route, sender, alerts, events };
}

const meta = { action: "post" as const, tags: ["t"] };

describe("the writer's TxSender through a send route", () => {
  test("the send, its nonce, its estimate and its receipt go to the send endpoint; the eth_call and the fees to the read endpoints", async () => {
    if (!available) return;
    reset();
    const meter = new RpcMeter({ home, role: "standby", scope: "aaaaaaaa", dailyCu: 1_000_000 });
    const { sender } = await rig({ meter });
    const r = await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta });
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(S.methods().every((m) => SEND_PATH.has(m))).toBe(true);
    for (const m of ["eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt"]) expect({ m, send: (S.counts.get(m) ?? 0) > 0 }).toEqual({ m, send: true });
    const pub = pubMethods();
    expect(pub.has("eth_call")).toBe(true);
    expect(pub.has("eth_getBlockByNumber")).toBe(true); // the fees
    for (const m of ["eth_sendRawTransaction", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt"]) expect({ m, pub: pub.has(m) }).toEqual({ m, pub: false });
    expect(meter.snapshot().methods).toEqual(Object.fromEntries(S.http));
  });

  test("reads never reach a send endpoint, even with every read endpoint down: nothing is sent", async () => {
    if (!available) return;
    reset();
    const { pool, sender } = await rig();
    S.reset();
    A.mode = "error";
    B.mode = "error";
    await expect(sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).rejects.toBeInstanceOf(RpcDownError);
    await expect(pool.request("eth_blockNumber")).rejects.toBeInstanceOf(RpcDownError);
    await expect(pool.checkHead(Math.floor(Date.now() / 1000))).rejects.toBeInstanceOf(RpcDownError);
    // after the failed send the sender re-reads its nonce: that read is its own, on the send endpoint; nothing else
    expect(S.methods().filter((m) => !SEND_PATH.has(m))).toEqual([]);
    expect(S.counts.get("eth_call") ?? 0).toBe(0);
    expect(S.counts.get("eth_sendRawTransaction") ?? 0).toBe(0);
  });

  test("a send endpoint that is down passes the send on to the read endpoints", async () => {
    if (!available) return;
    reset();
    const { sender, events } = await rig();
    S.mode = "error";
    const r = await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta });
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(S.counts.get("eth_sendRawTransaction")).toBe(1);
    expect(pubMethods().has("eth_sendRawTransaction")).toBe(true);
    expect(events.map((x) => x.e)).toContain("send_endpoint_down");
  });

  test("a rebroadcast goes to the send endpoint and to every read endpoint", async () => {
    if (!available) return;
    reset();
    const { route } = await rig();
    const res = await route.broadcastAll("0x02");
    expect(res.length).toBe(3);
    expect(S.counts.get("eth_sendRawTransaction")).toBe(1);
    expect((A.counts.get("eth_sendRawTransaction") ?? 0) + (B.counts.get("eth_sendRawTransaction") ?? 0)).toBe(2);
  });

  test("a send endpoint on another chain is dropped once the pool knows its chain", async () => {
    if (!available) return;
    reset();
    const other = Bun.serve({ port: 0, fetch: async (req) => Response.json({ jsonrpc: "2.0", id: ((await req.json()) as { id: number }).id, result: "0x1" }) });
    try {
      const { route, alerts } = await rig({ sendUrls: [`http://127.0.0.1:${other.port}/v2/FAKEKEYFAKEKEYFAKE`, S.url] });
      expect(route.urls).toEqual([S.url]);
      expect(alerts.map((a) => [a.code, a.severity])).toEqual([["RPC_FAILOVER", "action"]]);
      expect(alerts[0]!.message).not.toContain("FAKEKEY");
    } finally {
      other.stop(true);
    }
  });

  test("the day's spent budget turns the send endpoint off until 00:00 UTC", async () => {
    if (!available) return;
    reset();
    const clock = { t: Date.parse("2026-10-06T23:59:00Z") };
    const meter = new RpcMeter({ home, role: "primary", scope: "bbbbbbbb", dailyCu: 50, nowMs: () => clock.t });
    meter.count("eth_sendRawTransaction", 2);
    const { sender } = await rig({ meter });
    S.reset();
    expect((await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).ok).toBe(true);
    expect(S.methods()).toEqual([]);
    clock.t = Date.parse("2026-10-07T00:00:30Z");
    expect((await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).ok).toBe(true);
    expect(S.counts.get("eth_sendRawTransaction")).toBe(1);
  });

  test("rpcEndpointsFromEnv keeps the send: entries (deduplicated) and the old list shape without them", () => {
    const e = rpcEndpointsFromEnv({ AGATE_RPC_URLS: "send:http://s.test,send:http://s.test,http://a.test,http://b.test,http://a.test" });
    expect(e).toEqual({ http: ["http://a.test", "http://b.test"], ws: [], send: ["http://s.test"] });
    expect(rpcEndpointsFromEnv({ AGATE_RPC_URLS: "http://a.test,http://b.test" })).toEqual({ http: ["http://a.test", "http://b.test"], ws: [] });
  });
});
