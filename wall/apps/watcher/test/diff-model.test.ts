// Three-way differential test of rule R v4.3: the TS decision module (evaluate) against the two independent Python
// models outside the repo, verify-v43/liveness/model43.py and verify-v43/thief/rule_r43.py.
//
// Vectors: test/vectors-model/r1-*.json (random honest worlds, from model43's fuzz), test/vectors-model/thief/t43-*.json
// (decisions on the attack days of the v4.3 thief scenarios, from rule_r43's attester) and thief/e43-*.json (five small
// constructed worlds aimed at the seams where the implementations read the spec differently; their descriptions say
// which). test/vectors-model/cross/models.json holds, for every vector, the full verdict table of BOTH models, each
// re-evaluated from the vector's own inputs, and a hash of the vector. Pages are synthetic. Regenerate with
// verify-v43/diff/gen_diff_vectors.py (after any fuzz43.py vectors run, which deletes the top-level *.json).
// AGATE_DIFF_TABLE=1 prints every disagreement found.
//
// Compared per vector: the formula (value, p, kinds), W(d), each readable slot's class, blindness, expected kinds,
// complete and partial range, each candidate's STRICT, FIX-OK, NEAR, R1b gate, tier, R11 and R12 (no looks), and R1's
// action and alert. Where the three disagree, ADJUDICATED names the side the spec text supports; the test then requires
// the TS module to equal that side. Any disagreement not adjudicated fails the test.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "@agate/report/types";
import { Kind } from "@agate/report/types";
import { computeRecord } from "../src/formula.ts";
import { evaluate } from "../src/rule/decide.ts";
import type { CandidateRecord, Evaluation, LogCell, PendingRecord, Range, RuleScenario, WriterDay } from "../src/rule/types.ts";

const DIR = join(import.meta.dir, "vectors-model");
const THIEF_DIR = join(DIR, "thief");
const CROSS = join(DIR, "cross", "models.json");
const ADDR: Record<string, Address> = { w1: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", w2: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" };
const NAME = (a: Address | undefined) => (a ? Object.keys(ADDR).find((k) => ADDR[k]!.toLowerCase() === a.toLowerCase()) : undefined);
const KIND: Record<string, Kind> = { OUT: Kind.OUT, FRESH: Kind.FRESH, HELD: Kind.HELD };
const KIND_NAME = ["OUT", "FRESH", "HELD"] as const;
const GPU: Hex = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
const R1_ALERTS = ["R1_NO_CANDIDATE", "R9_UNCHANGED_NOT_STRICT"];

// ------------------------------------------------------------------------------------------------ vector shapes

interface MRange { lo: number; hi: number; open: boolean; empty: boolean }
type MSlot = { readable: false } | { readable: true; cls: string; blind: boolean; expected: string[]; completeRange: MRange | null; partialRange: MRange | null; remembered?: MRange | null; anchorDay?: number | null };
interface MVerdict { writer: string; tier: number; firstFailure?: string | null; strict?: boolean; fixOk?: boolean; near?: boolean; gate?: boolean; r11?: boolean; r12?: boolean }
interface MAction { type: string; writer?: string; alert?: string }
interface MTable { W: number; slots: MSlot[]; verdicts: MVerdict[]; action: MAction }
interface MVector {
  id: string;
  description: string;
  clocks: { name: string; DAY: number; SLICES: number; MIN_READINGS: number; Q_MIN: number; signAll: boolean; EPOCH_TS: number; EPOCH_DAY: number; T_PEND: number };
  now: number;
  day: number;
  gpu: { nSlots: number; family: number[]; famQ: number[]; liveFrom: number[]; liveUntil: number[]; firstRecordDay: number | null };
  preState: { e: number[]; inMedian: boolean[]; miss: number[]; wasIn: boolean[] };
  firstWriter: string | null;
  watcherLog: { kFrom: number; slots: string[][] };
  accumulators: Record<string, { counts: number[]; sums: number[]; sliceBits: number; slotSliceBits: number[] }>;
  candidates: { writer: string; isPending: boolean; complete: boolean; value: number; changed: boolean; needsSign: boolean; p: number[]; kinds: string[]; counts: number[] }[];
  expected: MTable;
}
interface Cross { vectors: Record<string, { hash: string; generatedBy: "liveness" | "thief"; liveness: MTable; thief: MTable }> }

// ------------------------------------------------------------------------------------------------ vector -> scenario

function cellOf(s: string): LogCell {
  if (s.startsWith("V:")) return Number(s.slice(2));
  if (s === "UNREAD") return "MISSED";
  return s as LogCell;
}

function toScenario(v: MVector): RuleScenario {
  const c = v.clocks;
  const n = v.gpu.nSlots;
  const pre = v.preState.e.map((e, i) => ({ e, miss: v.preState.miss[i]!, inMedian: v.preState.inMedian[i]!, wasIn: v.preState.wasIn[i]! }));
  const log = v.watcherLog.slots.map((cells) => {
    let end = cells.length;
    while (end > 0 && cells[end - 1] === "UNREAD") end--; // not yet read: beyond the log
    return { k0: v.watcherLog.kFrom, cells: cells.slice(0, end).map(cellOf) };
  });
  const writers: WriterDay[] = Object.entries(v.accumulators).map(([w, a]) => ({ address: ADDR[w]!, slot: w === "w1" ? 0 : 1, eligible: true, sums: a.sums, counts: a.counts, sliceBits: a.sliceBits, slotSlices: a.slotSliceBits }));
  const recs = v.candidates.map((m) => {
    const a = v.accumulators[m.writer]!;
    const r = computeRecord({
      params: { slices: c.SLICES, minReadings: c.MIN_READINGS, qMin: c.Q_MIN, signAll: c.signAll, tPend: c.T_PEND },
      gpu: { nSlots: n, family: v.gpu.family, famQ: v.gpu.famQ, liveFrom: v.gpu.liveFrom, liveUntil: v.gpu.liveUntil },
      gpuId: GPU,
      day: v.day,
      writer: ADDR[m.writer]!,
      postedAt: 0,
      pre,
      acc: { sums: a.sums, counts: a.counts, sliceBits: a.sliceBits, late: false, anyValid: true },
      prev: null,
      firstRecordDay: v.gpu.firstRecordDay,
      firstWriter: v.firstWriter ? ADDR[v.firstWriter]! : null,
    });
    const rec: CandidateRecord = { source: ADDR[m.writer]!, digest: r.digest, value: r.value, p: r.p, kinds: r.kinds, counts: r.counts, post: r.post, complete: m.complete, changed: m.changed, needsSign: m.needsSign, quorate: r.quorate };
    return { m, rec };
  });
  const pend = recs.find((x) => x.m.isPending)!;
  const pending: PendingRecord = { ...pend.rec, postedAt: v.now - 1, finalAt: pend.m.needsSign ? 0 : v.now + 1_000_000, attestedAt: 0 };
  return {
    version: 1,
    clock: { day: c.DAY, slices: c.SLICES, minReadings: c.MIN_READINGS, qMin: c.Q_MIN, signAll: c.signAll, epochTs: c.EPOCH_TS, epochDay: c.EPOCH_DAY, tPend: c.T_PEND },
    gpu: { gpuId: GPU, nSlots: n, family: v.gpu.family, famQ: v.gpu.famQ, liveFrom: v.gpu.liveFrom, liveUntil: v.gpu.liveUntil, firstDay: v.gpu.firstRecordDay ?? v.day },
    day: v.day,
    now: v.now,
    firstRecordDay: v.gpu.firstRecordDay,
    pre,
    log,
    writers,
    pending,
    candidates: recs.filter((x) => !x.m.isPending).map((x) => x.rec),
    history: [],
    // anchors and remembered ranges are model inputs (computed by the model from earlier days)
    remembered: v.expected.slots.map((s) => {
      if (!s.readable || !s.remembered || s.remembered.empty) return null;
      return { lo: s.remembered.lo, hi: s.remembered.hi, ...(typeof s.anchorDay === "number" ? { anchorDay: s.anchorDay } : {}) };
    }),
  };
}

// ------------------------------------------------------------------------------------------------ canonical tables

// complete: null (UNKNOWN, or no slice could show a price) | [lo, hi]; partial: "unknown" (no values, open) |
// "empty" (no values, closed) | [lo, hi, open]
type CRange = null | [number, number];
type PRange = "unknown" | "empty" | [number, number, boolean];
type Flat = Record<string, unknown>;

const mComplete = (r: MRange | null): CRange => (r && !r.empty ? [r.lo, r.hi] : null);
const mPartial = (r: MRange | null): PRange | null => (r === null ? null : r.empty ? (r.open ? "unknown" : "empty") : [r.lo, r.hi, r.open]);
const tComplete = (r: Range): CRange => (r.t === "int" ? [r.lo, r.hi] : null);
const tPartial = (r: Range): PRange | null => (r.t === "int" ? [r.lo, r.hi, Boolean(r.open)] : r.t === "unknown" ? "unknown" : r.t === "empty" ? "empty" : null);

/** Flattens a table to path -> value. Verdict fields a table does not carry (the captured `expected` has tiers only)
 *  are left out. NEAR is compared only where STRICT fails: with no blind or unverifiable slot NEAR is STRICT's checks 2
 *  to 5 (model43, TS) or false (rule_r43: "X empty, not NEAR"), a convention with no effect on the tier. */
function flatModel(t: MTable): Flat {
  const out: Flat = { W: t.W };
  t.slots.forEach((s, i) => {
    out[`slot${i}.readable`] = s.readable;
    if (!s.readable) return;
    out[`slot${i}.cls`] = s.cls;
    out[`slot${i}.blind`] = s.blind;
    out[`slot${i}.expected`] = [...new Set(s.expected)].sort().join("|");
    out[`slot${i}.complete`] = mComplete(s.completeRange);
    out[`slot${i}.partial`] = mPartial(s.partialRange);
  });
  for (const x of t.verdicts) {
    const p = `${x.writer}.`;
    out[`${p}tier`] = x.tier;
    for (const k of ["strict", "fixOk", "gate", "r11", "r12"] as const) if (x[k] !== undefined) out[p + k] = x[k];
    if (x.near !== undefined && x.strict === false) out[`${p}near`] = x.near;
  }
  out["action.type"] = t.action.type;
  out["action.writer"] = t.action.writer ?? null;
  out["action.alert"] = t.action.alert ?? null;
  return out;
}

function flatTs(v: MVector, ev: Evaluation): Flat {
  const out: Flat = { W: ev.W };
  ev.slots.forEach((s, i) => {
    out[`slot${i}.readable`] = s.readable;
    if (!s.readable) return;
    out[`slot${i}.cls`] = s.cls;
    out[`slot${i}.blind`] = s.blind;
    out[`slot${i}.expected`] = [...new Set([s.exp!, ...(s.expAlt !== undefined ? [s.expAlt] : [])].map((k) => KIND_NAME[k]))].sort().join("|");
    out[`slot${i}.complete`] = tComplete(s.complete);
    out[`slot${i}.partial`] = tPartial(s.partial);
  });
  for (const m of v.candidates) {
    const c = ev.candidates.find((x) => x.source === ADDR[m.writer])!;
    const p = `${m.writer}.`;
    out[`${p}tier`] = c.tier;
    out[`${p}strict`] = c.strict.ok;
    out[`${p}fixOk`] = c.fixOk.ok;
    out[`${p}gate`] = c.gate.ok;
    out[`${p}r11`] = c.r11.ok;
    out[`${p}r12`] = c.r12.ok;
    if (!c.strict.ok) out[`${p}near`] = c.near.ok;
  }
  out["action.type"] = ev.action.kind;
  out["action.writer"] = NAME(ev.action.writer) ?? null;
  // R1's own alert is the action one; R9 (a) after a select is info (R9: "info if the attester selected"), checked apart
  out["action.alert"] = ev.alerts.find((a) => R1_ALERTS.includes(a.code) && a.severity === "action")?.code ?? null;
  return out;
}

// ------------------------------------------------------------------------------------------------ adjudication

type Side = "ts" | "liveness" | "thief";
interface Adjudication {
  /** which side's value the spec text supports */
  spec: Side;
  /** the spec line (BUILD-SPEC.md section and the sentence) */
  line: string;
  why: string;
}

/** Disagreements found by this test and decided against the spec text (BUILD-SPEC.md, version 2), keyed
 *  `vectorId path` (path as in the flat table). The TS value must equal the `spec` side's value. */
const ADJUDICATED: Record<string, Adjudication> = {};
function adjudicate(keys: string[], a: Adjudication): void {
  for (const k of keys) ADJUDICATED[k] = a;
}

// Fix round 1 (Oct 1 2026, BUILD-SPEC 6.7) settled every seam the e43 vectors were built for: TS and both models now
// agree on e43-00 to e43-04 and t43 (6.2 unverifiable wording W2 and its DARK clause; R12 any value counts OUT
// families; LV-7 for a FAIL writer range; R11's NOT_FRESH row needs no look for a blind slot; NEAR's X leaves out a
// value the same-side exception decides). A new disagreement must be adjudicated here against the spec text.

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Disagreement { id: string; path: string; ts: unknown; liveness: unknown; thief: unknown; captured: unknown }

// ------------------------------------------------------------------------------------------------ the test

const r1Files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^r1-\d+\.json$/.test(f)).sort().map((f) => join(DIR, f)) : [];
const tFiles = existsSync(THIEF_DIR) ? readdirSync(THIEF_DIR).filter((f) => /^[te]43-\d+\.json$/.test(f)).sort().map((f) => join(THIEF_DIR, f)) : [];
const cross: Cross | null = existsSync(CROSS) ? (JSON.parse(readFileSync(CROSS, "utf8")) as Cross) : null;

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]));
  return x;
}
/** sha256 of the vector JSON with sorted keys, first 16 hex (the generator's vec_hash) */
function vecHash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(v))).digest("hex").slice(0, 16);
}

const found: Disagreement[] = [];
const used = new Set<string>();

describe("rule R v4.3: TS against model43.py and rule_r43.py", () => {
  test("the vectors and the cross table are present and match", () => {
    expect(r1Files.length, "test/vectors-model/r1-*.json (model43 fuzz vectors)").toBeGreaterThan(0);
    expect(tFiles.filter((f) => /t43-/.test(f)).length, "test/vectors-model/thief/t43-*.json").toBeGreaterThan(0);
    expect(tFiles.filter((f) => /e43-/.test(f)).length, "test/vectors-model/thief/e43-*.json").toBeGreaterThan(0);
    expect(cross, "test/vectors-model/cross/models.json").not.toBeNull();
    const ids = [...r1Files, ...tFiles].map((f) => f.split("/").pop()!.replace(/\.json$/, "")).sort();
    expect(Object.keys(cross!.vectors).sort()).toEqual(ids);
  });

  for (const f of [...r1Files, ...tFiles]) {
    const v = JSON.parse(readFileSync(f, "utf8")) as MVector;
    test(`${v.id}: ${v.description}`, () => {
      const x = cross!.vectors[v.id];
      expect(x, `${v.id} has no cross entry: rerun verify-v43/diff/gen_diff_vectors.py`).toBeDefined();
      expect(vecHash(v), `${v.id} changed since the cross table was made: rerun gen_diff_vectors.py`).toBe(x!.hash);
      const sc = toScenario(v);
      // the formula (4.6) on the model's readings and pre-state
      for (const m of v.candidates) {
        const mine = (m.isPending ? sc.pending! : sc.candidates.find((c) => c.source === ADDR[m.writer]))!;
        expect([m.writer, mine.value, mine.p, mine.kinds]).toEqual([m.writer, m.value, m.p, m.kinds.map((k) => KIND[k]!)]);
      }
      const ev = evaluate(sc);
      const ts = flatTs(v, ev);
      const lv = flatModel(x!.liveness);
      const th = flatModel(x!.thief);
      const cap = flatModel(v.expected);
      // each model's re-evaluation must agree with its own captured decision (the generator checks this too)
      const own = x!.generatedBy === "liveness" ? lv : th;
      for (const [k, val] of Object.entries(cap)) expect([k, own[k]]).toEqual([k, val]);

      const problems: string[] = [];
      // every path any side reports; only NEAR may be absent on a side (left out where that side's STRICT passed)
      for (const path of [...new Set([...Object.keys(ts), ...Object.keys(lv), ...Object.keys(th)])]) {
        const opt = path.endsWith(".near");
        const a = path in ts ? ts[path] : opt ? (path in lv ? lv[path] : th[path]) : "<absent>";
        const l = path in lv ? lv[path] : opt ? a : "<absent>";
        const t = path in th ? th[path] : opt ? a : "<absent>";
        if (eq(a, l) && eq(a, t)) continue;
        const key = `${v.id} ${path}`;
        found.push({ id: v.id, path, ts: a, liveness: l, thief: t, captured: cap[path] });
        const adj = ADJUDICATED[key];
        if (!adj) {
          problems.push(`${path}: ts ${JSON.stringify(a)}, liveness ${JSON.stringify(l)}, thief ${JSON.stringify(t)} (not adjudicated)`);
          continue;
        }
        used.add(key);
        const want = adj.spec === "ts" ? a : adj.spec === "liveness" ? l : t;
        if (!eq(a, want)) problems.push(`${path}: ts ${JSON.stringify(a)} but the spec (${adj.line}) gives ${JSON.stringify(want)} (${adj.spec})`);
      }
      expect(problems, problems.join("\n")).toEqual([]);

      // R9 (a): an unchanged pending record that is not STRICT raises R9 info when the attester selected, action otherwise
      const pv = ev.candidates.find((c) => c.isPending)!;
      if (!pv.needsSign && pv.tier < 3) {
        const r9 = ev.alerts.filter((a) => a.code === "R9_UNCHANGED_NOT_STRICT").map((a) => a.severity);
        expect(r9).toEqual([ev.action.kind === "select" ? "info" : "action"]);
      }
    });
  }

  test("every adjudication still matches a live disagreement", () => {
    if (process.env.AGATE_DIFF_TABLE) console.log(JSON.stringify(found, null, 1));
    const stale = Object.keys(ADJUDICATED).filter((k) => !used.has(k));
    expect(stale, `stale entries (the sides now agree, or the vector changed): ${stale.join(", ")}`).toEqual([]);
  });
});
