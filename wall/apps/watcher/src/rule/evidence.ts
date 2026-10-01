// Rule R v4.3, sections 6.1 and 6.2 for one slot: rule-R states, side, span, the day class, blindness and the
// complete, writer and partial ranges. Pure; memoised per (slot, day).
import { cent } from "../formula.ts";
import type { LogCell, Look, Range, SlotClass, SlotLog } from "./types.ts";

export type RState = { s: "V"; v: number } | { s: "NR" } | { s: "DARK" } | { s: "UNK" };
const UNK: RState = { s: "UNK" };
const NR: RState = { s: "NR" };
const DARK: RState = { s: "DARK" };

export type Span = { t: "int"; lo: number; hi: number } | { t: "unknown" } | { t: "empty" };

export interface DayGeom {
  slices: number;
  epochDay: number;
  minReadings: number;
  gap: number;
}

export function kOfDay(g: DayGeom, d: number, h: number): number {
  return (d - g.epochDay) * g.slices + h;
}

/** The evidence of one slot: the watcher's cells, optionally with the guardian's looks filling UNK intervals. */
export class SlotEvidence {
  private readonly cells: Map<number, LogCell>;
  readonly lastLogged: number; // newest logged interval (-Infinity if none)
  readonly firstLogged: number;
  private readonly memo = new Map<string, unknown>();

  constructor(
    readonly geom: DayGeom,
    log: SlotLog,
    looks: readonly Look[] = [],
  ) {
    this.cells = new Map();
    log.cells.forEach((c, j) => this.cells.set(log.k0 + j, c));
    let last = log.cells.length > 0 ? log.k0 + log.cells.length - 1 : -Infinity;
    let first = log.cells.length > 0 ? log.k0 : Infinity;
    // A look never replaces a watcher line: it fills an interval whose watcher state is UNK (6.1).
    const sorted = [...looks].sort((a, b) => a.at - b.at);
    for (const lk of sorted) {
      const own = this.cells.get(lk.interval);
      if (own === undefined || own === "MISSED" || (own === "FAILED" && this.mapped(lk.interval).s === "UNK")) {
        this.cells.set(lk.interval, lk.cell);
        last = Math.max(last, lk.interval);
        first = Math.min(first, lk.interval);
      }
    }
    this.lastLogged = last;
    this.firstLogged = first;
  }

  raw(k: number): LogCell | undefined {
    return this.cells.get(k);
  }

  private mapped(k: number): RState {
    const c = this.cells.get(k);
    if (c === undefined || c === "MISSED") return UNK;
    if (typeof c === "number") return { s: "V", v: c };
    if (c === "NOT_RENTABLE") return NR;
    if (c === "NO_ROW" || c === "BAD_VALUE") return DARK;
    // FAILED: DARK inside a run of failures, UNK when isolated (HF-1)
    return this.cells.get(k - 1) === "FAILED" || this.cells.get(k + 1) === "FAILED" ? DARK : UNK;
  }

  R(k: number): RState {
    return this.mapped(k);
  }

  /** V, NR, or DARK from NO_ROW or BAD_VALUE (the page was actually read). */
  pageRead(k: number): boolean {
    const c = this.cells.get(k);
    return c !== undefined && c !== "MISSED" && c !== "FAILED";
  }

  private cached<T>(key: string, f: () => T): T {
    if (this.memo.has(key)) return this.memo.get(key) as T;
    const v = f();
    this.memo.set(key, v);
    return v;
  }

  /** side(j, dir): {v}, {} (observed no price) or null (UNKNOWN). */
  side(j: number, dir: 1 | -1): number[] | null {
    let allDark = true;
    for (let s = 0; s <= this.geom.gap; s++) {
      const st = this.R(j + s * dir);
      if (st.s === "V") return [st.v];
      if (st.s !== "NR" && st.s !== "DARK") allDark = false;
    }
    return allDark ? [] : null;
  }

  /** The nearest V beyond a run of NR or DARK starting at j (LV-1); null (UNKNOWN) at an UNK or past the log. */
  beyond(j: number, dir: 1 | -1): number[] | null {
    for (let k = j; ; k += dir) {
      const st = this.R(k);
      if (st.s === "V") return [st.v];
      if (st.s === "UNK") return null;
    }
  }

  span(d: number, h: number): Span {
    return this.cached(`span:${d}:${h}`, () => {
      const k = kOfDay(this.geom, d, h);
      const st = this.R(k);
      let L = this.side(k - 1, -1);
      let Rt = this.side(k + 1, 1);
      // a V slice next to observed darkness: the page may have come back (or gone) at another price inside this
      // interval, so that side reaches the nearest V beyond the dark run (6.2, LV-1)
      if (st.s === "V") {
        if (L !== null && L.length === 0) L = this.beyond(k - 1, -1);
        if (Rt !== null && Rt.length === 0) Rt = this.beyond(k + 1, 1);
      }
      if (L === null || Rt === null) return { t: "unknown" } as Span;
      const vals = st.s === "V" ? [st.v, ...L, ...Rt] : [...L, ...Rt];
      if (vals.length === 0) return (st.s === "UNK" ? { t: "unknown" } : { t: "empty" }) as Span;
      return { t: "int", lo: Math.min(...vals), hi: Math.max(...vals) } as Span;
    });
  }

  dayClass(d: number): SlotClass {
    return this.cached(`class:${d}`, () => {
      let nLo = 0;
      let nHi = 0;
      for (let h = 0; h < this.geom.slices; h++) {
        const k = kOfDay(this.geom, d, h);
        if (this.R(k).s === "V") nLo++;
        const dark = (x: number) => {
          const s = this.R(x).s;
          return s === "NR" || s === "DARK";
        };
        if (!(dark(k - 1) && dark(k) && dark(k + 1))) nHi++;
      }
      if (nLo >= this.geom.minReadings) return "FRESH";
      if (nHi < this.geom.minReadings) return "NOT_FRESH";
      return "UNKNOWN";
    });
  }

  /** Blind on d: class not FRESH and fewer than MIN_READINGS of the day's inner states were page reads (6.1). */
  blind(d: number): boolean {
    if (this.dayClass(d) === "FRESH") return false;
    let n = 0;
    for (let h = 0; h < this.geom.slices; h++) if (this.pageRead(kOfDay(this.geom, d, h))) n++;
    return n < this.geom.minReadings;
  }

  /** Inner states of d that are DARK (not NR), for R4b's "DARK majority". */
  darkCount(d: number): { dark: number; nr: number } {
    let dark = 0;
    let nr = 0;
    for (let h = 0; h < this.geom.slices; h++) {
      const s = this.R(kOfDay(this.geom, d, h)).s;
      if (s === "DARK") dark++;
      if (s === "NR") nr++;
    }
    return { dark, nr };
  }

  /** The V values the watcher read inside the intervals of d (for W(d)). */
  dayValues(d: number): number[] {
    const out: number[] = [];
    for (let h = 0; h < this.geom.slices; h++) {
      const st = this.R(kOfDay(this.geom, d, h));
      if (st.s === "V") out.push(st.v);
    }
    return out;
  }

  private avg(spans: { lo: number; hi: number }[]): [number, number] {
    const n = spans.length;
    let lo = 0;
    let hi = 0;
    for (const s of spans) {
      lo += s.lo;
      hi += s.hi;
    }
    return [cent(Math.floor(lo / n)), cent(Math.floor(hi / n))];
  }

  /** Complete range (STRICT): hull of avg(S) and avg(S+); UNKNOWN if any span is UNKNOWN; EMPTY when no slice could
   *  show a price. */
  completeRange(d: number): Range {
    return this.cached(`complete:${d}`, () => {
      const S: { lo: number; hi: number }[] = [];
      const Sp: { lo: number; hi: number }[] = [];
      for (let h = 0; h < this.geom.slices; h++) {
        const sp = this.span(d, h);
        if (sp.t === "unknown") return { t: "unknown" } as Range;
        if (sp.t !== "int") continue;
        Sp.push(sp);
        if (this.R(kOfDay(this.geom, d, h)).s === "V") S.push(sp);
      }
      if (Sp.length === 0) return { t: "empty" } as Range;
      const a = this.avg(Sp);
      const b = S.length > 0 ? this.avg(S) : a;
      return { t: "int", lo: Math.min(a[0], b[0]), hi: Math.max(a[1], b[1]) } as Range;
    });
  }

  /** Writer range (FIX-OK) over the slices whose entries carried a valid reading of the slot. */
  writerRange(d: number, slotSlices: number): Range {
    const spans: { lo: number; hi: number }[] = [];
    let empty = false;
    for (let h = 0; h < this.geom.slices; h++) {
      if (Math.floor(slotSlices / 2 ** h) % 2 !== 1) continue;
      const sp = this.span(d, h);
      if (sp.t === "unknown") return { t: "unknown" };
      if (sp.t === "empty") empty = true;
      else spans.push(sp);
    }
    if (empty) return { t: "fail" };
    if (spans.length === 0) return { t: "unknown" };
    const [lo, hi] = this.avg(spans);
    return { t: "int", lo, hi };
  }

  /** Partial range (D2) without its memory term: the day hull from a to b plus every interval span of d.
   *  remembered: the slot's remembered range on d when it has an anchor (added by the caller's context). */
  partialRange(d: number, remembered: Range | null): Range {
    const key = `partial:${d}:${remembered && remembered.t === "int" ? `${remembered.lo}-${remembered.hi}` : "-"}`;
    return this.cached(key, () => {
      const k0 = kOfDay(this.geom, d, 0);
      const k1 = kOfDay(this.geom, d, this.geom.slices - 1);
      // a and b are the nearest intervals with a V state (LV-1: availability may change between V readings)
      let a: number | null = null;
      for (let k = k0; k >= this.firstLogged && Number.isFinite(this.firstLogged); k--) {
        if (this.R(k).s === "V") {
          a = k;
          break;
        }
      }
      let b: number | null = null;
      for (let k = k1; k <= this.lastLogged; k++) {
        if (this.R(k).s === "V") {
          b = k;
          break;
        }
      }
      const vals: number[] = [];
      for (let k = a ?? k0; k <= (b ?? k1); k++) {
        const st = this.R(k);
        if (st.s === "V") vals.push(st.v);
      }
      for (let h = 0; h < this.geom.slices; h++) {
        const sp = this.span(d, h);
        if (sp.t === "int") vals.push(sp.lo, sp.hi);
      }
      if (remembered && remembered.t === "int") vals.push(remembered.lo, remembered.hi);
      const open = a === null || b === null;
      if (vals.length === 0) return (open ? { t: "unknown" } : { t: "empty" }) as Range;
      return { t: "int", lo: Math.min(...vals), hi: Math.max(...vals), open } as Range;
    });
  }

  /** R12's long bridge (6.4, LV-2): a run of more than `lim` UNK intervals just before d (over logged intervals),
   *  just after it (up to kNow, the interval of now), or inside it. */
  longBridge(d: number, lim: number, kNow: number): boolean {
    const k0 = kOfDay(this.geom, d, 0);
    const k1 = kOfDay(this.geom, d, this.geom.slices - 1);
    let n = 0;
    for (let k = k0 - 1; k >= this.firstLogged && this.R(k).s === "UNK" && n <= lim; k--) n++;
    let m = 0;
    for (let k = k1 + 1; k <= kNow && this.R(k).s === "UNK" && m <= lim; k++) m++;
    let inner = 0;
    for (let h = 0; h < this.geom.slices; h++) if (this.R(kOfDay(this.geom, d, h)).s === "UNK") inner++;
    return n > lim || m > lim || inner > lim;
  }

  /** The per-slot VETO range (R3) over the candidate's slices for the slot. */
  vetoRange(d: number, slotSlices: number): Range {
    let lo = 0;
    let hi = 0;
    let n = 0;
    for (let h = 0; h < this.geom.slices; h++) {
      if (Math.floor(slotSlices / 2 ** h) % 2 !== 1) continue;
      const k = kOfDay(this.geom, d, h);
      const three = [this.R(k - 1), this.R(k), this.R(k + 1)];
      if (three.some((s) => s.s !== "V")) return { t: "any" };
      const vs = three.map((s) => (s as { v: number }).v);
      lo += Math.min(...vs);
      hi += Math.max(...vs);
      n++;
    }
    if (n === 0) return { t: "any" };
    return { t: "int", lo: cent(Math.floor(lo / n)), hi: cent(Math.floor(hi / n)) };
  }

  /** R3's dark reason: the candidate's valid slices of the slot whose three watcher states are all DARK. */
  darkSlices(d: number, slotSlices: number): number[] {
    const out: number[] = [];
    for (let h = 0; h < this.geom.slices; h++) {
      if (Math.floor(slotSlices / 2 ** h) % 2 !== 1) continue;
      const k = kOfDay(this.geom, d, h);
      if ([k - 1, k, k + 1].every((x) => this.R(x).s === "DARK")) out.push(h);
    }
    return out;
  }
}

/** Checks a fresh value against a range after the fallback (6.2): inside, fail (closed, EMPTY or FAIL), or
 *  unverifiable (outside an open partial range, or no values and open). */
export function checkValue(p: number, r: Range): "inside" | "fail" | "unverifiable" {
  if (r.t === "any") return "inside";
  if (r.t === "int") {
    if (r.lo <= p && p <= r.hi) return "inside";
    return r.open ? "unverifiable" : "fail";
  }
  if (r.t === "unknown") return "unverifiable";
  return "fail";
}

export function hull(a: Range, b: Range): Range {
  if (a.t !== "int") return b;
  if (b.t !== "int") return a;
  return { t: "int", lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), open: Boolean(a.open && b.open) };
}

export function widen(r: Range, vals: readonly number[]): Range {
  if (vals.length === 0) return r;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (r.t === "int") return { ...r, lo: Math.min(r.lo, lo), hi: Math.max(r.hi, hi) };
  if (r.t === "unknown" || r.t === "empty") return { t: "int", lo, hi, open: r.t === "unknown" };
  return r;
}
