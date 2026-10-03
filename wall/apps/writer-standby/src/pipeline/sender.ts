// One key's transactions (BUILD-SPEC 4.14, 13.4). Every send: eth_call at "pending" first (never send what it says
// reverts); gas limit min(CAP, ceil(1.5 x max(estimate, MEASURED))), CAP = 2 x MEASURED, refused with GAS_CAP when
// 1.5 x estimate passes CAP; the RPC's fees capped by AGATE_MAX_FEE_GWEI; sequential sends with a local nonce (read
// at "pending" at start, after a wake and after any send error); the signed bytes journaled BEFORE they are
// broadcast, so a restart finds a transaction it may have sent; rebroadcast unchanged after max(3 blocks, 30 s);
// replaced (same nonce, fees + 25 %) after max(120 s, slice / 4), or cancelled (a 0-value self transfer) when its
// content's send window has closed or it would now revert; NONCE_STUCK after three replacements; "nonce too low"
// settled by looking up our own hashes. A send is done only when its receipt is read.
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex } from "@agate/report/types";
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, keccak256, type LocalAccount, parseTransaction } from "viem";
import type { KeyLock } from "./lock.ts";
import { type AlertFn, RpcDownError, RpcError, type RpcPool } from "./rpc.ts";

export type Shape = "postReport" | "closeDay" | "onReport";

/** Builder A's published worst cases (forge test --gas-report --isolate, PRODUCTION clock, 3 GPUs of 15 slots in 15
 * families, two writers): postReport and onReport 3 x 15 on a day's first slice, closeDay with the first writer
 * below quorum (both writers computed). */
export const MEASURED: Readonly<Record<Shape, bigint>> = { postReport: 512_718n, closeDay: 630_218n, onReport: 518_247n };

const ceil15 = (x: bigint) => (3n * x + 1n) / 2n;

export type GasDecision = { ok: true; limit: bigint; cap: bigint } | { ok: false; need: bigint; cap: bigint };

/** 13.4: min(CAP, ceil(1.5 x max(estimate, MEASURED))), CAP = 2 x MEASURED; refuse when 1.5 x estimate > CAP. */
export function gasLimitFor(estimate: bigint, measured: bigint): GasDecision {
  const cap = 2n * measured;
  const need = ceil15(estimate);
  if (need > cap) return { ok: false, need, cap };
  const want = ceil15(estimate > measured ? estimate : measured);
  return { ok: true, limit: want < cap ? want : cap, cap };
}

export interface TxMeta {
  action: "post" | "repost" | "close" | "backfill" | "cre";
  /** What the transaction carries: `${gpuId}:${day}:${slice}` per entry, `close:${gpuId}:${day}`. */
  tags: string[];
  /** Unix second after which this content must not be sent any more (REPOST_END, 8.1); a pending one is then cancelled. */
  deadline?: number;
  dayId?: number;
  slice?: number;
  /** Before a replacement: false when the content can no longer land (its day closed or was carried, E3); the
   * replacement is then a cancel. Not journaled: a restart falls back to the deadline. */
  useful?: () => Promise<boolean>;
}

export interface SendResult {
  ok: boolean;
  /** false when nothing was broadcast (eth_call said it reverts, GAS_CAP, key busy, RPC down). */
  sent: boolean;
  txHash?: Hex;
  gasLimit?: bigint;
  gasUsed?: bigint;
  nonce?: number;
  /** Broadcast, not mined yet: it stays in flight and later ticks finish it. */
  pending?: boolean;
  error?: string;
}

export interface TxLine {
  kind: "tx";
  index: Address;
  from: Address;
  at: number;
  nonce: number;
  hash: Hex;
  raw: Hex;
  action: TxMeta["action"] | "cancel";
  tags: string[];
  deadline?: number;
  replaces?: Hex;
}

export interface TxJournal {
  append(l: TxLine): void;
  /** This key's journaled transactions of the last two UTC days, oldest first. */
  recent(from: Address): TxLine[];
}

export interface SenderTiming {
  pollMs: number;
  rebroadcastMs: number;
  replaceMs: number;
  /** Default wait for a receipt inside one send (the tx stays in flight after it). */
  waitMs: number;
  lockWaitMs: number;
}

export function timingFor(sliceS: number): SenderTiming {
  return {
    pollMs: 500,
    rebroadcastMs: 30_000,
    replaceMs: Math.max(120, Math.floor(sliceS / 4)) * 1000,
    waitMs: Math.min(60, Math.max(5, Math.floor(sliceS / 4))) * 1000,
    lockWaitMs: Math.min(30, Math.max(2, Math.floor(sliceS / 10))) * 1000,
  };
}

interface Signed {
  hash: Hex;
  raw?: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  cancel: boolean;
}

interface Flight {
  nonce: number;
  to: Address;
  data: Hex;
  gas: bigint;
  meta: TxMeta;
  txs: Signed[];
  signedAt: number;
  broadcastAt: number;
  replacements: number;
  stuckAlerted: boolean;
  /** Adopted from the CRE CLI: not ours to cancel by content, only to see mined. */
  external?: boolean;
}

export type Settled = { kind: "mined"; hash: Hex; status: "success" | "reverted"; gasUsed: bigint; cancel: boolean } | { kind: "superseded" } | { kind: "pending" };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Revert reason as the contract names it (custom errors of IAgateIndex decoded), else the message. */
export function errText(e: unknown): string {
  if (e instanceof RpcError) {
    const data = typeof e.data === "string" ? e.data : typeof (e.data as { data?: unknown })?.data === "string" ? (e.data as { data: string }).data : undefined;
    if (data && /^0x[0-9a-fA-F]{8}/.test(data)) {
      try {
        const d = decodeErrorResult({ abi: agateIndexAbi, data: data as Hex });
        return `${d.errorName}(${(d.args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {
        // not one of ours
      }
    }
    return e.message;
  }
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) {
      return `${rev.data.errorName}(${(rev.data.args ?? []).map((a) => String(a)).join(", ")})`;
    }
    return e.shortMessage;
  }
  return errMsg(e);
}

const isNonceLow = (s: string) => /nonce too low|nonce has already been used|noncetoolow|oldnonce|invalid nonce/i.test(s);
const isKnown = (s: string) => /already known|known transaction|already imported|already exists|alreadyknown/i.test(s);
const isUnderpriced = (s: string) => /underpriced|replacement fee too low|fee too low/i.test(s);

export interface SenderOptions {
  pool: RpcPool;
  account: LocalAccount;
  index: Address;
  journal: TxJournal;
  alert?: AlertFn;
  timing: SenderTiming;
  measured?: Partial<Record<Shape, bigint>>;
  /** AGATE_MAX_FEE_GWEI in wei. */
  maxFeeWei?: bigint;
  keyLock?: KeyLock;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  say?: (event: string, data?: Record<string, unknown>) => void;
  /** "pending" (13.4); "latest" where an RPC refuses the pending tag. */
  callTag?: "pending" | "latest";
  /** The writer's clock (unix s) for content deadlines; default the wall clock. Mempool timing is always real. */
  nowS?: () => number;
}

export class TxSender {
  private nonce: number | undefined;
  private flight: Flight | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowS: () => number;
  private tag: "pending" | "latest";
  readonly measured: Record<Shape, bigint>;
  readonly from: Address;

  constructor(private readonly o: SenderOptions) {
    this.now = o.nowMs ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
    this.nowS = o.nowS ?? (() => Math.floor(this.now() / 1000));
    this.measured = { ...MEASURED, ...(o.measured ?? {}) };
    this.from = o.account.address;
    this.tag = o.callTag ?? "pending";
  }

  /** 13.4 asks for the "pending" tag; an RPC that refuses it is asked at "latest" from then on (said once). */
  private async tagged<T>(f: (tag: "pending" | "latest") => Promise<T>): Promise<T> {
    try {
      return await f(this.tag);
    } catch (e) {
      if (this.tag === "pending" && e instanceof RpcError && e.data === undefined && /pending|block tag|unknown block|invalid block|not supported/i.test(e.message)) {
        this.tag = "latest";
        this.say("rpc_pending_unsupported", { error: e.message });
        return f("latest");
      }
      throw e;
    }
  }

  private rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    return this.o.pool.request(method, params) as Promise<T>;
  }

  private say(event: string, data?: Record<string, unknown>) {
    this.o.say?.(event, data);
  }

  /** Tags carried by the transaction in flight (not mined yet). */
  inFlight(): ReadonlySet<string> {
    return new Set(this.flight?.meta.tags ?? []);
  }

  get pendingNonce(): number | undefined {
    return this.flight?.nonce;
  }

  async count(tag: "latest" | "pending"): Promise<number> {
    const get = (t: "latest" | "pending") => this.rpc<string>("eth_getTransactionCount", [this.from, t]);
    return Number(BigInt(tag === "latest" ? await get("latest") : await this.tagged(get)));
  }

  /** Local nonce from the chain's pending count (start, wake, after an error, after another process sent). */
  async resync(): Promise<void> {
    const pending = await this.count("pending");
    this.nonce = this.flight ? Math.max(pending, this.flight.nonce + 1) : pending;
  }

  /** eth_call; throws with the decoded reason when it reverts. */
  async simulate(to: Address, data: Hex): Promise<void> {
    await this.tagged((tag) => this.rpc("eth_call", [{ from: this.from, to, data }, tag]));
  }

  private async estimate(to: Address, data: Hex): Promise<bigint> {
    return BigInt(await this.tagged((tag) => this.rpc<string>("eth_estimateGas", [{ from: this.from, to, data }, tag])));
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.rpc<{ baseFeePerGas?: string } | null>("eth_getBlockByNumber", ["latest", false]);
    let tip: bigint;
    try {
      tip = BigInt(await this.rpc<string>("eth_maxPriorityFeePerGas"));
    } catch {
      tip = 1_000_000_000n;
    }
    const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : BigInt(await this.rpc<string>("eth_gasPrice"));
    let maxFee = 2n * base + tip;
    if (this.o.maxFeeWei !== undefined && maxFee > this.o.maxFeeWei) maxFee = this.o.maxFeeWei;
    if (tip > maxFee) tip = maxFee;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  }

  private async sign(nonce: number, to: Address, data: Hex, gas: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, cancel = false): Promise<Signed> {
    const raw = await this.o.account.signTransaction({
      type: "eip1559",
      chainId: this.o.pool.chainId,
      nonce,
      to: cancel ? this.from : to,
      data: cancel ? "0x" : data,
      gas: cancel ? 21_000n : gas,
      value: 0n,
      ...fees,
    });
    return { hash: keccak256(raw), raw, ...fees, cancel };
  }

  private journal(f: { nonce: number; meta: TxMeta }, t: Signed, replaces?: Hex) {
    if (!t.raw) return;
    this.o.journal.append({
      kind: "tx",
      index: this.o.index,
      from: this.from,
      at: Math.floor(Date.now() / 1000), // the wall clock: the journal is about mempools, and is found by it
      nonce: f.nonce,
      hash: t.hash,
      raw: t.raw,
      action: t.cancel ? "cancel" : f.meta.action,
      tags: f.meta.tags,
      ...(f.meta.deadline !== undefined ? { deadline: f.meta.deadline } : {}),
      ...(replaces ? { replaces } : {}),
    });
  }

  /** First broadcast: the current URL (with failover). */
  private async broadcast(raw: Hex): Promise<{ ok: boolean; known?: boolean; nonceLow?: boolean; underpriced?: boolean; unknown?: boolean; error?: string }> {
    try {
      await this.rpc("eth_sendRawTransaction", [raw]);
      return { ok: true };
    } catch (e) {
      const m = errMsg(e);
      if (isKnown(m)) return { ok: true, known: true };
      // no node answered: it may have reached one anyway, so it is treated as sent (in flight), never as unsent
      if (e instanceof RpcDownError) return { ok: false, unknown: true, error: m };
      return { ok: false, nonceLow: isNonceLow(m), underpriced: isUnderpriced(m), error: m };
    }
  }

  private async rebroadcast(f: Flight): Promise<void> {
    f.broadcastAt = this.now();
    const t = f.txs.at(-1);
    if (!t?.raw) return;
    const res = await this.o.pool.broadcastAll(t.raw);
    this.say("tx_rebroadcast", { nonce: f.nonce, hash: t.hash, answers: res.map((r) => (r.ok ? "ok" : r.error.slice(0, 80))) });
  }

  private async receipt(hash: Hex): Promise<{ status: string; gasUsed: string } | null> {
    return this.rpc<{ status: string; gasUsed: string } | null>("eth_getTransactionReceipt", [hash]);
  }

  /** One look at the flight: mined, superseded, or still pending (rebroadcast or replaced when due). */
  private async step(f: Flight): Promise<Settled> {
    for (const t of [...f.txs].reverse()) {
      const rc = await this.receipt(t.hash);
      if (rc) return { kind: "mined", hash: t.hash, status: rc.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(rc.gasUsed ?? 0), cancel: t.cancel };
    }
    if ((await this.count("latest")) > f.nonce) {
      for (const t of f.txs) {
        const rc = await this.receipt(t.hash);
        if (rc) return { kind: "mined", hash: t.hash, status: rc.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(rc.gasUsed ?? 0), cancel: t.cancel };
      }
      return { kind: "superseded" };
    }
    const t = this.now();
    if (t - f.signedAt >= this.o.timing.replaceMs) await this.replace(f);
    else if (t - f.broadcastAt >= this.o.timing.rebroadcastMs) await this.rebroadcast(f);
    return { kind: "pending" };
  }

  private async replace(f: Flight): Promise<void> {
    if (f.replacements >= 3 && !f.stuckAlerted) {
      f.stuckAlerted = true;
      this.o.alert?.({
        code: "NONCE_STUCK",
        severity: "action",
        message: `nonce ${f.nonce} of ${this.from} still unmined after ${f.replacements} replacements`,
        data: { nonce: f.nonce, hashes: f.txs.map((x) => x.hash), tags: f.meta.tags },
      });
    }
    const last = f.txs.at(-1)!;
    let maxFee = (last.maxFeePerGas * 125n + 99n) / 100n;
    let tip = (last.maxPriorityFeePerGas * 125n + 99n) / 100n;
    const live = await this.fees().catch(() => undefined);
    if (live && live.maxFeePerGas > maxFee) maxFee = live.maxFeePerGas;
    if (this.o.maxFeeWei !== undefined && maxFee > this.o.maxFeeWei) maxFee = this.o.maxFeeWei;
    if (tip > maxFee) tip = maxFee;
    f.signedAt = this.now();
    if (maxFee <= last.maxFeePerGas) {
      // the fee cap allows no higher bid: keep the one we have in every mempool
      await this.rebroadcast(f);
      return;
    }
    let cancel = last.cancel || Boolean(f.external);
    if (!cancel) {
      const past = f.meta.deadline !== undefined && this.nowS() > f.meta.deadline;
      let reverts = false;
      if (!past) {
        try {
          await this.simulate(f.to, f.data);
        } catch {
          reverts = true;
        }
      }
      let useless = false;
      if (!past && !reverts && f.meta.useful) useless = !(await f.meta.useful().catch(() => true));
      cancel = past || reverts || useless;
    }
    const t = await this.sign(f.nonce, f.to, f.data, f.gas, { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }, cancel);
    this.journal(f, t, last.hash);
    const res = await this.o.pool.broadcastAll(t.raw!);
    const accepted = res.some((r) => r.ok || isKnown(r.error));
    this.say("tx_replace", { nonce: f.nonce, from: last.hash, to: t.hash, cancel, accepted, answers: res.map((r) => (r.ok ? "ok" : r.error.slice(0, 80))) });
    if (accepted) {
      f.txs.push(t);
      f.replacements += 1;
      f.broadcastAt = this.now();
    }
  }

  /** Drives the flight until it settles or untilMs passes. Releases the key when it settles. */
  async settle(untilMs: number): Promise<Settled> {
    const f = this.flight;
    if (!f) throw new Error("settle: nothing in flight");
    for (;;) {
      const s = await this.step(f);
      if (s.kind !== "pending") {
        this.flight = undefined;
        if (s.kind === "superseded") await this.resync().catch(() => (this.nonce = undefined));
        else this.nonce = Math.max(this.nonce ?? 0, f.nonce + 1);
        this.o.keyLock?.release();
        this.say("tx_settled", { nonce: f.nonce, ...s, ...("gasUsed" in s ? { gasUsed: s.gasUsed.toString() } : {}) });
        return s;
      }
      if (this.now() >= untilMs) return s;
      await this.sleep(this.o.timing.pollMs);
    }
  }

  /** One non-blocking look at the flight (each tick). */
  async poll(): Promise<void> {
    if (this.flight) await this.settle(0);
  }

  async send(o: { to: Address; data: Hex; shape: Shape; meta: TxMeta; waitUntilMs?: number }): Promise<SendResult> {
    const until = o.waitUntilMs ?? this.now() + this.o.timing.waitMs;
    if (this.flight) {
      const s = await this.settle(until);
      if (s.kind === "pending") return { ok: false, sent: false, error: `nonce ${this.flight.nonce} still in flight` };
    }
    if (this.o.keyLock && !(await this.o.keyLock.acquire())) return { ok: false, sent: false, error: "key busy: another process is sending with this key" };
    let keep = false;
    try {
      try {
        await this.simulate(o.to, o.data);
      } catch (e) {
        if (e instanceof RpcDownError) throw e; // no node answered: not a revert
        return { ok: false, sent: false, error: errText(e) };
      }
      let est: bigint;
      try {
        est = await this.estimate(o.to, o.data);
      } catch (e) {
        if (e instanceof RpcDownError) throw e;
        return { ok: false, sent: false, error: `estimate: ${errText(e)}` };
      }
      const g = gasLimitFor(est, this.measured[o.shape]);
      if (!g.ok) {
        this.o.alert?.({
          code: "GAS_CAP",
          severity: "action",
          message: `${o.shape} needs ${g.need} gas (1.5 x estimate ${est}), over its cap ${g.cap} (2 x MEASURED): not sent`,
          data: { shape: o.shape, estimate: est.toString(), cap: g.cap.toString(), tags: o.meta.tags },
        });
        return { ok: false, sent: false, error: `GAS_CAP: need ${g.need}, cap ${g.cap}` };
      }
      const fees = await this.fees();
      if (this.nonce === undefined) await this.resync();
      let nonce = this.nonce!;
      let t = await this.sign(nonce, o.to, o.data, g.limit, fees);
      const f: Flight = { nonce, to: o.to, data: o.data, gas: g.limit, meta: o.meta, txs: [t], signedAt: this.now(), broadcastAt: this.now(), replacements: 0, stuckAlerted: false };
      this.journal(f, t);
      let b = await this.broadcast(t.raw!);
      if (!b.ok && b.nonceLow && (await this.receipt(t.hash).catch(() => null))) {
        // a URL took it before its answer was lost and the failover's URL found the nonce used: ours, mined
        b = { ok: true };
      } else if (!b.ok && b.nonceLow) {
        // our counter was behind (another sender used the key): re-read, check the call again, sign again once
        await this.resync();
        try {
          await this.simulate(o.to, o.data);
        } catch (e) {
          if (e instanceof RpcDownError) throw e;
          return { ok: false, sent: false, error: errText(e) };
        }
        nonce = this.nonce!;
        t = await this.sign(nonce, o.to, o.data, g.limit, fees);
        f.nonce = nonce;
        f.txs = [t];
        this.journal(f, t);
        b = await this.broadcast(t.raw!);
      }
      if (!b.ok && !b.unknown) {
        await this.resync().catch(() => (this.nonce = undefined));
        return { ok: false, sent: false, gasLimit: g.limit, error: b.error ?? "broadcast failed" };
      }
      this.nonce = nonce + 1;
      this.flight = f;
      keep = true;
      if (b.unknown) {
        f.broadcastAt = 0; // rebroadcast the same bytes at the next look
        return { ok: false, sent: true, pending: true, txHash: t.hash, gasLimit: g.limit, nonce, error: `broadcast outcome unknown (${b.error}): in flight` };
      }
      const s = await this.settle(until);
      const base = { txHash: t.hash, gasLimit: g.limit, nonce };
      if (s.kind === "pending") return { ok: false, sent: true, pending: true, ...base, error: "not mined yet (in flight)" };
      if (s.kind === "superseded") return { ok: false, sent: true, ...base, error: "superseded: the nonce was used by another transaction" };
      if (s.cancel) return { ok: false, sent: true, ...base, txHash: s.hash, gasUsed: s.gasUsed, error: "cancelled" };
      return s.status === "success" ? { ok: true, sent: true, ...base, txHash: s.hash, gasUsed: s.gasUsed } : { ok: false, sent: true, ...base, txHash: s.hash, gasUsed: s.gasUsed, error: "reverted onchain" };
    } catch (e) {
      await this.resync().catch(() => (this.nonce = undefined));
      throw e;
    } finally {
      if (!keep && !this.flight) this.o.keyLock?.release();
    }
  }

  /** Runs fn (another program sending with this key: the CRE CLI) with no flight of ours and the key held, then
   * re-reads the nonce. Returns undefined when our own flight did not settle by untilMs or the key is busy. */
  async exclusive<T>(fn: () => Promise<T>, untilMs: number): Promise<T | undefined> {
    if (this.flight && (await this.settle(untilMs)).kind === "pending") return undefined;
    if (this.o.keyLock && !(await this.o.keyLock.acquire())) return undefined;
    try {
      return await fn();
    } finally {
      this.o.keyLock?.release();
      await this.resync().catch(() => (this.nonce = undefined));
    }
  }

  /** Takes over a transaction another program broadcast with this key (the CRE CLI) while it is unmined. */
  async adopt(hash: Hex, meta: TxMeta): Promise<boolean> {
    if (this.flight) return false;
    if (await this.receipt(hash)) return false;
    const tx = await this.rpc<{ nonce: string; to: Address; input: Hex; gas: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; gasPrice?: string } | null>("eth_getTransactionByHash", [hash]);
    if (!tx) return false;
    const fee = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? "0");
    this.flight = {
      nonce: Number(BigInt(tx.nonce)),
      to: tx.to,
      data: tx.input,
      gas: BigInt(tx.gas),
      meta,
      txs: [{ hash, maxFeePerGas: fee, maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? tx.gasPrice ?? "0"), cancel: false }],
      signedAt: this.now(),
      broadcastAt: this.now(),
      replacements: 0,
      stuckAlerted: false,
      external: true,
    };
    if (this.o.keyLock) await this.o.keyLock.acquire();
    this.say("tx_adopted", { hash, nonce: this.flight.nonce });
    return true;
  }

  /** After a restart: a journaled transaction whose nonce the chain has not used yet is either still in a mempool
   * (adopted, finished as usual) or gone (rebroadcast as the same bytes while its content may still be sent and
   * would not revert; otherwise forgotten, and its nonce is reused). */
  async reconcile(): Promise<{ adopted?: number; dropped: Hex[] }> {
    const dropped: Hex[] = [];
    const latest = await this.count("latest");
    const open = this.o.journal.recent(this.from).filter((l) => l.nonce >= latest && l.index.toLowerCase() === this.o.index.toLowerCase());
    await this.resync();
    if (open.length === 0 || this.flight) return { dropped };
    const n = Math.min(...open.map((l) => l.nonce));
    const group = open.filter((l) => l.nonce === n);
    const first = group.find((l) => l.action !== "cancel") ?? group[0]!;
    const parsed = parseTransaction(first.raw);
    const txs: Signed[] = group.map((l) => {
      const p = parseTransaction(l.raw);
      return { hash: l.hash, raw: l.raw, maxFeePerGas: p.maxFeePerGas ?? p.gasPrice ?? 0n, maxPriorityFeePerGas: p.maxPriorityFeePerGas ?? p.gasPrice ?? 0n, cancel: l.action === "cancel" };
    });
    const meta: TxMeta = { action: first.action === "cancel" ? "post" : first.action, tags: first.tags, ...(first.deadline !== undefined ? { deadline: first.deadline } : {}) };
    let known = false;
    for (const t of txs) {
      if ((await this.receipt(t.hash)) || (await this.rpc<unknown>("eth_getTransactionByHash", [t.hash]))) known = true;
    }
    if (!known) {
      const last = txs.at(-1)!;
      const stale = meta.deadline !== undefined && this.nowS() > meta.deadline;
      let reverts = false;
      if (!stale && !last.cancel) {
        try {
          await this.simulate(parsed.to as Address, (parsed.data ?? "0x") as Hex);
        } catch {
          reverts = true;
        }
      }
      if (stale || reverts || last.cancel) {
        dropped.push(...txs.map((t) => t.hash));
        this.say("tx_forgotten", { nonce: n, hashes: dropped, why: stale ? "window closed" : last.cancel ? "cancel" : "would revert" });
        return { dropped };
      }
    }
    if (this.o.keyLock) await this.o.keyLock.acquire();
    this.flight = {
      nonce: n,
      to: parsed.to as Address,
      data: (parsed.data ?? "0x") as Hex,
      gas: parsed.gas ?? 0n,
      meta,
      txs,
      signedAt: this.now(),
      broadcastAt: known ? this.now() : 0,
      replacements: Math.max(0, txs.length - 1),
      stuckAlerted: false,
    };
    this.nonce = Math.max(this.nonce ?? 0, n + 1);
    if (!known) await this.rebroadcast(this.flight);
    this.say("tx_reconciled", { nonce: n, known, hashes: txs.map((t) => t.hash) });
    return { adopted: n, dropped };
  }
}
