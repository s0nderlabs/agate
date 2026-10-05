// JSON-RPC over two or more URLs with failover (BUILD-SPEC 13.4). A transport failure (HTTP error, timeout, bad
// body) or a stale head moves to the next URL; a JSON-RPC error answer (a revert, a refused transaction) is the
// node speaking and is passed through unchanged. A JSON-RPC error that comes with an HTTP status that refuses the
// caller whatever it asked (401, 402, 403: a key that is revoked or mistyped, a billing block, an app's allowlist; 404,
// 407, 408, 429, 5xx) or that names a provider's limit (a rate, a capacity) is the provider refusing to serve, not the
// node: it moves on too. Any other 4xx (a 400, a 413) stays the node's answer to the request (a range refused is
// halved by its caller). The first URL is re-probed every five minutes.
// Oct 4: SendRoute puts the send: endpoints (env.ts) in front of the pool for the writer's own transactions.
import type { RpcMeter } from "@agate/report/meter";
import type { AlertCode } from "@agate/report/types";

export interface AlertInput {
  code: AlertCode;
  severity: "info" | "action";
  message: string;
  gpuId?: `0x${string}`;
  day?: number;
  slot?: number;
  writer?: `0x${string}`;
  deadline?: number;
  data?: unknown;
  /** clears the open alert with this alert's id (same code, gpuId, day, slot, writer) instead of raising one */
  clear?: true;
}
export type AlertFn = (a: AlertInput) => void;

/** Every URL failed on one request. */
export class RpcDownError extends Error {
  constructor(readonly method: string, readonly causes: string[]) {
    super(`every RPC URL failed for ${method}: ${causes.join("; ")}`);
    this.name = "RpcDownError";
  }
}

/** The node answered with a JSON-RPC error object (EIP-1193 shape, so viem decodes revert data from it). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
    /** the HTTP status the answer came with */
    readonly status = 200,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** No usable answer from this URL: the next one is asked. `timeout`: it did not answer in time. */
class TransportError extends Error {
  constructor(
    message: string,
    readonly timeout = false,
  ) {
    super(message);
  }
}

/** HTTP statuses that refuse the caller whatever it asked: the provider's word, never the node's. */
const REFUSED = new Set([401, 402, 403, 404, 407, 408, 429]);

/** A provider's limit in a JSON-RPC error (the words of the market scanner's isRateLimit, and Alchemy's code 429):
 *  "Your app has exceeded its compute units per second capacity", "Monthly capacity limit exceeded", "Too Many
 *  Requests". An answer with revert data (a hex string), or about a revert, is the node's and never a limit. */
const LIMIT = /\b429\b|rate.?limit|too many requests|compute units|capacity|throughput|throttl/i;
export function isProviderLimit(err: { code?: number; message?: string; data?: unknown }): boolean {
  const m = err.message ?? "";
  if ((typeof err.data === "string" && /^0x/i.test(err.data)) || /revert/i.test(m)) return false;
  return err.code === 429 || LIMIT.test(m);
}

export interface RpcPoolOptions {
  urls: readonly string[];
  /** Expected chain id (AGATE_CHAIN_ID). Unset: the id of the first URL that answers. */
  expectChainId?: number;
  /** Per request; 13.4: min(10 s, slice / 10). */
  timeoutMs: number;
  /** A head older than this (seconds behind the local clock) is stale; 13.4: max(30 s, slice / 4). */
  staleS: number;
  reprobeMs?: number;
  nowMs?: () => number;
  alert?: AlertFn;
  fetchImpl?: typeof fetch;
}

/** URLs carry API keys in their path or query: logs and alerts show only the origin. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? "/..." : ""}`;
  } catch {
    return "<bad url>";
  }
}

export class RpcPool {
  urls: string[];
  cur = 0;
  chainId = 0;
  private lastProbe = 0;
  private id = 1;
  private singleSaid = false;
  /** False until init() has checked every URL's chain id (a start from the cached clock runs before that). */
  verified = false;
  private readonly now: () => number;
  private readonly f: typeof fetch;

  constructor(private o: RpcPoolOptions) {
    if (o.urls.length === 0) throw new Error("no RPC URL configured (AGATE_RPC_URLS)");
    this.urls = [...o.urls];
    this.now = o.nowMs ?? Date.now;
    this.f = o.fetchImpl ?? fetch;
  }

  /** Per-request timeout and stale-head limit, once the index clock is known (13.4). */
  tune(timeoutMs: number, staleS: number): void {
    this.o = { ...this.o, timeoutMs, staleS };
  }

  get url(): string {
    return this.urls[this.cur]!;
  }

  private alert(a: AlertInput) {
    this.o.alert?.(a);
  }

  /** One JSON-RPC call to one URL. Throws TransportError (move on) or RpcError (the node's answer). */
  async call(url: string, method: string, params: readonly unknown[] = [], timeoutMs = this.o.timeoutMs): Promise<unknown> {
    let res: Response;
    try {
      res = await this.f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TransportError(`${redact(url)}: ${e instanceof Error ? e.message : String(e)}`, e instanceof Error && e.name === "TimeoutError");
    }
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      throw new TransportError(`${redact(url)}: HTTP ${res.status}, no JSON body`, e instanceof Error && e.name === "TimeoutError");
    }
    if (body?.error) {
      // a 5xx, a status that refuses the caller (401, 402, 403: the provider will not serve this key) or a provider's
      // limit in the body (even with HTTP 200) is the provider, not the node
      if (res.status >= 500 || REFUSED.has(res.status) || isProviderLimit(body.error)) throw new TransportError(`${redact(url)}: HTTP ${res.status} ${body.error.message ?? ""}`);
      throw new RpcError(body.error.message ?? "rpc error", body.error.code ?? -32000, body.error.data, res.status);
    }
    if (!res.ok) throw new TransportError(`${redact(url)}: HTTP ${res.status}`);
    if (!("result" in (body ?? {}))) throw new TransportError(`${redact(url)}: no result`);
    return body.result;
  }

  /** Checks every URL's chain id; drops the ones on another chain (or dead at start) with an alert. */
  async init(): Promise<void> {
    if (this.o.urls.length === 1 && !this.singleSaid) {
      this.singleSaid = true;
      this.alert({ code: "RPC_SINGLE", severity: "action", message: `only one RPC URL configured (${redact(this.o.urls[0]!)}); set AGATE_RPC_URLS to two or more` });
    }
    const ids = await Promise.all(this.o.urls.map((u) => this.call(u, "eth_chainId").then((x) => Number(x), (e: Error) => e)));
    const answered = ids.filter((x): x is number => typeof x === "number");
    if (answered.length === 0) throw new RpcDownError("eth_chainId", ids.map((x) => String(x instanceof Error ? x.message : x)));
    let want = this.o.expectChainId;
    if (want === undefined) {
      // no AGATE_CHAIN_ID: a strict majority of the answering URLs decides; a tie is refused, never guessed
      const votes = new Map<number, number>();
      for (const x of answered) votes.set(x, (votes.get(x) ?? 0) + 1);
      const [top, n] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
      if (votes.size > 1 && [...votes.values()].filter((v) => v === n).length > 1) {
        throw new Error(`RPC URLs disagree on the chain id (${[...votes.keys()].join(", ")}): set AGATE_CHAIN_ID`);
      }
      want = top;
    }
    const keep: string[] = [];
    this.o.urls.forEach((u, i) => {
      const x = ids[i];
      if (x === want) keep.push(u);
      else if (typeof x === "number") {
        this.alert({ code: "RPC_FAILOVER", severity: "action", message: `RPC ${redact(u)} is on chain ${x}, expected ${want}: dropped`, data: { url: redact(u), chainId: x } });
      } else keep.push(u); // dead at start, not wrong: kept, the failover skips it while it is down
    });
    if (keep.length === 0 || !ids.some((x) => x === want)) throw new Error(`no RPC URL on chain ${want}`);
    this.urls = keep;
    this.chainId = want;
    this.cur = Math.max(0, keep.findIndex((u) => ids[this.o.urls.indexOf(u)] === want));
    this.lastProbe = this.now();
    this.verified = true;
  }

  /** Starts unverified on a chain id remembered from an earlier start (every URL down at boot); init() later. */
  assume(chainId: number): void {
    this.chainId = chainId;
    this.urls = [...this.o.urls];
    this.cur = 0;
  }

  private switchTo(i: number, why: string) {
    if (i === this.cur) return;
    const from = this.urls[this.cur]!;
    this.cur = i;
    this.lastProbe = this.now();
    this.alert({ code: "RPC_FAILOVER", severity: "info", message: `RPC ${redact(from)} -> ${redact(this.url)}: ${why}`, data: { from: redact(from), to: redact(this.url), why } });
  }

  /** The current URL, then each other one once; a node's JSON-RPC error answer is returned as is. */
  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const causes: string[] = [];
    for (let k = 0; k < this.urls.length; k++) {
      const i = (this.cur + k) % this.urls.length;
      try {
        const r = await this.call(this.urls[i]!, method, params);
        if (k > 0) this.switchTo(i, causes.at(-1) ?? "error");
        return r;
      } catch (e) {
        if (!(e instanceof TransportError)) {
          if (k > 0) this.switchTo(i, causes.at(-1) ?? "error");
          throw e;
        }
        causes.push(e.message);
      }
    }
    throw new RpcDownError(method, causes);
  }

  /** Sends a signed transaction to every URL (rebroadcast); the answers in URL order. */
  async broadcastAll(raw: `0x${string}`): Promise<({ ok: true; hash: unknown } | { ok: false; error: string; transport: boolean })[]> {
    return Promise.all(
      this.urls.map((u) =>
        this.call(u, "eth_sendRawTransaction", [raw]).then(
          (hash) => ({ ok: true as const, hash }),
          (e: Error) => ({ ok: false as const, error: e.message, transport: e instanceof TransportError }),
        ),
      ),
    );
  }

  private async headOf(url: string): Promise<number> {
    const b = (await this.call(url, "eth_getBlockByNumber", ["latest", false])) as { timestamp?: string } | null;
    if (!b?.timestamp) throw new TransportError(`${redact(url)}: no latest block`);
    return Number(BigInt(b.timestamp));
  }

  /** Once per tick: a stale head moves to a fresh URL (if any is fresh; if none is, the local clock is suspect and
   * nothing moves); every five minutes the first URL is re-probed and taken back when healthy. Returns the head. */
  async checkHead(nowS: number): Promise<number | undefined> {
    if (this.cur !== 0 && this.now() - this.lastProbe >= (this.o.reprobeMs ?? 300_000)) {
      this.lastProbe = this.now();
      try {
        const id = Number(await this.call(this.urls[0]!, "eth_chainId"));
        const h = await this.headOf(this.urls[0]!);
        if (id === this.chainId && nowS - h <= this.o.staleS) this.switchTo(0, "first URL healthy again");
        else if (id !== this.chainId) this.alert({ code: "RPC_FAILOVER", severity: "action", message: `RPC ${redact(this.urls[0]!)} now answers chain ${id}, expected ${this.chainId}` });
      } catch {
        // still down: stay
      }
    }
    let head: number | undefined;
    let cause = "";
    try {
      head = await this.headOf(this.url);
    } catch (e) {
      head = undefined;
      cause = e instanceof Error ? e.message : String(e);
    }
    if (head !== undefined && nowS - head <= this.o.staleS) return head;
    for (let k = 1; k < this.urls.length; k++) {
      const i = (this.cur + k) % this.urls.length;
      try {
        const id = Number(await this.call(this.urls[i]!, "eth_chainId"));
        if (id !== this.chainId) continue;
        const h = await this.headOf(this.urls[i]!);
        if (nowS - h <= this.o.staleS) {
          this.switchTo(i, head === undefined ? `no head (${cause})` : `stale head (${nowS - head} s behind)`);
          return h;
        }
      } catch {
        // next
      }
    }
    if (head === undefined) throw new RpcDownError("eth_getBlockByNumber", ["no URL returned a head"]);
    return head;
  }
}

export interface SendRouteOptions {
  urls: readonly string[];
  /** counts every call to a send endpoint; turns them off for the rest of a UTC day once the day's budget is spent */
  meter?: RpcMeter;
  alert?: AlertFn;
  say?: (event: string, data?: Record<string, unknown>) => void;
  /** how long a send endpoint that did not answer in time is left out (default SEND_REST_MS) */
  restMs?: number;
  nowMs?: () => number;
}

/** A send endpoint that did not answer in time is left out this long: the calls of a send go to the pool at once
 *  instead of each waiting a full timeout (estimate, nonce, broadcast, receipts: about 40 s a send at 10 s). */
export const SEND_REST_MS = 60_000;

/** The node's own word on this one transaction: a revert, a nonce or fee it refuses, a transaction it knows, funds. */
const NODE_ANSWER = /revert|nonce too (low|high)|nonce has already been used|noncetoolow|oldnonce|invalid nonce|already known|known transaction|already imported|already exists|alreadyknown|underpriced|fee too low|insufficient funds/i;

/** Whether a send endpoint's error is final: only the node's word on this transaction, with an HTTP status under 400.
 *  Anything else a send endpoint says is passed on to the pool, whose own answer then stands: a transport failure,
 *  an HTTP status of 400 or above with a JSON-RPC error (a revoked or mistyped key, an app's allowlist, a billing
 *  block), a provider's limit (also in an HTTP 200), or an error that says nothing about the transaction. Before Oct 4
 *  (recheck r1) the writers took a 401, 402 or 403 with a JSON body, or a 200 with an error, as final: the estimate
 *  failed and nothing was sent, every tick, while the watcher's and the market's routes failed over. */
export function sendFinal(e: unknown): boolean {
  return e instanceof RpcError && e.status < 400 && NODE_ANSWER.test(e.message);
}

/**
 * The writer's own transactions (Oct 4): eth_sendRawTransaction and what reads that one transaction (the nonce, the
 * gas estimate, the receipts, the transaction by hash) go to the send: endpoints first, then to the pool in its
 * failover order. A send endpoint's answer that is the node's word on the transaction (sendFinal: a revert, a refused
 * nonce or fee, a known transaction; a receipt that is null is a result) is final; anything else moves on. A send
 * endpoint that did not answer in time is left out for SEND_REST_MS. Reads never come here: they keep using the pool,
 * which never holds a send endpoint. Each call to a send endpoint is counted by the meter; while the meter says the
 * day's Alchemy budget is spent the send endpoints are skipped (the pool takes the call) until 00:00 UTC.
 */
export class SendRoute {
  urls: string[];
  private verifiedOn = 0;
  private down = false;
  /** a send endpoint that timed out, and until when it is left out (ms) */
  private resting = new Map<string, number>();

  constructor(
    readonly pool: RpcPool,
    private readonly o: SendRouteOptions,
  ) {
    this.urls = [...new Set(o.urls)];
  }

  private now(): number {
    return this.o.nowMs ? this.o.nowMs() : Date.now();
  }

  /** The send endpoints in use now: none while the day's budget is spent, and none resting after a timeout. */
  private live(): string[] {
    if (this.urls.length === 0) return [];
    if (this.o.meter && !this.o.meter.allowed()) return [];
    const t = this.now();
    return this.urls.filter((u) => (this.resting.get(u) ?? 0) <= t);
  }

  /** A send endpoint that did not answer in time rests; one that answered is in use again. */
  private note(url: string, e?: unknown): void {
    if (e instanceof TransportError && e.timeout) this.resting.set(url, this.now() + (this.o.restMs ?? SEND_REST_MS));
    else if (e === undefined) this.resting.delete(url);
  }

  private async one(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
    this.o.meter?.count(method);
    try {
      const r = await this.pool.call(url, method, params);
      this.note(url);
      return r;
    } catch (e) {
      this.note(url, e);
      throw e;
    }
  }

  /** Once the pool knows its chain: a send endpoint on another chain is dropped (an action alert); one that does not
   *  answer now is kept. */
  async verify(): Promise<void> {
    if (!this.pool.verified || this.verifiedOn === this.pool.chainId) return;
    const keep: string[] = [];
    for (const u of this.urls) {
      let id: number | null = null;
      try {
        id = Number(await this.one(u, "eth_chainId", []));
      } catch {
        id = null;
      }
      if (id === null || id === this.pool.chainId) keep.push(u);
      else this.o.alert?.({ code: "RPC_FAILOVER", severity: "action", message: `send endpoint ${redact(u)} is on chain ${id}, expected ${this.pool.chainId}: dropped`, data: { url: redact(u), chainId: id } });
    }
    this.urls = keep;
    this.verifiedOn = this.pool.chainId;
  }

  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    let cause = "";
    for (const u of this.live()) {
      try {
        const r = await this.one(u, method, params);
        this.mark(false);
        return r;
      } catch (e) {
        if (sendFinal(e)) {
          this.mark(false);
          throw e;
        }
        cause = e instanceof TransportError ? e.message : `${redact(u)}: ${e instanceof RpcError ? `HTTP ${e.status} ` : ""}${e instanceof Error ? e.message : String(e)}`;
      }
    }
    if (cause) this.mark(true, cause);
    return this.pool.request(method, params);
  }

  /** A rebroadcast: every send endpoint, then every read endpoint; the answers in that order. */
  async broadcastAll(raw: `0x${string}`): Promise<({ ok: true; hash: unknown } | { ok: false; error: string; transport: boolean })[]> {
    const mine = await Promise.all(
      this.live().map((u) =>
        this.one(u, "eth_sendRawTransaction", [raw]).then(
          (hash) => ({ ok: true as const, hash }),
          (e: Error) => ({ ok: false as const, error: e.message, transport: !sendFinal(e) }),
        ),
      ),
    );
    return [...mine, ...(await this.pool.broadcastAll(raw))];
  }

  redactedUrls(): string[] {
    return this.urls.map(redact);
  }

  private mark(down: boolean, why?: string): void {
    if (down === this.down) return;
    this.down = down;
    this.o.say?.(down ? "send_endpoint_down" : "send_endpoint_up", down ? { urls: this.redactedUrls(), error: why, then: "the read endpoints" } : { urls: this.redactedUrls() });
  }
}
