// A websocket handshake that never answers (Bun's WebSocket has no handshake timeout; seen live on a fork Oct 4: the
// sockets stayed CONNECTING for good after the endpoint recovered) is closed after handshakeMs and retried on the next
// URL. Fake sockets only.
import { describe, expect, test } from "bun:test";
import { WsWake, type WsLike } from "../src/chain/ws-wake.ts";

const ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

class FakeSocket implements WsLike {
  readyState = 0;
  closed = false;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
}

describe("WsWake: handshake timeout", () => {
  test("a socket that never opens is closed and the next URL is tried; the one that opens subscribes", async () => {
    const made: FakeSocket[] = [];
    const w = new WsWake({
      urls: ["wss://hang.example/ws", "wss://good.example/ws"],
      address: ADDR,
      onWake: () => {},
      role: "attest",
      handshakeMs: 40,
      minBackoffMs: 5,
      connect: (url) => {
        const s = new FakeSocket(url);
        made.push(s);
        if (url.includes("good")) queueMicrotask(() => s.open());
        return s;
      },
    });
    w.start();
    await Bun.sleep(150);
    w.stop();
    expect(made[0]!.url).toContain("hang");
    expect(made[0]!.closed).toBe(true);
    const good = made.find((s) => s.url.includes("good"));
    expect(good).toBeDefined();
    expect(good!.sent.some((m) => m.includes("eth_subscribe"))).toBe(true);
    expect(w.connects).toBe(1);
  });

  test("a socket that opens in time is kept: no close, no second connect", async () => {
    const made: FakeSocket[] = [];
    const w = new WsWake({
      urls: ["wss://good.example/ws"],
      address: ADDR,
      onWake: () => {},
      role: "keep",
      handshakeMs: 40,
      minBackoffMs: 5,
      connect: (url) => {
        const s = new FakeSocket(url);
        made.push(s);
        queueMicrotask(() => s.open());
        return s;
      },
    });
    w.start();
    await Bun.sleep(120);
    w.stop();
    expect(made.length).toBe(1);
    expect(w.connects).toBe(1);
  });

  test("stop() during a pending handshake leaves no timer that reconnects", async () => {
    const made: FakeSocket[] = [];
    const w = new WsWake({
      urls: ["wss://hang.example/ws"],
      address: ADDR,
      onWake: () => {},
      role: "attest",
      handshakeMs: 30,
      minBackoffMs: 5,
      connect: (url) => {
        const s = new FakeSocket(url);
        made.push(s);
        return s;
      },
    });
    w.start();
    w.stop();
    await Bun.sleep(100);
    expect(made.length).toBe(1);
  });
});
