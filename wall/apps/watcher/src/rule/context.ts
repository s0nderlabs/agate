// Rule R v4.3: per-scenario context. Expected kinds from the onchain pre-state (6.3), anchors, vouched checks and
// remembered ranges (6.2), the walked count, W(d), the same-side exception and blind-slot agreement.
import type { Address, SlotState } from "@agate/report/types";
import { HOLD_DAYS, Kind } from "@agate/report/types";
import { gapOf } from "../clock.ts";
import { cent, type GpuShape, isEntry, live, median, readable } from "../formula.ts";
import { checkValue, type DayGeom, SlotEvidence } from "./evidence.ts";
import type { CandidateRecord, HistoryDay, Look, Range, RuleScenario, SlotClass, WriterDay } from "./types.ts";

export interface Remembered {
  range: Range;
  anchor: number | null;
  vouched: boolean | null;
  mismatch: boolean; // R9_HELD_MISMATCH
  unvouched: boolean; // R9_HELD_UNVOUCHED
}

export interface Expected {
  exp: Kind | null; // null: not readable
  expAlt?: Kind; // class UNKNOWN: expN (exp = expF)
}

export function lower(a: string): string {
  return a.toLowerCase();
}

export class RuleContext {
  readonly geom: DayGeom;
  readonly gpu: GpuShape;
  readonly MR: number;
  readonly H = HOLD_DAYS;
  readonly d: number;
  readonly ev: SlotEvidence[];
  readonly evL: SlotEvidence[]; // with the guardian's looks
  readonly hist = new Map<number, HistoryDay>();
  readonly guardAct: number;
  private readonly memoRem = new Map<string, Remembered>();
  private readonly memoVouched = new Map<string, boolean>();
  private readonly memoExp = new Map<number, Expected>();

  constructor(readonly sc: RuleScenario) {
    const c = sc.clock;
    this.geom = { slices: c.slices, epochDay: c.epochDay, minReadings: c.minReadings, gap: gapOf(c.slices) };
    this.MR = c.minReadings;
    this.d = sc.day;
    this.gpu = { nSlots: sc.gpu.nSlots, family: sc.gpu.family, famQ: sc.gpu.famQ, liveFrom: sc.gpu.liveFrom, liveUntil: sc.gpu.liveUntil };
    this.guardAct = sc.guardAct ?? Math.floor(c.day / 4);
    const looksBySlot: Look[][] = Array.from({ length: sc.gpu.nSlots }, () => []);
    for (const lk of sc.looks ?? []) looksBySlot[lk.slot]?.push(lk);
    this.ev = sc.log.map((l) => new SlotEvidence(this.geom, l));
    this.evL = sc.log.map((l, i) => new SlotEvidence(this.geom, l, looksBySlot[i]));
    for (const h of sc.history) this.hist.set(h.day, h);
  }

  get n(): number {
    return this.gpu.nSlots;
  }
  readable(i: number, d = this.d): boolean {
    return readable(this.gpu, i, d);
  }
  live(i: number, d = this.d): boolean {
    return live(this.gpu, i, d);
  }
  get entry(): boolean {
    return isEntry(this.d, this.sc.firstRecordDay);
  }
  cls(i: number, d = this.d): SlotClass {
    return this.ev[i]!.dayClass(d);
  }
  blind(i: number, d = this.d): boolean {
    return this.ev[i]!.blind(d);
  }
  get pre(): readonly SlotState[] {
    return this.sc.pre;
  }

  /** 6.3: the kind an honest writer whose freshness equals the watcher's class must show. */
  expected(i: number): Expected {
    const hit = this.memoExp.get(i);
    if (hit) return hit;
    let out: Expected;
    if (!this.readable(i)) out = { exp: null };
    else {
      const pre = this.pre[i]!;
      const kindAt = (miss: number): Kind => {
        const elig = this.live(i) && miss <= this.H && (pre.wasIn || this.entry);
        return elig ? (miss === 0 ? Kind.FRESH : Kind.HELD) : Kind.OUT;
      };
      const missN = Math.min(pre.miss + 1, this.H + 1);
      const c = this.cls(i);
      if (c === "FRESH") out = { exp: kindAt(0) };
      else if (c === "NOT_FRESH") out = { exp: kindAt(missN) };
      else out = { exp: kindAt(0), expAlt: kindAt(missN) };
    }
    this.memoExp.set(i, out);
    return out;
  }

  kindExpected(i: number, k: Kind): boolean {
    const e = this.expected(i);
    return e.exp === k || e.expAlt === k;
  }
  memberExpected(i: number, k: Kind): boolean {
    const e = this.expected(i);
    const inn = k !== Kind.OUT;
    return (e.exp !== null && (e.exp !== Kind.OUT) === inn) || (e.expAlt !== undefined && (e.expAlt !== Kind.OUT) === inn);
  }

  // ------------------------------------------------------------ other writers (6.2)

  writersOf(day: number): WriterDay[] {
    return day === this.d ? this.sc.writers : (this.hist.get(day)?.writers ?? []);
  }

  /** Day values of slot i from every other eligible writer with MIN_READINGS readings. */
  otherValues(day: number, source: Address, i: number): { w: Address; v: number }[] {
    const out: { w: Address; v: number }[] = [];
    for (const w of this.writersOf(day)) {
      if (!w.eligible || lower(w.address) === lower(source)) continue;
      const c = w.counts[i] ?? 0;
      if (c >= this.MR) out.push({ w: w.address, v: cent(Math.floor(w.sums[i]! / c)) });
    }
    return out;
  }

  /** Same-side exception (HF-4, F7): signing form requires p between the range and v'; R7's form only the side. */
  sameSide(day: number, source: Address, i: number, p: number, lo: number, hi: number, between = true): boolean {
    for (const { v } of this.otherValues(day, source, i)) {
      if (between ? (hi < p && p <= v) || (v <= p && p < lo) : (p > hi && v > hi) || (p < lo && v < lo)) return true;
    }
    return false;
  }

  blindAgree(day: number, source: Address, i: number, p: number): boolean {
    return this.otherValues(day, source, i).some((o) => o.v === p);
  }

  slotSlicesOf(day: number, source: Address, i: number): number {
    const w = this.writersOf(day).find((x) => lower(x.address) === lower(source));
    return w?.slotSlices[i] ?? 0;
  }

  // ------------------------------------------------------------ ranges with fallback

  complete(i: number, day = this.d): Range {
    return this.ev[i]!.completeRange(day);
  }

  /** Partial range with its memory term (the remembered range when the slot has an anchor). */
  partial(i: number, day = this.d, looks = false): Range {
    const rem = this.remembered(i, day);
    const memory = rem.anchor !== null ? rem.range : null;
    return (looks ? this.evL : this.ev)[i]!.partialRange(day, memory);
  }

  /** A range after D2's fallback: UNKNOWN goes to the partial range; FAIL and EMPTY stay. */
  fallback(r: Range, i: number, day = this.d, looks = false): { range: Range; from: string } {
    if (r.t === "unknown") return { range: this.partial(i, day, looks), from: "partial" };
    return { range: r, from: "" };
  }

  // ------------------------------------------------------------ anchors and the remembered range

  anchor(i: number, day: number): HistoryDay | null {
    for (let j = day - 1; j >= this.sc.gpu.firstDay; j--) {
      const h = this.hist.get(j);
      if (!h) return null; // history not supplied that far back: no anchor known
      if (h.carried || !h.post) continue;
      if (h.post[i]?.miss === 0) return h;
    }
    return null;
  }

  /** vouched(i, j): slot i of j's final record passes on day j the value check its kind and class call for. */
  vouched(i: number, j: HistoryDay): boolean {
    const key = `${i}:${j.day}`;
    const hit = this.memoVouched.get(key);
    if (hit !== undefined) return hit;
    let ok = false;
    if (j.handSigned) ok = true;
    else if (j.p && j.source && j.writers) {
      const p = j.p[i]!;
      const c = this.cls(i, j.day);
      if (c === "UNKNOWN") ok = checkValue(p, this.partial(i, j.day)) === "inside";
      else if (c === "NOT_FRESH") ok = this.blindAgree(j.day, j.source, i, p);
      else {
        const viaRange = (r: Range) => {
          if (r.t === "fail") return false;
          const res = checkValue(p, r);
          return res === "inside" || (r.t === "int" && this.sameSide(j.day, j.source!, i, p, r.lo, r.hi));
        };
        ok =
          viaRange(this.fallback(this.complete(i, j.day), i, j.day).range) ||
          viaRange(this.fallback(this.ev[i]!.writerRange(j.day, this.slotSlicesOf(j.day, j.source, i)), i, j.day).range);
      }
    }
    this.memoVouched.set(key, ok);
    return ok;
  }

  remembered(i: number, day = this.d): Remembered {
    const key = `${i}:${day}`;
    const hit = this.memoRem.get(key);
    if (hit) return hit;
    const given = day === this.d ? this.sc.remembered?.[i] : undefined;
    if (given !== undefined) {
      const out: Remembered = given === null
        ? { range: { t: "unknown" }, anchor: null, vouched: null, mismatch: false, unvouched: false }
        : { range: { t: "int", lo: given.lo, hi: given.hi }, anchor: given.anchorDay ?? null, vouched: given.vouched ?? null, mismatch: false, unvouched: false };
      this.memoRem.set(key, out);
      return out;
    }
    const a = this.anchor(i, day);
    let out: Remembered;
    if (!a) out = { range: { t: "unknown" }, anchor: null, vouched: null, mismatch: false, unvouched: false };
    else {
      const e = day === this.d ? this.pre[i]!.e : a.p![i]!;
      if (this.vouched(i, a)) out = { range: { t: "int", lo: e, hi: e }, anchor: a.day, vouched: true, mismatch: false, unvouched: false };
      else {
        const cr = this.complete(i, a.day);
        let known: Range | null = cr.t === "int" ? cr : null;
        if (!known) {
          const pr = this.partial(i, a.day);
          if (pr.t === "int" && !pr.open) known = pr;
        }
        if (known && known.t === "int" && (e < known.lo || e > known.hi))
          out = { range: { t: "int", lo: known.lo, hi: known.hi }, anchor: a.day, vouched: false, mismatch: true, unvouched: false };
        else out = { range: { t: "int", lo: e, hi: e }, anchor: a.day, vouched: false, mismatch: false, unvouched: true };
      }
    }
    this.memoRem.set(key, out);
    return out;
  }

  /** 6.2 walked count for a NOT_FRESH slot on d (alerts only). null = gave up. */
  walked(i: number): number | null {
    if (this.cls(i) !== "NOT_FRESH") return null;
    let n = 0;
    for (let j = this.d - 1; ; j--) {
      if (j < this.sc.gpu.firstDay) return null;
      const h = this.hist.get(j);
      if (!h) return null;
      if (h.carried) {
        if (h.missAdvanced !== undefined && Math.floor(h.missAdvanced / 2 ** i) % 2 === 1) n++;
      } else {
        if (!this.readable(i, j)) return null;
        const c = this.cls(i, j);
        if (c === "UNKNOWN") return null;
        if (c === "FRESH") return n;
        n++;
      }
      if (n >= this.H + 1) return this.H + 1;
    }
  }

  /** W(d), the watcher's own value (6.1): orders candidates, never a check. 0 = unordered. */
  W(): number {
    const famSlots = new Map<number, number[]>();
    for (let i = 0; i < this.n; i++) {
      if (!this.readable(i)) continue;
      const e = this.expected(i);
      let kind = e.exp!;
      const vals = this.ev[i]!.dayValues(this.d);
      if (e.expAlt !== undefined) kind = vals.length > 0 ? e.exp! : e.expAlt;
      if (kind === Kind.OUT) continue;
      let v: number;
      const pr = kind === Kind.FRESH && this.complete(i).t !== "int" ? this.partial(i) : null;
      if (pr && pr.t === "int") {
        // finding I: with the complete range UNKNOWN the readings the watcher happened to log can sit on one side
        // of a step it slept through; the partial range's midpoint does not lean to either side
        v = cent(Math.floor((pr.lo + pr.hi) / 2));
      } else if (kind === Kind.FRESH) {
        if (vals.length === 0) continue;
        v = cent(Math.floor(vals.reduce((a, b) => a + b, 0) / vals.length));
      } else v = this.pre[i]!.e;
      const f = this.gpu.family[i]!;
      famSlots.set(f, [...(famSlots.get(f) ?? []), v]);
    }
    const fams = [...famSlots.values()].map((vs) => cent(median(vs)));
    return fams.length === 0 ? 0 : cent(median(fams));
  }

  /** R12's long bridge of slot i on d (6.4, LV-2), from the watcher's own states. */
  longBridge(i: number): boolean {
    const c = this.sc.clock;
    const slice = c.day / c.slices;
    const lim = Math.max(this.geom.gap, Math.floor(this.guardAct / slice));
    const kNow = Math.floor((this.sc.now - c.epochTs) / slice);
    return this.ev[i]!.longBridge(this.d, lim, kNow);
  }

  /** W from the guardian's look values at a candidate's membership (R11 with the watcher down). */
  lookW(c: CandidateRecord): number {
    const famSlots = new Map<number, number[]>();
    for (let i = 0; i < this.n; i++) {
      if (c.kinds[i] === Kind.OUT) continue;
      const vals = this.lookValues(i);
      const v = c.kinds[i] === Kind.HELD ? this.pre[i]!.e : vals.length > 0 ? cent(median(vals)) : null;
      if (v === null) continue;
      const f = this.gpu.family[i]!;
      famSlots.set(f, [...(famSlots.get(f) ?? []), v]);
    }
    const fams = [...famSlots.values()].map((vs) => cent(median(vs)));
    return fams.length === 0 ? 0 : cent(median(fams));
  }

  /** Values the writer-region looks read inside d or within GUARD_ACT after its end (6.4 hand ranges). */
  lookValues(i: number): number[] {
    const c = this.sc.clock;
    const start = c.epochTs + (this.d - c.epochDay) * c.day;
    const end = start + c.day + this.guardAct;
    const out: number[] = [];
    for (const lk of this.sc.looks ?? []) {
      if (lk.slot === i && lk.writerRegion && lk.at >= start && lk.at < end && typeof lk.cell === "number") out.push(lk.cell);
    }
    return out;
  }

  /** Writer-region looks of slot i taken at or after the start of d. */
  looksOf(i: number): Look[] {
    const c = this.sc.clock;
    const start = c.epochTs + (this.d - c.epochDay) * c.day;
    return (this.sc.looks ?? []).filter((lk) => lk.slot === i && lk.writerRegion && lk.at >= start);
  }

  dayStart(d = this.d): number {
    const c = this.sc.clock;
    return c.epochTs + (d - c.epochDay) * c.day;
  }
}
