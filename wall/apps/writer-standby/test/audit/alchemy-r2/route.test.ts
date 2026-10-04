// Recheck r2 (Oct 4): the writers' send route after fixer round 1, on a fake network (no chain, no socket). Which answers
// of a send endpoint are final (sendFinal), what the meter counts, what happens once the day's budget is spent, and
// that no event or error carries the send URL's key. The send endpoint's URL carries a made-up 32-character key.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcMeter } from "@agate/report/meter";
import { RpcDownError, RpcError, RpcPool, SendRoute, sendFinal } from "../../../src/pipeline/rpc.ts";

const FAKE = "FAKEr2keyFAKEr2keyFAKEr2keyFAKE0"; // made up, Alchemy-shaped (32 characters)
const S = `http://127.0.0.1:1/v2/${FAKE}`;
const R1 = "http://127.0.0.1:2/";
const R2 = "http://127.0.0.1:3/";
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

type Answer = { status: number; result: unknown } | { status: number; error: { code: number; message: string; data?: string } } | { status: number; text: string } | "hang" | "refuse";

/** A fake network: each URL answers each method as told; every request is recorded. */
function net(answer: (url: string, method: string) => Answer) {
  const seen: { url: string; method: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const j = JSON.parse(String(init!.body)) as { id: number; method: string };
    seen.push({ url, method: j.method });
    const a = answer(url, j.method);
    if (a === "refuse") throw new TypeError("Unable to connect. Is the computer able to access the url?");
    if (a === "hang") {
      return new Promise<Response>((_, reject) => {
        const s = init!.signal!;
        s.addEventListener("abort", () => reject(s.reason));
      });
    }
    const headers = { "content-type": "application/json" };
    if ("text" in a) return new Response(a.text, { status: a.status, headers });
    const body = "error" in a ? { jsonrpc: "2.0", id: j.id, error: a.error } : { jsonrpc: "2.0", id: j.id, result: a.result };
    return new Response(JSON.stringify(body), { status: a.status, headers });
  }) as typeof fetch;
  return { f, seen, at: (u: string) => seen.filter((x) => x.url === u).map((x) => x.method) };
}

const ok = (result: unknown): Answer => ({ status: 200, result });
const chain = (method: string): Answer => (method === "eth_chainId" ? ok("0x279f") : ok("0x1"));

async function rig(sendAnswer: (method: string) => Answer, o: { meter?: RpcMeter; restMs?: number; timeoutMs?: number; readAnswer?: (method: string) => Answer } = {}) {
  // the start check finds the send endpoint on the right chain; every later call gets sendAnswer
  let started = false;
  const n = net((url, method) => (url === S ? (!started && method === "eth_chainId" ? ok("0x279f") : sendAnswer(method)) : (o.readAnswer ?? chain)(method)));
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const pool = new RpcPool({ urls: [R1, R2], expectChainId: 10143, timeoutMs: o.timeoutMs ?? 300, staleS: 1e9, fetchImpl: n.f });
  await pool.init();
  const route = new SendRoute(pool, { urls: [S], say: (event, data) => void events.push({ event, ...(data ? { data } : {}) }), ...(o.meter ? { meter: o.meter } : {}), ...(o.restMs !== undefined ? { restMs: o.restMs } : {}) });
  await route.verify();
  started = true;
  n.seen.length = 0;
  return { n, pool, route, events };
}

describe("which answers of a send endpoint are final (sendFinal, recheck r2)", () => {
  const cases: [string, RpcError | Error, boolean][] = [
    ["HTTP 200 execution reverted", new RpcError("execution reverted: Agate: late", 3, "0x08c379a0", 200), true],
    ["HTTP 200 nonce too low", new RpcError("nonce too low: next nonce 5, tx nonce 4", -32000, undefined, 200), true],
    ["HTTP 200 already known", new RpcError("already known", -32000, undefined, 200), true],
    ["HTTP 200 replacement transaction underpriced", new RpcError("replacement transaction underpriced", -32000, undefined, 200), true],
    ["HTTP 200 insufficient funds", new RpcError("insufficient funds for gas * price + value", -32000, undefined, 200), true],
    ["HTTP 400 execution reverted", new RpcError("execution reverted", 3, "0x", 400), false],
    ["HTTP 401 nonce too low (a provider's page quoting the words)", new RpcError("nonce too low", -32000, undefined, 401), false],
    ["HTTP 200 Must be authenticated!", new RpcError("Must be authenticated!", -32600, undefined, 200), false],
    ["HTTP 200 header not found (a lagging node)", new RpcError("header not found", -32000, undefined, 200), false],
    ["HTTP 200 invalid block tag", new RpcError("invalid argument 1: invalid block tag pending", -32602, undefined, 200), false],
    ["HTTP 200 method not found", new RpcError("the method eth_sendRawTransaction does not exist/is not available", -32601, undefined, 200), false],
    ["a plain Error", new Error("execution reverted"), false],
  ];
  for (const [name, e, final] of cases) test(`${name}: ${final ? "final" : "passed on"}`, () => expect(sendFinal(e)).toBe(final));
});

describe("the writers' send route on a fake network (recheck r2)", () => {
  test("a revert of the estimate at the send endpoint is final: the read endpoints are never asked, and the error names no URL", async () => {
    const { n, route } = await rig((m) => (m === "eth_estimateGas" ? { status: 200, error: { code: 3, message: "execution reverted: Agate: late", data: "0x08c379a0" } } : ok("0x1")));
    const e = await route.request("eth_estimateGas", [{ to: "0x00000000000000000000000000000000000000e6", data: "0x" }, "pending"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(n.at(S)).toEqual(["eth_estimateGas"]);
    expect(n.at(R1)).toEqual([]);
    expect(n.at(R2)).toEqual([]);
    expect(String((e as Error).message)).not.toContain(FAKE);
  });

  for (const [name, a] of [
    ["HTTP 401", { status: 401, error: { code: -32600, message: "Must be authenticated!" } }],
    ["HTTP 200 allowlist", { status: 200, error: { code: -32600, message: "Unspecified origin not on whitelist." } }],
    ["HTTP 200 capacity", { status: 200, error: { code: 429, message: "Monthly capacity limit exceeded." } }],
    ["refused", "refuse"],
    ["HTTP 502 not JSON", { status: 502, text: "bad gateway" }],
  ] as [string, Answer][]) {
    test(`${name}: each tx method is asked of the send endpoint once, then of the pool; the down event names no key`, async () => {
      const { n, route, events } = await rig(() => a);
      for (const m of ["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getTransactionByHash"]) {
        await route.request(m, []);
      }
      expect(n.at(S)).toEqual(["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
      expect(n.at(R1).length + n.at(R2).length).toBe(5);
      expect(events.map((x) => x.event)).toEqual(["send_endpoint_down"]);
      expect(JSON.stringify(events)).not.toContain(FAKE);
      expect(JSON.stringify(events)).not.toContain("/v2/");
    });
  }

  test("the meter counts every call to the send endpoint (failed ones included) and none to the pool", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-recheck-r2-wmeter-"));
    homes.push(home);
    const meter = new RpcMeter({ home, role: "standby", scope: "r2r2r2r2", dailyCu: 1_000_000 });
    let i = 0;
    const { n, route } = await rig(() => (i++ % 2 === 0 ? { status: 401, error: { code: -32600, message: "Must be authenticated!" } } : ok("0x1")), { meter });
    for (const m of ["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_getTransactionReceipt", "eth_getTransactionReceipt"]) await route.request(m, []);
    const want: Record<string, number> = { eth_chainId: 1 };
    for (const m of n.at(S)) want[m] = (want[m] ?? 0) + 1;
    expect(meter.snapshot().methods).toEqual(want);
    // 1 nonce 20 + 1 estimate 20 + 1 send 40 + 3 receipts 60 (+ the start check at 0)
    expect(meter.ownCu()).toBe(140);
  });

  test("a hanging send endpoint costs one timeout, then rests: the next calls and a rebroadcast skip it", async () => {
    const { n, route, events } = await rig(() => "hang", { timeoutMs: 300, restMs: 60_000 });
    const t0 = Date.now();
    await route.request("eth_estimateGas", []);
    const first = Date.now() - t0;
    const t1 = Date.now();
    await route.request("eth_sendRawTransaction", ["0x02"]);
    const answers = await route.broadcastAll("0x02");
    const rest = Date.now() - t1;
    expect(first).toBeGreaterThanOrEqual(250);
    expect(rest).toBeLessThan(250);
    expect(n.at(S)).toEqual(["eth_estimateGas"]);
    expect(answers.length).toBe(2); // the two read endpoints only
    expect(events.map((x) => x.event)).toEqual(["send_endpoint_down"]);
  });

  test("once the day's budget is spent the send endpoint gets no transaction call; a restart's start check still asks its chain id (0 CU)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agate-recheck-r2-wstop-"));
    homes.push(home);
    const meter = new RpcMeter({ home, role: "primary", scope: "r2r2r2r2", dailyCu: 100 });
    const { n, route } = await rig(chain, { meter });
    await route.request("eth_sendRawTransaction", ["0x02"]); // 40
    await route.request("eth_sendRawTransaction", ["0x02"]); // 80
    await route.request("eth_sendRawTransaction", ["0x02"]); // 120: over 100
    meter.tick(true);
    expect(meter.budgetStopped).toBe(true);
    n.seen.length = 0;
    for (const m of ["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt"]) await route.request(m, []);
    await route.broadcastAll("0x02");
    expect(n.at(S)).toEqual([]);
    expect(n.at(R1).length + n.at(R2).length).toBe(6);
    // a process started after the stop (same day, same files): its verify() asks the send endpoint eth_chainId once
    const meter2 = new RpcMeter({ home, role: "standby", scope: "r2r2r2r2", dailyCu: 100 });
    const pool2 = new RpcPool({ urls: [R1, R2], expectChainId: 10143, timeoutMs: 300, staleS: 1e9, fetchImpl: n.f });
    await pool2.init();
    n.seen.length = 0;
    const route2 = new SendRoute(pool2, { urls: [S], meter: meter2 });
    await route2.verify();
    expect(n.at(S)).toEqual(["eth_chainId"]);
    expect(meter2.budgetStopped).toBe(true);
    await route2.request("eth_sendRawTransaction", ["0x02"]);
    expect(n.at(S)).toEqual(["eth_chainId"]);
  });

  // OPEN (recheck r2, INFO): Monad's official RPC limits each IP to 15 requests a second ("requests limited to
  // 15/sec", build.md of the live check). Its HTTP status was not recorded. With HTTP 429 the writers' pool moves on;
  // with HTTP 200 the words are not among the limit words, so the pool takes them as the node's answer and does not
  // ask the next public RPC for that call (the next tick asks again). Not a change of round 1: the same held before.
  test("the official RPC's per-IP limit text: with HTTP 429 the pool moves on; with HTTP 200 it is taken as the node's answer", async () => {
    for (const [status, movesOn] of [
      [429, true],
      [200, false],
    ] as const) {
      const n = net((url, method) => (method === "eth_chainId" ? ok("0x279f") : url === R1 ? { status, error: { code: -32007, message: "requests limited to 15/sec" } } : ok("0x2")));
      const pool = new RpcPool({ urls: [R1, R2], expectChainId: 10143, timeoutMs: 300, staleS: 1e9, fetchImpl: n.f });
      await pool.init();
      n.seen.length = 0;
      const r = await pool.request("eth_call", []).catch((e: unknown) => e);
      expect({ status, answered: r === "0x2", r2: n.at(R2).length }).toEqual({ status, answered: movesOn, r2: movesOn ? 1 : 0 });
    }
  });

  test("reads stay on the pool even with every read endpoint down: the send endpoint is never asked", async () => {
    const { n, pool } = await rig(() => ok("0x1"), { readAnswer: (m) => (m === "eth_chainId" ? ok("0x279f") : "refuse") });
    for (const m of ["eth_call", "eth_getLogs", "eth_getBlockByNumber", "eth_getBalance", "eth_feeHistory"]) {
      expect(await pool.request(m, []).catch((e: unknown) => e)).toBeInstanceOf(RpcDownError);
    }
    expect(n.at(S)).toEqual([]);
  });
});
