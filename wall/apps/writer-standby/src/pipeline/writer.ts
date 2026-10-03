// The writer pipeline both writers share (BUILD-SPEC 8.1, rule R v4.3, D10). tick(now) is the whole loop body: it
// takes the time as an argument so e2e can drive it on a warped anvil clock. Per slice: read at a random second with
// the readers in force for the day (8.6), log, send, read the slice bits back, repost logged entries whose bits are
// missing (to land by F1's repost point; then, Oct 3, while the day is open until REPOST_END = graceStart + GRACE -
// slice), check the chain against the log for a second user of the key (8.5), close. A start, or a gap of more than
// three tick periods (a machine sleep), runs the wake routine first: the nonce and the transaction journal are reconciled
// with the chain, and a slice whose read window has passed is skipped. Each phase runs on its own, so a dead RPC
// never stops the pages from being read and logged.
import type { Address, Entry, Hex, Readings } from "@agate/report/types";
import type { Panel, SourcesPureApi } from "@agate/sources/types";
import {
  type Clock,
  clockOf,
  closableAt,
  dayEnd,
  dayIdAt,
  entryToJson,
  pendEnd,
  type Reading,
  readAtFor,
  readOffset,
  readWindow,
  repostEnd,
  reportHex,
  type SlotReaders,
  sendDeadline,
  sliceAt,
  sliceStart,
  tickPeriod,
} from "../core/index.ts";
import type { IndexChain, SendResult, TxMeta } from "./chain.ts";
import { KeyCheck } from "./keycheck.ts";
import type { ReadingLog, Role } from "./log.ts";
import { writeHeartbeat } from "./ops.ts";
import { ReaderBook } from "./readers.ts";
import { type AlertFn, RpcDownError } from "./rpc.ts";

export interface TakeResult {
  reading: Reading;
  via: "cre" | "direct";
  /** Set when the source already sent the report (the CRE path broadcasts it itself). */
  sent?: SendResult;
  ms?: number;
  error?: string;
  /** The CRE run the reading came from (announced through onRun before the CLI started). */
  runId?: string;
}

export interface TakeAt {
  dayId: number;
  slice: number;
  readAt: number;
  /** The readers of swapped slots for this day (8.6); absent: every slot reads with the registered recipe's reader. */
  readers?: SlotReaders;
  /** A source that hands the key to another program (the CRE CLI) calls this just before starting it (8.2 (4)). */
  onRun?: (runId: string) => void;
}

export interface ReadingSource {
  take(at: TakeAt): Promise<TakeResult>;
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
  /** Most node-answered reposts of one (gpu, day, slice); default 8. Reposts no node answered do not count. */
  maxRepostTries?: number;
  /** How long one send may wait for its receipt before leaving it in flight (default min(60, slice / 4) s). */
  sendWaitS?: number;
  nowMs?: () => number;
  /** The sources API: with it, each reading uses the readers in force for its day (8.6). */
  api?: SourcesPureApi;
  /** Where the reader histories are kept between starts (per index). */
  readerCache?: string;
  /** 8.5: false turns the key check off (default on); an object tunes its eth_getLogs use. */
  keyCheck?: boolean | { chunk?: number; callsPerTick?: number; backlogBlocks?: number };
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
/** Days a writer looks back at most (registerGpu accepts a firstDay up to 31 days back). */
const LOOKBACK = 31;

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
  private readonly rds = new Map<string, Readings>();
  private readonly retryAt = new Map<string, number>();
  private readonly tries = new Map<string, number>();
  private readonly closeAt = new Map<string, number>();
  private readonly jitter = new Map<string, number>();
  private readonly synced = new Map<number, number>();
  private readonly heads = new Map<Hex, number>();
  private readonly regAt = new Map<Hex, number>();
  private readonly finished = new Set<number>();
  private finishFrom: number | undefined;
  private entriesCache = new Map<number, Map<number, Map<Hex, Entry>>>();
  private rpcDownTicks = 0;
  /** 8.1 step 3 (fix round, audit M3): the chain was unreachable from this tick on (undefined: reachable) */
  private downSince: number | undefined;
  /** the last time the chain came back after an outage, or the local machine woke from a sleep */
  private recoveredAt: number | undefined;
  private skewTicks = 0;
  private skewAlerted = false;
  private tickNo = 0;
  private lastAction = "start";
  readonly readers: ReaderBook | undefined;
  readonly keys: KeyCheck | undefined;

  constructor(private readonly c: WriterConfig) {
    this.rand = c.rand ?? Math.random;
    this.say = c.say ?? (() => {});
    this.nowMs = c.nowMs ?? Date.now;
    this.tickS = c.tickS ?? tickPeriod(c.clock);
    this.sendWaitS = c.sendWaitS ?? Math.min(60, Math.max(2, Math.floor(c.clock.slice / 4)));
    if (c.api) {
      this.readers = new ReaderBook({
        chain: c.chain,
        api: c.api,
        panels: c.panels,
        clock: c.clock,
        say: this.say,
        ...(c.alert ? { alert: c.alert } : {}),
        ...(c.readerCache ? { cacheFile: c.readerCache } : {}),
      });
    }
    if (c.keyCheck !== false) {
      const k = typeof c.keyCheck === "object" ? c.keyCheck : {};
      this.keys = new KeyCheck({ chain: c.chain, log: c.log, clock: c.clock, panels: c.panels, say: this.say, ...(c.alert ? { alert: c.alert } : {}), ...k });
    }
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
        await this.readers?.refresh(now, true);
        this.needResync = false;
      });
    }
    await phase("read", () => this.readPhase(now, out));
    await phase("poll", async () => this.checkSkew(now, await this.c.chain.poll(now)));
    await phase("sync", () => this.syncPhase(now, out));
    // an outage is over once a tick's chain phases all answer: the other writer's backlog goes out within its own
    // next tick, so a close that came due in the outage waits one CLOSE_GRACE from here (closePhase)
    if (rpcDown) this.downSince ??= now;
    else if (this.downSince !== undefined) {
      this.downSince = undefined;
      this.recoveredAt = now;
    }
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
    this.keys?.wake();
    const { log, chain, role } = this.c;
    log.append({ kind: "wake", index: chain.index, role, at: now, slept });
    if (slept !== null) {
      this.recoveredAt = now; // a machine sleep is an outage of every writer on the local machine
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
      if (this.entriesCache.size > 8) this.entriesCache.delete(this.entriesCache.keys().next().value!);
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

  /** For a stuck transaction: can its entries still land (some GPU's day d not closed or carried)? */
  private stillOpen(d: number, gpuIds: readonly Hex[]): () => Promise<boolean> {
    return async () => {
      for (const g of gpuIds) if ((await this.c.chain.head(g)) <= d) return true;
      return false;
    };
  }

  /** The last second any entry of day d may be sent: REPOST_END of the earliest-registered GPU among gpuIds. */
  private sendEnd(d: number, gpuIds: readonly Hex[]): number {
    const ends = gpuIds.map((g) => repostEnd(this.c.clock, d, this.regAt.get(g)));
    return ends.length ? Math.min(...ends) : repostEnd(this.c.clock, d);
  }

  private async read(dayId: number, slice: number, now: number): Promise<TickResult["read"]> {
    const { chain, log, role, clock } = this.c;
    const t0 = this.nowMs();
    let r: TakeResult;
    try {
      // the readers in force for this day, read from the chain at most once per slice (8.6). While the chain is known to
      // be down (a chain phase failed on an earlier tick) the last known readers serve: the refresh would only wait out
      // every URL's timeout before the pages are fetched, skewing readAt (8.1); a swap gives a slice of notice and the
      // first read after the recovery reads the history again
      if (this.downSince === undefined) await this.readers?.refresh(now).catch(() => undefined);
      const at = readAtFor(clock, now);
      const readers = this.readers?.readersFor(at.dayId, now);
      const onRun = (runId: string) => log.append({ kind: "run", index: chain.index, role, dayId: at.dayId, slice: at.slice, startedAt: now, runId });
      r = await this.c.source.take({ dayId: at.dayId, slice: at.slice, readAt: at.readAt, ...(readers ? { readers } : {}), onRun });
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
      ...(r.runId ? { runId: r.runId } : {}),
    });
    this.lastAction = `read ${rd.dayId}/${rd.slice}`;
    this.entriesCache.delete(rd.dayId);
    this.done.add(`${rd.dayId}:${rd.slice}`);

    const end = this.sendEnd(rd.dayId, rd.entries.map((e) => e.gpuId));
    const meta: TxMeta = {
      action: r.via === "cre" ? "cre" : "post",
      tags: rd.entries.map((e) => `${e.gpuId}:${rd.dayId}:${rd.slice}`),
      deadline: end,
      dayId: rd.dayId,
      slice: rd.slice,
      useful: this.stillOpen(rd.dayId, rd.entries.map((e) => e.gpuId)),
    };
    let sent = r.sent;
    if (sent?.txHash && !sent.ok) {
      // the CRE CLI broadcast it and gave up waiting: finish it as ours rather than send the entries twice
      if (await chain.adopt(sent.txHash, meta).catch(() => false)) sent = { ...sent, pending: true };
    }
    if (!sent && rd.entries.length > 0) {
      if (now > end) sent = { ok: false, sent: false, error: "past REPOST_END" };
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

  /** slice / 10, doubling per try, at most one slice apart: a stuck entry keeps a try every slice while it may land. */
  private backoff(tries: number): number {
    const s = this.c.clock.slice;
    return Math.min(s, Math.max(1, Math.floor(s / 10)) * 2 ** tries);
  }

  private hasBit(gpuId: Hex, d: number, h: number): boolean {
    const r = this.rds.get(`${gpuId}:${d}`);
    return r !== undefined && ((BigInt(r.sliceBits) >> BigInt(h)) & 1n) === 1n;
  }

  private async sync(d: number, now: number, force: boolean): Promise<void> {
    const every = Math.max(1, Math.floor(this.c.clock.slice / 12));
    if (!force && now - (this.synced.get(d) ?? -Infinity) < every) return;
    for (const p of this.c.panels) {
      const g = p.gpuId as Hex;
      this.rds.set(`${g}:${d}`, await this.c.chain.readings(g, d, this.me));
    }
    this.synced.set(d, now);
  }

  /** Is (g, d) still repostable: the day open (not closed, not carried) and now inside REPOST_END? */
  private open(g: Hex, d: number, now: number): boolean {
    return (this.heads.get(g) ?? Infinity) <= d && now <= repostEnd(this.c.clock, d, this.regAt.get(g));
  }

  private async syncPhase(now: number, out: TickResult) {
    const { clock, chain } = this.c;
    for (const p of this.c.panels) {
      const g = p.gpuId as Hex;
      this.heads.set(g, await chain.head(g));
      if (!this.regAt.has(g)) {
        try {
          this.regAt.set(g, Number((await chain.gpu(g)).registeredAt));
        } catch (e) {
          if (e instanceof RpcDownError) throw e; // unknown: graceStart falls back to dayEnd (the earliest REPOST_END)
        }
      }
    }
    const cur = dayIdAt(clock, now);
    const minHead = Math.min(...this.c.panels.map((p) => this.heads.get(p.gpuId as Hex) ?? cur));
    const lo = Math.max(cur - LOOKBACK, Math.min(this.finishFrom ?? cur - 2, cur - 2, minHead));
    // days whose window has closed for every GPU (closed, carried, or past REPOST_END): what never landed is abandoned
    for (let d = lo; d < cur; d++) {
      if (this.finished.has(d)) continue;
      if (this.c.panels.every((p) => !this.open(p.gpuId as Hex, d, now)) && now > sendDeadline(clock, d)) await this.finishDay(d, now, out);
    }
    this.finishFrom = undefined;
    for (const d of this.finished) if (d < cur - LOOKBACK - 1) this.finished.delete(d);
    const active: number[] = [];
    for (let d = lo; d <= cur; d++) if (!this.finished.has(d) && this.c.panels.some((p) => this.open(p.gpuId as Hex, d, now))) active.push(d);
    // per-entry schedules of days no longer active are never read again
    const keep = (d: number) => active.includes(d) || d >= cur - 1;
    for (const m of [this.retryAt, this.tries]) {
      for (const k of m.keys()) if (!keep(Number(k.split(":")[1]))) m.delete(k);
    }
    const oldestHead = Math.min(...this.c.panels.map((p) => this.heads.get(p.gpuId as Hex) ?? 0));
    for (const m of [this.closeAt, this.jitter]) {
      for (const k of m.keys()) if (Number(k.split(":")[1]) < oldestHead) m.delete(k);
    }
    for (const k of this.rds.keys()) if (!keep(Number(k.split(":")[1]))) this.rds.delete(k);
    for (const d of this.synced.keys()) if (!keep(d)) this.synced.delete(d);
    const checked: { d: number; readings: Map<Hex, Readings> }[] = [];
    for (const d of active) {
      await this.sync(d, now, false);
      out.reposts.push(...(await this.repost(d, now)));
      const m = new Map<Hex, Readings>();
      for (const p of this.c.panels) {
        const r = this.rds.get(`${p.gpuId}:${d}`);
        if (r && (this.heads.get(p.gpuId as Hex) ?? Infinity) <= d) m.set(p.gpuId as Hex, r);
      }
      if (m.size) checked.push({ d, readings: m });
    }
    // 8.5: the open days (the previous one until it is closed) against the log, every tick
    const cur0 = sliceAt(clock, now);
    await this.keys?.tick(now, checked, (d, h) => d === cur0.dayId && h === cur0.slice && !this.done.has(`${d}:${h}`));
  }

  /** Once a day's window has closed for every GPU: every logged entry whose bit is missing is logged as abandoned. */
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
      const reason = closed ? "the day closed or was carried without it" : "its repost window ended (REPOST_END)";
      this.c.log.append({ kind: "abandon", index: this.c.chain.index, role: this.c.role, at: now, dayId: d, slice: h, gpuIds, reason });
      out.abandoned.push({ dayId: d, slice: h, gpuIds, reason });
      this.say("abandoned", { dayId: d, slice: h, gpuIds, reason });
    }
    this.finished.add(d);
  }

  /** Reposts every logged entry of day d whose bit is missing, in slice order, each after its backoff; once d's close
   * is due (dayEnd + CLOSE_GRACE) an entry no node has answered for yet is not held back by its backoff, so after an
   * outage the whole backlog goes before the close of the same tick (8.1 step 2). */
  private async repost(d: number, now: number): Promise<TickResult["reposts"]> {
    const out: TickResult["reposts"] = [];
    const { clock, chain } = this.c;
    const maxTries = this.c.maxRepostTries ?? 8;
    const inFlight = chain.inFlight();
    const voided = new Map<Hex, boolean>();
    const backlog = now >= closableAt(clock, d);
    let sentAny = false;
    for (const [h, byGpu] of [...this.entriesOf(d)].sort((a, b) => a[0] - b[0])) {
      if (sliceStart(clock, d, h) > now) continue;
      const missing: Entry[] = [];
      for (const [g, e] of byGpu) {
        if (!this.open(g, d, now)) continue; // closed, carried, past REPOST_END (or not one of our panels)
        if (!this.rds.has(`${g}:${d}`) || this.hasBit(g, d, h)) continue;
        const k = `${g}:${d}:${h}`;
        if (inFlight.has(k)) continue; // sent and not mined yet: never twice
        const tried = this.tries.get(k) ?? 0;
        if (tried >= maxTries) continue;
        // the backlog (entries no node has answered for yet) goes at once when the close is due; tried ones keep their backoff
        if (now < (this.retryAt.get(k) ?? 0) && !(backlog && tried === 0)) continue;
        if (!voided.has(g)) voided.set(g, await chain.isVoided(g, d, this.me));
        if (voided.get(g)) continue; // E4: a vetoed day takes nothing more from us
        missing.push(e);
      }
      if (missing.length === 0) continue;
      const gpuIds = missing.map((e) => e.gpuId);
      const meta: TxMeta = { action: "repost", tags: missing.map((e) => `${e.gpuId}:${d}:${h}`), deadline: this.sendEnd(d, gpuIds), dayId: d, slice: h, useful: this.stillOpen(d, gpuIds) };
      let res: SendResult;
      try {
        res = await chain.postReport(reportHex(this.c.chainSelector, chain.index, missing), meta, this.waitUntil());
      } catch (e) {
        // no node answered: not a try; the next tick tries again
        for (const x of missing) this.retryAt.set(`${x.gpuId}:${d}:${h}`, now + this.tickS);
        throw e;
      }
      for (const e of missing) {
        const k = `${e.gpuId}:${d}:${h}`;
        const n = (this.tries.get(k) ?? 0) + 1;
        this.tries.set(k, n);
        this.retryAt.set(k, now + this.backoff(n));
      }
      this.logSend(now, "repost", d, h, missing, res);
      sentAny = sentAny || res.sent;
      const item = { dayId: d, slice: h, gpuIds, ok: res.ok, ...(res.pending ? { pending: true } : {}), ...(res.error ? { error: res.error } : {}) };
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
   * not; its reposts were aimed at F1's repost point, and after an outage the sync phase of the same tick has just sent
   * its backlog. After an outage (or a machine sleep) that ended after the day did, no writer closes before the recovery +
   * CLOSE_GRACE (capped at REPOST_END): the other writer's backlog lands first, so its record stays complete and
   * selectable (fix round, audit M3). Any other writer closes from dayEnd + T_PEND if the day is still open. eth_call
   * decides the rest (C2 a pending record, C3 below quorum). */
  private async closePhase(now: number, out: TickResult) {
    const { clock, chain } = this.c;
    for (const p of this.c.panels) {
      const g = p.gpuId as Hex;
      const d = this.heads.get(g) ?? (await chain.head(g));
      if (now < closableAt(clock, d)) continue;
      if (this.recoveredAt !== undefined && this.recoveredAt > dayEnd(clock, d) && now < Math.min(this.recoveredAt + clock.closeGrace, repostEnd(clock, d, this.regAt.get(g)))) continue;
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
