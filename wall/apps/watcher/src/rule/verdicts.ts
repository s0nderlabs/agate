// Rule R v4.3, 6.4: STRICT, FIX-OK, NEAR, the R1b gate, the strict (R11) and relaxed (R12) hand ranges, and the
// guardian's VETO view (R3, R7). Pure.
import { Kind, P_MAX, P_MIN } from "@agate/report/types";
import { cent, median } from "../formula.ts";
import { lower, type RuleContext } from "./context.ts";
import { checkValue, hull, widen } from "./evidence.ts";
import type { CandidateRecord, CheckResult, HandVerdict, Range, SlotCheck, Verdict, VetoView } from "./types.ts";

const KIND_NAME = ["OUT", "FRESH", "HELD"] as const;

/** Fix range over the IN slots: family low/high = cent median of member lows/highs; then the cent median of
 *  families (6.2). null when a needed slot range is not an interval or no family has an IN slot. */
export function fixRange(ctx: RuleContext, kinds: readonly Kind[], ranges: Map<number, Range>): [number, number] | null {
  const lows: number[] = [];
  const highs: number[] = [];
  const nFam = ctx.gpu.famQ.length;
  for (let f = 0; f < nFam; f++) {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < ctx.n; i++) {
      if (ctx.gpu.family[i] !== f || kinds[i] === Kind.OUT) continue;
      const r = ranges.get(i);
      if (!r) return null;
      if (r.t === "any") {
        lo.push(P_MIN);
        hi.push(P_MAX);
      } else if (r.t === "int") {
        lo.push(r.lo);
        hi.push(r.hi);
      } else return null;
    }
    if (lo.length > 0) {
      lows.push(cent(median(lo)));
      highs.push(cent(median(hi)));
    }
  }
  if (lows.length === 0) return null;
  return [cent(median(lows)), cent(median(highs))];
}

function slotBase(ctx: RuleContext, c: CandidateRecord, i: number): SlotCheck {
  const e = ctx.expected(i);
  const row: SlotCheck = {
    slot: i,
    cls: ctx.readable(i) ? ctx.cls(i) : null,
    exp: e.exp,
    kind: c.kinds[i]!,
    counts: c.counts[i]!,
    p: c.p[i]!,
    result: "skip",
  };
  if (e.expAlt !== undefined) row.expAlt = e.expAlt;
  return row;
}

/** STRICT check 4 for one slot (also the "value check it needs" that defines unverifiable for NEAR). */
function strictValue(ctx: RuleContext, c: CandidateRecord, i: number): { result: CheckResult; range: Range; from: string } {
  const p = c.p[i]!;
  const cls = ctx.cls(i);
  if (cls === "UNKNOWN") {
    const r = ctx.partial(i);
    return { result: checkValue(p, r), range: r, from: "partial" };
  }
  if (cls === "NOT_FRESH" && ctx.blind(i)) {
    const ok = ctx.blindAgree(ctx.d, c.source, i, p);
    return { result: ok ? "inside" : "unverifiable", range: { t: "int", lo: p, hi: p }, from: "pp" };
  }
  const fb = ctx.fallback(ctx.complete(i), i);
  let res = checkValue(p, fb.range);
  if (res !== "inside" && fb.range.t === "int" && ctx.sameSide(ctx.d, c.source, i, p, fb.range.lo, fb.range.hi))
    return { result: "exception", range: fb.range, from: fb.from || "complete" };
  // 6.2: a slot the watcher read DARK (not blind) is never unverifiable: a fresh value there fails
  if (res === "unverifiable" && cls === "NOT_FRESH") res = "fail";
  return { result: res, range: fb.range, from: fb.from || "complete" };
}

function heldRange(ctx: RuleContext, i: number): Range {
  return ctx.remembered(i).range;
}

/** STRICT checks 2 to 4 for one slot; returns the row and the range the slot enters the fix range at. */
function strictSlot(ctx: RuleContext, c: CandidateRecord, i: number, why: string[]): { row: SlotCheck; ok: boolean; enter?: Range } {
  const row = slotBase(ctx, c, i);
  if (!ctx.readable(i)) return { row, ok: true };
  let ok = true;
  const k = c.kinds[i]!;
  const cls = row.cls!;
  if (!ctx.kindExpected(i, k)) {
    ok = false;
    why.push(`slot ${i}: kind ${KIND_NAME[k]} not expected (${KIND_NAME[row.exp!]}${row.expAlt !== undefined ? `/${KIND_NAME[row.expAlt]}` : ""})`);
    row.why = "kind";
  }
  if (k === Kind.OUT && cls !== "UNKNOWN" && (c.counts[i]! >= ctx.MR) !== (cls === "FRESH")) {
    ok = false;
    why.push(`slot ${i}: OUT with ${c.counts[i]} readings against class ${cls}`);
    row.why = row.why ?? "freshness";
  }
  let enter: Range | undefined;
  if (c.counts[i]! >= ctx.MR) {
    const v = strictValue(ctx, c, i);
    row.result = v.result;
    row.range = v.range;
    row.from = v.from;
    if (v.result !== "inside" && v.result !== "exception") {
      ok = false;
      why.push(`slot ${i}: p ${c.p[i]} ${v.result} (${v.from})`);
    }
    if (k === Kind.FRESH) enter = v.range;
  }
  if (k === Kind.HELD) {
    const r = heldRange(ctx, i);
    row.range = r;
    row.from = "remembered";
    row.result = r.t === "int" ? "inside" : "unverifiable";
    if (r.t !== "int") {
      ok = false;
      why.push(`slot ${i}: HELD with no remembered range`);
    }
    enter = r;
  }
  return { row, ok, enter };
}

export function strict(ctx: RuleContext, c: CandidateRecord): Verdict {
  const why: string[] = [];
  if (!c.complete) why.push("incomplete");
  const slots: SlotCheck[] = [];
  const ranges = new Map<number, Range>();
  let ok = c.complete;
  for (let i = 0; i < ctx.n; i++) {
    const s = strictSlot(ctx, c, i, why);
    slots.push(s.row);
    if (!s.ok) ok = false;
    if (s.enter) ranges.set(i, s.enter);
  }
  const fr = fixRange(ctx, c.kinds, ranges);
  if (!fr) {
    ok = false;
    why.push("no fix range");
  } else if (c.value < fr[0] || c.value > fr[1]) {
    ok = false;
    why.push(`value ${c.value} outside fix range ${fr[0]}..${fr[1]}`);
  }
  const v: Verdict = { ok, why, slots };
  if (fr) v.fixRange = fr;
  return v;
}

export function fixOk(ctx: RuleContext, c: CandidateRecord, isPending: boolean): Verdict {
  const why: string[] = [];
  let ok = true;
  if (!c.complete && !isPending) {
    ok = false;
    why.push("incomplete (only the pending record may be incomplete)");
  }
  const slots: SlotCheck[] = [];
  const ranges = new Map<number, Range>();
  for (let i = 0; i < ctx.n; i++) {
    const row = slotBase(ctx, c, i);
    slots.push(row);
    if (!ctx.readable(i)) continue;
    const k = c.kinds[i]!;
    const cls = row.cls!;
    const p = c.p[i]!;
    if (!ctx.memberExpected(i, k)) {
      ok = false;
      why.push(`slot ${i}: membership ${k === Kind.OUT ? "OUT" : "IN"} not expected`);
      row.why = "membership";
    }
    let wr: Range | null = null;
    if (cls === "FRESH") {
      const fb = ctx.fallback(ctx.ev[i]!.writerRange(ctx.d, ctx.slotSlicesOf(ctx.d, c.source, i)), i);
      wr = fb.range;
      row.from = fb.from || "writer";
    }
    if (c.counts[i]! >= ctx.MR) {
      let res: CheckResult;
      if (cls === "FRESH") {
        res = wr!.t === "fail" ? "fail" : checkValue(p, wr!);
        if (res !== "inside" && wr!.t === "int" && ctx.sameSide(ctx.d, c.source, i, p, wr!.lo, wr!.hi)) res = "exception";
        row.range = wr!;
      } else if (cls === "UNKNOWN") {
        const r = ctx.partial(i);
        res = checkValue(p, r);
        row.range = r;
        row.from = "partial";
      } else {
        res = ctx.blindAgree(ctx.d, c.source, i, p) ? "inside" : ctx.blind(i) ? "unverifiable" : "fail";
        row.range = { t: "int", lo: p, hi: p };
        row.from = "pp";
      }
      row.result = res;
      if (res !== "inside" && res !== "exception") {
        ok = false;
        why.push(`slot ${i}: p ${p} ${res} (${row.from})`);
      }
    }
    if (k === Kind.FRESH) {
      if (cls === "FRESH") ranges.set(i, wr!);
      else if (cls === "UNKNOWN") ranges.set(i, ctx.partial(i));
      else ranges.set(i, { t: "int", lo: p, hi: p });
    } else if (k === Kind.HELD) {
      if (cls === "FRESH") ranges.set(i, ctx.fallback(ctx.complete(i), i).range);
      else ranges.set(i, heldRange(ctx, i));
      if (row.result === "skip") {
        row.range = ranges.get(i)!;
        row.from = cls === "FRESH" ? "complete" : "remembered";
        row.result = row.range.t === "int" ? "inside" : "unverifiable";
      }
    }
  }
  const fr = fixRange(ctx, c.kinds, ranges);
  if (!fr) {
    ok = false;
    why.push("no fix range");
  } else if (c.value < fr[0] || c.value > fr[1]) {
    ok = false;
    why.push(`value ${c.value} outside fix range ${fr[0]}..${fr[1]}`);
  }
  const v: Verdict = { ok, why, slots };
  if (fr) v.fixRange = fr;
  return v;
}

/** Slots c reads fresh that are blind or unverifiable (6.2), for NEAR. */
export function unverifiableSlots(ctx: RuleContext, c: CandidateRecord): number[] {
  const out: number[] = [];
  for (let i = 0; i < ctx.n; i++) {
    if (!ctx.readable(i) || c.counts[i]! < ctx.MR) continue;
    if (ctx.blind(i)) {
      out.push(i);
      continue;
    }
    if (strictValue(ctx, c, i).result === "unverifiable") out.push(i);
  }
  return out;
}

export function near(ctx: RuleContext, c: CandidateRecord): Verdict {
  const why: string[] = [];
  let ok = c.complete;
  if (!c.complete) why.push("incomplete");
  const X = unverifiableSlots(ctx, c);
  const fams = new Set(X.map((i) => ctx.gpu.family[i]));
  if (fams.size > 1) {
    ok = false;
    why.push(`unverified slots ${X.join(",")} span ${fams.size} families`);
  }
  const slots: SlotCheck[] = [];
  const ranges = new Map<number, Range>();
  for (let i = 0; i < ctx.n; i++) {
    if (X.includes(i)) {
      const row = slotBase(ctx, c, i);
      row.result = "unverifiable";
      row.range = { t: "any" };
      row.from = "any";
      slots.push(row);
      if (c.kinds[i] !== Kind.OUT) ranges.set(i, { t: "any" });
      continue;
    }
    const s = strictSlot(ctx, c, i, why);
    slots.push(s.row);
    if (!s.ok) ok = false;
    if (s.enter) ranges.set(i, s.enter);
  }
  const fr = fixRange(ctx, c.kinds, ranges);
  if (!fr) {
    ok = false;
    why.push("no fix range");
  } else if (c.value < fr[0] || c.value > fr[1]) {
    ok = false;
    why.push(`value ${c.value} outside fix range ${fr[0]}..${fr[1]}`);
  }
  const v: Verdict = { ok, why, slots };
  if (fr) v.fixRange = fr;
  return v;
}

/** R1b gate (6.4). all: every candidate of the day, the pending one included. */
export function gate(ctx: RuleContext, c: CandidateRecord, all: readonly CandidateRecord[]): { ok: boolean; why?: string } {
  for (let i = 0; i < ctx.n; i++) {
    if (!ctx.readable(i) || c.kinds[i] === Kind.FRESH) continue;
    if (ctx.cls(i) !== "NOT_FRESH" || !ctx.blind(i)) continue;
    const flagged = (ctx.sc.blockedForWatcher ?? []).some((b) => b.slot === i && b.from <= ctx.d && ctx.d <= b.to);
    const freshAgreeing = all.some(
      (o) => o !== c && o.complete && o.kinds[i] === Kind.FRESH && ctx.blindAgree(ctx.d, o.source, i, o.p[i]!),
    );
    if (!flagged && !freshAgreeing) continue;
    const agree = all.some((o) => o !== c && o.complete && o.value === c.value);
    if (!agree) return { ok: false, why: `slot ${i} blind for the watcher (${flagged ? "flagged R4b" : "agreeing FRESH elsewhere"}): needs a second complete record with the same fix` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ hand ranges (R11 strict, R12 relaxed)

function bitCount(x: number): number {
  let n = 0;
  for (let v = x; v > 0; v = Math.floor(v / 2)) n += v % 2;
  return n;
}

export function hand(ctx: RuleContext, c: CandidateRecord, relaxed: boolean): HandVerdict {
  const why: string[] = [];
  let ok = true;
  const slots: SlotCheck[] = [];
  const ranges = new Map<number, Range>();
  const anyFams = new Set<number>();
  for (let i = 0; i < ctx.n; i++) {
    const row = slotBase(ctx, c, i);
    slots.push(row);
    if (!ctx.readable(i)) continue;
    const k = c.kinds[i]!;
    const p = c.p[i]!;
    const cls = row.cls!;
    const fresh = k === Kind.FRESH || (k === Kind.OUT && c.counts[i]! >= ctx.MR);
    const looks = ctx.lookValues(i);
    if (fresh) {
      let r: Range;
      let res: CheckResult;
      if (cls === "FRESH") {
        const comp = ctx.fallback(ctx.complete(i), i, ctx.d, true).range;
        const ss = ctx.slotSlicesOf(ctx.d, c.source, i);
        const wr0 = ctx.ev[i]!.writerRange(ctx.d, ss);
        // LV-7: a reading in an EMPTY slice (writer range FAIL) fails only with R3's dark reason; NR flickers, so
        // otherwise the slot is judged on the complete range alone
        const darkFail = wr0.t === "fail" && bitCount(ss) - ctx.ev[i]!.darkSlices(ctx.d, ss).length < ctx.MR;
        const wr = wr0.t === "fail" ? (darkFail ? wr0 : comp) : ctx.fallback(wr0, i, ctx.d, true).range;
        r = widen(wr.t === "fail" ? comp : hull(comp, wr), looks);
        res = wr.t === "fail" ? "fail" : checkValue(p, r);
        if (res !== "inside" && r.t === "int" && ctx.sameSide(ctx.d, c.source, i, p, r.lo, r.hi)) res = "exception";
        row.from = "hull";
      } else if (cls === "UNKNOWN") {
        r = widen(ctx.partial(i, ctx.d, true), looks);
        res = checkValue(p, r);
        row.from = "partial+looks";
        if (relaxed && res !== "inside") {
          // LV-2: another eligible writer's equal day value is agreement; a long UNK bridge leaves the slot
          // unverifiable (A3 cannot bound a page over a watcher gap that long)
          if (ctx.blindAgree(ctx.d, c.source, i, p)) {
            res = "inside";
            r = widen(r, [p]);
            row.from = "partial+looks+agreement";
          } else if (ctx.longBridge(i)) {
            res = "unverifiable";
            row.from = "partial, long bridge";
          }
        }
      } else {
        const lookRead = ctx.looksOf(i).some((lk) => typeof lk.cell === "number");
        if (ctx.blindAgree(ctx.d, c.source, i, p)) {
          r = { t: "int", lo: p, hi: p };
          res = "inside";
          row.from = "pp";
        } else if (!ctx.blind(i) && !lookRead) {
          r = { t: "empty" };
          res = "fail";
          row.from = "dark, no look read";
        } else {
          r = widen(ctx.partial(i, ctx.d, true), looks);
          res = checkValue(p, r);
          if (res === "unverifiable" && !ctx.blind(i)) res = "fail";
          row.from = "partial+looks";
        }
      }
      if (res === "unverifiable" && relaxed) {
        res = "inside";
        r = { t: "any" };
        row.from = "any";
        anyFams.add(ctx.gpu.family[i]!); // every fresh slot's family, OUT ones included (6.4 "any value")
      }
      row.result = res;
      row.range = r;
      if (res !== "inside" && res !== "exception") {
        ok = false;
        why.push(`slot ${i}: p ${p} ${res} (${row.from})`);
      }
      if (k === Kind.FRESH) ranges.set(i, r);
    } else if (k === Kind.HELD) {
      const e = ctx.pre[i]!.e;
      let r: Range;
      if (cls === "FRESH") {
        r = ctx.fallback(ctx.complete(i), i, ctx.d, true).range;
        row.from = "complete";
        if (relaxed && r.t === "int" && !(r.lo <= e && e <= r.hi)) {
          const others = ctx.otherValues(ctx.d, c.source, i);
          const anyInside = others.some((o) => r.t === "int" && r.lo <= o.v && o.v <= r.hi);
          // W1: only a writer-region look that could not read the page shows a writer-side block (another writer's
          // value outside the range, possibly a thief's, is no evidence)
          const lookFailed = ctx.looksOf(i).some((lk) => typeof lk.cell !== "number");
          if (!anyInside && lookFailed) {
            r = hull(r, { t: "int", lo: e, hi: e });
            row.from = "complete+e (writer-side block)";
          }
        }
      } else {
        r = ctx.remembered(i).range;
        row.from = "remembered";
        if (relaxed) {
          r = hull(r, { t: "int", lo: e, hi: e });
          row.from = "remembered+e";
        }
      }
      row.range = r;
      row.result = r.t === "int" ? "inside" : "unverifiable";
      if (r.t !== "int") {
        ok = false;
        why.push(`slot ${i}: HELD without a range`);
      }
      ranges.set(i, r);
    }
  }
  if (relaxed && anyFams.size > 0) {
    const F = new Set<number>();
    for (let i = 0; i < ctx.n; i++) if (c.kinds[i] !== Kind.OUT) F.add(ctx.gpu.family[i]!);
    if (anyFams.size > Math.floor((F.size - 1) / 2)) {
      ok = false;
      why.push(`${anyFams.size} unverifiable families of ${F.size}: R12 does not apply`);
    }
  }
  const fr = fixRange(ctx, c.kinds, ranges);
  if (!fr) {
    ok = false;
    why.push("no fix range");
  } else if (c.value < fr[0] || c.value > fr[1]) {
    ok = false;
    why.push(`value ${c.value} outside ${relaxed ? "relaxed" : "strict"} hand range ${fr[0]}..${fr[1]}`);
  }
  const v: HandVerdict = { ok, why, slots };
  if (fr) v.fixRange = fr;
  return v;
}

// ------------------------------------------------------------------ R3 VETO view and R7

export function vetoView(ctx: RuleContext, c: CandidateRecord, all: readonly CandidateRecord[]): VetoView {
  const slotRanges: { slot: number; range: Range }[] = [];
  const ranges = new Map<number, Range>();
  const slotReasons: number[] = [];
  const darkReasons: number[] = [];
  const darkCounts: { slot: number; nc: number; dark: number }[] = [];
  let inconclusive = false;
  const r7slot: boolean[] = [];
  let r7dark = true;
  for (let i = 0; i < ctx.n; i++) {
    if (!ctx.readable(i)) continue;
    const k = c.kinds[i]!;
    const fresh = c.counts[i]! >= ctx.MR;
    const ss = ctx.slotSlicesOf(ctx.d, c.source, i);
    if (k === Kind.HELD) ranges.set(i, { t: "int", lo: ctx.pre[i]!.e, hi: ctx.pre[i]!.e });
    if (!fresh) continue;
    const vr = ctx.ev[i]!.vetoRange(ctx.d, ss);
    slotRanges.push({ slot: i, range: vr });
    if (k === Kind.FRESH) {
      ranges.set(i, vr);
      if (vr.t === "any") inconclusive = true;
    }
    const p = c.p[i]!;
    if (vr.t === "int" && (p < vr.lo || p > vr.hi)) {
      slotReasons.push(i);
      r7slot.push(ctx.otherValues(ctx.d, c.source, i).some((o) => (p > vr.hi && o.v > vr.hi) || (p < vr.lo && o.v < vr.lo)));
    }
    const darkH = ctx.ev[i]!.darkSlices(ctx.d, ss);
    let nc = 0;
    for (let h = 0; h < ctx.geom.slices; h++) if (Math.floor(ss / 2 ** h) % 2 === 1) nc++;
    darkCounts.push({ slot: i, nc, dark: darkH.length });
    if (darkH.length > 0 && nc - darkH.length < ctx.MR) {
      darkReasons.push(i);
      const shared = ctx.writersOf(ctx.d).some(
        (w) => w.eligible && lower(w.address) !== lower(c.source) && darkH.some((h) => Math.floor((w.slotSlices[i] ?? 0) / 2 ** h) % 2 === 1),
      );
      if (!shared) r7dark = false;
    }
  }
  let fixRng: [number, number] | "inconclusive" = "inconclusive";
  let fixOutside = false;
  if (!inconclusive) {
    const fr = fixRange(ctx, c.kinds, ranges);
    if (fr) {
      fixRng = fr;
      fixOutside = c.value < fr[0] || c.value > fr[1];
    }
  }
  const r7fix = all.some((o) => o !== c && lower(o.source) !== lower(c.source) && o.quorate !== false && o.value === c.value);
  const r7 = { fix: r7fix, slot: slotReasons.length > 0 && r7slot.every(Boolean), dark: darkReasons.length > 0 && r7dark };
  // a slot or dark reason stands only once a writer-region look shows the watcher's view, not the writer's (HF-3)
  const confirmed: number[] = [];
  for (const i of new Set([...slotReasons, ...darkReasons])) {
    const looks = ctx.looksOf(i);
    if (looks.length === 0) continue;
    const vr = slotRanges.find((s) => s.slot === i)?.range;
    const p = c.p[i]!;
    const latest = looks[looks.length - 1]!;
    const lv = latest.cell;
    if (darkReasons.includes(i) && typeof lv !== "number" && lv !== "FAILED" && lv !== "MISSED") confirmed.push(i);
    else if (slotReasons.includes(i) && typeof lv === "number" && vr?.t === "int" && lv >= vr.lo && lv <= vr.hi && lv !== p) confirmed.push(i);
  }
  const cSlot = confirmed.some((i) => slotReasons.includes(i));
  const cDark = confirmed.some((i) => darkReasons.includes(i));
  const actionable = (fixOutside && !r7.fix) || (cSlot && !r7.slot) || (cDark && !r7.dark);
  return { fixRange: fixRng, fixOutside, slotRanges, slotReasons, darkReasons, darkCounts, r7, confirmed, actionable };
}
