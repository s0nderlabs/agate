// The writer pipeline both writers share (BUILD-SPEC 8.1, rule R v4.3, D10). tick(now) is the whole loop body: it
// takes the time as an argument so e2e can drive it on a warped anvil clock. Per slice: read at a random second,
// log, send, read the slice bits back, repost logged entries whose bits are missing (only until sendDeadline: F1),
// close. A start, or a gap of more than three tick periods (a machine sleep), runs the wake routine first: the nonce
// and the transaction journal are reconciled with the chain, and a slice whose read window has passed is skipped.
// Each phase runs on its own, so a dead RPC never stops the pages from being read and logged.
import type { Address, Entry, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import {
  type Clock,
  clockOf,
  closableAt,
  dayIdAt,
  entryToJson,
  pendEnd,
  type Reading,
  readAtFor,
  readOffset,
  readWindow,
  reportHex,
  sendDeadline,
  sliceAt,
  sliceStart,
  tickPeriod,
} from "../core/index.ts";
import type { IndexChain, SendResult, TxMeta } from "./chain.ts";
import type { ReadingLog, Role } from "./log.ts";
import { writeHeartbeat } from "./ops.ts";
import { type AlertFn, RpcDownError } from "./rpc.ts";

export interface TakeResult {
  reading: Reading;
  via: "cre" | "direct";
  /** Set when the source already sent the report (the CRE path broadcasts it itself). */
  sent?: SendResult;
  ms?: number;
  error?: string;
}

export interface ReadingSource {
  take(at: { dayId: number; slice: number; readAt: number }): Promise<TakeResult>;
}

export interface WriterConfig {
  role: Role;
  chain: IndexChain;
  clock: Clock;
  chainSelector: bigint;
  panels: readonly Panel[];
  log: ReadingLog;
  source: ReadingSource;
  rand?: () => number;
  say?: (event: string, data?: Record<string, unknown>) => void;
  alert?: AlertFn;
  /** <home>/<role>: heartbeat.json is written here every tick (13.4). */
  heartbeatDir?: string;
  /** The loop's period in seconds (default min(20, slice / 30)); a gap of more than three is a wake (8.1 step 5). */
  tickS?: number;
  /** Most reposts of one (gpu, day, slice); default 8 (the doubling backoff reaches the F1 deadline first). */
  maxRepostTries?: number;
  /** How long one send may wait for its receipt before leaving it in flight (default min(60, slice / 4) s). */
  sendWaitS?: number;
  nowMs?: () => number;
}

export interface TickResult {
  wake?: { slept: number | null };
  read?: { dayId: number; slice: number; ok: boolean; txHash?: Hex; error?: string; via: "cre" | "direct" };
  skipped?: { dayId: number; slice: number; reason: string };
  reposts: { dayId: number; slice: number; gpuIds: Hex[]; ok: boolean; pending?: boolean; error?: string }[];
  closes: { gpuId: Hex; dayId: number; ok: boolean; error?: string }[];
  abandoned: { dayId: number; slice: number; gpuIds: Hex[]; reason: string }[];
  errors: string[];
}

const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const ZERO = /^0x0{40}$/i;

export class Writer {
  private readonly rand: () => number;
  private readonly say: NonNullable<WriterConfig["say"]>;
  private readonly nowMs: () => number;
  readonly tickS: number;
  private readonly sendWaitS: number;
  private lastTickEnd: number | undefined;
  private wakeAt: number | undefined;
  private needResync = true;
  private readonly plan = new Map<string, number>();
  private readonly done = new Set<string>();
  private readonly bits = new Map<string, bigint>();
  private readonly retryAt = new Map<string, number>();
  private readonly tries = new Map<string, number>();
  private readonly closeAt = new Map<string, number>();
  private readonly jitter = new Map<string, number>();
  private readonly synced = new Map<number, number>();
  private readonly heads = new Map<Hex, number>();
  private readonly finished = new Set<number>();
  private finishFrom: number | undefined;
  private entriesCache = new Map<number, Map<number, Map<Hex, Entry>>>();
  private rpcDownTicks = 0;
  private skewTicks = 0;
  private skewAlerted = false;
  private tickNo = 0;
  private lastAction = "start";

  constructor(private readonly c: WriterConfig) {
    this.rand = c.rand ?? Math.random;
    this.say = c.say ?? (() => {});
    this.nowMs = c.nowMs ?? Date.now;
    this.tickS = c.tickS ?? tickPeriod(c.clock);
    this.sendWaitS = c.sendWaitS ?? Math.min(60, Math.max(2, Math.floor(c.clock.slice / 4)));
  }

  get me(): Address {
    return this.c.chain.writer;
  }

  private alert(a: Parameters<AlertFn>[0]) {
    this.c.alert?.(a);
  }

  private waitUntil(): number {
    return this.nowMs() + this.sendWaitS * 1000;
  }

  async tick(now: number): Promise<TickResult> {
    const t0 = this.nowMs();
    const out: TickResult = { reposts: [], closes: [], abandoned: [], errors: [] };
    let rpcDown = false;
    const phase = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof RpcDownError) rpcDown = true;
        const error = e instanceof Error ? e.message : String(e);
        out.errors.push(`${name}: ${error}`);
        this.say("tick_error", { phase: name, error });
      }
    };

    const slept = this.lastTickEnd === undefined ? null : now - this.lastTickEnd;
    if (slept === null || slept > 3 * this.tickS) this.wake(now, slept, out);
    if (this.needResync) {
      await phase("wake", async () => {
        await this.c.chain.resync();
        const ck = clockOf(await this.c.chain.clocks());
        const mine = this.c.clock;
        if (ck.day !== mine.day || ck.slices !== mine.slices || ck.epochTs !== mine.epochTs || ck.epochDay !== mine.epochDay || ck.tPend !== mine.tPend) {
          throw new Error(`the index's clocks() no longer match this process's clock: restart it`);
        }
        this.needResync = false;
      });
    }
    await phase("read", () => this.readPhase(now, out));
    await phase("poll", async () => this.checkSkew(now, await this.c.chain.poll(now)));
    await phase("sync", () => this.syncPhase(now, out));
    await phase("close", () => this.closePhase(now, out));

    if (rpcDown) {
      this.rpcDownTicks += 1;
      if (this.rpcDownTicks === 2) this.alert({ code: "RPC_DOWN", severity: "action", message: `every RPC URL failed on two ticks running (${this.c.role})`, data: { errors: out.errors } });
    } else this.rpcDownTicks = 0;
    this.tickNo += 1;
    this.lastTickEnd = now + Math.floor((this.nowMs() - t0) / 1000);
    if (this.c.heartbeatDir) {
      try {
        writeHeartbeat(
          this.c.heartbeatDir,
          { pid: process.pid, role: this.c.role, index: this.c.chain.index, at: now, tick: this.tickNo, lastAction: this.lastAction },
          `heartbeat-${this.c.chain.index.slice(2, 10).toLowerCase()}.json`,
        );
      } catch (e) {
        out.errors.push(`heartbeat: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ wake (8.1 step 5)

  /** Every in-memory schedule is suspect after a sleep: drop them; the chain and the log are the state. */
  private wake(now: number, slept: number | null, out: TickResult) {
    out.wake = { slept };
    this.wakeAt = now;
    this.needResync = true;
    this.retryAt.clear();
    this.synced.clear();
    this.closeAt.clear();
    this.entriesCache.clear();
    const { log, chain, role } = this.c;
    log.append({ kind: "wake", index: chain.index, role, at: now, slept });
    if (slept !== null) {
      this.alert({ code: "CLOCK_JUMP", severity: "info", message: `${role} woke after ${slept} s without a tick`, data: { slept } });
      this.finishFrom = Math.min(this.finishFrom ?? Infinity, dayIdAt(this.c.clock, now - slept) - 1);
    }
    this.lastAction = slept === null ? "start" : "wake";
    this.say(slept === null ? "start_tick" : "wake", { slept });
  }

  // ------------------------------------------------------------------ reading

  private entriesOf(d: number): Map<number, Map<Hex, Entry>> {
    let m = this.entriesCache.get(d);
    if (!m) {
      m = this.c.log.entriesOf(this.c.chain.index, this.c.clock, d);
      this.entriesCache.set(d, m);
      if (this.entriesCache.size > 4) this.entriesCache.delete(this.entriesCache.keys().next().value!);
    }
    return m;
  }

  private async readPhase(now: number, out: TickResult) {
    const { clock } = this.c;
    const cur = sliceAt(clock, now);
    const key = `${cur.dayId}:${cur.slice}`;
    if (this.done.has(key)) return;
    if (this.entriesOf(cur.dayId).has(cur.slice)) {
      this.done.add(key);
      return;
    }
    const off = now - cur.start;
    let at = this.plan.get(key);
    if (this.wakeAt === now) {
      // never fetch for a slice whose read window has passed (it is lost: one missing bit, the day closes incomplete)
      const [, hi] = readWindow(clock);
      if (off >= hi) {
        this.done.add(key);
        const reason = `started or woke ${off} s into the slice, after its read window [${readWindow(clock).join(", ")})`;
        this.c.log.append({ kind: "skip", index: this.c.chain.index, role: this.c.role, at: now, dayId: cur.dayId, slice: cur.slice, reason });
        out.skipped = { dayId: cur.dayId, slice: cur.slice, reason };
        this.say("skip", out.skipped);
        return;
      }
      if (at === undefined || at < now) at = cur.start + readOffset(clock, this.rand(), off);
    }
    if (at === undefined) at = cur.start + readOffset(clock, this.rand());
    this.plan.set(key, at);
    if (this.plan.size > 64) this.plan.delete(this.plan.keys().next().value!);
    if (now < at) return;
    this.done.add(key);
    if (this.done.size > 512) this.done.delete(this.done.values().next().value!);
    out.read = await this.read(cur.dayId, cur.slice, now);
  }

  private async read(dayId: number, slice: number, now: number): Promise<TickResult["read"]> {
    const { chain, log, role, clock } = this.c;
    const t0 = this.nowMs();
    let r: TakeResult;
    try {
      const at = readAtFor(clock, now);
      r = await this.c.source.take({ dayId: at.dayId, slice: at.slice, readAt: at.readAt });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.say("read_failed", { dayId, slice, error });
      return { dayId, slice, ok: false, error, via: "direct" };
    }
    const rd = r.reading;
    log.append({
      kind: "reading",
      index: chain.index,
      role,
      dayId: rd.dayId,
      slice: rd.slice,
      readAt: rd.readAt,
      entries: rd.entries.map(entryToJson),
      sources: rd.sources,
      via: r.via,
      ...(r.sent?.txHash ? { txHash: r.sent.txHash } : {}),
      ms: r.ms ?? this.nowMs() - t0,
      ...(r.error ? { error: r.error } : {}),
    });
    this.lastAction = `read ${rd.dayId}/${rd.slice}`;
    this.entriesCache.delete(rd.dayId);
    this.done.add(`${rd.dayId}:${rd.slice}`);

    const meta: TxMeta = {
      action: r.via === "cre" ? "cre" : "post",
      tags: rd.entries.map((e) => `${e.gpuId}:${rd.dayId}:${rd.slice}`),
      deadline: sendDeadline(clock, rd.dayId),
      dayId: rd.dayId,
      slice: rd.slice,
    };
    let sent = r.sent;
    if (sent?.txHash && !sent.ok) {
      // the CRE CLI broadcast it and gave up waiting: finish it as ours rather than send the entries twice
      if (await chain.adopt(sent.txHash, meta).catch(() => false)) sent = { ...sent, pending: true };
    }
    if (!sent && rd.entries.length > 0) {
      if (now > sendDeadline(clock, rd.dayId)) sent = { ok: false, sent: false, error: "past the F1 send deadline" };
      else sent = await chain.postReport(reportHex(this.c.chainSelector, chain.index, rd.entries), meta, this.waitUntil());
      this.logSend(now, "post", rd.dayId, rd.slice, rd.entries, sent);
    }
    // a repost of these entries waits one backoff: a receipt may still be on its way through a lagging node
    for (const e of rd.entries) this.retryAt.set(`${e.gpuId}:${rd.dayId}:${rd.slice}`, now + this.backoff(0));
    let landed = false;
    try {
      await this.sync(rd.dayId, now, true);
      landed = rd.entries.every((e) => this.hasBit(e.gpuId, rd.dayId, rd.slice));
    } catch (e) {
      if (!(e instanceof RpcDownError)) throw e;
    }
    const res = {
      dayId: rd.dayId,
      slice: rd.slice,
      ok: Boolean(sent?.ok) && landed,
      via: r.via,
      ...(sent?.txHash ? { txHash: sent.txHash } : {}),
      ...(sent?.error || !landed ? { error: sent?.error ?? r.error ?? "slice bit not set after send" } : {}),
    };
    this.say("read", res);
    return res;
  }

  // ------------------------------------------------------------------ read-back, reposts, abandoned entries

  /** slice / 10, doubling per try, so a stuck slice keeps a last try near the F1 deadline without spamming. */
  private backoff(tries: number): number {
    return Math.max(1, Math.floor(this.c.clock.slice / 10)) * 2 ** tries;
  }

  private hasBit(gpuId: Hex, d: number, h: number): boolean {
    const b = this.bits.get(`${gpuId}:${d}`);
    return b !== undefined && ((b >> BigInt(h)) & 1n) === 1n;
  }

  private async sync(d: number, now: number, force: boolean): Promise<void> {
    const every = Math.max(1, Math.floor(this.c.clock.slice / 12));
    if (!force && now - (this.synced.get(d) ?? -Infinity) < every) return;
    for (const p of this.c.panels) {
      const g = p.gpuId as Hex;
      const r = await this.c.chain.readings(g, d, this.me);
      this.bits.set(`${g}:${d}`, BigInt(r.sliceBits));
    }
    this.synced.set(d, now);
  }

  private async syncPhase(now: number, out: TickResult) {
    const { clock, chain } = this.c;
    for (const p of this.c.panels) this.heads.set(p.gpuId as Hex, await chain.head(p.gpuId as Hex));
    const cur = dayIdAt(clock, now);
    // days whose send window has closed: yesterday and the day before, and after a sleep every day back to it
    for (let d = Math.max(Math.min(this.finishFrom ?? cur - 2, cur - 2), cur - 31); d < cur; d++) {
      if (!this.finished.has(d) && now > sendDeadline(clock, d)) await this.finishDay(d, now, out);
    }
    this.finishFrom = undefined;
    for (const d of this.finished) if (d < cur - 32) this.finished.delete(d);
    // per-entry schedules of days whose window has closed are never read again
    for (const m of [this.retryAt, this.tries]) {
      for (const k of m.keys()) if (Number(k.split(":")[1]) < cur - 2) m.delete(k);
    }
    const oldestHead = Math.min(...this.c.panels.map((p) => this.heads.get(p.gpuId as Hex) ?? 0));
    for (const m of [this.closeAt, this.jitter]) {
      for (const k of m.keys()) if (Number(k.split(":")[1]) < oldestHead) m.delete(k);
    }
    for (const k of this.bits.keys()) if (Number(k.split(":")[1]) < cur - 2) this.bits.delete(k);
    for (const d of this.synced.keys()) if (d < cur - 2) this.synced.delete(d);
    for (const d of [cur - 1, cur]) {
      if (now > sendDeadline(clock, d)) continue;
      if (!this.c.panels.some((p) => (this.heads.get(p.gpuId as Hex) ?? 0) <= d)) continue;
      await this.sync(d, now, false);
      out.reposts.push(...(await this.repost(d, now)));
    }
  }

  /** Once a day's send window has closed: every logged entry whose bit is missing is logged as abandoned. */
  private async finishDay(d: number, now: number, out: TickResult) {
    const logged = this.entriesOf(d);
    if (logged.size === 0) {
      this.finished.add(d);
      return;
    }
    const bits = new Map<Hex, bigint>();
    for (const p of this.c.panels) bits.set(p.gpuId as Hex, BigInt((await this.c.chain.readings(p.gpuId as Hex, d, this.me)).sliceBits));
    for (const [h, byGpu] of [...logged].sort((a, b) => a[0] - b[0])) {
      const gpuIds = [...byGpu.keys()].filter((g) => bits.has(g) && !((bits.get(g)! >> BigInt(h)) & 1n));
      if (gpuIds.length === 0) continue;
      const closed = gpuIds.some((g) => (this.heads.get(g) ?? 0) > d);
      const reason = closed ? "the day closed without it" : "its send window (F1) closed";
      this.c.log.append({ kind: "abandon", index: this.c.chain.index, role: this.c.role, at: now, dayId: d, slice: h, gpuIds, reason });
      out.abandoned.push({ dayId: d, slice: h, gpuIds, reason });
      this.say("abandoned", { dayId: d, slice: h, gpuIds, reason });
    }
    this.finished.add(d);
  }

  private async repost(d: number, now: number): Promise<TickResult["reposts"]> {
    const out: TickResult["reposts"] = [];
    const { clock, chain } = this.c;
    const maxTries = this.c.maxRepostTries ?? 8;
    const inFlight = chain.inFlight();
    const voided = new Map<Hex, boolean>();
    let sentAny = false;
    for (const [h, byGpu] of [...this.entriesOf(d)].sort((a, b) => a[0] - b[0])) {
      if (sliceStart(clock, d, h) > now) continue;
      const missing: Entry[] = [];
      for (const [g, e] of byGpu) {
        if ((this.heads.get(g) ?? Infinity) > d) continue; // closed (or not one of our panels)
        if (!this.bits.has(`${g}:${d}`) || this.hasBit(g, d, h)) continue;
        const k = `${g}:${d}:${h}`;
        if (inFlight.has(k)) continue; // sent and not mined yet: never twice
        if (now < (this.retryAt.get(k) ?? 0) || (this.tries.get(k) ?? 0) >= maxTries) continue;
        if (!voided.has(g)) voided.set(g, await chain.isVoided(g, d, this.me));
        if (voided.get(g)) continue; // E4: a vetoed day takes nothing more from us
        missing.push(e);
      }
      if (missing.length === 0) continue;
      for (const e of missing) {
        const k = `${e.gpuId}:${d}:${h}`;
        const n = (this.tries.get(k) ?? 0) + 1;
        this.tries.set(k, n);
        this.retryAt.set(k, now + this.backoff(n));
      }
      const meta: TxMeta = { action: "repost", tags: missing.map((e) => `${e.gpuId}:${d}:${h}`), deadline: sendDeadline(clock, d), dayId: d, slice: h };
      const res = await chain.postReport(reportHex(this.c.chainSelector, chain.index, missing), meta, this.waitUntil());
      this.logSend(now, "repost", d, h, missing, res);
      sentAny = sentAny || res.sent;
      const item = { dayId: d, slice: h, gpuIds: missing.map((e) => e.gpuId), ok: res.ok, ...(res.pending ? { pending: true } : {}), ...(res.error ? { error: res.error } : {}) };
      this.say("repost", item);
      out.push(item);
      if (!res.ok && (res.pending || /in flight|key busy/.test(res.error ?? ""))) break; // the key is busy: next tick
    }
    if (sentAny) await this.sync(d, now, true);
    return out;
  }

  // ------------------------------------------------------------------ close (8.1 step 3, v4.3)

  /** C3's first writer: the first writer slot address, nonzero, not suspended, not voided for d, with valid readings. */
  private async firstWriter(g: Hex, d: number): Promise<Address | undefined> {
    const { chain } = this.c;
    for (const w of await chain.writers()) {
      if (ZERO.test(w)) continue;
      if (await chain.isSuspended(w)) continue;
      if (await chain.isVoided(g, d, w)) continue;
      if ((await chain.readings(g, d, w)).anyValid) return w;
    }
    return undefined;
  }

  /** The first writer closes at dayEnd + CLOSE_GRACE (+ jitter): C3 makes it the source when it is quorate, complete or
   * not, and every repost of its window has landed or been dropped by then. Any other writer closes from dayEnd +
   * T_PEND if the day is still open. eth_call decides the rest (C2 a pending record, C3 below quorum). */
  private async closePhase(now: number, out: TickResult) {
    const { clock, chain } = this.c;
    for (const p of this.c.panels) {
      const g = p.gpuId as Hex;
      const d = this.heads.get(g) ?? (await chain.head(g));
      if (now < closableAt(clock, d)) continue;
      const key = `${g}:${d}`;
      if (now < (this.closeAt.get(key) ?? 0)) continue;
      let j = this.jitter.get(key);
      if (j === undefined) {
        j = Math.floor(this.rand() * Math.max(1, Math.floor(clock.slice / 20)));
        this.jitter.set(key, j);
      }
      const first = await this.firstWriter(g, d);
      if (!first) {
        this.closeAt.set(key, now + clock.slice); // nobody has readings: no close, the keeper carries
        continue;
      }
      const at = (same(first, this.me) ? closableAt(clock, d) : pendEnd(clock, d)) + j;
      if (now < at) {
        this.closeAt.set(key, at);
        continue;
      }
      const res = await chain.closeDay(g, { action: "close", tags: [`close:${g}:${d}`], dayId: d }, this.waitUntil());
      this.logSend(now, "close", d, undefined, [], res, [g]);
      if (res.ok) {
        this.heads.set(g, d + 1);
        this.lastAction = `close ${d}`;
      } else this.closeAt.set(key, now + Math.max(1, Math.floor(clock.slice / 6)));
      const item = { gpuId: g, dayId: d, ok: res.ok, ...(res.error ? { error: res.error } : {}) };
      this.say("close", item);
      out.closes.push(item);
    }
  }

  // ------------------------------------------------------------------ clock skew (13.4)

  private checkSkew(now: number, head: number | undefined) {
    if (head === undefined) return;
    const lim = Math.max(5, Math.floor(this.c.clock.slice / 20));
    if (Math.abs(now - head) <= lim) {
      this.skewTicks = 0;
      this.skewAlerted = false;
      return;
    }
    this.skewTicks += 1;
    if (this.skewTicks >= 3 && !this.skewAlerted) {
      this.skewAlerted = true;
      this.alert({ code: "CLOCK_SKEW", severity: "action", message: `local clock ${now} and chain head ${head} differ by ${now - head} s for three ticks (limit ${lim} s)`, data: { now, head } });
    }
  }

  private logSend(at: number, action: "post" | "repost" | "close", dayId: number, slice: number | undefined, entries: readonly Entry[], r: SendResult, gpuIds: Hex[] = entries.map((e) => e.gpuId)): void {
    if (r.sent) this.lastAction = `${action} ${dayId}${slice !== undefined ? `/${slice}` : ""}`;
    this.c.log.append({
      kind: "send",
      index: this.c.chain.index,
      role: this.c.role,
      at,
      action,
      dayId,
      ...(slice !== undefined ? { slice } : {}),
      gpuIds,
      ok: r.ok,
      sent: r.sent,
      ...(r.pending ? { pending: true } : {}),
      ...(r.txHash ? { txHash: r.txHash } : {}),
      ...(r.nonce !== undefined ? { nonce: r.nonce } : {}),
      ...(r.gasLimit !== undefined ? { gasLimit: r.gasLimit.toString() } : {}),
      ...(r.gasUsed !== undefined ? { gasUsed: r.gasUsed.toString() } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }
}
