// RPC failover (13.4): the first URL erroring, hanging, on the wrong chain id, with a stale head; every URL down;
// a node's own JSON-RPC error passed through; the first URL taken back after its re-probe.
import { afterAll, describe, expect, test } from "bun:test";
import { isProviderLimit, RpcDownError, RpcError, RpcPool, redact, sendFinal } from "../src/pipeline/rpc.ts";
import type { AlertInput } from "../src/pipeline/rpc.ts";

type Mode = "ok" | "http500" | "hang" | "garbage" | "revert" | "answer";

interface FakeNode {
  url: string;
  mode: Mode;
  chainId: number;
  head: number;
  calls: string[];
  /** mode "answer": every call gets this HTTP status and JSON-RPC error */
  answer?: { status: number; error: { code: number; message: string; data?: string } };
  stop(): void;
}

const nodes: FakeNode[] = [];
afterAll(() => {
  for (const n of nodes) n.stop();
});

function node(chainId = 10_143, head = 1_000): FakeNode {
  const n: FakeNode = { url: "", mode: "ok", chainId, head, calls: [], stop: () => {} };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string };
      n.calls.push(body.method);
      if (n.mode === "http500") return new Response("boom", { status: 500 });
      if (n.mode === "garbage") return new Response("<html>gateway</html>", { status: 200 });
      if (n.mode === "hang") await Bun.sleep(5_000);
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (n.mode === "revert") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } });
      if (n.mode === "answer") return Response.json({ jsonrpc: "2.0", id: body.id, error: n.answer!.error }, { status: n.answer!.status });
      if (body.method === "eth_chainId") return reply(`0x${n.chainId.toString(16)}`);
      if (body.method === "eth_getBlockByNumber") return reply({ number: "0x1", timestamp: `0x${n.head.toString(16)}` });
      return reply("0x2a");
    },
  });
  n.url = `http://127.0.0.1:${server.port}/key/SECRET`;
  n.stop = () => server.stop(true);
  nodes.push(n);
  return n;
}

function pool(urls: string[], o: Partial<ConstructorParameters<typeof RpcPool>[0]> = {}) {
  const alerts: AlertInput[] = [];
  let ms = 0;
  const p = new RpcPool({ urls, timeoutMs: 300, staleS: 30, alert: (a) => void alerts.push(a), nowMs: () => ms, ...o });
  return { p, alerts, advance: (d: number) => void (ms += d) };
}

describe("RPC pool", () => {
  test("one URL configured: RPC_SINGLE at start", async () => {
    const a = node();
    const { p, alerts } = pool([a.url]);
    await p.init();
    expect(alerts.map((x) => x.code)).toEqual(["RPC_SINGLE"]);
    expect(await p.request("eth_blockNumber")).toBe("0x2a");
  });

  test("first URL erroring (HTTP 500), hanging, or answering garbage: the next one answers, RPC_FAILOVER", async () => {
    for (const mode of ["http500", "hang", "garbage"] as const) {
      const a = node();
      const b = node();
      const { p, alerts } = pool([a.url, b.url]);
      await p.init();
      a.mode = mode;
      expect(await p.request("eth_blockNumber")).toBe("0x2a");
      expect(p.url).toBe(b.url);
      const fo = alerts.filter((x) => x.code === "RPC_FAILOVER");
      expect(fo.length).toBe(1);
      expect(fo[0]!.severity).toBe("info");
      expect(JSON.stringify(fo[0])).not.toContain("SECRET"); // URLs carry keys: alerts show the origin only
    }
  });

  test("a URL on the wrong chain is dropped at start with an alert", async () => {
    const wrong = node(1);
    const right = node(10_143);
    const { p, alerts } = pool([wrong.url, right.url], { expectChainId: 10_143 });
    await p.init();
    expect(p.urls).toEqual([right.url]);
    expect(p.chainId).toBe(10_143);
    expect(alerts.some((a) => a.code === "RPC_FAILOVER" && a.severity === "action" && /chain 1,/.test(a.message))).toBe(true);
    await expect(pool([wrong.url], { expectChainId: 10_143 }).p.init()).rejects.toThrow(/no RPC URL on chain 10143/);
  });

  test("without AGATE_CHAIN_ID a strict majority decides the chain; a tie refuses to start", async () => {
    const x = node(10_143);
    const y = node(10_143);
    const z = node(1);
    const { p, alerts } = pool([z.url, x.url, y.url]);
    await p.init();
    expect(p.chainId).toBe(10_143);
    expect(p.urls).toEqual([x.url, y.url]);
    expect(alerts.some((a) => a.code === "RPC_FAILOVER" && a.severity === "action")).toBe(true);
    await expect(pool([z.url, x.url]).p.init()).rejects.toThrow(/disagree.*AGATE_CHAIN_ID/);
  });

  test("a stale head moves to a fresh URL; when every head is equally behind the local clock nothing moves", async () => {
    const a = node(10_143, 1_000);
    const b = node(10_143, 1_100);
    const { p, alerts } = pool([a.url, b.url]);
    await p.init();
    expect(await p.checkHead(1_100)).toBe(1_100); // a is 100 s behind (> 30): b is fresh
    expect(p.url).toBe(b.url);
    expect(alerts.at(-1)!.message).toMatch(/stale head/);
    b.head = 1_000;
    expect(await p.checkHead(2_000)).toBe(1_000); // both stale: the local clock is the suspect (CLOCK_SKEW's job)
    expect(p.url).toBe(b.url);
  });

  test("every URL down: RpcDownError with each cause; a node's JSON-RPC error is its answer, not a failover", async () => {
    const a = node();
    const b = node();
    const { p, alerts } = pool([a.url, b.url]);
    await p.init();
    a.mode = "http500";
    b.mode = "hang";
    const err = await p.request("eth_blockNumber").catch((e) => e);
    expect(err).toBeInstanceOf(RpcDownError);
    expect((err as RpcDownError).causes.length).toBe(2);
    a.mode = "revert";
    b.mode = "ok";
    const rev = await p.request("eth_call").catch((e) => e);
    expect(rev).toBeInstanceOf(RpcError);
    expect((rev as RpcError).data).toBe("0xdeadbeef");
    expect(p.url).toBe(a.url);
    expect(alerts.filter((x) => x.code === "RPC_FAILOVER").length).toBe(0);
  });

  test("the first URL is re-probed every five minutes and taken back once healthy", async () => {
    const a = node();
    const b = node();
    const { p, advance } = pool([a.url, b.url]);
    await p.init();
    a.mode = "http500";
    await p.request("eth_blockNumber");
    expect(p.url).toBe(b.url);
    a.mode = "ok";
    advance(299_000);
    await p.checkHead(1_000);
    expect(p.url).toBe(b.url);
    advance(1_000);
    await p.checkHead(1_000);
    expect(p.url).toBe(a.url);
  });

  test("a provider refusing to serve (HTTP 401, 402, 403, 404, 408 with a JSON-RPC error, or a limit in an HTTP 200) moves on (fixer r1)", async () => {
    const refusals = [
      { status: 401, error: { code: -32600, message: "Must be authenticated!" } },
      { status: 404, error: { code: -32601, message: "app not found" } },
      { status: 408, error: { code: -32000, message: "request timeout" } },
      { status: 402, error: { code: -32000, message: "Your account has reached its spending limit." } },
      { status: 403, error: { code: -32600, message: "Unspecified origin not on whitelist." } },
      { status: 200, error: { code: 429, message: "Monthly capacity limit exceeded." } },
      { status: 200, error: { code: -32005, message: "Your app has exceeded its compute units per second capacity." } },
      { status: 200, error: { code: -32000, message: "rate limit reached, try again later" } },
    ];
    for (const answer of refusals) {
      const a = node();
      const b = node();
      const { p } = pool([a.url, b.url]);
      await p.init();
      a.mode = "answer";
      a.answer = answer;
      expect({ answer, r: await p.request("eth_blockNumber") }).toEqual({ answer, r: "0x2a" });
      expect(p.url).toBe(b.url);
    }
  });

  test("a node's answer stays final: HTTP 400 or 413 with a JSON-RPC error, and a revert whose text names a capacity", async () => {
    for (const answer of [
      { status: 400, error: { code: -32602, message: "invalid argument 0: hex string without 0x prefix" } },
      { status: 413, error: { code: -32005, message: "response too large: ask for a smaller block range" } },
      { status: 200, error: { code: 3, message: "execution reverted: pool capacity reached", data: "0x08c379a0" } },
      { status: 200, error: { code: -32005, message: "block range too large (max 100)" } },
    ]) {
      const a = node();
      const b = node();
      const { p } = pool([a.url, b.url]);
      await p.init();
      a.mode = "answer";
      a.answer = answer;
      const e = await p.request("eth_call").catch((x) => x);
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).status).toBe(answer.status);
      expect(p.url).toBe(a.url);
      expect(b.calls.filter((m) => m === "eth_call")).toEqual([]);
    }
  });

  test("isProviderLimit and sendFinal: what a send endpoint's answer means", () => {
    expect(isProviderLimit({ code: 429, message: "Monthly capacity limit exceeded." })).toBe(true);
    expect(isProviderLimit({ code: -32000, message: "Too Many Requests" })).toBe(true);
    expect(isProviderLimit({ code: 3, message: "execution reverted: capacity", data: "0x" })).toBe(false);
    expect(isProviderLimit({ code: -32000, message: "pool at capacity", data: "0x08c379a0" })).toBe(false);
    expect(isProviderLimit({ code: 429, message: "Monthly capacity limit exceeded.", data: null })).toBe(true);
    expect(isProviderLimit({ code: -32000, message: "Your app has exceeded its compute units per second capacity.", data: { see: "https://docs" } })).toBe(true);
    expect(isProviderLimit({ code: -32005, message: "block range too large" })).toBe(false);
    // final: the node's word on this transaction, under HTTP 400
    for (const m of ["execution reverted", "nonce too low", "nonce too high", "already known", "replacement transaction underpriced", "insufficient funds for gas * price + value"]) expect({ m, final: sendFinal(new RpcError(m, -32000)) }).toEqual({ m, final: true });
    // passed on: the same words with HTTP 400 or above, and anything else
    expect(sendFinal(new RpcError("execution reverted", 3, undefined, 400))).toBe(false);
    expect(sendFinal(new RpcError("nonce too low", -32000, undefined, 403))).toBe(false);
    for (const m of ["Unspecified origin not on whitelist.", "Must be authenticated!", "gas required exceeds allowance (30000000)", "method not found"]) expect({ m, final: sendFinal(new RpcError(m, -32000)) }).toEqual({ m, final: false });
    expect(sendFinal(new Error("execution reverted"))).toBe(false);
  });

  test("a URL dead at start is kept (not wrong, just down) and the live one is used", async () => {
    const a = node();
    const b = node();
    a.mode = "http500";
    const { p } = pool([a.url, b.url]);
    await p.init();
    expect(p.urls.length).toBe(2);
    expect(p.url).toBe(b.url);
    expect(redact("https://rpc.example.com/v2/abcdef?key=1")).toBe("https://rpc.example.com/...");
  });
});
