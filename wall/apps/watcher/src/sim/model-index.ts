// An in-memory AgateIndex built on formula.ts: closeDay (C1 to C7), attest (countersign and select), veto, suspend,
// carryDay (cases 1 and 2 with carryPost and the chained close) and postReport (E2 to E9), with the v4.3 changes.
// It is the "fake index" of the watcher's harness (BUILD-SPEC 12.5); every op checks before it mutates, so a thrown
// Revert leaves the state untouched (a failed eth_call).
import type { Address, Clocks, Hex, IndexRecord, Readings, SlotState } from "@agate/report/types";
import { NEVER, P_MAX, P_MIN, Status, TICK } from "@agate/report/types";
import { ACTION_WINDOW_DAYS, actionIdOf, type ActionFields, readerHashOf, readerSwapIdOf } from "../chain/owner.ts";
import { carryPost, computeRecord, type Computed, type GpuShape, initialState, readable } from "../formula.ts";

export class Revert extends Error {}
function req(c: unknown, m: string): asserts c {
  if (!c) throw new Revert(m);
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

export interface ModelAcc {
  sums: number[];
  counts: number[];
  sliceBits: number;
  late: boolean;
  anyValid: boolean;
  lastPostAt: number;
  slotSlices: number[];
}

export interface ModelRecord extends Computed {
  /** the pre-state this record was computed from (harness bookkeeping, not contract storage) */
  pre: SlotState[];
  attestedAt: number;
  attestedBy: Address;
  dropped: boolean;
  carried: boolean;
}

export interface ModelEvent {
  name: string;
  gpuId: Hex;
  day: number;
  at: number;
  seq: number;
  args: Record<string, unknown>;
}

interface Gpu extends GpuShape {
  liveFrom: number[];
  liveUntil: number[];
  gpuId: Hex;
  firstDay: number;
  registeredAt: number;
  lastCarryAt: number;
  head: number;
  base: SlotState[];
  last: SlotState[];
  records: Map<number, ModelRecord>;
  firstRecordDay: number | null;
  acc: Map<string, ModelAcc>;
  voided: Set<string>;
  reopenedAt: Map<number, number>;
}

export class ModelIndex {
  readonly address: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  readonly gpus = new Map<string, Gpu>();
  writers: [Address, Address];
  attester: Address;
  guardians: [Address, Address];
  readonly suspended = new Set<string>();
  readonly events: ModelEvent[] = [];
  private seq = 0;

  constructor(
    readonly clocks: Clocks,
    roles: { writers: [Address, Address]; attester: Address; guardians: [Address, Address] },
  ) {
    this.writers = roles.writers;
    this.attester = roles.attester;
    this.guardians = roles.guardians;
  }

  get C() {
    const c = this.clocks;
    return {
      day: c.day,
      slice: c.slice,
      slices: c.slices,
      tPend: c.tPend,
      closeGrace: c.closeGrace,
      grace: c.grace,
      holdMove: c.holdMove,
      holdMin: c.holdMin,
      step: c.step,
      reopenWait: c.reopenWait,
      epochTs: Number(c.epochTs),
      epochDay: c.epochDay,
      minReadings: c.minReadings,
      qMin: c.qMin,
      signAll: c.signAll,
    };
  }
  dayStart(d: number) {
    return this.C.epochTs + (d - this.C.epochDay) * this.C.day;
  }
  dayEnd(d: number) {
    return this.dayStart(d + 1);
  }
  dayId(t: number) {
    return t < this.C.epochTs ? this.C.epochDay : this.C.epochDay + Math.floor((t - this.C.epochTs) / this.C.day);
  }
  private emit(name: string, gpuId: Hex, day: number, at: number, args: Record<string, unknown>) {
    this.events.push({ name, gpuId, day, at, seq: this.seq++, args: structuredClone(args) });
  }
  g(gpuId: Hex): Gpu {
    const g = this.gpus.get(lc(gpuId));
    req(g, "UnknownGpu");
    return g;
  }
  private params() {
    const C = this.C;
    return { slices: C.slices, minReadings: C.minReadings, qMin: C.qMin, signAll: C.signAll, tPend: C.tPend };
  }

  registerGpu(gpuId: Hex, family: number[], famQ: number[], firstDay: number, liveMask: number, now: number): void {
    req(!this.gpus.has(lc(gpuId)), "GpuExists");
    const n = family.length;
    req(n >= 1 && n <= 15, "BadSlots");
    const liveFrom = family.map((_, i) => (Math.floor(liveMask / 2 ** i) % 2 === 1 ? firstDay : NEVER));
    this.gpus.set(lc(gpuId), {
      gpuId,
      nSlots: n,
      family: [...family],
      famQ: [...famQ],
      liveFrom,
      liveUntil: family.map(() => NEVER),
      firstDay,
      registeredAt: now,
      lastCarryAt: now,
      head: firstDay,
      base: initialState(n),
      last: initialState(n),
      records: new Map(),
      firstRecordDay: null,
      acc: new Map(),
      voided: new Set(),
      reopenedAt: new Map(),
    });
  }
  /** Owner's LIVE_FROM / LIVE_UNTIL after the timelock (tests set the window directly). */
  setWindow(gpuId: Hex, slot: number, liveFrom: number, liveUntil: number = NEVER) {
    const g = this.g(gpuId);
    g.liveFrom[slot] = liveFrom;
    g.liveUntil[slot] = liveUntil;
  }

  private isWriter(a: Address) {
    return a !== ZERO && this.writers.some((w) => lc(w) === lc(a));
  }
  private active(a: Address) {
    return this.isWriter(a) && !this.suspended.has(lc(a));
  }
  private akey(d: number, w: Address) {
    return `${d}:${lc(w)}`;
  }
  accOf(g: Gpu, d: number, w: Address): ModelAcc | null {
    return g.acc.get(this.akey(d, w)) ?? null;
  }
  isFinal(r: ModelRecord | undefined, now: number): boolean {
    return r !== undefined && r.finalAt !== 0 && now >= r.finalAt;
  }
  private full() {
    return 2 ** this.C.slices - 1;
  }

  // ------------------------------------------------------------------ writers

  postReport(writer: Address, entries: { gpuId: Hex; day: number; slice: number; readAt: number; values: number[] }[], now: number) {
    req(this.active(writer), "A2_NotActiveWriter");
    const C = this.C;
    const skipped: string[] = [];
    for (const e of entries) {
      const g = this.gpus.get(lc(e.gpuId));
      if (!g || e.values.length !== g.nSlots) { skipped.push("E1"); continue; }
      if (!(e.slice < C.slices)) { skipped.push("E2"); continue; }
      if (!(e.day >= g.firstDay && e.day >= g.head)) { skipped.push("E3"); continue; }
      if (g.voided.has(this.akey(e.day, writer))) { skipped.push("E4"); continue; }
      const ss = this.dayStart(e.day) + e.slice * C.slice;
      if (!(ss <= e.readAt && e.readAt < ss + C.slice)) { skipped.push("E5"); continue; }
      if (!(e.readAt <= now)) { skipped.push("E6"); continue; }
      const k = this.akey(e.day, writer);
      const a: ModelAcc = g.acc.get(k) ?? { sums: Array(g.nSlots).fill(0), counts: Array(g.nSlots).fill(0), sliceBits: 0, late: false, anyValid: false, lastPostAt: 0, slotSlices: Array(g.nSlots).fill(0) };
      if (Math.floor(a.sliceBits / 2 ** e.slice) % 2 === 1) { skipped.push("E7"); continue; }
      a.sliceBits += 2 ** e.slice;
      let mask = 0;
      e.values.forEach((v, i) => {
        if (v === 0 || v < P_MIN || v > P_MAX || v % TICK !== 0) return;
        if (!readable(g, i, e.day)) return;
        a.sums[i] += v;
        a.counts[i] += 1;
        a.slotSlices[i] += 2 ** e.slice;
        mask += 2 ** i;
        a.anyValid = true;
      });
      if (now >= ss + 2 * C.slice) a.late = true;
      a.lastPostAt = now;
      g.acc.set(k, a);
      this.emit("ReadingsPosted", g.gpuId, e.day, now, { writer, slice: e.slice, readAt: e.readAt, values: [...e.values], validMask: mask, late: now >= ss + 2 * C.slice });
    }
    return skipped;
  }

  // ------------------------------------------------------------------ the formula on stored readings

  eligible(g: Gpu, d: number): Address[] {
    return this.writers.filter((w) => w !== ZERO && !this.suspended.has(lc(w)) && !g.voided.has(this.akey(d, w)) && (this.accOf(g, d, w)?.sliceBits ?? 0) !== 0);
  }
  firstWriter(g: Gpu, d: number): Address | null {
    return this.eligible(g, d).find((w) => this.accOf(g, d, w)!.anyValid) ?? null;
  }
  compute(g: Gpu, d: number, w: Address, pre: SlotState[], t: number): Computed {
    const a = this.accOf(g, d, w);
    const prev = g.records.get(d - 1);
    return computeRecord({
      params: this.params(),
      gpu: g,
      gpuId: g.gpuId,
      day: d,
      writer: w,
      postedAt: t,
      pre,
      acc: a,
      prev: prev ? { value: prev.value } : null,
      firstRecordDay: g.firstRecordDay,
      firstWriter: this.firstWriter(g, d),
    });
  }
  private graceStart(g: Gpu, d: number) {
    return Math.max(this.dayEnd(d), g.registeredAt);
  }

  /** C3's source at `now` (null: below quorum). */
  source(g: Gpu, d: number, now: number): Address | null {
    const fw = this.firstWriter(g, d);
    const q = (w: Address) => this.compute(g, d, w, g.last, now).quorate;
    const complete = (w: Address) => this.accOf(g, d, w)!.sliceBits === this.full();
    if (now < this.dayEnd(d) + this.C.tPend) return fw && q(fw) ? fw : null;
    if (fw && q(fw)) return fw;
    const el = this.eligible(g, d);
    return el.find((w) => complete(w) && q(w)) ?? el.find((w) => q(w)) ?? null;
  }

  closeDay(gpuId: Hex, caller: Address, now: number): number {
    const g = this.g(gpuId);
    const C = this.C;
    const d = g.head;
    req(now >= this.dayEnd(d) + C.closeGrace, "C1_DayNotOver");
    const prev = g.records.get(d - 1);
    req(!prev || this.isFinal(prev, now), "C2_PreviousNotFinal");
    const src = this.source(g, d, now);
    req(src, "C3_BelowQuorum");
    const complete = this.accOf(g, d, src)!.sliceBits === this.full();
    if (now < this.dayEnd(d) + C.tPend && !complete) req(lc(caller) === lc(src), "C4_CallerNotAllowed");
    req(this.active(caller) || complete || now >= this.graceStart(g, d) + C.grace, "C4_CallerNotAllowed");
    const r = this.compute(g, d, src, g.last, now);
    g.records.set(d, { ...r, pre: g.last.map((x) => ({ ...x })), attestedAt: 0, attestedBy: ZERO, dropped: false, carried: false });
    g.base = g.last;
    g.last = r.post;
    g.head = d + 1;
    if (g.firstRecordDay === null) g.firstRecordDay = d;
    this.emit("DayClosed", g.gpuId, d, now, { source: src, value: r.value, changed: r.changed, needsSign: r.needsSign, digest: r.digest, incomplete: r.incomplete });
    this.emit("RecordSlots", g.gpuId, d, now, { source: src, digest: r.digest, p: r.p, kinds: r.kinds, counts: r.counts, post: r.post });
    return d;
  }

  attest(gpuId: Hex, d: number, writer: Address, digest: Hex, caller: Address, now: number): void {
    const g = this.g(gpuId);
    const isG = this.guardians.some((x) => x !== ZERO && lc(x) === lc(caller));
    req(lc(caller) === lc(this.attester) || isG, "NotAttesterOrGuardian");
    const r = g.records.get(d);
    req(d === g.head - 1 && r, "NoPendingRecord");
    req(!r.carried && !this.isFinal(r, now), "AlreadyFinal");
    req(r.attestedAt === 0, "AlreadyAttested");
    const C = this.C;
    if (lc(writer) === lc(r.source)) {
      req(lc(digest) === lc(r.digest), "DigestMismatch");
      r.attestedAt = now;
      r.attestedBy = caller;
      if (r.needsSign) r.finalAt = Math.max(r.postedAt + C.tPend, now);
      this.emit("Attested", g.gpuId, d, now, { by: caller, source: r.source, digest, finalAt: r.finalAt });
      return;
    }
    const a = this.accOf(g, d, writer);
    req(this.active(writer) && !g.voided.has(this.akey(d, writer)) && a && a.sliceBits !== 0, "SelectNotEligible");
    if (!isG) req(a.sliceBits === this.full(), "SelectIncomplete");
    const s = this.compute(g, d, writer, g.base, r.postedAt);
    req(s.quorate, "SelectBelowQuorum");
    req(lc(s.digest) === lc(digest), "DigestMismatch");
    const old = r;
    const nr: ModelRecord = { ...s, pre: g.base.map((x) => ({ ...x })), postedAt: r.postedAt, attestedAt: now, attestedBy: caller, finalAt: Math.max(r.postedAt + C.tPend, now), dropped: false, carried: false };
    g.records.set(d, nr);
    g.last = s.post;
    this.emit("RecordReplaced", g.gpuId, d, now, { by: caller, oldSource: old.source, newSource: writer, oldValue: old.value, newValue: s.value, oldDigest: old.digest, newDigest: s.digest });
    this.emit("RecordSlots", g.gpuId, d, now, { source: writer, digest: s.digest, p: s.p, kinds: s.kinds, counts: s.counts, post: s.post });
    this.emit("Attested", g.gpuId, d, now, { by: caller, source: writer, digest: s.digest, finalAt: nr.finalAt });
  }

  veto(gpuId: Hex, d: number, source: Address, digest: Hex, caller: Address, now: number): void {
    const g = this.g(gpuId);
    req(this.guardians.some((x) => x !== ZERO && lc(x) === lc(caller)), "NotGuardian");
    const r = g.records.get(d);
    req(r && d === g.head - 1 && !r.carried, "NoPendingRecord");
    req(!this.isFinal(r, now), "AlreadyFinal");
    req(lc(r.source) === lc(source) && lc(r.digest) === lc(digest), "VetoStale");
    g.records.delete(d);
    g.last = g.base;
    g.voided.add(this.akey(d, source));
    g.reopenedAt.set(d, now);
    g.head = d;
    if (g.firstRecordDay === d) g.firstRecordDay = null;
    this.emit("Vetoed", g.gpuId, d, now, { by: caller, source, digest, value: r.value });
  }

  suspend(writer: Address, caller: Address, now: number): void {
    req(this.guardians.some((x) => x !== ZERO && lc(x) === lc(caller)), "NotGuardian");
    req(this.isWriter(writer), "NotAWriter");
    this.suspended.add(lc(writer));
    this.emit("WriterSuspended", "0x" as Hex, 0, now, { writer, by: caller });
  }

  carryDay(gpuId: Hex, caller: Address, now: number): 1 | 2 {
    const g = this.g(gpuId);
    const C = this.C;
    const pend = g.records.get(g.head - 1);
    let d: number;
    let kase: 1 | 2;
    let dropped = false;
    if (pend && !this.isFinal(pend, now)) {
      d = g.head - 1;
      req(!pend.carried && pend.needsSign && pend.attestedAt === 0 && pend.finalAt === 0, "Carry1_NotDroppable");
      const at = Math.max(this.graceStart(g, d) + C.holdMove, pend.postedAt + C.holdMin, g.lastCarryAt + C.step);
      req(now >= at, `Carry1_TooEarly(${at})`);
      kase = 1;
    } else {
      d = g.head;
      req(now >= this.dayEnd(d), "Carry2_DayNotOver");
      const prev = g.records.get(d - 1);
      req(!prev || this.isFinal(prev, now), "Carry2_PreviousNotFinal");
      const ro = g.reopenedAt.get(d) ?? 0;
      const at = Math.max(this.graceStart(g, d) + C.grace, g.lastCarryAt + C.step, ro > 0 ? ro + C.reopenWait : 0);
      req(now >= at, `Carry2_TooEarly(${at})`);
      for (const w of this.eligible(g, d)) req(this.compute(g, d, w, g.last, now).quorum < C.qMin, "Carry2_HasQuorum");
      kase = 2;
    }
    if (kase === 1) {
      const r = g.records.get(d)!;
      g.records.delete(d);
      if (g.firstRecordDay === d) g.firstRecordDay = null;
      g.last = g.base;
      g.head = d;
      dropped = true;
      this.emit("FixDropped", g.gpuId, d, now, { source: r.source, value: r.value, digest: r.digest });
    }
    g.lastCarryAt = now;
    const prev = g.records.get(d - 1);
    if (prev) {
      const counts = this.eligible(g, d).map((w) => this.accOf(g, d, w)!.counts);
      const { post, mask } = carryPost(g.last, g, d, C.minReadings, counts);
      g.records.set(d, {
        value: prev.value, status: Status.CARRIED, fresh: 0, quorum: 0, quorate: false, held: 0, freshMedian: 0, late: false, incomplete: false,
        changed: false, needsSign: false, source: ZERO, postedAt: now, finalAt: now, digest: `0x${"00".repeat(32)}`, p: [], kinds: [], counts: [], post, pre: g.last.map((x) => ({ ...x })),
        attestedAt: 0, attestedBy: ZERO, dropped, carried: true,
      });
      g.base = g.last;
      g.last = post;
      this.emit("DayCarried", g.gpuId, d, now, { value: prev.value, carryCase: kase, dropped, missAdvanced: mask });
    } else this.emit("DaySkipped", g.gpuId, d, now, { carryCase: kase });
    g.head = d + 1;
    try {
      this.closeDay(gpuId, caller, now);
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
    }
    return kase;
  }

  // ------------------------------------------------------------------ owner queue and reader swaps (4.11, 4.15)
  // The guardian's status and the watcher's alerts read these; the owner check is left out (tests call them as owner).

  readonly queued = new Map<string, number>(); // id -> eta
  private readonly swapReason = new Map<string, string>();
  readonly readerHistory = new Map<string, { fromDay: number; executedAt: number; readerHash: Hex; url: string; parserVersion: string; reason: string }[]>();

  private window(): number {
    return ACTION_WINDOW_DAYS * this.C.day;
  }
  queuedEta(id: Hex, now: number): number {
    const eta = this.queued.get(lc(id));
    return eta !== undefined && now <= eta + this.window() ? eta : 0;
  }
  private take(id: Hex, now: number): void {
    const eta = this.queued.get(lc(id));
    req(eta !== undefined, `NotQueued(${id})`);
    req(now >= eta, `TimelockActive(${eta})`);
    req(now <= eta + this.window(), `ActionExpired(${id}, ${eta + this.window()})`);
    this.queued.delete(lc(id));
  }
  queueAction(a: ActionFields, now: number): Hex {
    const id = actionIdOf(a);
    req(this.queuedEta(id, now) === 0, `AlreadyQueued(${id})`);
    const eta = now + this.clocks.timelock;
    this.queued.set(lc(id), eta);
    this.emit("ActionQueued", "0x" as Hex, 0, now, { id, eta, kind: a.kind, slot: a.slot, addr: a.addr, actionGpuId: a.gpuId, actionDay: a.day, mode: a.mode });
    return id;
  }
  executeAction(a: ActionFields, now: number): void {
    const id = actionIdOf(a);
    this.take(id, now);
    this.emit("ActionExecuted", "0x" as Hex, 0, now, { id, kind: a.kind });
  }
  cancelAction(a: ActionFields, now: number): void {
    const id = actionIdOf(a);
    req(this.queued.has(lc(id)), `NotQueued(${id})`);
    this.queued.delete(lc(id));
    this.emit("ActionCancelled", "0x" as Hex, 0, now, { id });
  }
  queueReaderSwap(gpuId: Hex, slot: number, url: string, parserVersion: string, reason: string, now: number): Hex {
    const g = this.g(gpuId);
    req(slot < g.nSlots, "BadSlot");
    const id = readerSwapIdOf(g.gpuId, slot, url, parserVersion);
    req(this.queuedEta(id, now) === 0, `AlreadyQueued(${id})`);
    const eta = now + this.clocks.timelock;
    this.queued.set(lc(id), eta);
    this.swapReason.set(lc(id), reason);
    this.emit("ReaderSwapQueued", g.gpuId, 0, now, { id, slot, url, parserVersion, reason, eta });
    return id;
  }
  executeReaderSwap(gpuId: Hex, slot: number, url: string, parserVersion: string, now: number): number {
    const g = this.g(gpuId);
    const id = readerSwapIdOf(g.gpuId, slot, url, parserVersion);
    this.take(id, now);
    const fromDay = this.dayId(now + this.C.slice) + 1;
    const key = `${lc(g.gpuId)}:${slot}`;
    const h = this.readerHistory.get(key) ?? [];
    req(h.length === 0 || h[h.length - 1]!.fromDay < fromDay, `ReaderSwapPending(${fromDay})`);
    const reason = this.swapReason.get(lc(id)) ?? "";
    const readerHash = readerHashOf(url, parserVersion);
    h.push({ fromDay, executedAt: now, readerHash, url, parserVersion, reason });
    this.readerHistory.set(key, h);
    this.swapReason.delete(lc(id));
    this.emit("ReaderSwapped", g.gpuId, 0, now, { id, slot, fromDay, readerHash, url, parserVersion, reason });
    return fromDay;
  }
  cancelReaderSwap(gpuId: Hex, slot: number, url: string, parserVersion: string, now: number): void {
    const g = this.g(gpuId);
    const id = readerSwapIdOf(g.gpuId, slot, url, parserVersion);
    req(this.queued.has(lc(id)), `NotQueued(${id})`);
    this.queued.delete(lc(id));
    this.swapReason.delete(lc(id));
    this.emit("ReaderSwapCancelled", g.gpuId, 0, now, { id, slot });
  }

  // ------------------------------------------------------------------ views

  record(gpuId: Hex, d: number, now: number): { exists: boolean; isFinal: boolean; rec: IndexRecord } {
    const g = this.gpus.get(lc(gpuId));
    const r = g?.records.get(d);
    if (!r) return { exists: false, isFinal: false, rec: emptyRecord() };
    return { exists: true, isFinal: this.isFinal(r, now), rec: toIndexRecord(r) };
  }

  previewRecord(gpuId: Hex, d: number, w: Address, now: number): { ok: boolean; detail: Computed | null } {
    const g = this.gpus.get(lc(gpuId));
    if (!g) return { ok: false, detail: null };
    const r = g.records.get(d);
    let pre: SlotState[];
    let t: number;
    if (d === g.head - 1 && r && !r.carried && !this.isFinal(r, now)) {
      pre = g.base;
      t = r.postedAt;
    } else if (d === g.head) {
      pre = g.last;
      t = now;
    } else return { ok: false, detail: null };
    if (!this.eligible(g, d).some((x) => lc(x) === lc(w))) return { ok: false, detail: null };
    const c = this.compute(g, d, w, pre, t);
    return { ok: c.quorate, detail: c };
  }

  readings(gpuId: Hex, d: number, w: Address): Readings & { slotSlices: number[] } {
    const g = this.g(gpuId);
    const a = this.accOf(g, d, w);
    return {
      sums: a ? [...a.sums] : Array(g.nSlots).fill(0),
      counts: a ? [...a.counts] : Array(g.nSlots).fill(0),
      sliceBits: BigInt(a?.sliceBits ?? 0),
      late: a?.late ?? false,
      anyValid: a?.anyValid ?? false,
      lastPostAt: BigInt(a?.lastPostAt ?? 0),
      slotSlices: a ? [...a.slotSlices] : Array(g.nSlots).fill(0),
    };
  }
}

export function emptyRecord(): IndexRecord {
  return {
    value: 0, status: Status.NONE, fresh: 0, quorum: 0, held: 0, freshMedian: 0, late: false, incomplete: false, changed: false, needsSign: false,
    dropped: false, source: ZERO, postedAt: 0n, finalAt: 0n, attestedAt: 0n, attestedBy: ZERO, digest: `0x${"00".repeat(32)}`,
  };
}

export function toIndexRecord(r: ModelRecord): IndexRecord {
  return {
    value: r.value, status: r.status, fresh: r.fresh, quorum: r.quorum, held: r.held, freshMedian: r.freshMedian, late: r.late,
    incomplete: r.incomplete, changed: r.changed, needsSign: r.needsSign, dropped: r.dropped, source: r.source,
    postedAt: BigInt(r.postedAt), finalAt: BigInt(r.finalAt), attestedAt: BigInt(r.attestedAt), attestedBy: r.attestedBy, digest: r.digest,
  };
}
