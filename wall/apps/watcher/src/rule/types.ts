// Rule R v4.3 (BUILD-SPEC section 6): the JSON scenario the pure decision module takes and the verdict it returns.
// Everything here is plain JSON (numbers, strings, booleans, arrays): a differential test can write a scenario from
// the Python model, run evaluate() on it and compare the verdict table field by field.
//
// Conventions
// - Prices are u (1 u = $0.000001) per GPU-hour, integers on the cent grid where the spec says so.
// - Masks (sliceBits, slotSlices, missAdvanced) are plain numbers used as bit sets (bit h = 2^h), exact to 2^52.
// - Kind is the onchain enum: 0 OUT, 1 FRESH, 2 HELD.
// - Intervals are absolute: interval k = [epochTs + k*slice, epochTs + (k+1)*slice); k(d, h) = (d - epochDay)*slices + h.
import type { Address, Hex, Kind, SlotState } from "@agate/report/types";

/** One logged watcher (or look) reading of one slot in one interval. A number is VALID at that value. MISSED and an
 *  absent cell are UNK; FAILED is UNK when isolated and DARK inside a run of FAILED (6.1). */
export type LogCell = number | "NOT_RENTABLE" | "NO_ROW" | "BAD_VALUE" | "FAILED" | "MISSED";

/** The watcher's log of one slot: cells[j] is interval k0 + j. Intervals before k0 are unknown (UNK); intervals after
 *  the last cell are not yet logged (UNK, and the partial range's forward walk stops there). */
export interface SlotLog {
  k0: number;
  cells: LogCell[];
}

/** A guardian `look` (section 10): evidence for the hand ranges, R9b, R11 and R12 only, never for the attester. */
export interface Look {
  slot: number;
  interval: number;
  at: number; // unix s
  cell: LogCell;
  region: string; // operator's label
  writerRegion: boolean; // taken from the writer's region (R3, R4b, R12 need this)
}

export interface RuleClock {
  day: number;
  slices: number;
  minReadings: number;
  qMin: number;
  signAll: boolean;
  epochTs: number;
  epochDay: number;
  tPend: number;
  grace?: number; // for R12 timing and lag reporting only
}

export interface ScenarioGpu {
  gpuId: Hex;
  nSlots: number;
  family: number[]; // slot -> family id
  famQ: number[]; // family -> famQ
  liveFrom: number[]; // NEVER = 4294967295
  liveUntil: number[];
  firstDay: number;
}

/** One writer slot's stored readings for one day (readings() plus its ReadingsPosted validMasks). */
export interface WriterDay {
  address: Address;
  slot: number; // writer slot 0 (primary) or 1 (standby)
  /** writer slot address, nonzero, not suspended, not voided for the day (6.2 "another writer" and C3) */
  eligible: boolean;
  sums: number[];
  counts: number[];
  sliceBits: number;
  /** per slot: bit h set when this writer's entry of slice h carried a valid reading of the slot */
  slotSlices: number[];
}

/** A computed record (the pending one, or another writer's previewRecord of the same day). */
export interface CandidateRecord {
  source: Address;
  digest: Hex;
  value: number;
  p: number[];
  kinds: Kind[];
  counts: number[];
  post: SlotState[];
  complete: boolean;
  changed: boolean;
  needsSign: boolean;
  quorate?: boolean;
}

export interface PendingRecord extends CandidateRecord {
  postedAt: number;
  finalAt: number; // 0 = needs the countersign
  attestedAt: number;
}

/** A final record of an earlier day, with what rule R needs from it (anchors, walked count, R4, R8, R10). */
export interface HistoryDay {
  day: number;
  carried: boolean;
  dropped?: boolean;
  /** CARRIED only: DayCarried.missAdvanced */
  missAdvanced?: number;
  // computed records only (from the RecordSlots of the final record):
  source?: Address;
  digest?: Hex;
  value?: number;
  p?: number[];
  kinds?: Kind[];
  counts?: number[];
  post?: SlotState[];
  /** signed by hand under R11 or R12 (the guardian log names it): its fresh values count as vouched */
  handSigned?: boolean;
  /** the day's writers (for the vouched check: writer range, same-side exception, blind-slot agreement) */
  writers?: WriterDay[];
  /** R8 memory, written by the guardian tooling for that day's pending records */
  r8?: R8Memo[];
}

export interface R8Memo {
  writer: Address;
  fixOutside: boolean;
  otherGood: boolean; // another writer's record of the day was STRICT or FIX-OK
  confirmedSlots: number[]; // slot or dark reasons confirmed by a writer-region look
  replaced: boolean; // a select replaced this writer's record
}

export interface RuleScenario {
  version: 1;
  clock: RuleClock;
  gpu: ScenarioGpu;
  day: number; // d, the pending day (head - 1), or the head day when only previewing
  now: number;
  /** firstRecordDay as the formula sees it for d (null = none before d) */
  firstRecordDay: number | null;
  /** the onchain pre-state of d (slotStates base for the pending day) */
  pre: SlotState[];
  /** slot -> the watcher's log of that slot's page for this GPU */
  log: SlotLog[];
  looks?: Look[];
  writers: WriterDay[];
  pending: PendingRecord | null;
  /** every other writer's ok previewRecord of d (complete or not; R1 keeps the complete ones) */
  candidates: CandidateRecord[];
  history: HistoryDay[];
  /** R4b: a person flagged slot "blocked for the watcher" over days [from, to] */
  blockedForWatcher?: { slot: number; from: number; to: number }[];
  /** R12 timing: the earliest unix s at which an action alert R1_NO_CANDIDATE, R9 (a) or R5_HEAD_LAG was raised for d */
  alertRaisedAt?: number;
  /** a FixDropped of this GPU since its last final computed record (R12 applies at once, FREEZE_LOOP) */
  droppedSinceLastComputed?: boolean;
  /** the watcher is down: HEARTBEAT_LOST or WATCHER_GAP open (R12 looks cover every page) */
  watcherDown?: boolean;
  guardAct?: number; // default day / 4
  /** Differential tests only: each slot's remembered range on d given as an input (null = no anchor) instead of
   *  being derived from `history` (6.2). A model that computes anchors itself passes its result here. */
  remembered?: ({ lo: number; hi: number; anchorDay?: number; vouched?: boolean } | null)[];
}

// ---------------------------------------------------------------- outputs

export type SlotClass = "FRESH" | "NOT_FRESH" | "UNKNOWN";

export type Range =
  | { t: "int"; lo: number; hi: number; open?: boolean }
  | { t: "unknown" }
  | { t: "empty" } // every slice EMPTY: no price could have been read
  | { t: "fail" } // writer range with a reading in an EMPTY slice
  | { t: "any" }; // VETO range "any value", R12 "any value"

export type CheckResult = "inside" | "exception" | "fail" | "unverifiable" | "skip";

export interface SlotCheck {
  slot: number;
  cls: SlotClass | null; // null: not readable
  exp: Kind | null;
  expAlt?: Kind; // class UNKNOWN: expN (exp holds expF)
  kind: Kind;
  counts: number;
  p: number;
  result: CheckResult;
  range?: Range;
  from?: string; // which range: complete, partial, writer, remembered, pp, any, hull
  why?: string;
}

export interface Verdict {
  ok: boolean;
  why: string[];
  slots: SlotCheck[];
  fixRange?: [number, number];
}

export interface HandVerdict {
  ok: boolean;
  why: string[];
  fixRange?: [number, number];
  slots: SlotCheck[];
}

export interface VetoView {
  fixRange: [number, number] | "inconclusive";
  fixOutside: boolean;
  slotRanges: { slot: number; range: Range }[];
  slotReasons: number[]; // fresh slots outside their VETO range
  darkReasons: number[]; // fresh slots whose freshness came only from dark slices
  darkCounts: { slot: number; nc: number; dark: number }[];
  r7: { fix: boolean; slot: boolean; dark: boolean };
  /** slot and dark reasons confirmed by a writer-region look that shows the watcher's view */
  confirmed: number[];
  /** reasons R3 allows acting on now (fix needs no look; slot and dark need a confirming look) */
  actionable: boolean;
}

export interface CandidateVerdict {
  source: Address;
  digest: Hex;
  value: number;
  isPending: boolean;
  complete: boolean;
  changed: boolean;
  needsSign: boolean;
  strict: Verdict;
  fixOk: Verdict;
  near: Verdict;
  gate: { ok: boolean; why?: string };
  tier: 0 | 1 | 2 | 3;
  dist: number; // |value - W(d)|, 0 when W(d) is 0
  r11: HandVerdict;
  r12: HandVerdict;
  veto: VetoView;
}

export interface AlertDraft {
  code: string;
  severity: "info" | "action";
  slot?: number;
  writer?: Address;
  deadline?: number;
  message: string;
  data?: unknown;
}

export interface SlotView {
  slot: number;
  readable: boolean;
  cls: SlotClass | null;
  blind: boolean;
  exp: Kind | null;
  expAlt?: Kind;
  complete: Range;
  partial: Range;
  remembered: Range;
  anchor: number | null;
  vouched: boolean | null;
  walked: number | null;
}

export type ActionKind = "attest" | "select" | "none";

export interface RuleAction {
  kind: ActionKind;
  writer?: Address;
  digest?: Hex;
  why: string;
}

export interface Evaluation {
  day: number;
  now: number;
  W: number;
  slots: SlotView[];
  candidates: CandidateVerdict[]; // pending first, then the others in slot order
  /** R1 (the attester): what to send now */
  action: RuleAction;
  /** R11 and R12 for the guardian: best candidate by each, or none */
  guardian: {
    r11: { writer: Address; digest: Hex; value: number } | null;
    r12: { writer: Address; digest: Hex; value: number } | null;
    r12Ready: boolean;
    r12Why: string[];
    looksNeeded: number[]; // slots R12's looks must cover
    /** liveness: 6.6 step 3b, a needsSign record no candidate signs under R11 or R12 (never an R8 reason) */
    veto: { writer: Address; digest: Hex; reasons: string[]; liveness?: boolean } | null;
    r8: { writer: Address; reason: string }[];
  };
  alerts: AlertDraft[];
}
