// An in-memory index with the parts of AgateIndex a writer touches (A3, E1 to E7, E9 slice bits, C1, C3 and C4 of
// rule R v4.3 in simplified form: "quorate" = any valid reading). Each writer gets its own IndexChain view. Not a
// model of the formula: that is builder A's (the anvil tests run the real contract).
import { decodeReport } from "@agate/report";
import type { Address, Clocks, GpuConfig, Hex, Readings } from "@agate/report/types";
import { NEVER } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import type { IndexChain, PostedEvent, ReaderVersionView, SendResult, TxMeta } from "../../src/pipeline/chain.ts";
import { RpcDownError, RpcError } from "../../src/pipeline/rpc.ts";
import { type Clock, clockOf, dayEnd, deriveClock, sliceStart } from "../../src/core/index.ts";
import { fakeSources } from "./fakeSources.ts";

export const INDEX: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const PRIMARY: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const STANDBY: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const SELECTOR = 2183018362218727504n;

interface Acc {
  bits: bigint;
  anyValid: boolean;
  sums: number[];
  counts: number[];
  lastPostAt: number;
}

export class FakeIndex {
  time = 0;
  readonly clock: Clock;
  readonly heads = new Map<Hex, number>();
  readonly acc = new Map<string, Acc>();
  readonly suspended = new Set<string>();
  readonly posts: { at: number; writer: Address; entries: { gpuId: Hex; dayId: number; slice: number; readAt: number; values: number[] }[] }[] = [];
  readonly closes: { at: number; caller: Address; gpuId: Hex; day: number; source: Address; bits: bigint; seq: number; carried?: boolean }[] = [];
  /** Per writer: the next n posts are mined but change nothing (a forwarder try/catch swallowing a revert). */
  readonly swallow = new Map<string, number>();
  /** Per writer: posts are refused by eth_call until this unix second. */
  readonly refuseUntil = new Map<string, number>();
  /** While true every call throws RpcDownError (every URL down). */
  down = false;
  /** Seconds the chain head lags the writers' clock (CLOCK_SKEW). */
  skew = 0;
  writers: [Address, Address] = [PRIMARY, STANDBY];
  /** Every postReport call, accepted or not: (time, writer, the days it carried). */
  readonly calls: { at: number; writer: Address; days: number[]; slices: number[]; seq: number }[] = [];
  readonly metas: TxMeta[] = [];
  /** Registration time of every GPU (graceStart = max(dayEnd, registeredAt)); default: before the epoch. */
  registeredAt: number;
  /** Blocks: one per accepted post or close, at the index's time (block 0 = genesis). */
  readonly blockTimes: number[];
  /** ReadingsPosted events, in block order. */
  readonly events: (PostedEvent & { writer: Address })[] = [];
  /** eth_getLogs: refuses every call (a node without logs) / refuses a range wider than this. */
  logsFail = false;
  logsMaxRange = Number.POSITIVE_INFINITY;
  logsCalls = 0;
  /** Executed reader swaps per `${gpuId}:${slot}` (4.15). */
  readonly readerSwaps = new Map<string, ReaderVersionView[]>();
  /** Slot windows per `${gpuId}:${slot}` (default: live from firstDay, never removed). */
  readonly windows = new Map<string, { liveFrom: number; liveUntil: number }>();
  /** Entries of these slices are mined but skipped without a trace (a slot the chain never takes). */
  readonly dropSlices = new Set<number>();
  /** The next n readings() calls answer an empty record (a lagging node). */
  staleReads = 0;
  /** A global order of posts and closes. */
  seq = 0;

  constructor(
    readonly clocks: Clocks,
    readonly panels: readonly Panel[],
    readonly firstDay: number,
  ) {
    this.clock = clockOf(clocks);
    for (const p of panels) this.heads.set(p.gpuId as Hex, firstDay);
    this.registeredAt = this.clock.epochTs - 1;
    this.blockTimes = [this.clock.epochTs - 1];
  }

  private block(): number {
    this.blockTimes.push(this.time);
    return this.blockTimes.length - 1;
  }

  /** The keeper's carryDay: the head day is closed as CARRIED. */
  carry(g: Hex) {
    this.heads.set(g, this.heads.get(g)! + 1);
    this.closes.push({ at: this.time, caller: "0x000000000000000000000000000000000000c0de", gpuId: g, day: this.heads.get(g)! - 1, source: "0x0000000000000000000000000000000000000000", bits: 0n, seq: ++this.seq, carried: true });
  }

  key(g: Hex, d: number, w: Address) {
    return `${g}:${d}:${w.toLowerCase()}`;
  }

  accOf(g: Hex, d: number, w: Address): Acc {
    const n = this.panels.find((p) => p.gpuId === g)?.slots.length ?? 0;
    return this.acc.get(this.key(g, d, w)) ?? { bits: 0n, anyValid: false, sums: Array(n).fill(0), counts: Array(n).fill(0), lastPostAt: 0 };
  }

  private check() {
    if (this.down) throw new RpcDownError("eth_call", ["fake: every URL down"]);
  }

  post(w: Address, hex: Hex): SendResult {
    this.check();
    const lw = w.toLowerCase();
    const rep = decodeReport(hex);
    this.calls.push({ at: this.time, writer: w, days: rep.entries.map((e) => e.dayId), slices: rep.entries.map((e) => e.slice), seq: ++this.seq });
    if (this.time < (this.refuseUntil.get(lw) ?? 0)) return { ok: false, sent: false, error: "A2_NotActiveWriter" };
    if (!this.writers.some((x) => x.toLowerCase() === lw) || this.suspended.has(lw)) return { ok: false, sent: false, error: "A2_NotActiveWriter" };
    if (rep.version !== 1 || rep.chainSelector !== SELECTOR || rep.index.toLowerCase() !== INDEX.toLowerCase()) {
      return { ok: false, sent: false, error: "A3_BadHeader" };
    }
    const txHash = `0x${(this.calls.length + 1).toString(16).padStart(64, "0")}` as Hex;
    const sw = this.swallow.get(lw) ?? 0;
    if (sw > 0) {
      this.swallow.set(lw, sw - 1);
      return { ok: true, sent: true, txHash };
    }
    const c = this.clock;
    const applied: (typeof this.posts)[number]["entries"] = [];
    let blk: number | undefined;
    for (const e of rep.entries) {
      if (this.dropSlices.has(e.slice)) continue;
      const p = this.panels.find((x) => x.gpuId === e.gpuId);
      if (!p || e.values.length !== p.slots.length) continue; // E1
      if (e.slice >= c.slices) continue; // E2
      if (e.dayId < this.firstDay || e.dayId < (this.heads.get(e.gpuId) ?? 0)) continue; // E3
      const s0 = sliceStart(c, e.dayId, e.slice);
      const readAt = Number(e.readAt);
      if (readAt < s0 || readAt >= s0 + c.slice) continue; // E5
      if (readAt > this.time) continue; // E6
      const a = this.accOf(e.gpuId, e.dayId, w);
      if ((a.bits >> BigInt(e.slice)) & 1n) continue; // E7
      a.bits |= 1n << BigInt(e.slice);
      e.values.forEach((v, i) => {
        if (v >= 100_000 && v <= 1_000_000_000 && v % 10_000 === 0) {
          a.sums[i]! += v;
          a.counts[i]! += 1;
          a.anyValid = true;
        }
      });
      a.lastPostAt = this.time;
      this.acc.set(this.key(e.gpuId, e.dayId, w), a);
      applied.push({ gpuId: e.gpuId, dayId: e.dayId, slice: e.slice, readAt, values: [...e.values] });
      blk ??= this.block();
      this.events.push({ writer: w, gpuId: e.gpuId, day: e.dayId, slice: e.slice, readAt, values: [...e.values].map(Number), block: blk, txHash });
    }
    this.posts.push({ at: this.time, writer: w, entries: applied });
    return { ok: true, sent: true, txHash };
  }

  complete(g: Hex, d: number, w: Address) {
    return this.accOf(g, d, w).bits === (1n << BigInt(this.clock.slices)) - 1n;
  }

  closeDay(caller: Address, g: Hex): SendResult {
    this.check();
    const c = this.clock;
    const d = this.heads.get(g)!;
    if (this.time < dayEnd(c, d) + c.closeGrace) return { ok: false, sent: false, error: "C1_DayNotOver" };
    const eligible = this.writers.filter((w) => !/^0x0{40}$/i.test(w) && !this.suspended.has(w.toLowerCase()) && this.accOf(g, d, w).anyValid);
    const afterPend = this.time >= dayEnd(c, d) + c.tPend;
    // v4.3 C3: the first writer (quorate) from the first closable second; after T_PEND, failing that, a complete one
    const source = eligible[0] ?? (afterPend ? eligible.find((w) => this.complete(g, d, w)) : undefined);
    if (!source) return { ok: false, sent: false, error: "C3_BelowQuorum" };
    const isWriter = this.writers.some((w) => w.toLowerCase() === caller.toLowerCase());
    if (!afterPend && !this.complete(g, d, source) && caller.toLowerCase() !== source.toLowerCase()) return { ok: false, sent: false, error: "C4_CallerNotAllowed" };
    if (!isWriter && !this.complete(g, d, source)) return { ok: false, sent: false, error: "C4_CallerNotAllowed" };
    this.heads.set(g, d + 1);
    this.block();
    this.closes.push({ at: this.time, caller, gpuId: g, day: d, source, bits: this.accOf(g, d, source).bits, seq: ++this.seq });
    return { ok: true, sent: true, txHash: `0x${"c".repeat(64)}` as Hex };
  }

  view(w: Address): IndexChain {
    const self = this;
    const guard = async <T>(f: () => T): Promise<T> => {
      self.check();
      return f();
    };
    return {
      index: INDEX,
      writer: w,
      blockTime: () => guard(() => self.time),
      clocks: () => guard(() => self.clocks),
      gpu: (g) =>
        guard((): GpuConfig => {
          const p = self.panels.find((x) => x.gpuId === g);
          return {
            recipeHash: p ? fakeSources.recipeHash(p) : `0x${"0".repeat(64)}`,
            nSlots: p?.slots.length ?? 0,
            nFamilies: p?.families.length ?? 0,
            firstDay: self.firstDay,
            registeredAt: BigInt(self.registeredAt),
            lastCarryAt: BigInt(self.time),
            head: self.heads.get(g) ?? 0,
          };
        }),
      head: (g) => guard(() => self.heads.get(g) ?? 0),
      readings: (g, d, writer) =>
        guard((): Readings => {
          const a = self.accOf(g, d, writer);
          if (self.staleReads > 0) {
            self.staleReads -= 1;
            return { sums: a.sums.map(() => 0), counts: a.counts.map(() => 0), sliceBits: 0n, late: false, anyValid: false, lastPostAt: 0n };
          }
          return { sums: [...a.sums], counts: [...a.counts], sliceBits: a.bits, late: false, anyValid: a.anyValid, lastPostAt: BigInt(a.lastPostAt) };
        }),
      writers: () => guard(() => self.writers),
      isSuspended: (x) => guard(() => self.suspended.has(x.toLowerCase())),
      isVoided: () => guard(() => false),
      postReport: async (hex, meta) => {
        self.metas.push(meta);
        return self.post(w, hex);
      },
      closeDay: async (g, meta) => {
        self.metas.push(meta);
        return self.closeDay(w, g);
      },
      inFlight: () => new Set<string>(),
      poll: () => guard(() => self.time - self.skew),
      resync: () => guard(() => undefined),
      exclusive: async (fn) => fn(),
      adopt: async () => false,
      readerHistory: (g, slot) => guard(() => [...(self.readerSwaps.get(`${g}:${slot}`) ?? [])]),
      slotWindow: (g, slot) => guard(() => self.windows.get(`${g}:${slot}`) ?? { liveFrom: self.firstDay, liveUntil: NEVER }),
      blockNumber: () => guard(() => self.blockTimes.length - 1),
      blockAt: (n) =>
        guard(() => {
          if (n < 0 || n >= self.blockTimes.length) throw new Error(`no block ${n}`);
          return self.blockTimes[n]!;
        }),
      postedBy: (writer, from, to) =>
        guard(() => {
          self.logsCalls += 1;
          if (self.logsFail) throw new Error("eth_getLogs is not served here");
          if (to - from + 1 > self.logsMaxRange) throw new RpcError(`block range too large (max ${self.logsMaxRange})`, -32_005);
          return self.events.filter((e) => e.writer.toLowerCase() === writer.toLowerCase() && e.block >= from && e.block <= to).map(({ writer: _w, ...e }) => e);
        }),
    };
  }

  /** A reader swap executed now, effective from fromDay (4.15). */
  swap(g: Hex, slot: number, fromDay: number, url: string, parserVersion: string) {
    const k = `${g}:${slot}`;
    const h = this.readerSwaps.get(k) ?? [];
    h.push({ fromDay, executedAt: BigInt(this.time), readerHash: `0x${"0".repeat(64)}`, url, parserVersion, reason: "test" });
    this.readerSwaps.set(k, h);
  }
}

/** TEST profile (2.2, v4.3): DAY 2,400 s, SLICES 12, epoch at 2026-10-01 00:00 UTC carrying dayId 20,727. */
export function testClocks(over: Partial<Clocks> = {}): Clocks {
  const day = over.day ?? 2_400;
  const slices = over.slices ?? 12;
  const d = deriveClock({ day, slices, epochTs: 1_790_812_800, epochDay: 20_727, signAll: over.signAll ?? false });
  return {
    day,
    slice: d.slice,
    tPend: d.tPend,
    closeGrace: d.closeGrace,
    grace: d.grace,
    holdMove: d.holdMove,
    holdMin: d.holdMin,
    step: d.step,
    reopenWait: d.reopenWait,
    timelock: d.timelock,
    slices,
    minReadings: d.minReadings,
    qMin: 1,
    demoLabel: true,
    signAll: d.signAll,
    epochTs: 1_790_812_800n,
    epochDay: 20_727,
    chainSelector: SELECTOR,
    ...over,
  };
}
