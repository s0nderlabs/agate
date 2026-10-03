// RPC with failover (BUILD-SPEC 13.4): two or more URLs, each checked at start for the expected chain id
// (AGATE_CHAIN_ID, else the one most answering URLs report, a tie refused, else the cached one); reads and
// sends go to the current URL and fail over on an error, a timeout or a stale head; the first URL is re-probed every
// five minutes and taken back when healthy. RPC_FAILOVER (info), RPC_DOWN (action, every URL failed on two ticks
// running), RPC_SINGLE (action, only one URL).
import { BaseError, ContractFunctionRevertedError, createPublicClient, http, type PublicClient } from "viem";
import { redactUrl } from "@agate/report/env";
import { AlertCode } from "@agate/report/types";
import type { AlertSink } from "../alerts.ts";

export class RpcDown extends Error {}

/** A contract revert (or a JSON-RPC "execution reverted"): the node answered; never a reason to fail over. */
export function isRevert(e: unknown): boolean {
  if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return true;
  const m = `${(e as Error)?.message ?? e}`.toLowerCase();
  return m.includes("execution reverted") || m.includes("reverted with") || m.includes("revert");
}

export interface Endpoint {
  url: string;
  client: PublicClient;
}

export interface RpcOptions {
  urls: string[];
  expectChainId?: number;
  /** The chain id an earlier start verified (cached beside the clocks): used only when no URL answers eth_chainId,
   *  so a process can start during an RPC outage. Each URL's chain id is checked once one answers. */
  fallbackChainId?: number;
  timeoutMs: number;
  /** a head older than this (vs the local clock) is stale: max(30 s, slice / 4) */
  staleS: number;
  reprobeS?: number;
  alerts?: AlertSink;
  role: string;
  now: () => number;
  /** test hook: build a client for a URL */
  clientFor?: (url: string, timeoutMs: number) => PublicClient;
}

export class RpcPool {
  private eps: Endpoint[] = [];
  private cur = 0;
  private failedThisTick = false;
  private okThisTick = false;
  private downTicks = 0;
  private lastReprobe = 0;
  chainId = 0;
  /** false while no URL has confirmed chainId (a start on the expected or cached id with every URL down) */
  verified = false;
  readonly events: string[] = [];

  private constructor(readonly o: RpcOptions) {}

  static async create(o: RpcOptions): Promise<RpcPool> {
    const p = new RpcPool(o);
    await p.init();
    return p;
  }

  private mk(url: string): PublicClient {
    return this.o.clientFor ? this.o.clientFor(url, this.o.timeoutMs) : (createPublicClient({ transport: http(url, { timeout: this.o.timeoutMs, retryCount: 0 }) }) as PublicClient);
  }

  private chainIds(urls: readonly string[]): Promise<(number | null)[]> {
    return Promise.all(
      urls.map(async (u) => {
        try {
          return await this.mk(u).getChainId();
        } catch {
          return null;
        }
      }),
    );
  }

  /** The URLs on chain `expect`, plus the ones down now (kept, checked again later); the others dropped. */
  private keepOn(urls: readonly string[], ids: readonly (number | null)[], expect: number): Endpoint[] {
    const eps: Endpoint[] = [];
    urls.forEach((u, i) => {
      if (ids[i] === expect || ids[i] === null) eps.push({ url: u, client: this.mk(u) });
      else this.o.alerts?.raise({ code: AlertCode.RPC_FAILOVER, severity: "info", message: `${this.o.role}: dropped ${redactUrl(u)}: chain id ${ids[i]}, expected ${expect}` });
    });
    return eps;
  }

  private async init(): Promise<void> {
    const urls = [...new Set(this.o.urls.map((u) => u.trim()).filter(Boolean))];
    if (urls.length === 0) throw new Error("no RPC URL configured (AGATE_RPC_URLS_CMD or AGATE_RPC_URLS)");
    const ids = await this.chainIds(urls);
    const expect = this.o.expectChainId ?? majorityChainId(ids) ?? this.o.fallbackChainId ?? null;
    if (expect === null) throw new RpcDown("no RPC URL answered eth_chainId");
    this.chainId = expect;
    this.verified = ids.some((x) => x === expect);
    this.eps = this.keepOn(urls, ids, expect);
    if (this.eps.length === 0) throw new RpcDown(`no RPC URL on chain ${expect}`);
    if (this.eps.length === 1) this.o.alerts?.raise({ code: AlertCode.RPC_SINGLE, severity: "action", message: `${this.o.role}: only one RPC URL (${redactUrl(this.eps[0]!.url)}); configure two in AGATE_RPC_URLS_CMD or AGATE_RPC_URLS (13.4, 13.6)` });
    this.lastReprobe = this.o.now();
  }

  /** Started with no URL on the expected chain answering: drop the wrong-chain URLs once one on it answers. */
  private async verify(): Promise<void> {
    const urls = this.eps.map((e) => e.url);
    const ids = await this.chainIds(urls);
    if (!ids.some((x) => x === this.chainId)) {
      const wrong = ids.filter((x) => x !== null);
      if (wrong.length > 0) this.o.alerts?.raise({ code: AlertCode.RPC_FAILOVER, severity: "action", message: `${this.o.role}: no RPC URL answers chain ${this.chainId} (they answer ${[...new Set(wrong)].join(", ")})` });
      return;
    }
    this.eps = this.keepOn(urls, ids, this.chainId);
    this.cur = 0;
    this.verified = true;
  }

  /** Profile-specific bounds once the clock is known: rebuilds the clients with the new timeout. */
  retune(timeoutMs: number, staleS: number): void {
    this.o.timeoutMs = timeoutMs;
    this.o.staleS = staleS;
    this.eps = this.eps.map((e) => ({ url: e.url, client: this.mk(e.url) }));
  }

  get url(): string {
    return this.eps[this.cur]!.url;
  }
  get client(): PublicClient {
    return this.eps[this.cur]!.client;
  }
  clients(): PublicClient[] {
    return this.eps.map((e) => e.client);
  }
  urls(): string[] {
    return this.eps.map((e) => e.url);
  }
  /** The URLs for a log line: scheme and host only (13.6: every URL is a secret). */
  redactedUrls(): string[] {
    return this.eps.map((e) => redactUrl(e.url));
  }

  private switchTo(i: number, why: string): void {
    if (i === this.cur) return;
    const from = redactUrl(this.eps[this.cur]!.url);
    this.cur = i;
    const to = redactUrl(this.eps[i]!.url);
    this.events.push(`failover ${from} -> ${to}: ${why}`);
    this.o.alerts?.raise({ code: AlertCode.RPC_FAILOVER, severity: "info", message: `${this.o.role}: RPC ${from} -> ${to} (${why})` });
  }

  /** Runs fn on the current URL; on a transport or node failure tries the next URLs in turn. appError: errors that
   *  are the node's answer (a revert by default) are rethrown at once, never failed over. */
  async call<T>(fn: (c: PublicClient) => Promise<T>, appError: (e: unknown) => boolean = isRevert): Promise<T> {
    let last: unknown;
    for (let n = 0; n < this.eps.length; n++) {
      const i = (this.cur + n) % this.eps.length;
      try {
        const v = await fn(this.eps[i]!.client);
        if (i !== this.cur) this.switchTo(i, `previous URL failed: ${short(last)}`);
        this.okThisTick = true;
        return v;
      } catch (e) {
        if (appError(e)) {
          this.okThisTick = true;
          throw e;
        }
        last = e;
      }
    }
    this.failedThisTick = true;
    throw new RpcDown(`every RPC URL failed: ${short(last)}`);
  }

  /** Once per process tick: stale-head check, re-probe of the first URL, RPC_DOWN bookkeeping. */
  async tick(now: number): Promise<void> {
    if (!this.verified) await this.verify();
    try {
      const b = await this.call((c) => c.getBlock({ blockTag: "latest" }));
      const age = now - Number(b.timestamp);
      if (age > this.o.staleS) {
        const next = await this.firstFresh(now, this.cur);
        if (next !== null) this.switchTo(next, `stale head (${age} s behind)`);
      }
    } catch {
      // counted in failedThisTick
    }
    if (this.cur !== 0 && now - this.lastReprobe >= (this.o.reprobeS ?? 300)) {
      this.lastReprobe = now;
      if (await this.healthy(0, now)) this.switchTo(0, "first URL healthy again");
    }
    if (this.failedThisTick && !this.okThisTick) this.downTicks++;
    else if (this.okThisTick) {
      if (this.downTicks >= 2) this.o.alerts?.clearWhere((a) => a.code === AlertCode.RPC_DOWN && a.message.startsWith(`${this.o.role}:`));
      this.downTicks = 0;
    }
    if (this.downTicks >= 2) this.o.alerts?.raise({ code: AlertCode.RPC_DOWN, severity: "action", message: `${this.o.role}: every RPC URL failed on ${this.downTicks} ticks running` });
    this.failedThisTick = false;
    this.okThisTick = false;
  }

  get down(): boolean {
    return this.downTicks >= 2;
  }

  private async healthy(i: number, now: number): Promise<boolean> {
    try {
      const c = this.eps[i]!.client;
      if ((await c.getChainId()) !== this.chainId) return false;
      const b = await c.getBlock({ blockTag: "latest" });
      return now - Number(b.timestamp) <= this.o.staleS;
    } catch {
      return false;
    }
  }

  private async firstFresh(now: number, skip: number): Promise<number | null> {
    for (let n = 1; n < this.eps.length; n++) {
      const i = (skip + n) % this.eps.length;
      if (await this.healthy(i, now)) return i;
    }
    return null;
  }
}

/** No AGATE_CHAIN_ID: the chain id most answering URLs report (the writers' rule); a tie is refused, never guessed.
 *  null when no URL answered. */
export function majorityChainId(ids: readonly (number | null)[]): number | null {
  const votes = new Map<number, number>();
  for (const x of ids) if (x !== null) votes.set(x, (votes.get(x) ?? 0) + 1);
  if (votes.size === 0) return null;
  const top = Math.max(...votes.values());
  const leaders = [...votes].filter(([, n]) => n === top);
  if (leaders.length > 1) throw new Error(`RPC URLs disagree on the chain id (${[...votes.keys()].join(", ")}): set AGATE_CHAIN_ID`);
  return leaders[0]![0];
}

export function short(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

/** The http URLs of a plain list (no command, nothing deleted): for tools; processes use config.readEndpoints. */
export function parseRpcUrls(env: Record<string, string | undefined>): string[] {
  if (env.AGATE_RPC_URLS) return env.AGATE_RPC_URLS.split(/[,\r\n]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  if (env.AGATE_RPC_URL) return [env.AGATE_RPC_URL.trim()];
  return [];
}
