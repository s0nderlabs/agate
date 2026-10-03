// KEY_MISMATCH: a second user of this writer's key (BUILD-SPEC 8.5; the Oct 2 recheck, point 4). A writer only
// checked that its slice bit was set, so a thief posting first with the same key went unnoticed. Now every tick:
// 1. Events (primary): this index's ReadingsPosted with writer = this key, scanned forward from the first block of the
//    oldest day being checked (found by binary search on block times at start and on wake), in ranges a node accepts
//    (halved on a refusal). Each event must match a logged reading of (gpuId, day, slice) with the same readAt and
//    values; a mismatch or an event for a slice it never read is KEY_MISMATCH (action); when that slice has a CRE run
//    whose output was never parsed, it is KEY_UNVERIFIED (info) instead.
// 2. Accumulators (backstop, for a day the event scan does not cover: getLogs failing or still catching up): the
//    counts and sums expected from its logged readings of the slices whose bits are set (E8 and E8b applied) must equal
//    readings(gpuId, day, writer); a bit set for a slice it never read is a mismatch too.
// The writer keeps running: its own posts are honest. It catches a stolen key file, not a stolen machine.
import type { Address, Hex, Readings } from "@agate/report/types";
import { NEVER, P_MAX, P_MIN, SHADOW_DAYS, TICK } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { type Clock, dayStart, guardAct } from "../core/index.ts";
import type { IndexChain, PostedEvent } from "./chain.ts";
import type { ReadingLine, ReadingLog, RunLine } from "./log.ts";
import { type AlertFn, RpcDownError, RpcError } from "./rpc.ts";

export interface KeyCheckOptions {
  chain: IndexChain;
  log: ReadingLog;
  clock: Clock;
  panels: readonly Panel[];
  alert?: AlertFn;
  say?: (event: string, data?: Record<string, unknown>) => void;
  /** Blocks per eth_getLogs call to start with (AGATE_LOGS_CHUNK, default 1,000); halved on a refusal, down to 1. */
  chunk?: number;
  /** At most this many eth_getLogs calls per tick (AGATE_LOGS_CALLS, default 20); a backlog continues next tick. */
  callsPerTick?: number;
  /** At a start or wake the scan goes back at most this many blocks (AGATE_LOGS_BACKLOG, default 20,000: about 2 h on
   * Monad); a day whose start lies further back is checked by the accumulators until the next day (a node that serves
   * only narrow eth_getLogs ranges would otherwise spend hours of calls on the backlog). */
  backlogBlocks?: number;
}

export interface KeyFinding {
  code: "KEY_MISMATCH" | "KEY_UNVERIFIED";
  gpuId: Hex;
  day: number;
  slice?: number;
  via: "events" | "accumulators";
  why: string;
}

const sameValues = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));
const valid = (v: number) => v !== 0 && v >= P_MIN && v <= P_MAX && v % TICK === 0;

/** Blocks rescanned at the head on every tick (a lagging node's missing logs are asked for again). */
export const KEYCHECK_OVERLAP = 3;

export class KeyCheck {
  private cursor: number | undefined; // the next scan starts after this block
  private scannedTo: number | undefined; // the newest block scanned, inclusive
  private scanFloor = 0; // the first block of the current unbroken scan (the overlap never rescans below it)
  private coverFrom: number | undefined; // time of the first block of the current unbroken scan
  private chunk: number;
  private readonly calls: number;
  private readonly backlog: number;
  private failing = false;
  private reset = true;
  private headBlock = 0;
  private now = 0;
  private lastFail = "";
  private capped = false;
  private pending: (d: number, h: number) => boolean = () => false;
  /** Events of a slice this writer has not read yet (its read is still ahead): judged once it has. */
  private deferred: PostedEvent[] = [];
  private readonly raised = new Set<string>();
  /** (gpuId:day) -> the readings already compared (unchanged readings cannot raise anything new). */
  private readonly seen = new Map<string, string>();
  /** (gpuId:slot) -> its window and when it was read (windows change only through a timelocked owner action). */
  private readonly windows = new Map<string, { w: { liveFrom: number; liveUntil: number }; at: number }>();
  readonly findings: KeyFinding[] = [];

  constructor(private readonly o: KeyCheckOptions) {
    this.chunk = Math.max(1, Math.floor(o.chunk ?? 1_000));
    this.calls = Math.max(1, Math.floor(o.callsPerTick ?? 20));
    this.backlog = Math.max(1, Math.floor(o.backlogBlocks ?? 20_000));
  }

  private get me(): Address {
    return this.o.chain.writer;
  }

  /** After a sleep or a restart the scan starts again from the oldest day being checked. */
  wake(): void {
    this.reset = true;
  }

  /** True when the events of every block from dayStart(d) to the newest one were scanned without a failure. */
  covers(d: number): boolean {
    return !this.failing && this.coverFrom !== undefined && this.coverFrom <= dayStart(this.o.clock, d) && this.scannedTo !== undefined && this.scannedTo >= this.headBlock;
  }

  /** One tick. `days`: the days being checked (the open day, and earlier ones still open), each with the readings of
   * every panel GPU the writer just synced. `pending(d, h)`: this writer has not yet tried to read slice h of day d
   * (the current slice before its read second): a post of it is judged once the writer has read it, so the alert
   * carries both values. */
  async tick(now: number, days: readonly { d: number; readings: ReadonlyMap<Hex, Readings> }[], pending?: (d: number, h: number) => boolean): Promise<void> {
    this.now = now;
    this.pending = pending ?? (() => false);
    if (this.deferred.length) {
      const again = this.deferred;
      this.deferred = [];
      this.checkEvents(again);
    }
    if (days.length === 0) return;
    const oldest = Math.min(...days.map((x) => x.d));
    try {
      await this.scan(oldest);
    } catch (e) {
      if (!(e instanceof RpcDownError)) throw e;
      this.failing = true;
    }
    for (const x of days) {
      if (this.covers(x.d)) continue;
      try {
        await this.accumulators(x.d, x.readings);
      } catch (e) {
        if (!(e instanceof RpcDownError)) throw e;
      }
    }
  }

  // ------------------------------------------------------------------ events

  private async scan(oldest: number): Promise<void> {
    const c = this.o.chain;
    if (!c.postedBy || !c.blockNumber || !c.blockAt) {
      this.failing = true;
      return;
    }
    const head = await c.blockNumber();
    this.headBlock = head;
    const from = dayStart(this.o.clock, oldest);
    if (this.reset || this.cursor === undefined || (this.coverFrom !== undefined && this.coverFrom > from && !this.capped)) {
      // every event of day d sits in a block timed at or after dayStart(d) (E5, E6): scan from the last block before
      // it, at most `backlog` blocks back; a capped scan covers only the days starting after its first block's time
      const floor = Math.max(0, head - this.backlog);
      if (floor > 0 && (await c.blockAt!(floor)) > from - 1) {
        this.cursor = floor - 1;
        this.coverFrom = (await c.blockAt!(floor)) + 1;
        this.capped = true;
      } else {
        this.cursor = (await this.blockBefore(from - 1, head, floor)) - 1;
        this.coverFrom = from;
        this.capped = false;
      }
      this.reset = false;
      this.scannedTo = this.cursor;
      this.scanFloor = this.cursor + 1;
    }
    let budget = this.calls;
    this.failing = false;
    while (this.cursor < head && budget > 0) {
      const a = this.cursor + 1;
      const b = Math.min(head, a + this.chunk - 1);
      budget -= 1;
      let evs: PostedEvent[];
      try {
        evs = await c.postedBy(this.me, a, b);
      } catch (e) {
        if (e instanceof RpcError && this.chunk > 1) {
          this.chunk = Math.max(1, Math.floor(this.chunk / 2)); // the node refused the range: ask for less
          continue;
        }
        this.failing = true;
        if (e instanceof RpcDownError) throw e;
        const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
        if (error !== this.lastFail) this.o.say?.("keycheck_logs_failed", { from: a, to: b, error, backstop: "accumulators" });
        this.lastFail = error;
        return;
      }
      this.cursor = b;
      this.scannedTo = Math.max(this.scannedTo ?? b, b);
      this.lastFail = "";
      this.checkEvents(evs);
    }
    // fix round (audit L1): the newest blocks are asked for again next tick, so a node that answered before it had
    // indexed their logs (a load-balanced or failed-over one) cannot hide a second user's post for good; a repeated
    // event is judged again and raises nothing new (one alert per id)
    if (this.cursor >= head) this.cursor = Math.max(this.scanFloor - 1, head - KEYCHECK_OVERLAP);
  }

  /** The last block at or before time t, searched in [lo, head] (lo when every block there is later). */
  private async blockBefore(t: number, head: number, lo = 0): Promise<number> {
    const at = this.o.chain.blockAt!;
    if ((await at(head)) <= t) return head;
    let hi = head;
    if ((await at(lo)) > t) return lo;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((await at(mid)) <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private checkEvents(evs: readonly PostedEvent[]): void {
    const byDay = new Map<number, { reads: ReadingLine[]; runs: RunLine[] }>();
    for (const ev of evs) {
      if (!this.o.panels.some((p) => p.gpuId.toLowerCase() === ev.gpuId.toLowerCase())) continue;
      if (this.pending(ev.day, ev.slice)) {
        this.deferred.push(ev);
        continue;
      }
      let day = byDay.get(ev.day);
      if (!day) {
        day = { reads: this.o.log.readingLines(this.o.chain.index, this.o.clock, ev.day), runs: this.o.log.runLines(this.o.chain.index, this.o.clock, ev.day) };
        byDay.set(ev.day, day);
      }
      const mine = day.reads.flatMap((l) => l.entries.filter((e) => e.gpuId.toLowerCase() === ev.gpuId.toLowerCase() && e.dayId === ev.day && e.slice === ev.slice));
      if (mine.some((e) => Number(e.readAt) === ev.readAt && sameValues(e.values, ev.values))) continue;
      const logged = mine[0];
      const data = {
        gpuId: ev.gpuId,
        day: ev.day,
        slice: ev.slice,
        onchain: { readAt: ev.readAt, values: ev.values },
        logged: logged ? { readAt: Number(logged.readAt), values: logged.values } : null,
        txHash: ev.txHash ?? null,
        block: ev.block,
        via: "events",
      };
      if (this.unparsedRun(day, ev.day, ev.slice)) {
        this.raise({ code: "KEY_UNVERIFIED", gpuId: ev.gpuId, day: ev.day, slice: ev.slice, via: "events", why: "a CRE run of this slice was never parsed" }, data);
      } else {
        const why = logged ? "another party posted this slice with this writer's key (other readAt or values)" : "another party posted a slice this writer never read, with its key";
        this.raise({ code: "KEY_MISMATCH", gpuId: ev.gpuId, day: ev.day, slice: ev.slice, via: "events", why }, data);
      }
    }
  }

  /** A run line of (day, slice) with no parsed reading of that run: the CLI may have posted values this log lacks. */
  private unparsedRun(day: { reads: ReadingLine[]; runs: RunLine[] }, d: number, h: number): boolean {
    return day.runs.some((r) => r.dayId === d && r.slice === h && !day.reads.some((l) => l.runId === r.runId));
  }

  // ------------------------------------------------------------------ accumulators (backstop)

  private async window(g: Hex, i: number): Promise<{ liveFrom: number; liveUntil: number }> {
    const k = `${g.toLowerCase()}:${i}`;
    const c = this.windows.get(k);
    if (c && this.now - c.at < this.o.clock.slice) return c.w;
    const w = this.o.chain.slotWindow ? await this.o.chain.slotWindow(g, i) : { liveFrom: 0, liveUntil: NEVER };
    this.windows.set(k, { w, at: this.now });
    return w;
  }

  private async accumulators(d: number, readings: ReadonlyMap<Hex, Readings>): Promise<void> {
    const { chain, log, clock } = this.o;
    const reads = log.readingLines(chain.index, clock, d);
    const runs = log.runLines(chain.index, clock, d);
    const day = { reads, runs };
    for (const p of this.o.panels) {
      const g = p.gpuId as Hex;
      const r = readings.get(g) ?? readings.get(g.toLowerCase() as Hex);
      if (!r) continue;
      const bits = BigInt(r.sliceBits);
      if (bits === 0n) continue;
      const sig = `${bits}:${r.counts.join(",")}:${r.sums.join(",")}`;
      if (this.seen.get(`${g.toLowerCase()}:${d}`) === sig) continue;
      if (await chain.isVoided(g, d, this.me)) continue; // a vetoed day takes nothing more
      const n = p.slots.length;
      const expCount = Array<number>(n).fill(0);
      const expSum = Array<number>(n).fill(0);
      let unverified: string | undefined;
      const stray: number[] = [];
      const perSlice: { h: number; values: readonly number[] }[] = [];
      for (let h = 0; h < clock.slices; h++) {
        if (((bits >> BigInt(h)) & 1n) === 0n) continue;
        const ents = reads.flatMap((l) => l.entries.filter((e) => e.gpuId.toLowerCase() === g.toLowerCase() && e.dayId === d && e.slice === h));
        const distinct = ents.filter((e, i) => ents.findIndex((x) => Number(x.readAt) === Number(e.readAt) && sameValues(x.values, e.values)) === i);
        if (distinct.length === 0) {
          if (this.unparsedRun(day, d, h)) unverified ??= `slice ${h} has a CRE run whose output was never parsed`;
          else stray.push(h);
          continue;
        }
        if (distinct.length > 1 || this.unparsedRun(day, d, h)) {
          unverified ??= `slice ${h} has more than one logged reading or an unparsed run`;
          continue;
        }
        perSlice.push({ h, values: distinct[0]!.values });
      }
      if (stray.some((h) => this.pending(d, h))) continue; // its read is still ahead: judged next tick
      if (stray.length) {
        this.raise(
          { code: "KEY_MISMATCH", gpuId: g, day: d, via: "accumulators", why: `slice bits set for slices this writer never read: ${stray.join(", ")}` },
          { gpuId: g, day: d, slices: stray, sliceBits: `0x${bits.toString(16)}`, via: "accumulators" },
        );
        this.seen.set(`${g.toLowerCase()}:${d}`, sig);
        continue;
      }
      if (unverified) {
        this.raise({ code: "KEY_UNVERIFIED", gpuId: g, day: d, via: "accumulators", why: unverified }, { gpuId: g, day: d, via: "accumulators", why: unverified });
        this.seen.set(`${g.toLowerCase()}:${d}`, sig);
        continue;
      }
      const windows: { liveFrom: number; liveUntil: number }[] = [];
      for (let i = 0; i < n; i++) windows.push(await this.window(g, i));
      const readable = (i: number) => windows[i]!.liveFrom !== NEVER && windows[i]!.liveFrom <= d + SHADOW_DAYS && d < windows[i]!.liveUntil;
      // a LIVE_FROM or LIVE_UNTIL executed during d may have flipped E8b mid-day: such a slot cannot be judged here
      const mayFlip = (i: number) => (windows[i]!.liveFrom !== NEVER && windows[i]!.liveFrom > d && windows[i]!.liveFrom <= d + SHADOW_DAYS) || windows[i]!.liveUntil <= d;
      for (const { values } of perSlice) {
        for (let i = 0; i < n; i++) {
          const v = Number(values[i] ?? 0);
          if (valid(v) && readable(i)) {
            expCount[i]! += 1;
            expSum[i]! += v;
          }
        }
      }
      const bad: number[] = [];
      const flip: number[] = [];
      for (let i = 0; i < n; i++) {
        if (Number(r.counts[i] ?? 0) === expCount[i] && Number(r.sums[i] ?? 0) === expSum[i]) continue;
        (mayFlip(i) ? flip : bad).push(i);
      }
      const data = {
        gpuId: g,
        day: d,
        slots: [...bad, ...flip],
        onchain: { counts: r.counts.map(Number), sums: r.sums.map(Number) },
        logged: { counts: expCount, sums: expSum },
        sliceBits: `0x${bits.toString(16)}`,
        via: "accumulators",
      };
      if (bad.length) this.raise({ code: "KEY_MISMATCH", gpuId: g, day: d, via: "accumulators", why: `onchain counts or sums differ from the log on slots ${bad.join(", ")}` }, data);
      else if (flip.length) this.raise({ code: "KEY_UNVERIFIED", gpuId: g, day: d, via: "accumulators", why: `slots ${flip.join(", ")} differ, and their window may have changed during the day` }, data);
      this.seen.set(`${g.toLowerCase()}:${d}`, sig);
    }
  }

  private raise(f: KeyFinding, data: Record<string, unknown>): void {
    const id = `${f.code}:${f.gpuId.toLowerCase()}:${f.day}:${f.slice ?? "-"}:${f.via}`;
    if (this.raised.has(id)) return;
    this.raised.add(id);
    this.findings.push(f);
    const g = this.o.panels.find((p) => p.gpuId.toLowerCase() === f.gpuId.toLowerCase())?.gpu ?? f.gpuId;
    const where = `${g} day ${f.day}${f.slice !== undefined ? ` slice ${f.slice}` : ""}`;
    this.o.alert?.({
      code: f.code,
      severity: f.code === "KEY_MISMATCH" ? "action" : "info",
      gpuId: f.gpuId,
      day: f.day,
      // the alert id carries the slice in the slot position: KEY_MISMATCH:<gpuId>:<day>:<slice>:<writer> (8.5)
      ...(f.slice !== undefined ? { slot: f.slice } : {}),
      writer: this.me,
      ...(f.code === "KEY_MISMATCH" ? { deadline: this.now + guardAct(this.o.clock) } : {}),
      message:
        f.code === "KEY_MISMATCH"
          ? `${where}: ${f.why}. Run guardian keycheck ${this.me}; confirmed: suspend this writer (R8 (d)) and appoint a new key`
          : `${where}: cannot verify this writer's onchain readings against its log (${f.why})`,
      data,
    });
    this.o.say?.(f.code === "KEY_MISMATCH" ? "key_mismatch" : "key_unverified", { gpuId: f.gpuId, day: f.day, slice: f.slice, via: f.via, why: f.why });
  }
}
