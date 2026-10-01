// RPC failover and the transaction sender (BUILD-SPEC 13.4) against a local anvil and a scriptable proxy in front of
// it: a URL erroring, hanging, on the wrong chain id, a stale head, both down, a dropped transaction rebroadcast with
// the same nonce, a replacement after the timeout, "nonce too low" resolved by receipt, NONCE_STUCK and GAS_CAP.
// Keys: Anvil's default account 3, on a local chain only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type Abi, type Address, type Hex } from "viem";
import { AlertSink } from "../src/alerts.ts";
import { RpcDown, RpcPool } from "../src/chain/rpc.ts";
import { TxSender } from "../src/chain/sender.ts";
import { deriveClocks, PROFILES } from "../src/clock.ts";
import { connect } from "../src/config.ts";
import { writeAtomic } from "../src/fsutil.ts";

const KEY_ENV = "AGATE_TEST_SENDER_KEY";
process.env[KEY_ENV] = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil #3, local only
const PING: Abi = [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }];
const EOA: Address = "0x00000000000000000000000000000000000000E0";
const REVERTER: Address = "0x00000000000000000000000000000000000000Ee";

let anvil: ReturnType<typeof Bun.spawn> | null = null;
let anvilUrl = "";
type Mode = "forward" | "error" | "hang" | "wrongchain" | "stale" | "drop-raw" | "forward-then-error";
const proxy = { mode: "forward" as Mode, server: null as ReturnType<typeof Bun.serve> | null, url: "", raws: [] as string[] };
let available = true;

async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message: string } };
}

beforeAll(async () => {
  const port = 18_545 + Math.floor(Math.random() * 1_000);
  try {
    anvil = Bun.spawn([`${import.meta.dir}/../../../scripts/anvil-safe.sh`, "--port", String(port), "--silent", "--chain-id", "31337"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    available = false;
    return;
  }
  anvilUrl = `http://127.0.0.1:${port}`;
  for (let j = 0; j < 100; j++) {
    try {
      if ((await rpc(anvilUrl, "eth_chainId")).result) break;
    } catch {
      await Bun.sleep(100);
    }
  }
  await rpc(anvilUrl, "anvil_setCode", [REVERTER, "0x60006000fd"]);
  proxy.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string; params: unknown[] };
      const reply = (x: object) => Response.json({ jsonrpc: "2.0", id: body.id, ...x });
      const m = proxy.mode;
      if (m === "error") return new Response("upstream down", { status: 502 });
      if (m === "hang") {
        await Bun.sleep(5_000);
        return new Response("late", { status: 504 });
      }
      if (m === "wrongchain" && body.method === "eth_chainId") return reply({ result: "0x1" });
      if (m === "stale" && body.method === "eth_getBlockByNumber") {
        const r = await rpc(anvilUrl, body.method, body.params);
        return reply({ result: { ...(r.result as object), timestamp: "0x1" } });
      }
      if (m === "drop-raw" && body.method === "eth_sendRawTransaction") {
        proxy.raws.push(body.params[0] as string);
        return reply({ result: "0x" + "00".repeat(32) });
      }
      const r = await fetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (m === "forward-then-error" && body.method === "eth_sendRawTransaction") return new Response("lost reply", { status: 502 });
      return new Response(await r.text(), { headers: { "content-type": "application/json" } });
    },
  });
  proxy.url = `http://127.0.0.1:${proxy.server.port}`;
});

afterAll(() => {
  anvil?.kill();
  proxy.server?.stop(true);
});

const nowS = () => Math.floor(Date.now() / 1000);
function mkAlerts() {
  return new AlertSink(null, { now: nowS, print: false });
}
async function mkPool(urls: string[], alerts = mkAlerts(), staleS = 60) {
  return RpcPool.create({ urls, timeoutMs: 1_000, staleS, reprobeS: 1, alerts, role: "test", now: nowS });
}
function mkSender(pool: RpcPool, alerts: AlertSink, extra: Partial<ConstructorParameters<typeof TxSender>[0]> = {}) {
  return new TxSender({ pool, to: EOA, keyEnv: KEY_ENV, role: "test", alerts, abi: PING, now: nowS, pollMs: 100, rebroadcastS: 1, replaceS: 2, giveUpS: 2, ...extra });
}

describe("RPC failover (13.4)", () => {
  test("the first URL erroring or hanging: reads fail over, RPC_FAILOVER raised", async () => {
    if (!available) return;
    for (const mode of ["error", "hang"] as const) {
      proxy.mode = "forward";
      const alerts = mkAlerts();
      const pool = await mkPool([proxy.url, anvilUrl], alerts);
      proxy.mode = mode;
      const n = await pool.call((c) => c.getBlockNumber());
      expect(n).toBeGreaterThanOrEqual(0n);
      expect(pool.url).toBe(anvilUrl);
      expect(alerts.all().some((a) => a.code === "RPC_FAILOVER")).toBe(true);
    }
    proxy.mode = "forward";
  });

  test("a URL on the wrong chain id is dropped at start; one URL left raises RPC_SINGLE", async () => {
    if (!available) return;
    proxy.mode = "wrongchain";
    const alerts = mkAlerts();
    const pool = await RpcPool.create({ urls: [anvilUrl, proxy.url], expectChainId: 31337, timeoutMs: 1_000, staleS: 60, alerts, role: "test", now: nowS });
    expect(pool.urls()).toEqual([anvilUrl]);
    expect(alerts.all().map((a) => a.code).sort()).toEqual(["RPC_FAILOVER", "RPC_SINGLE"]);
    proxy.mode = "forward";
  });

  test("a stale head fails over; the first URL is taken back once healthy", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const alerts = mkAlerts();
    await rpc(anvilUrl, "evm_mine");
    const pool = await mkPool([proxy.url, anvilUrl], alerts, 10_000_000_000);
    proxy.mode = "stale";
    // stale = older than staleS: use a pool whose staleS is small against anvil's fresh head
    const pool2 = await mkPool([proxy.url, anvilUrl], alerts, 30);
    await pool2.tick(nowS());
    expect(pool2.url).toBe(anvilUrl);
    proxy.mode = "forward";
    await Bun.sleep(1_100);
    await pool2.tick(nowS());
    expect(pool2.url).toBe(proxy.url);
    expect(pool.url).toBe(proxy.url);
  });

  test("every URL down: RpcDown; RPC_DOWN after two ticks; cleared on recovery", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const alerts = mkAlerts();
    const pool = await mkPool([proxy.url, "http://127.0.0.1:1"], alerts);
    proxy.mode = "error";
    await expect(pool.call((c) => c.getBlockNumber())).rejects.toBeInstanceOf(RpcDown);
    await pool.tick(nowS());
    await pool.tick(nowS());
    expect(alerts.open().some((a) => a.code === "RPC_DOWN")).toBe(true);
    proxy.mode = "forward";
    await pool.call((c) => c.getBlockNumber());
    await pool.tick(nowS());
    expect(alerts.open().some((a) => a.code === "RPC_DOWN")).toBe(false);
  });

  test("a revert is the node's answer: never a failover", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const pool = await mkPool([proxy.url, anvilUrl]);
    await expect(pool.call((c) => c.call({ to: REVERTER, data: "0x" }))).rejects.toThrow();
    expect(pool.url).toBe(proxy.url);
  });
});

describe("TxSender (4.14, 13.4)", () => {
  test("eth_call first: a call that reverts is never sent", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const pool = await mkPool([anvilUrl, proxy.url]);
    const s = new TxSender({ pool, to: REVERTER, keyEnv: KEY_ENV, role: "test", abi: PING, now: nowS });
    const before = Number((await rpc(anvilUrl, "eth_getTransactionCount", [s.from, "pending"])).result);
    const r = await s.send("ping", []);
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(Number((await rpc(anvilUrl, "eth_getTransactionCount", [s.from, "pending"])).result)).toBe(before);
  });

  test("gas limit min(CAP, ceil(1.5 * max(estimate, MEASURED))); GAS_CAP refuses above the cap", async () => {
    if (!available) return;
    const alerts = mkAlerts();
    const pool = await mkPool([anvilUrl, proxy.url], alerts);
    const s = mkSender(pool, alerts, { measured: { ping: 100_000n } });
    const r = await s.send("ping", []);
    expect(r.ok).toBe(true);
    expect(r.gasLimit).toBe(150_000n);
    const tx = (await rpc(anvilUrl, "eth_getTransactionByHash", [r.txHash])).result as { gas: Hex };
    expect(BigInt(tx.gas)).toBe(150_000n);
    const s2 = mkSender(pool, alerts, { measured: { ping: 1_000n } });
    const r2 = await s2.send("ping", []);
    expect(r2).toMatchObject({ ok: false, sent: false, error: "GAS_CAP" });
    expect(alerts.all().some((a) => a.code === "GAS_CAP")).toBe(true);
  });

  test("sequential sends use consecutive nonces with no gap", async () => {
    if (!available) return;
    const pool = await mkPool([anvilUrl, proxy.url]);
    const s = mkSender(pool, mkAlerts());
    const start = Number((await rpc(anvilUrl, "eth_getTransactionCount", [s.from, "latest"])).result);
    const rs = await Promise.all([s.send("ping", []), s.send("ping", []), s.send("ping", [])]);
    expect(rs.every((r) => r.ok)).toBe(true);
    const nonces = await Promise.all(rs.map(async (r) => Number(((await rpc(anvilUrl, "eth_getTransactionByHash", [r.txHash])).result as { nonce: Hex }).nonce)));
    expect(nonces.sort((a, b) => a - b)).toEqual([start, start + 1, start + 2]);
  });

  test("a dropped transaction is rebroadcast unchanged (same nonce, same hash) to every URL", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const pool = await mkPool([proxy.url, anvilUrl]);
    const s = mkSender(pool, mkAlerts(), { replaceS: 60 });
    proxy.mode = "drop-raw";
    proxy.raws.length = 0;
    const r = await s.send("ping", []);
    proxy.mode = "forward";
    expect(r.ok).toBe(true);
    // the swallowed original and its rebroadcast are the same signed bytes (same nonce, same hash)
    expect(proxy.raws.length).toBeGreaterThanOrEqual(1);
    expect(new Set(proxy.raws).size).toBe(1);
    expect(s.log.some((l) => l.startsWith("rebroadcast"))).toBe(true);
    expect(s.log.some((l) => l.startsWith("replaced"))).toBe(false);
  });

  test("an unmined transaction is replaced with the same nonce and higher fees; NONCE_STUCK after three", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const alerts = mkAlerts();
    const pool = await mkPool([anvilUrl, proxy.url], alerts);
    await rpc(anvilUrl, "evm_setAutomine", [false]);
    try {
      const s = mkSender(pool, alerts, { rebroadcastS: 1, replaceS: 1, giveUpS: 1 });
      const p = s.send("ping", []);
      await Bun.sleep(1_600);
      await rpc(anvilUrl, "evm_mine");
      const r = await p;
      expect(r.ok).toBe(true);
      expect(s.log.some((l) => l.startsWith("replaced"))).toBe(true);
      const s2 = mkSender(pool, alerts, { rebroadcastS: 1, replaceS: 1, giveUpS: 1 });
      const r2 = await s2.send("ping", []);
      expect(r2).toMatchObject({ ok: false, sent: true, error: "NONCE_STUCK" });
      expect(alerts.all().some((a) => a.code === "NONCE_STUCK")).toBe(true);
    } finally {
      await rpc(anvilUrl, "evm_setAutomine", [true]);
      await rpc(anvilUrl, "evm_mine");
    }
  }, 30_000);

  test("a reply lost after the node took the transaction: 'nonce too low' on the next URL is resolved by receipt", async () => {
    if (!available) return;
    proxy.mode = "forward";
    const pool = await mkPool([proxy.url, anvilUrl]);
    const s = mkSender(pool, mkAlerts());
    proxy.mode = "forward-then-error";
    const r = await s.send("ping", []);
    proxy.mode = "forward";
    expect(r.ok).toBe(true);
    const r2 = await s.send("ping", []);
    expect(r2.ok).toBe(true);
  });

  test("the key is read at call time: no key, no send", async () => {
    if (!available) return;
    const pool = await mkPool([anvilUrl, proxy.url]);
    const s = mkSender(pool, mkAlerts());
    const k = process.env[KEY_ENV];
    delete process.env[KEY_ENV];
    try {
      const r = await s.send("ping", []);
      expect(r).toMatchObject({ ok: false, sent: false });
      expect(r.error).toContain(KEY_ENV);
    } finally {
      process.env[KEY_ENV] = k;
    }
  });
});

describe("the chain id at start (no AGATE_CHAIN_ID) and a start with every URL down", () => {
  // fake clients: each URL answers its chain id, or nothing (null)
  const fake = (ids: Record<string, number | null>) => (url: string) =>
    ({
      getChainId: async () => {
        if (ids[url] === null) throw new Error("down");
        return ids[url]!;
      },
      getBlock: async () => ({ timestamp: BigInt(nowS()) }),
    }) as never;
  const create = (ids: Record<string, number | null>, extra: { fallbackChainId?: number; alerts?: AlertSink } = {}) =>
    RpcPool.create({ urls: Object.keys(ids), timeoutMs: 100, staleS: 60, role: "test", now: nowS, clientFor: fake(ids), ...extra });

  test("the chain most answering URLs report wins; a wrong-chain URL listed first is dropped; a tie is refused", async () => {
    const p = await create({ "http://main": 143, "http://test-a": 10_143, "http://test-b": 10_143 });
    expect([p.chainId, p.urls()]).toEqual([10_143, ["http://test-a", "http://test-b"]]);
    expect((await create({ "http://down": null, "http://test": 10_143 })).chainId).toBe(10_143);
    await expect(create({ "http://main": 143, "http://test": 10_143 })).rejects.toThrow(/disagree on the chain id/);
  });

  test("no URL answers: the cached chain id starts the pool (all URLs kept); a wrong-chain URL is dropped once one answers", async () => {
    const ids: Record<string, number | null> = { "http://a": null, "http://b": null };
    await expect(create(ids)).rejects.toBeInstanceOf(RpcDown);
    const alerts = mkAlerts();
    const p = await create(ids, { fallbackChainId: 10_143, alerts });
    expect([p.chainId, p.verified, p.urls()]).toEqual([10_143, false, ["http://a", "http://b"]]);
    ids["http://a"] = 143;
    await p.tick(nowS());
    expect(p.verified).toBe(false);
    expect(alerts.open().some((a) => a.code === "RPC_FAILOVER" && a.severity === "action")).toBe(true);
    ids["http://b"] = 10_143;
    await p.tick(nowS());
    expect([p.verified, p.urls()]).toEqual([true, ["http://b"]]);
  });

  test("connect(): every URL down and no AGATE_CHAIN_ID, the process starts from the cached clocks and chain id", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-connect-"));
    const index = "0xaaaaaaaa00000000000000000000000000000001";
    const cache = join(home, "watcher", index, "clocks.json");
    const clocks = deriveClocks({ ...PROFILES.FAST, epochTs: 1_000 });
    const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    writeAtomic(join(home, "panels.json"), JSON.stringify([{ gpu: "H100", gpuId: `0x${"12".repeat(32)}`, slots: [{ slot: 0, sourceId: "p_lambda" }] }]));
    const keys = ["AGATE_WALL_HOME", "AGATE_INDEX", "AGATE_RPC_URLS", "AGATE_RPC_URL", "AGATE_PANELS", "AGATE_CHAIN_ID", "AGATE_WATCHER_LOG_DIR"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { AGATE_WALL_HOME: home, AGATE_INDEX: index, AGATE_RPC_URLS: "http://127.0.0.1:1,http://127.0.0.1:2", AGATE_PANELS: join(home, "panels.json") });
    for (const k of ["AGATE_RPC_URL", "AGATE_CHAIN_ID", "AGATE_WATCHER_LOG_DIR"] as const) delete process.env[k];
    try {
      writeAtomic(cache, JSON.stringify(clocks, big)); // a cache from before the chain id was kept
      await expect(connect("log", nowS)).rejects.toBeInstanceOf(RpcDown);
      writeAtomic(cache, JSON.stringify({ ...clocks, chainId: 10_143 }, big));
      const w = await connect("log", nowS);
      expect([w.pool.chainId, w.clock.slice, w.clock.epochTs]).toEqual([10_143, clocks.slice, 1_000]);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

test("viem client sanity (anvil reachable)", async () => {
  if (!available) return;
  const c = createPublicClient({ transport: http(anvilUrl) });
  expect(await c.getChainId()).toBe(31337);
});
