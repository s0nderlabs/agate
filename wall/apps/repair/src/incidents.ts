// Incidents (BUILD-SPEC 15.2): per (index, sourceId), from the index's watcher log, for sources with a live or reserve
// slot. Triggers: reader (NO_ROW or BAD_VALUE on a GPU the source prices, 3 consecutive served intervals), fetch
// (FAILED, 6 consecutive intervals), sold_out (NOT_RENTABLE on every GPU for DAY of intervals), wrong_cell (an open
// PAGECHECK_FAULT). An incident closes when the source reads VALID, within 10% of the trackers where compared, for 3
// consecutive intervals with the reader in force.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GpuModel, Hex } from "@agate/report/types";
import type { Line, WatchLog } from "@agate/pagecheck";
import type { Panel } from "@agate/sources/types";

export type IncidentKind = "reader" | "fetch" | "sold_out" | "wrong_cell";
export type DiagnosisKind = "sold_out" | "blocked" | "moved" | "redesign" | "wrong_cell" | "unsure";
export type IncidentStatus = "new" | "watch" | "draft" | "moved" | "shadow" | "noted" | "refused" | "closed";

export interface Evidence {
  intervals: number;
  served: number;
  noRow: number;
  badValue: number;
  notRentable: number;
  failed: number;
  valid: number;
  faults: number;
  lastHttp: number;
}

export interface Diagnosis {
  kind: DiagnosisKind;
  why: string;
  location?: string;
  support?: string[];
}

export interface Incident {
  id: string;
  index: string;
  sourceId: string;
  kind: IncidentKind;
  gpus: GpuModel[];
  sinceK: number;
  since: number;
  openedAt: number;
  openedK: number;
  evidence: Evidence;
  status: IncidentStatus;
  diagnosis?: Diagnosis;
  calls: number;
  draftId?: string;
  proposedUrl?: string;
  lastAttemptK?: number;
  lastRefusal?: string;
  shadow?: { fromK: number; lastK: number; good: number; seen: number };
  noteAt?: number;
  movedFetchK?: number;
  closedAt?: number;
  closedWhy?: string;
  updatedAt: number;
}

/** A served source of an index: its panel GPUs and slots. */
export interface SourceSlots {
  index: string;
  sourceId: string;
  gpus: GpuModel[];
  slots: { gpu: GpuModel; gpuId: Hex; slot: number }[];
}

export function servedSources(index: string, panels: readonly Panel[]): SourceSlots[] {
  const m = new Map<string, SourceSlots>();
  for (const p of panels)
    for (const s of p.slots) {
      let x = m.get(s.sourceId);
      if (!x) m.set(s.sourceId, (x = { index: index.toLowerCase(), sourceId: s.sourceId, gpus: [], slots: [] }));
      if (!x.gpus.includes(p.gpu)) x.gpus.push(p.gpu);
      x.slots.push({ gpu: p.gpu, gpuId: p.gpuId, slot: s.slot });
    }
  return [...m.values()];
}

const ok2xx = (l: Line) => l.attempts > 0 && l.httpStatus >= 200 && l.httpStatus < 300;

interface Cls {
  k: number;
  served: boolean;
  failed: boolean;
  bad: boolean; // a panel GPU NO_ROW or BAD_VALUE
  noRow: number;
  badValue: number;
  allNotRentable: boolean;
  notRentable: number;
  allValid: boolean;
  valid: number;
  http: number;
}

/** One interval of a source as the triggers see it; null when the watcher has no attempted line (MISSED). */
export function classify(log: WatchLog, sourceId: string, gpus: readonly GpuModel[], k: number): Cls | null {
  const lines = log.at(sourceId, k);
  if (lines.length === 0) return null;
  const c: Cls = { k, served: false, failed: false, bad: false, noRow: 0, badValue: 0, allNotRentable: gpus.length > 0, notRentable: 0, allValid: gpus.length > 0, valid: 0, http: lines[0]!.httpStatus };
  for (const g of gpus) {
    const l = log.lineFor(sourceId, k, g)!;
    if (ok2xx(l)) c.served = true;
    const st = l.gpus[g]?.state ?? (ok2xx(l) ? "NO_ROW" : "FAILED");
    if (st === "FAILED") c.failed = true;
    if (st === "NO_ROW") c.noRow++;
    if (st === "BAD_VALUE") c.badValue++;
    if (st === "NO_ROW" || st === "BAD_VALUE") c.bad = true;
    if (st === "NOT_RENTABLE") c.notRentable++;
    else c.allNotRentable = false;
    if (st === "VALID") c.valid++;
    else c.allValid = false;
  }
  if (!c.served) c.allNotRentable = false;
  return c;
}

export interface TriggerHit {
  kind: IncidentKind;
  sinceK: number;
  evidence: Evidence;
}

function evidenceOf(xs: readonly Cls[], faults = 0): Evidence {
  const e: Evidence = { intervals: xs.length, served: 0, noRow: 0, badValue: 0, notRentable: 0, failed: 0, valid: 0, faults, lastHttp: xs[xs.length - 1]?.http ?? 0 };
  for (const x of xs) {
    if (x.served) e.served++;
    if (x.failed) e.failed++;
    e.noRow += x.noRow;
    e.badValue += x.badValue;
    e.notRentable += x.notRentable;
    e.valid += x.valid;
  }
  return e;
}

/** The newest streak of `pick` intervals satisfying `pred` (walking back from kDone over intervals `pick` keeps). */
function streak(log: WatchLog, s: SourceSlots, kDone: number, kMin: number, pick: (c: Cls) => boolean, pred: (c: Cls) => boolean): Cls[] {
  const out: Cls[] = [];
  for (let k = kDone; k >= kMin; k--) {
    const c = classify(log, s.sourceId, s.gpus, k);
    if (!c || !pick(c)) continue;
    if (!pred(c)) break;
    out.unshift(c);
  }
  return out;
}

export interface TriggerClock {
  day: number;
  slice: number;
}

/** The incident a source's log calls for at kDone (the newest complete interval), or null. */
export function detect(log: WatchLog, s: SourceSlots, kDone: number, c: TriggerClock, fault: { sinceK: number } | null): TriggerHit | null {
  const kMin = kDone - Math.ceil((14 * c.day) / c.slice);
  if (fault) {
    const xs = streak(log, s, kDone, Math.max(kMin, fault.sinceK), () => true, () => true);
    return { kind: "wrong_cell", sinceK: fault.sinceK, evidence: evidenceOf(xs, 1) };
  }
  const failed = streak(log, s, kDone, kMin, () => true, (x) => !x.served && x.failed);
  if (failed.length >= 6) return { kind: "fetch", sinceK: failed[0]!.k, evidence: evidenceOf(failed) };
  const bad = streak(log, s, kDone, kMin, (x) => x.served, (x) => x.bad);
  if (bad.length >= 3) return { kind: "reader", sinceK: bad[0]!.k, evidence: evidenceOf(bad) };
  const sold = streak(log, s, kDone, kMin, (x) => x.served, (x) => x.allNotRentable);
  if (sold.length > 0 && (sold[sold.length - 1]!.k - sold[0]!.k + 1) * c.slice >= c.day) return { kind: "sold_out", sinceK: sold[0]!.k, evidence: evidenceOf(sold) };
  return null;
}

/** Closure: the newest 3 attempted intervals after the incident opened read VALID on every GPU, none gapped where
 *  the page check compared (wrong_cell also needs a comparison in each). */
export function closes(log: WatchLog, s: SourceSlots, inc: Incident, kDone: number, gapAt: (k: number, g: GpuModel) => boolean | null): boolean {
  const xs: Cls[] = [];
  for (let k = kDone; k > inc.openedK && xs.length < 3; k--) {
    const c = classify(log, s.sourceId, s.gpus, k);
    if (c) xs.push(c);
  }
  if (xs.length < 3) return false;
  for (const x of xs) {
    if (!x.allValid) return false;
    let compared = false;
    for (const g of s.gpus) {
      const gap = gapAt(x.k, g);
      if (gap === true) return false;
      if (gap === false) compared = true;
    }
    if (inc.kind === "wrong_cell" && !compared) return false;
  }
  return true;
}

/** incidents.jsonl: append-only, the newest line of an id wins. */
export class IncidentStore {
  private readonly byId = new Map<string, Incident>();
  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    for (const ln of readFileSync(path, "utf8").split("\n")) {
      if (!ln.trim()) continue;
      try {
        const x = JSON.parse(ln) as Incident;
        this.byId.set(x.id, x);
      } catch {
        // a torn line is skipped
      }
    }
  }
  put(x: Incident): void {
    this.byId.set(x.id, x);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(x)}\n`);
  }
  get(id: string): Incident | undefined {
    return this.byId.get(id);
  }
  all(): Incident[] {
    return [...this.byId.values()];
  }
  open(index?: string, sourceId?: string): Incident[] {
    return this.all().filter((x) => x.status !== "closed" && (!index || x.index === index) && (!sourceId || x.sourceId === sourceId));
  }
}

export const incidentId = (index: string, sourceId: string, since: number) => `${index.slice(2, 10).toLowerCase()}-${sourceId}-${since}`;
export const incidentsPath = (repairDir: string) => join(repairDir, "incidents.jsonl");
