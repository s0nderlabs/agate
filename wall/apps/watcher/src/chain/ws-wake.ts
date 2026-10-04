// Websocket wake-ups (BUILD-SPEC 13.6, 9.2; Oct 3). The attester and the keeper subscribe over the first ws(s)://
// endpoint that connects: eth_subscribe ["monadLogs", {address: index}] (and ["monadNewHeads"] where heads are wanted).
// monadLogs and monadNewHeads are Monad's speculative streams (a block may still change its commitState), so a
// notification is a wake-up hint only: it triggers an immediate tick (at most one per second), and the tick reads the
// chain over HTTP exactly as without it. Polling every tick continues; a dropped socket reconnects with a doubling
// backoff from 1 s to 60 s, trying the endpoints in order; no live subscription for 3 ticks raises RPC_WS_DOWN (info).
// URLs are secrets: only redacted forms ever reach a log line or an alert.
// Oct 4: AGATE_WS_KIND=logs asks the finalized "logs" (and "newHeads") first and the speculative monad streams only when
// a node refuses them (default "monad": the order above). Alchemy bills a websocket by the bytes it pushes, and the
// speculative stream pushes a block's events again as its commit state moves, so the kit sets logs for Alchemy. With
// a meter (report/meter.ts) each eth_subscribe and the bytes of each event are counted, and while the day's Alchemy
// budget is spent the socket stays closed (polling only, no RPC_WS_DOWN: ALCHEMY_BUDGET says why) until 00:00 UTC.
import { redactUrl } from "@agate/report/env";
import type { RpcMeter } from "@agate/report/meter";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "../alerts.ts";

export type WsKind = "logs" | "heads";
/** Which stream is asked first: Monad's speculative one (monadLogs, the default) or the finalized one (logs). */
export type WsPrefer = "monad" | "finalized";

/** AGATE_WS_KIND: unset or "monad" (monadLogs first), "logs" (the finalized logs first); anything else is refused. */
export function wsPreferFromEnv(env: Record<string, string | undefined>): WsPrefer {
  const v = env.AGATE_WS_KIND?.trim();
  if (v === undefined || v === "" || v === "monad") return "monad";
  if (v === "logs") return "finalized";
  throw new Error("AGATE_WS_KIND must be logs or monad");
}

/** The minimal WebSocket surface used here (the global WebSocket in Bun; a fake in tests). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsWakeOptions {
  urls: string[];
  /** the index address (monadLogs filter) */
  address: string;
  kinds?: WsKind[];
  onWake: () => void;
  alerts?: AlertSink;
  role: string;
  /** ms clock (debounce) */
  nowMs?: () => number;
  connect?: (url: string) => WsLike;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** consecutive ticks without a live subscription before RPC_WS_DOWN */
  downTicks?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** AGATE_WS_KIND (wsPreferFromEnv): the stream asked first (default monad) */
  prefer?: WsPrefer;
  /** a socket not open after this many ms is closed and retried (Bun's WebSocket has no handshake timeout) */
  handshakeMs?: number;
  /** counts the subscribe calls and the events' bytes; closes the socket while the day's budget is spent */
  meter?: RpcMeter;
}

export class WsWake {
  private ws: WsLike | null = null;
  private urlIx = 0;
  private backoff: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private subs = new Map<number, { kind: WsKind; monad: boolean }>(); // request id -> what it asked for
  private liveSubs = new Set<string>();
  private nextId = 1;
  private lastWake = -Infinity;
  private ticksDown = 0;
  private alerted = false;
  /** closed for the day's Alchemy budget (ALCHEMY_BUDGET) */
  private paused = false;
  /** notifications received (tests and the heartbeat) */
  notifications = 0;
  connects = 0;

  constructor(readonly o: WsWakeOptions) {
    this.backoff = o.minBackoffMs ?? 1_000;
  }

  get live(): boolean {
    return this.liveSubs.size > 0;
  }

  /** Closed while the day's Alchemy budget is spent (the meter says so). */
  get budgetPaused(): boolean {
    return this.paused;
  }

  private budgetSpent(): boolean {
    return this.o.meter !== undefined && !this.o.meter.allowed();
  }

  /** The socket closed for the rest of the UTC day (the meter's stop); polling carries on. */
  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearHandshake();
    const ws = this.ws;
    this.ws = null;
    this.liveSubs.clear();
    try {
      ws?.close();
    } catch {
      // closing a dead socket
    }
    if (this.alerted) {
      this.alerted = false;
      this.o.alerts?.clearWhere((a) => a.code === AlertCode.RPC_WS_DOWN && a.message.startsWith(`${this.o.role}:`));
    }
    this.ticksDown = 0;
    this.say("ws_paused", { why: "ALCHEMY_BUDGET", until: "00:00 UTC" });
  }

  private now(): number {
    return this.o.nowMs ? this.o.nowMs() : Date.now();
  }

  private say(event: string, data: Record<string, unknown> = {}): void {
    this.o.log?.(event, data);
  }

  start(): void {
    if (this.o.urls.length === 0 || !this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearHandshake();
    const ws = this.ws;
    this.ws = null;
    this.liveSubs.clear();
    try {
      ws?.close();
    } catch {
      // closing a dead socket
    }
  }

  private open(): void {
    if (this.stopped) return;
    if (this.budgetSpent()) {
      this.pause();
      return;
    }
    const url = this.o.urls[this.urlIx % this.o.urls.length]!;
    let ws: WsLike;
    try {
      ws = this.o.connect ? this.o.connect(url) : (new WebSocket(url) as unknown as WsLike);
    } catch {
      this.failed(url);
      return;
    }
    this.ws = ws;
    this.subs.clear();
    this.liveSubs.clear();
    this.clearHandshake();
    this.handshake = setTimeout(() => {
      this.handshake = null;
      if (this.ws !== ws) return;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // a socket still connecting
      }
      this.failed(url);
    }, this.o.handshakeMs ?? 15_000);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearHandshake();
      this.connects++;
      for (const k of this.o.kinds ?? ["logs"]) this.subscribe(ws, k, this.o.prefer !== "finalized");
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.message(ev.data);
    };
    ws.onerror = () => {
      // onclose follows
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.clearHandshake();
      this.ws = null;
      this.liveSubs.clear();
      this.failed(url);
    };
  }

  private clearHandshake(): void {
    if (this.handshake) clearTimeout(this.handshake);
    this.handshake = null;
  }

  /** monadLogs / monadNewHeads first (earliest, speculative); a node that refuses them gets logs / newHeads (finalized).
   *  With prefer "finalized" the other way round. Each stream is asked at most once per connection. */
  private subscribe(ws: WsLike, kind: WsKind, monad: boolean): void {
    const id = this.nextId++;
    this.subs.set(id, { kind, monad });
    const name = kind === "logs" ? (monad ? "monadLogs" : "logs") : monad ? "monadNewHeads" : "newHeads";
    this.o.meter?.count("eth_subscribe");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_subscribe", params: kind === "logs" ? [name, { address: this.o.address }] : [name] }));
  }

  private message(data: unknown): void {
    let m: { id?: number; result?: unknown; error?: unknown; method?: string; params?: { subscription?: string } };
    let text: string;
    try {
      text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.id !== undefined && this.subs.has(m.id)) {
      const q = this.subs.get(m.id)!;
      this.subs.delete(m.id);
      if (typeof m.result === "string") {
        this.liveSubs.add(m.result);
        this.backoff = this.o.minBackoffMs ?? 1_000;
        this.say("ws_subscribed", { kind: q.kind, monad: q.monad, url: redactUrl(this.o.urls[this.urlIx % this.o.urls.length]!) });
      } else {
        this.say("ws_subscribe_refused", { kind: q.kind, monad: q.monad });
        // the other stream once: monad then finalized by default, finalized then monad with prefer "finalized"
        if (this.ws && q.monad === (this.o.prefer !== "finalized")) this.subscribe(this.ws, q.kind, !q.monad);
      }
      return;
    }
    if (m.method === "eth_subscription") {
      this.notifications++;
      // Alchemy bills an event by its bytes (the JSON text as sent)
      this.o.meter?.wsEvent(new TextEncoder().encode(text).length);
      if (this.budgetSpent()) {
        this.pause();
        return;
      }
      // a hint only: never read the payload; the tick reads the chain over HTTP
      const t = this.now();
      if (t - this.lastWake >= 1_000) {
        this.lastWake = t;
        this.o.onWake();
      }
    }
  }

  private failed(url: string): void {
    if (this.stopped) return;
    this.say("ws_down", { url: redactUrl(url), retryMs: this.backoff });
    this.urlIx++;
    const wait = this.backoff;
    this.backoff = Math.min(this.o.maxBackoffMs ?? 60_000, this.backoff * 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, wait);
  }

  /** Once per process tick: RPC_WS_DOWN (info) after downTicks ticks without a live subscription; cleared when live.
   *  While the day's Alchemy budget is spent the socket stays closed and nothing is raised; the next UTC day it opens. */
  tick(): void {
    if (this.o.urls.length === 0) return;
    if (this.budgetSpent()) {
      this.pause();
      return;
    }
    if (this.paused) {
      this.paused = false;
      this.say("ws_resumed", {});
      if (!this.stopped) this.open();
      return;
    }
    if (this.live) {
      this.ticksDown = 0;
      if (this.alerted) {
        this.alerted = false;
        this.o.alerts?.clearWhere((a) => a.code === AlertCode.RPC_WS_DOWN && a.message.startsWith(`${this.o.role}:`));
      }
      return;
    }
    this.ticksDown++;
    if (this.ticksDown >= (this.o.downTicks ?? 3) && !this.alerted) {
      this.alerted = true;
      this.o.alerts?.raise({ code: AlertCode.RPC_WS_DOWN, severity: "info", message: `${this.o.role}: no websocket subscription live for ${this.ticksDown} ticks (${this.o.urls.map(redactUrl).join(", ")}); polling only` });
    }
  }
}

/** A sleep that a wake-up cuts short: the loop awaits wait(ms); wake() resolves the pending wait at once. */
export class Waker {
  private resolve: (() => void) | null = null;
  private pending = false;
  wait(ms: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise<void>((r) => {
      const t = setTimeout(() => {
        this.resolve = null;
        r();
      }, ms);
      this.resolve = () => {
        clearTimeout(t);
        this.resolve = null;
        r();
      };
    });
  }
  wake(): void {
    if (this.resolve) this.resolve();
    else this.pending = true;
  }
}
