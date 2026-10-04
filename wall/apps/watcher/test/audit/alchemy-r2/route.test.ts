// Recheck r2 (Oct 4): the watcher's send route (attester, keeper, guardian CLI; the market bots share it) on a local
// anvil, for what recheck r1 did not try: the node's own final answer coming from a send endpoint whose URL carries a
// key (the revert must not be asked again of the read endpoints, and no sink may show the key), and a process that
// starts after the day's budget is spent (only its start check may reach the send endpoint, at 0 CU). Keys: Anvil's
// default account 5, on a local chain only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address } from "viem";
import { scrubSecrets } from "@agate/report/env";
import { RpcMeter } from "@agate/report/meter";
import { AlertCode } from "@agate/report/types";
import { AlertSink } from "../../../src/alerts.ts";
import { RpcPool } from "../../../src/chain/rpc.ts";
import { SendRoute } from "../../../src/chain/send-route.ts";
import { TxSender } from "../../../src/chain/sender.ts";
import { setFileScrubber } from "../../../src/fsutil.ts";
import { spawnAnvil } from "../../../../../scripts/anvil.ts";
import { type CountingProxy, startCountingProxy } from "../../../../../scripts/counting-proxy.ts";

const KEY_ENV = "AGATE_TEST_RECHECK_R2_KEY";
process.env[KEY_ENV] = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"; // anvil #5, local only
const PING: Abi = [{ type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" }];
const EOA: Address = "0x00000000000000000000000000000000000000e5";
const nowS = () => Math.floor(Date.now() / 1000);
const FAKE_KEY = "FAKEr2watcherKEYFAKEr2watcher012"; // made up, Alchemy-shaped (32 characters)
// Error(string) "R2 late": what a node returns as revert data
const REVERT_DATA = "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000075232206c61746500000000000000000000000000000000000000000000000000";

function standIn(upstream: string) {
  const seen: string[] = [];
  const p = {
    revertEstimate: false,
    seen,
    url: "",
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const text = await req.text();
      const j = JSON.parse(text) as { id?: unknown; method?: string };
      seen.push(String(j.method));
      if (p.revertEstimate && j.method === "eth_estimateGas") {
        return Response.json({ jsonrpc: "2.0", id: j.id, error: { code: 3, message: "execution reverted: R2 late", data: REVERT_DATA } });
      }
      const r = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
    },
  });
  p.url = `http://127.0.0.1:${server.port}/v2/${FAKE_KEY}`;
  return p;
}

let anvil: Bun.Subprocess | null = null;
let available = true;
let P: ReturnType<typeof standIn>;
let A: CountingProxy;
let B: CountingProxy;
const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "agate-recheck-r2-watcher-"));
  homes.push(h);
  return h;
};

beforeAll(async () => {
  try {
    const a = await spawnAnvil(["--silent", "--chain-id", "31337"]);
    anvil = a.proc;
    P = standIn(a.rpc);
    A = startCountingProxy({ upstream: a.rpc });
    B = startCountingProxy({ upstream: a.rpc });
  } catch {
    available = false;
  }
}, 120_000);

afterAll(() => {
  setFileScrubber(null);
  for (const p of [P, A, B]) p?.stop();
  anvil?.kill();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("the watcher's send route: final answers and a late start (recheck r2)", () => {
  test("a revert of the estimate from a keyed send endpoint is final, and no sink shows the key", async () => {
    if (!available) return;
    const e = { http: [A.url, B.url], ws: [], send: [P.url] };
    // the scrubbers the processes install (config.readEndpoints): files through scrubSecrets, console likewise
    setFileScrubber((t) => scrubSecrets(t, e));
    const files = home();
    const alerts = new AlertSink(join(files, "alerts.jsonl"), { now: nowS, role: "attest", index: EOA });
    const logs: string[] = [];
    const pool = await RpcPool.create({ urls: [A.url, B.url], timeoutMs: 2_000, staleS: 600, role: "attest", now: nowS });
    const route = await SendRoute.create(pool, { urls: [P.url], role: "attest", timeoutMs: 2_000, alerts, log: (ev, d) => void logs.push(JSON.stringify({ ev, ...d })) });
    const sender = new TxSender({ pool, send: route, to: EOA, keyEnv: KEY_ENV, role: "attest", abi: PING, now: nowS, pollMs: 20, alerts });
    P.revertEstimate = true;
    P.seen.length = 0;
    A.reset();
    B.reset();
    const r = await sender.send("ping", []);
    P.revertEstimate = false;
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(String(r.error)).toContain("estimate");
    expect(P.seen).toEqual(["eth_estimateGas"]);
    expect([...A.methods(), ...B.methods()]).not.toContain("eth_estimateGas");
    // the error text itself is viem's short message: no URL in it even before any scrubber
    expect(String(r.error)).not.toContain(FAKE_KEY);
    // a send failure as an alert would carry it, with the URL quoted on purpose
    alerts.raise({ code: AlertCode.GAS_CAP, severity: "info", message: `attest: ${r.error} via ${P.url}` });
    const written = readFileSync(join(files, "alerts.jsonl"), "utf8");
    const all = [written, ...logs, ...sender.log, scrubSecrets(JSON.stringify(r), e)].join("\n");
    expect(all).not.toContain(FAKE_KEY);
    expect(all).not.toContain("/v2/");
  });

  test("a process that starts after the day's stop: its start check asks the send endpoint's chain id (0 CU), nothing else ever reaches it", async () => {
    if (!available) return;
    const h = home();
    // another process spent the day's budget
    const spent = new RpcMeter({ home: h, role: "keep", scope: "r2r2r2r2", dailyCu: 100 });
    for (let i = 0; i < 3; i++) spent.count("eth_sendRawTransaction");
    spent.tick(true);
    const meter = new RpcMeter({ home: h, role: "attest", scope: "r2r2r2r2", dailyCu: 100 });
    const pool = await RpcPool.create({ urls: [A.url, B.url], timeoutMs: 2_000, staleS: 600, role: "attest", now: nowS });
    P.seen.length = 0;
    const route = await SendRoute.create(pool, { urls: [P.url], role: "attest", timeoutMs: 2_000, meter });
    expect(P.seen).toEqual(["eth_chainId"]);
    expect(meter.budgetStopped).toBe(true);
    const sender = new TxSender({ pool, send: route, to: EOA, keyEnv: KEY_ENV, role: "attest", abi: PING, now: nowS, pollMs: 20 });
    A.reset();
    B.reset();
    expect(await sender.send("ping", [])).toMatchObject({ ok: true, sent: true });
    expect(P.seen).toEqual(["eth_chainId"]);
    expect([...A.methods(), ...B.methods()]).toContain("eth_sendRawTransaction");
    // a rebroadcast's endpoints: the read endpoints only
    expect(route.clients().length).toBe(2);
    expect(meter.snapshot().methods).toEqual({ eth_chainId: 1 });
    expect(meter.ownCu()).toBe(0);
  });
});
