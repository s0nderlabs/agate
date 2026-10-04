// The send route (Oct 4): a process's own transactions go to its send: endpoints first (env.ts; Alchemy on testnet),
// then to the read pool in its failover order. "Own transactions" is eth_sendRawTransaction and what reads that one
// transaction: the pending nonce, the gas estimate and the receipts (a lagging public node never misreports a
// transaction it has not seen yet). Every other read (eth_call, logs, blocks, balances, fees) stays on the pool and
// never reaches a send endpoint, not even when every read endpoint is down. A send endpoint's own answer (a revert, a
// receipt not found, "nonce too low") is final; anything else (a transport failure, an HTTP error, a provider's
// limit) moves on. A send endpoint that did not answer in time is left out for SEND_REST_MS, so the calls of a send go
// to the pool at once instead of each waiting a full timeout (recheck r1: four waits a send, about 40 s at 10 s). Each
// call to a send endpoint is counted by the process's RpcMeter, which also turns the send endpoints off for the rest
// of a UTC day once the day's Alchemy budget is spent (the pool then takes everything).
import { BaseError, createPublicClient, http, type PublicClient, TimeoutError, type Transport } from "viem";
import { redactUrl } from "@agate/report/env";
import type { RpcMeter } from "@agate/report/meter";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "../alerts.ts";
import { isRevert, type RpcPool, short } from "./rpc.ts";

/** What a sender needs for its own transactions: the read pool alone, or a SendRoute in front of it. */
export interface SendPath {
  readonly chainId: number;
  call<T>(fn: (c: PublicClient) => Promise<T>, appError?: (e: unknown) => boolean): Promise<T>;
  /** every endpoint a rebroadcast goes to */
  clients(): PublicClient[];
}

/** An http client whose every request is counted by the meter (method by method). */
export function meteredClient(url: string, timeoutMs: number, meter?: RpcMeter): PublicClient {
  const base = http(url, { timeout: timeoutMs, retryCount: 0 });
  if (!meter) return createPublicClient({ transport: base }) as PublicClient;
  const transport = ((opts: Parameters<typeof base>[0]) => {
    const t = base(opts);
    const request = (async (args: { method: string; params?: unknown }, o?: unknown) => {
      meter.count(args.method);
      return (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, o);
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
  return createPublicClient({ transport }) as PublicClient;
}

export interface SendRouteOptions {
  urls: readonly string[];
  role: string;
  timeoutMs: number;
  meter?: RpcMeter;
  alerts?: AlertSink;
  log?: (event: string, data: Record<string, unknown>) => void;
  /** test hook: build a client for a URL (counted by the meter only when the hook counts) */
  clientFor?: (url: string, timeoutMs: number) => PublicClient;
  /** how long a send endpoint that did not answer in time is left out (default SEND_REST_MS) */
  restMs?: number;
  nowMs?: () => number;
}

/** A send endpoint that did not answer in time is left out this long (ms). */
export const SEND_REST_MS = 60_000;

/** No answer in time: viem's TimeoutError anywhere in the chain of causes. */
export function isTimeout(e: unknown): boolean {
  if (e instanceof BaseError) return e.walk((x) => x instanceof TimeoutError) !== null;
  return (e as Error)?.name === "TimeoutError";
}

export class SendRoute implements SendPath {
  private eps: { url: string; client: PublicClient }[];
  private down = false;
  /** a send endpoint that timed out, and until when it is left out (ms) */
  private resting = new Map<string, number>();
  /** calls a send endpoint answered, and calls that went on to the pool (tests, the start line) */
  answered = 0;
  passedOn = 0;

  private constructor(
    readonly pool: RpcPool,
    private readonly o: SendRouteOptions,
  ) {
    this.eps = [...new Set(o.urls)].map((url) => ({ url, client: this.mk(url) }));
  }

  /** The send endpoints, each checked once for the pool's chain id: one on another chain is dropped (an action
   *  alert); one that does not answer now is kept. */
  static async create(pool: RpcPool, o: SendRouteOptions): Promise<SendRoute> {
    const r = new SendRoute(pool, o);
    await r.verify();
    return r;
  }

  private mk(url: string): PublicClient {
    return this.o.clientFor ? this.o.clientFor(url, this.o.timeoutMs) : meteredClient(url, this.o.timeoutMs, this.o.meter);
  }

  private now(): number {
    return this.o.nowMs ? this.o.nowMs() : Date.now();
  }

  /** A send endpoint that did not answer in time rests; one that answered is in use again. */
  private note(url: string, err?: unknown): void {
    if (err === undefined) this.resting.delete(url);
    else if (isTimeout(err)) this.resting.set(url, this.now() + (this.o.restMs ?? SEND_REST_MS));
  }

  private async verify(): Promise<void> {
    const keep: { url: string; client: PublicClient }[] = [];
    for (const e of this.eps) {
      let id: number | null = null;
      try {
        id = await e.client.getChainId();
        this.note(e.url);
      } catch (err) {
        id = null;
        this.note(e.url, err);
      }
      if (id === null || id === this.pool.chainId) keep.push(e);
      else this.o.alerts?.raise({ code: AlertCode.RPC_FAILOVER, severity: "action", message: `${this.o.role}: dropped send endpoint ${redactUrl(e.url)}: chain id ${id}, expected ${this.pool.chainId}` });
    }
    this.eps = keep;
  }

  get chainId(): number {
    return this.pool.chainId;
  }

  /** The send endpoints in use now: none while the day's Alchemy budget is spent, and none resting after a timeout. */
  private live(): { url: string; client: PublicClient }[] {
    if (this.eps.length === 0) return [];
    if (this.o.meter && !this.o.meter.allowed()) return [];
    const t = this.now();
    return this.eps.filter((e) => (this.resting.get(e.url) ?? 0) <= t);
  }

  /** The redacted send endpoints (a start line). */
  redactedUrls(): string[] {
    return this.eps.map((e) => redactUrl(e.url));
  }

  /** Rebuilds the clients with the profile's timeout (as RpcPool.retune). */
  retune(timeoutMs: number): void {
    this.o.timeoutMs = timeoutMs;
    this.eps = this.eps.map((e) => ({ url: e.url, client: this.mk(e.url) }));
  }

  async call<T>(fn: (c: PublicClient) => Promise<T>, appError: (e: unknown) => boolean = isRevert): Promise<T> {
    let last: unknown;
    for (const e of this.live()) {
      try {
        const v = await fn(e.client);
        this.answered++;
        this.note(e.url);
        this.mark(false);
        return v;
      } catch (err) {
        if (appError(err)) {
          this.answered++;
          this.note(e.url);
          this.mark(false);
          throw err;
        }
        this.note(e.url, err);
        last = err;
      }
    }
    if (last !== undefined) this.mark(true, last);
    this.passedOn++;
    return this.pool.call(fn, appError);
  }

  clients(): PublicClient[] {
    return [...this.live().map((e) => e.client), ...this.pool.clients()];
  }

  private mark(down: boolean, why?: unknown): void {
    if (down === this.down) return;
    this.down = down;
    this.o.log?.(down ? "send_endpoint_down" : "send_endpoint_up", down ? { urls: this.redactedUrls(), error: short(why), then: "the read endpoints" } : { urls: this.redactedUrls() });
  }
}
