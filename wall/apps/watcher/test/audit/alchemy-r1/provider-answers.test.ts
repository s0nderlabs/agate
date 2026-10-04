// Recheck r1 (Oct 4): the watcher's send route (the attester, the keeper, the guardian CLI; the market bots share it)
// against the answers a provider gives when it will not serve, on a local anvil. A stand-in for the send endpoint
// answers every call the same way; the read pool is two plain proxies of the same anvil. The property: the sender's
// own transaction still goes out through the read endpoints. Also: the meter counts each call the stand-in saw, and a
// send URL that carries a key never reaches a log line, an alert or the meter's file. Keys: Anvil's default account 7,
// on a local chain only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address } from "viem";
import { installScrubber } from "@agate/report/env";
import { RpcMeter } from "@agate/report/meter";
import { AlertSink } from "../../../src/alerts.ts";
import { RpcPool } from "../../../src/chain/rpc.ts";
import { SendRoute } from "../../../src/chain/send-route.ts";
import { TxSender } from "../../../src/chain/sender.ts";
import { meterFor } from "../../../src/config.ts";
import { setFileScrubber } from "../../../src/fsutil.ts";
import { spawnAnvil } from "../../../../../scripts/anvil.ts";
import { type CountingProxy, startCountingProxy } from "../../../../../scripts/counting-proxy.ts";

const KEY_ENV = "AGATE_TEST_RECHECK_R1_KEY";
process.env[KEY_ENV] = "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"; // anvil #7, local only
const PING: Abi = [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }];
const EOA: Address = "0x00000000000000000000000000000000000000e7";
const nowS = () => Math.floor(Date.now() / 1000);
/** an Alchemy-shaped key (32 characters, made up) in the stand-in's path */
const FAKE_KEY = "Zx9fQm2LkT7vWp4RbN8cYd3HsJ6gAe1U";

type Mode = { kind: "forward" } | { kind: "answer"; status: number; body: string } | { kind: "hang" };

function provider(upstream: string) {
  const seen: string[] = [];
  const hung: (() => void)[] = [];
  const p = {
    mode: { kind: "forward" } as Mode,
    seen,
    url: "",
    release: () => {
      for (const h of hung.splice(0)) h();
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const text = await req.text();
      let id: unknown = 1;
      try {
        const j = JSON.parse(text) as { id?: unknown; method?: unknown };
        id = j.id;
        seen.push(String(j.method));
      } catch {
        seen.push("?");
      }
      const m = p.mode;
      if (m.kind === "forward") {
        const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }
      if (m.kind === "hang") return new Promise<Response>((done) => hung.push(() => done(new Response("", { status: 504 }))));
      return new Response(m.body.replace("$ID", JSON.stringify(id)), { status: m.status, headers: { "content-type": "application/json" } });
    },
  });
  p.url = `http://127.0.0.1:${server.port}/v2/${FAKE_KEY}`;
  return p;
}

const err = (code: number, message: string) => `{"jsonrpc":"2.0","id":$ID,"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
const ANSWERS: Record<string, { status: number; body: string }> = {
  "HTTP 401, a JSON-RPC error": { status: 401, body: err(-32600, "Must be authenticated!") },
  "HTTP 403, a JSON-RPC error": { status: 403, body: err(-32600, "Unspecified origin not on whitelist.") },
  "HTTP 402, a JSON-RPC error": { status: 402, body: err(-32000, "Your account has reached its spending limit.") },
  "HTTP 200, a JSON-RPC error": { status: 200, body: err(429, "Monthly capacity limit exceeded.") },
  "HTTP 429, a JSON-RPC error": { status: 429, body: err(429, "Your app has exceeded its compute units per second capacity.") },
  "HTTP 503, not JSON": { status: 503, body: "upstream unavailable" },
};

let anvil: Bun.Subprocess | null = null;
let available = true;
let P: ReturnType<typeof provider>;
let A: CountingProxy;
let B: CountingProxy;
let home = "";

beforeAll(async () => {
  try {
    const a = await spawnAnvil(["--silent", "--chain-id", "31337"]);
    anvil = a.proc;
    P = provider(a.rpc);
    A = startCountingProxy({ upstream: a.rpc });
    B = startCountingProxy({ upstream: a.rpc });
  } catch {
    available = false;
  }
  home = mkdtempSync(join(tmpdir(), "agate-recheck-r1-watcher-"));
}, 120_000);

afterAll(() => {
  P?.release();
  for (const p of [P, A, B]) p?.stop();
  anvil?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function rig(o: { timeoutMs?: number; restMs?: number; meter?: RpcMeter; alerts?: AlertSink; log?: (e: string, d: Record<string, unknown>) => void } = {}) {
  const t = o.timeoutMs ?? 2_000;
  const pool = await RpcPool.create({ urls: [A.url, B.url], timeoutMs: t, staleS: 600, role: "test", now: nowS });
  P.mode = { kind: "forward" };
  const route = await SendRoute.create(pool, { urls: [P.url], role: "test", timeoutMs: t, ...(o.restMs !== undefined ? { restMs: o.restMs } : {}), ...(o.meter ? { meter: o.meter } : {}), ...(o.alerts ? { alerts: o.alerts } : {}), ...(o.log ? { log: o.log } : {}) });
  const sender = new TxSender({ pool, send: route, to: EOA, keyEnv: KEY_ENV, role: "test", abi: PING, now: nowS, pollMs: 20, ...(o.alerts ? { alerts: o.alerts } : {}) });
  return { pool, route, sender };
}

describe("the watcher's send route when the send endpoint answers instead of serving (recheck r1)", () => {
  for (const [name, a] of Object.entries(ANSWERS)) {
    test(`${name}: the send goes out through the read endpoints`, async () => {
      if (!available) return;
      const { sender } = await rig();
      P.mode = { kind: "answer", ...a };
      A.reset();
      B.reset();
      const r = await sender.send("ping", []);
      expect(r).toMatchObject({ ok: true, sent: true });
      expect([...A.methods(), ...B.methods()]).toContain("eth_sendRawTransaction");
    });
  }

  // INFO (recheck r1), fixed: each call of a send waited the route's full timeout on a send endpoint that never
  // answered (4 or more waits a send). Now the first wait rests it (SEND_REST_MS) and the read endpoints take the rest.
  test("a send endpoint that never answers: the first call waits the route's timeout, then it rests and the read endpoints take the rest at once", async () => {
    if (!available) return;
    const { sender } = await rig({ timeoutMs: 1_000 });
    P.mode = { kind: "hang" };
    P.seen.length = 0;
    const t0 = Date.now();
    const r = await sender.send("ping", []);
    const ms = Date.now() - t0;
    P.release();
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toEqual(["eth_estimateGas"]);
    expect(ms).toBeGreaterThanOrEqual(1_000 - 200);
    expect(ms).toBeLessThan(2 * 1_000);
    console.log(JSON.stringify({ recheck: "watcher hang", calls: P.seen, ms }));
  }, 60_000);

  test("a rested send endpoint is asked again once its rest is over (and a refused one is never rested)", async () => {
    if (!available) return;
    const events: string[] = [];
    const { sender } = await rig({ timeoutMs: 500, restMs: 1_500, log: (e) => void events.push(e) });
    P.mode = { kind: "hang" };
    P.seen.length = 0;
    expect(await sender.send("ping", [])).toMatchObject({ ok: true, sent: true });
    P.release();
    expect(await sender.send("ping", [])).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toEqual(["eth_estimateGas"]);
    await Bun.sleep(1_600);
    P.mode = { kind: "forward" };
    A.reset();
    B.reset();
    expect(await sender.send("ping", [])).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toContain("eth_sendRawTransaction");
    expect([...A.methods(), ...B.methods()]).not.toContain("eth_sendRawTransaction");
    expect(events).toEqual(["send_endpoint_down", "send_endpoint_up"]);
    // an answer that is not a timeout (here a 401) is passed on but asked again on the next call
    P.mode = { kind: "answer", ...ANSWERS["HTTP 401, a JSON-RPC error"]! };
    P.seen.length = 0;
    expect(await sender.send("ping", [])).toMatchObject({ ok: true, sent: true });
    expect(P.seen.length).toBeGreaterThan(1);
  }, 60_000);
});

describe("the meter and the secret on the watcher's send route (recheck r1)", () => {
  test("the meter counts every call the send endpoint saw, failed ones included, and nothing else", async () => {
    if (!available) return;
    const meter = new RpcMeter({ home, role: "attest", scope: "r1r1r1r1", dailyCu: 1_000_000 });
    P.seen.length = 0;
    const { sender } = await rig({ meter });
    expect(await sender.send("ping", [])).toMatchObject({ ok: true });
    P.mode = { kind: "answer", ...ANSWERS["HTTP 429, a JSON-RPC error"]! };
    expect(await sender.send("ping", [])).toMatchObject({ ok: true });
    const byMethod: Record<string, number> = {};
    for (const m of P.seen) byMethod[m] = (byMethod[m] ?? 0) + 1;
    // the start check (eth_chainId) is counted too, at 0 CU
    expect(meter.snapshot().methods).toEqual(byMethod);
    for (const m of Object.keys(byMethod)) expect(["eth_chainId", "eth_estimateGas", "eth_getTransactionCount", "eth_sendRawTransaction", "eth_getTransactionReceipt"]).toContain(m);
  });

  test("a send URL with a key: no log line, alert or meter file carries the key or the URL's path", async () => {
    if (!available) return;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const files = mkdtempSync(join(tmpdir(), "agate-recheck-r1-secret-"));
    try {
      const e = { http: [A.url, B.url], ws: [], send: [P.url] };
      installScrubber(e);
      setFileScrubber((t) => t.split(P.url).join("<send>").split(FAKE_KEY).join("<redacted>"));
      const alerts = new AlertSink(join(files, "alerts.jsonl"), { now: nowS, role: "test", index: EOA });
      const meter = meterFor({ home: files, role: "attest", scope: "r1r1r1r1", endpoints: e, alerts, env: { AGATE_ALCHEMY_DAILY_CU: "50" } })!;
      const { sender } = await rig({ meter, alerts, log: (event, data) => console.log(JSON.stringify({ event, ...data })) });
      for (const a of Object.values(ANSWERS)) {
        P.mode = { kind: "answer", ...a };
        await sender.send("ping", []);
      }
      meter.tick(true);
      const written = [readFileSync(join(files, "alerts.jsonl"), "utf8")];
      for (const d of readdirSync(join(files, "rpc-meter"))) for (const f of readdirSync(join(files, "rpc-meter", d))) written.push(readFileSync(join(files, "rpc-meter", d, f), "utf8"));
      const all = [...lines, ...written, ...sender.log].join("\n");
      expect(all.length).toBeGreaterThan(0);
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain("/v2/");
      // the budget of 50 CU was spent: the alert says so, without the URL
      expect(written[0]).toContain("ALCHEMY_BUDGET");
    } finally {
      console.log = orig;
      rmSync(files, { recursive: true, force: true });
    }
  });
});
