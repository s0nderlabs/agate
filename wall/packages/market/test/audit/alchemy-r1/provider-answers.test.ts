// Recheck r1 (Oct 4): the market bots' sender (maker, payer, lister) through the send route when the send endpoint
// answers instead of serving: an auth error, a billing or capacity error, a rate limit, a body that is not JSON. The
// read endpoint is the scriptable FakeRpc. The property: the claim still goes out through the read endpoint.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Address, encodeFunctionResult, toFunctionSelector } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { RpcPool, SendRoute } from "@agate/watcher";
import { agateSeriesAbi } from "../../../src/abi.ts";
import { LimitTable } from "../../../src/limits.ts";
import { MarketSender } from "../../../src/sender.ts";
import type { SendSpec } from "../../../src/types.ts";
import { FakeRpc } from "../../fake/rpc-server.ts";

const KEY_ENV = "AGATE_TEST_RECHECK_R1_MARKET_KEY";
process.env[KEY_ENV] = generatePrivateKey();
const SERIES: Address = "0x00000000000000000000000000000000000005e1";
const T = new LimitTable();
const claim: SendSpec = { to: SERIES, abi: agateSeriesAbi, functionName: "claimMany", args: [[1n, 2n]], shape: "series.claimMany", c: 1, n: 2 };

type Mode = { kind: "forward" } | { kind: "answer"; status: number; body: string } | { kind: "hang" };
const err = (code: number, message: string) => `{"jsonrpc":"2.0","id":$ID,"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
const ANSWERS: Record<string, { status: number; body: string }> = {
  "HTTP 401, a JSON-RPC error": { status: 401, body: err(-32600, "Must be authenticated!") },
  "HTTP 403, a JSON-RPC error": { status: 403, body: err(-32600, "Unspecified origin not on whitelist.") },
  "HTTP 402, a JSON-RPC error": { status: 402, body: err(-32000, "Your account has reached its spending limit.") },
  "HTTP 200, a JSON-RPC error": { status: 200, body: err(429, "Monthly capacity limit exceeded.") },
  "HTTP 429, a JSON-RPC error": { status: 429, body: err(429, "Your app has exceeded its compute units per second capacity.") },
  "HTTP 503, not JSON": { status: 503, body: "upstream unavailable" },
};

let pub: FakeRpc;
let mode: Mode = { kind: "forward" };
let server: ReturnType<typeof Bun.serve>;
let sendUrl = "";
const seen: string[] = [];
const hung: (() => void)[] = [];

beforeAll(() => {
  pub = new FakeRpc().start();
  pub.call = (p) => (p.data.startsWith(toFunctionSelector("claimMany(uint256[])")) ? { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "claimMany", result: 7n }) } : { result: "0x" });
  server = Bun.serve({
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
      if (mode.kind === "hang") return new Promise<Response>((done) => hung.push(() => done(new Response("", { status: 504 }))));
      if (mode.kind === "forward") {
        const r = await fetch(pub.url, { method: "POST", headers: { "content-type": "application/json" }, body: text });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }
      return new Response(mode.body.replace("$ID", JSON.stringify(id)), { status: mode.status, headers: { "content-type": "application/json" } });
    },
  });
  sendUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  for (const h of hung.splice(0)) h();
  pub.stop();
  server.stop(true);
});

describe("the market sender's route when the send endpoint answers instead of serving (recheck r1)", () => {
  for (const [name, a] of Object.entries(ANSWERS)) {
    test(`${name}: the claim goes out through the read endpoint`, async () => {
      mode = { kind: "forward" };
      const pool = await RpcPool.create({ urls: [pub.url, pub.url2], expectChainId: 10143, timeoutMs: 1_000, staleS: 10 ** 9, role: "payer", now: () => 0 });
      const route = await SendRoute.create(pool, { urls: [sendUrl], role: "payer", timeoutMs: 1_000 });
      const s = new MarketSender({ pool, send: route, role: "payer", keyEnv: KEY_ENV, limits: T, now: () => Math.floor(Date.now() / 1000), pollMs: 5 });
      mode = { kind: "answer", ...a };
      pub.raws = [];
      pub.seen.length = 0;
      seen.length = 0;
      const r = await s.send(claim);
      expect(r).toMatchObject({ ok: true, sent: true });
      expect(pub.raws.length).toBe(1);
      expect(seen).toContain("eth_sendRawTransaction");
    });
  }

  // fixer r1 (recheck r1 INFO, fixed): a send endpoint that never answers costs one timeout, then rests
  test("a send endpoint that never answers: one wait, then the claim goes out through the read endpoint at once", async () => {
    mode = { kind: "forward" };
    const pool = await RpcPool.create({ urls: [pub.url, pub.url2], expectChainId: 10143, timeoutMs: 1_000, staleS: 10 ** 9, role: "payer", now: () => 0 });
    const route = await SendRoute.create(pool, { urls: [sendUrl], role: "payer", timeoutMs: 1_000 });
    const s = new MarketSender({ pool, send: route, role: "payer", keyEnv: KEY_ENV, limits: T, now: () => Math.floor(Date.now() / 1000), pollMs: 5 });
    mode = { kind: "hang" };
    pub.raws = [];
    seen.length = 0;
    const t0 = Date.now();
    const r = await s.send(claim);
    const ms = Date.now() - t0;
    for (const h of hung.splice(0)) h();
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(pub.raws.length).toBe(1);
    expect(seen.length).toBe(1);
    expect(ms).toBeLessThan(2_000);
  }, 30_000);
});
