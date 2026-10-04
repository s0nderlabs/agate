// Recheck r1 (Oct 4): the attester's and the keeper's websocket when Alchemy refuses it (every connection closes at
// once, or every subscription is refused), and when the day's budget stops it: how many alerts 200 process ticks
// raise, and how often the socket is asked again. The tick loop itself (polling) never waits on the socket.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcMeter } from "@agate/report/meter";
import { AlertSink } from "../../../src/alerts.ts";
import { WsWake, type WsLike } from "../../../src/chain/ws-wake.ts";

const IX = "0x00000000000000000000000000000000000000a1";

/** A socket that opens and then does what `kind` says with each subscribe. */
function fakeSocket(kind: "close-at-once" | "refuse-subscribe" | "serve", sent: string[]): (url: string) => WsLike {
  return () => {
    const ws: WsLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: (d: string) => {
        sent.push(d);
        const m = JSON.parse(d) as { id: number };
        if (kind === "refuse-subscribe") queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not supported" } }) }));
        if (kind === "serve") queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "0xsub" }) }));
      },
      close: () => {},
    } as unknown as WsLike;
    queueMicrotask(() => (kind === "close-at-once" ? ws.onclose?.({} as never) : ws.onopen?.({} as never)));
    return ws;
  };
}

async function ticks(w: WsWake, n: number) {
  for (let i = 0; i < n; i++) {
    w.tick();
    await Bun.sleep(1);
  }
}

describe("the websocket refused (recheck r1)", () => {
  for (const kind of ["close-at-once", "refuse-subscribe"] as const) {
    test(`${kind}: one info RPC_WS_DOWN over 200 ticks, no action alert, reconnects backing off`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "agate-recheck-r1-ws-"));
      try {
        const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => 0, role: "attest", index: IX });
        const sent: string[] = [];
        const w = new WsWake({ urls: ["wss://stand-in.invalid/v2/k"], address: IX, kinds: ["logs"], onWake: () => {}, alerts, role: "attest", connect: fakeSocket(kind, sent), prefer: "finalized", minBackoffMs: 5, maxBackoffMs: 40 });
        w.start();
        await ticks(w, 200);
        w.stop();
        const open = alerts.open();
        expect(open.filter((a) => a.code === "RPC_WS_DOWN").length).toBe(1);
        expect(open.filter((a) => a.severity === "action").length).toBe(0);
        if (kind === "refuse-subscribe") {
          // logs refused, then monadLogs once, on the one connection: never asked again
          expect(sent.length).toBe(2);
        }
        console.log(JSON.stringify({ recheck: `ws ${kind}`, connects: w.connects, subscribes: sent.length }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("the budget spent while subscribed: the socket closes, the RPC_WS_DOWN alert is cleared, nothing is raised for 200 ticks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-recheck-r1-ws-"));
    try {
      let now = Date.parse("2026-10-04T10:00:00Z");
      const meter = new RpcMeter({ home: dir, role: "attest", scope: "a1a1a1a1", dailyCu: 50, nowMs: () => now });
      const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => 0, role: "attest", index: IX });
      const sent: string[] = [];
      let opened = 0;
      const make = fakeSocket("serve", sent);
      const w = new WsWake({ urls: ["wss://stand-in.invalid/v2/k"], address: IX, kinds: ["logs"], onWake: () => {}, alerts, role: "attest", connect: (u) => (opened++, make(u)), prefer: "finalized", meter, minBackoffMs: 5, maxBackoffMs: 40 });
      w.start();
      await ticks(w, 3);
      expect(w.live).toBe(true);
      // 2 KB events until the budget is gone
      for (let i = 0; i < 2; i++) (w as unknown as { message(d: unknown): void }).message(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub", result: "x".repeat(2_000) } }));
      now += 61_000;
      await ticks(w, 200);
      expect(w.budgetPaused).toBe(true);
      expect(w.live).toBe(false);
      expect(alerts.open().filter((a) => a.code === "RPC_WS_DOWN").length).toBe(0);
      const before = opened;
      now = Date.parse("2026-10-05T00:00:30Z");
      await ticks(w, 3);
      expect(w.budgetPaused).toBe(false);
      expect(opened).toBe(before + 1);
      w.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
