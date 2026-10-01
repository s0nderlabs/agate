// JSON-RPC over two or more URLs with failover (BUILD-SPEC 13.4). A transport failure (HTTP error, timeout, bad
// body) or a stale head moves to the next URL; a JSON-RPC error answer (a revert, a refused transaction) is the
// node speaking and is passed through unchanged. The first URL is re-probed every five minutes.
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
  ) {
    super(message);
    this.name = "RpcError";
  }
}

class TransportError extends Error {}

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
      throw new TransportError(`${redact(url)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TransportError(`${redact(url)}: HTTP ${res.status}, no JSON body`);
    }
    if (body?.error) {
      if (res.status >= 500 || res.status === 429) throw new TransportError(`${redact(url)}: HTTP ${res.status} ${body.error.message ?? ""}`);
      throw new RpcError(body.error.message ?? "rpc error", body.error.code ?? -32000, body.error.data);
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
