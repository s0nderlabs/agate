// Websocket wake-ups since Oct 4: AGATE_WS_KIND=logs asks the finalized logs first (Alchemy bills the bytes it pushes),
// the meter counts each eth_subscribe and each event's bytes, the day's spent Alchemy budget closes the socket without
// RPC_WS_DOWN noise until 00:00 UTC, and a role with no websocket configured raises nothing at all. A local mock
// websocket server only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcMeter } from "@agate/report/meter";
import { AlertCode } from "@agate/report/types";
import { AlertSink } from "../src/alerts.ts";
import { WsWake, wsPreferFromEnv } from "../src/chain/ws-wake.ts";

const ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "agate-ws-kind-"));
  homes.push(h);
  return h;
};

interface Mock {
  url: string;
  sockets: Set<{ send: (s: string) => void; close: () => void }>;
  subs: string[];
  refuse: (name: string) => boolean;
  opens: number;
  stop: () => void;
}
function mock(): Mock {
  const m: Mock = { url: "", sockets: new Set(), subs: [], refuse: () => false, opens: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("ws only", { status: 400 });
    },
    websocket: {
      open(ws) {
        m.opens++;
        m.sockets.add(ws);
      },
      message(ws, msg) {
        const j = JSON.parse(String(msg)) as { id: number; method: string; params: unknown[] };
        if (j.method !== "eth_subscribe") return;
        const name = String(j.params[0]);
        if (m.refuse(name)) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -32601, message: "unsupported" } }));
          return;
        }
        m.subs.push(name);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: `0xsub${m.subs.length}` }));
      },
      close(ws) {
        m.sockets.delete(ws);
      },
    },
  });
  m.url = `ws://127.0.0.1:${server.port}/v2/FAKEWSKEY000111222333`;
  m.stop = () => server.stop(true);
  return m;
}
const EVENT = JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub1", result: { address: ADDR, topics: ["0x01"], data: "0x00", blockNumber: "0x10", logIndex: "0x0", removed: false } } });
const until = async (f: () => boolean, ms = 3_000) => {
  const t = Date.now() + ms;
  while (!f() && Date.now() < t) await Bun.sleep(10);
  return f();
};

describe("AGATE_WS_KIND", () => {
  test("unset or monad: monadLogs first (unchanged); logs: the finalized logs first; anything else refused", () => {
    expect(wsPreferFromEnv({})).toBe("monad");
    expect(wsPreferFromEnv({ AGATE_WS_KIND: "monad" })).toBe("monad");
    expect(wsPreferFromEnv({ AGATE_WS_KIND: " logs " })).toBe("finalized");
    for (const v of ["monadLogs", "LOGS", "heads", "1"]) expect(() => wsPreferFromEnv({ AGATE_WS_KIND: v })).toThrow("AGATE_WS_KIND must be logs or monad");
  });

  test("prefer finalized: the logs subscription, and monadLogs only when a node refuses it", async () => {
    const m = mock();
    const a = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "attest", prefer: "finalized" });
    a.start();
    expect(await until(() => a.live)).toBe(true);
    expect(m.subs).toEqual(["logs"]);
    a.stop();
    m.subs.length = 0;
    m.refuse = (n) => n === "logs";
    const b = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "attest", prefer: "finalized" });
    b.start();
    expect(await until(() => b.live)).toBe(true);
    expect(m.subs).toEqual(["monadLogs"]);
    b.stop();
    // the default order is unchanged
    m.subs.length = 0;
    m.refuse = () => false;
    const c = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "attest" });
    c.start();
    expect(await until(() => c.live)).toBe(true);
    expect(m.subs).toEqual(["monadLogs"]);
    c.stop();
    m.stop();
  });

  test("a node refusing both streams: each asked once, then polling only", async () => {
    const m = mock();
    m.refuse = () => true;
    const events: string[] = [];
    const ws = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "keep", prefer: "finalized", log: (e) => events.push(e) });
    ws.start();
    expect(await until(() => events.filter((e) => e === "ws_subscribe_refused").length === 2)).toBe(true);
    await Bun.sleep(100);
    expect(events.filter((e) => e === "ws_subscribe_refused").length).toBe(2);
    expect(ws.live).toBe(false);
    ws.stop();
    m.stop();
  });
});

describe("the meter on the websocket", () => {
  test("each eth_subscribe and the bytes of each event are counted (0.04 CU a byte)", async () => {
    const m = mock();
    const meter = new RpcMeter({ home: home(), role: "attest", scope: "aaaaaaaa", dailyCu: 1_000_000 });
    const ws = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "attest", prefer: "finalized", meter });
    ws.start();
    expect(await until(() => ws.live)).toBe(true);
    for (const s of m.sockets) for (let i = 0; i < 3; i++) s.send(EVENT);
    expect(await until(() => ws.notifications === 3)).toBe(true);
    const snap = meter.snapshot();
    expect(snap.methods).toEqual({ eth_subscribe: 1 });
    expect(snap.wsBytes).toBe(3 * new TextEncoder().encode(EVENT).length);
    expect(snap.cu).toBe(Math.ceil(10 + 3 * new TextEncoder().encode(EVENT).length * 0.04));
    ws.stop();
    m.stop();
  });

  test("the day's spent budget closes the socket (no reconnect, no RPC_WS_DOWN) until 00:00 UTC, then it subscribes again", async () => {
    const m = mock();
    const clock = { t: Date.parse("2026-10-04T23:58:00Z") };
    const meter = new RpcMeter({ home: home(), role: "keep", scope: "bbbbbbbb", dailyCu: 100, nowMs: () => clock.t });
    const alerts = new AlertSink(null, { now: () => 0, print: false });
    const events: string[] = [];
    const ws = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "keep", prefer: "finalized", meter, alerts, minBackoffMs: 20, log: (e) => events.push(e) });
    ws.start();
    expect(await until(() => ws.live)).toBe(true);
    // a large event spends the budget: the socket closes on it
    const big = JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub1", result: { data: `0x${"ab".repeat(1_500)}` } } });
    clock.t += 60_000;
    for (const s of m.sockets) s.send(big);
    expect(await until(() => ws.budgetPaused)).toBe(true);
    expect(await until(() => m.sockets.size === 0)).toBe(true);
    expect(ws.live).toBe(false);
    for (let i = 0; i < 10; i++) ws.tick();
    await Bun.sleep(150);
    expect(m.opens).toBe(1); // never reconnected
    expect(alerts.all().filter((a) => a.code === AlertCode.RPC_WS_DOWN)).toEqual([]);
    expect(events).toContain("ws_paused");
    // 00:00 UTC: the next tick opens it again
    clock.t = Date.parse("2026-10-05T00:00:10Z");
    ws.tick();
    expect(await until(() => ws.live)).toBe(true);
    expect(m.opens).toBe(2);
    expect(events).toContain("ws_resumed");
    ws.stop();
    m.stop();
  });

  test("a budget already spent at start: the socket never opens", async () => {
    const m = mock();
    const meter = new RpcMeter({ home: home(), role: "attest", scope: "cccccccc", dailyCu: 10 });
    meter.count("eth_sendRawTransaction");
    expect(meter.allowed()).toBe(false);
    const ws = new WsWake({ urls: [m.url], address: ADDR, onWake: () => {}, role: "attest", meter });
    ws.start();
    await Bun.sleep(100);
    expect(m.opens).toBe(0);
    expect(ws.budgetPaused).toBe(true);
    ws.stop();
    m.stop();
  });
});

describe("a role with no websocket configured", () => {
  test("starts nothing, counts nothing and raises no RPC_WS_DOWN however many ticks", () => {
    const alerts = new AlertSink(null, { now: () => 0, print: false });
    const meter = new RpcMeter({ home: home(), role: "payer", scope: "market", dailyCu: 10 });
    const ws = new WsWake({ urls: [], address: ADDR, onWake: () => {}, role: "payer", alerts, meter, prefer: "finalized" });
    ws.start();
    for (let i = 0; i < 20; i++) ws.tick();
    expect(alerts.all()).toEqual([]);
    expect(ws.live).toBe(false);
    expect(ws.connects).toBe(0);
    expect(meter.snapshot().methods).toEqual({});
    ws.stop();
  });
});
