// Recheck r1 (Oct 4): the writer's send route against the answers a provider gives when it will not serve, on a local
// anvil. A stand-in for the send endpoint answers every call the same way (an auth error, a billing or capacity error,
// a rate limit, a body that is not JSON, or no answer at all); the read pool is two plain proxies of the same anvil.
// The property: the writer's own transaction still goes out through the read endpoints, as it does when the send
// endpoint is down. Keys: Anvil's default account 6, on a local chain only.
// Fixer r1 (Oct 4): the four answers the writer took as final now pass on (rpc.ts sendFinal), so the test.failing
// cases are plain tests and the "today the writer sends nothing" cases assert the fixed path; the node's own answer
// (a revert) stays final; a send endpoint that does not answer in time rests (SEND_REST_MS) instead of costing a full
// timeout on every call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { privateKeyToAccount } from "viem/accounts";
import { ReadingLog } from "../../../src/pipeline/log.ts";
import { RpcPool, SendRoute } from "../../../src/pipeline/rpc.ts";
import { type SenderTiming, TxSender } from "../../../src/pipeline/sender.ts";
import { spawnAnvil } from "../../../../../scripts/anvil.ts";
import { type CountingProxy, startCountingProxy } from "../../../../../scripts/counting-proxy.ts";

const KEY: Hex = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"; // anvil #6, local only
const TO: Address = "0x00000000000000000000000000000000000000E6";
const FAST: SenderTiming = { pollMs: 20, rebroadcastMs: 300, replaceMs: 60_000, waitMs: 3_000, lockWaitMs: 300 };
const meta = { action: "post" as const, tags: ["t"] };

/** How the stand-in answers every call. */
type Mode = { kind: "forward" } | { kind: "answer"; status: number; body: string } | { kind: "hang" };

/** A send endpoint stand-in in front of `upstream`: forwards, answers every call with one status and body, or never
 *  answers. Records each method it saw. */
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
  p.url = `http://127.0.0.1:${server.port}`;
  return p;
}

const err = (code: number, message: string) => `{"jsonrpc":"2.0","id":$ID,"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
/** Answers a provider gives instead of serving: what the writer's route does with each is the question. */
const ANSWERS: Record<string, { status: number; body: string }> = {
  "HTTP 401, a JSON-RPC error (a key that is revoked or mistyped)": { status: 401, body: err(-32600, "Must be authenticated!") },
  "HTTP 403, a JSON-RPC error (an app's allowlist, a suspended app)": { status: 403, body: err(-32600, "Unspecified origin not on whitelist.") },
  "HTTP 402, a JSON-RPC error (a billing limit)": { status: 402, body: err(-32000, "Your account has reached its spending limit.") },
  "HTTP 200, a JSON-RPC error (a capacity limit in the body)": { status: 200, body: err(429, "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.") },
  "HTTP 429, a JSON-RPC error (the per-second limit)": { status: 429, body: err(429, "Your app has exceeded its compute units per second capacity.") },
  "HTTP 503, a body that is not JSON": { status: 503, body: "upstream unavailable" },
};
/** The answers the route passed on before the fix (transport failures): a 5xx, a 429, a body that is not JSON. */
const TRANSPORT = new Set(["HTTP 429, a JSON-RPC error (the per-second limit)", "HTTP 503, a body that is not JSON"]);

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
  home = mkdtempSync(join(tmpdir(), "agate-recheck-r1-writer-"));
}, 120_000);

afterAll(() => {
  P?.release();
  for (const p of [P, A, B]) p?.stop();
  anvil?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function rig(timeoutMs = 2_000, restMs?: number) {
  const events: string[] = [];
  const pool = new RpcPool({ urls: [A.url, B.url], timeoutMs, staleS: 10_000_000 });
  await pool.init();
  P.mode = { kind: "forward" };
  const route = new SendRoute(pool, { urls: [P.url], say: (e) => void events.push(e), ...(restMs !== undefined ? { restMs } : {}) });
  await route.verify();
  const sender = new TxSender({ pool, send: route, account: privateKeyToAccount(KEY), index: TO, journal: new ReadingLog(home, "standby"), timing: FAST });
  return { pool, route, sender, events };
}

async function sendWith(name: string, answer: { status: number; body: string } = ANSWERS[name]!) {
  const { sender } = await rig();
  P.mode = { kind: "answer", ...answer };
  P.seen.length = 0;
  A.reset();
  B.reset();
  const r = await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta });
  const pub = [...A.methods(), ...B.methods()];
  return { r, pub, standIn: [...P.seen] };
}

describe("the writer's send route when the send endpoint answers instead of serving (recheck r1)", () => {
  for (const name of Object.keys(ANSWERS)) {
    if (TRANSPORT.has(name)) {
      test(`${name}: the send goes out through the read endpoints`, async () => {
        if (!available) return;
        const { r, pub } = await sendWith(name);
        expect(r).toMatchObject({ ok: true, sent: true });
        expect(pub).toContain("eth_sendRawTransaction");
      });
    } else {
      // FINDING (recheck r1), fixed: the writer's SendRoute passed on a transport failure only (rpc.ts pool.call: HTTP
      // 5xx, 429, no JSON body). An HTTP 401, 402 or 403 with a JSON-RPC error body, or an HTTP 200 carrying one, was
      // taken as the node's final answer: the estimate failed and nothing was sent, every tick. The watcher's and the
      // market's routes passed the same answers on (apps/watcher/test/audit/alchemy-r1). Now the writer's do too.
      test(`${name}: the send goes out through the read endpoints`, async () => {
        if (!available) throw new Error("no anvil");
        const { r, pub } = await sendWith(name);
        expect(r).toMatchObject({ ok: true, sent: true });
        expect(pub).toContain("eth_sendRawTransaction");
      });
      test(`${name}: the stand-in is asked first, then the read endpoints answer the estimate (it was final before)`, async () => {
        if (!available) return;
        const { r, pub, standIn } = await sendWith(name);
        expect(r).toMatchObject({ ok: true, sent: true });
        expect(standIn[0]).toBe("eth_estimateGas");
        expect(pub).toContain("eth_estimateGas");
        expect(pub).toContain("eth_sendRawTransaction");
      });
    }
  }

  test("HTTP 400 with a JSON-RPC error, even one about a revert: passed on, and the read endpoints' answer stands", async () => {
    if (!available) return;
    const { r, pub, standIn } = await sendWith("", { status: 400, body: err(3, "execution reverted") });
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(standIn[0]).toBe("eth_estimateGas");
    expect(pub).toContain("eth_estimateGas");
  });

  test("HTTP 200 with an error that names nothing about the transaction (an allowlist): passed on", async () => {
    if (!available) return;
    const { r, pub } = await sendWith("", { status: 200, body: err(-32600, "Unspecified origin not on whitelist.") });
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(pub).toContain("eth_sendRawTransaction");
  });

  test("the node's own answer (HTTP 200, a revert of the estimate) stays final: not asked again elsewhere", async () => {
    if (!available) return;
    const { r, pub, standIn } = await sendWith("", { status: 200, body: err(3, "execution reverted: not today") });
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(String(r.error)).toStartWith("estimate:");
    expect(String(r.error)).toContain("execution reverted");
    expect(standIn).toEqual(["eth_estimateGas"]);
    expect(pub).not.toContain("eth_estimateGas");
    expect(pub).not.toContain("eth_sendRawTransaction");
  });

  // INFO (recheck r1), fixed: each call of a send waited the full timeout on a send endpoint that never answered
  // (estimate, pending nonce, broadcast, receipts: 4 or more waits, about 40 s a send at 10 s). Now the first wait
  // rests the endpoint and the rest of the send goes to the read endpoints at once.
  test("a send endpoint that never answers: the first call waits the timeout, then it rests and the read endpoints take the rest at once", async () => {
    if (!available) return;
    const { sender, events } = await rig(1_000);
    P.mode = { kind: "hang" };
    P.seen.length = 0;
    const t0 = Date.now();
    const r = await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta });
    const ms = Date.now() - t0;
    P.release();
    expect(r).toMatchObject({ ok: true, sent: true });
    expect(events).toContain("send_endpoint_down");
    expect(P.seen).toEqual(["eth_estimateGas"]);
    expect(ms).toBeGreaterThanOrEqual(1_000 - 200);
    expect(ms).toBeLessThan(2 * 1_000);
    console.log(JSON.stringify({ recheck: "writer hang", calls: P.seen, ms }));
  }, 60_000);

  test("a rested send endpoint is asked again once its rest is over, and is up again when it answers", async () => {
    if (!available) return;
    const { sender, events } = await rig(500, 1_500);
    P.mode = { kind: "hang" };
    P.seen.length = 0;
    expect(await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).toMatchObject({ ok: true, sent: true });
    P.release();
    expect(P.seen).toEqual(["eth_estimateGas"]);
    // within the rest: not asked at all
    expect(await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toEqual(["eth_estimateGas"]);
    await Bun.sleep(1_600);
    P.mode = { kind: "forward" };
    A.reset();
    B.reset();
    expect(await sender.send({ to: TO, data: "0x1234", shape: "postReport", meta })).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toContain("eth_sendRawTransaction");
    expect([...A.methods(), ...B.methods()]).not.toContain("eth_sendRawTransaction");
    expect(events).toEqual(["send_endpoint_down", "send_endpoint_up"]);
  }, 60_000);
});
