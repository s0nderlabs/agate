// The page check (BUILD-SPEC 15.1), alert only: compares each panel cloud's reading in the watcher's log with the
// trackers' listed price for the same cloud and GPU, per interval. A gap above 10% raises PAGECHECK_REVIEW; the same
// gap lasting one DAY with at least MIN_READINGS gapped comparisons raises PAGECHECK_FAULT ("likely parser fault").
// Never in the price path: no key, no RPC, no transaction, never imported by a writer or the watcher.
import { join } from "node:path";
import type { GpuModel, Hex } from "@agate/report/types";
import type { Panel } from "@agate/sources/types";
import { appendLine, type AlertSink, type Heartbeat, writeAtomic } from "@agate/watcher";
import { existsSync, readFileSync } from "node:fs";
import { type FetchTracker, fetchInterval, loadInterval, pruneRaw } from "./fetch.ts";
import { ATTRIBUTION, gapBps, geUsable, type IntervalTrackers, isGap, TRACKER_MAP, type TrackerId, trackerFor, trackerLists } from "./trackers.ts";
import type { WatchLog } from "./watchlog.ts";

export const CODES = { REVIEW: "PAGECHECK_REVIEW", FAULT: "PAGECHECK_FAULT", DOWN: "PAGECHECK_TRACKERS_DOWN" } as const;

export interface PcClock {
  day: number;
  slice: number;
  minReadings: number;
  epochTs: number;
}

export interface Pair {
  gpu: GpuModel;
  gpuId: Hex;
  slot: number;
  sourceId: string;
}

export interface PairStatus extends Pair {
  lastK: number | null;
  own: number | null;
  t: number | null;
  tracker: TrackerId | null;
  gapBps: number | null;
  runStartK: number | null;
  runStartAt: number | null;
  gapped: number;
  faultRaised: boolean;
  state: "ok" | "review" | "fault" | "unknown";
}

export interface StatusFile {
  kind: "agate.pagecheck-status";
  index: string;
  at: number;
  lastComparedK: number | null;
  trackersDownIntervals: number;
  pairs: PairStatus[];
  attribution: typeof ATTRIBUTION;
}

export interface CompareLine {
  k: number;
  at: number;
  gpu: GpuModel;
  gpuId: Hex;
  slot: number;
  sourceId: string;
  own: number;
  t: number;
  tracker: TrackerId;
  row: { gpu_count: number | null; listed_since?: string; last_confirmed_at?: string };
  gapBps: number;
  gap: boolean;
  fallback?: string;
}

export function pairsOf(panels: readonly Panel[]): Pair[] {
  const out: Pair[] = [];
  for (const p of panels) for (const s of p.slots) if (TRACKER_MAP[s.sourceId]) out.push({ gpu: p.gpu, gpuId: p.gpuId, slot: s.slot, sourceId: s.sourceId });
  return out;
}

export const index8 = (index: string) => index.slice(2, 10).toLowerCase();
export const pagecheckDir = (home: string, index: string) => join(home, "pagecheck", index8(index));
export const statusPath = (home: string, index: string) => join(pagecheckDir(home, index), "status.json");
export const heartbeatPathOf = (home: string, index: string) => join(home, "pagecheck", `heartbeat-${index8(index)}.json`);

export function readStatus(path: string): StatusFile | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StatusFile) : null;
  } catch {
    return null;
  }
}

const cents = (u: number) => (u / 1_000_000).toFixed(2); // display only
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export interface PageCheckOptions {
  index: string;
  clock: PcClock;
  panels: readonly Panel[];
  log: WatchLog;
  alerts: AlertSink;
  home: string;
  fetch: FetchTracker;
  trackerBaseUrl?: string;
  heartbeat?: Heartbeat;
  now: () => number;
  retryMs?: number;
  /** seconds after an interval ends before it is compared (the watcher's line may land late); default min(120, slice/4) */
  settleS?: number;
}

export class PageCheck {
  readonly pairs: Pair[];
  readonly dir: string;
  private readonly st = new Map<string, PairStatus>();
  private readonly fetched = new Map<number, IntervalTrackers>();
  private lastComparedK: number | null = null;
  private downIntervals = 0;
  private lastPrune = "";
  private ticks = 0;
  readonly events: string[] = []; // short log for tests

  constructor(readonly o: PageCheckOptions) {
    this.pairs = pairsOf(o.panels);
    this.dir = pagecheckDir(o.home, o.index);
    const prev = readStatus(join(this.dir, "status.json"));
    for (const p of this.pairs) {
      const old = prev?.pairs.find((x) => x.gpuId === p.gpuId && x.slot === p.slot && x.sourceId === p.sourceId);
      this.st.set(this.key(p), old ? { ...old, ...p } : { ...p, lastK: null, own: null, t: null, tracker: null, gapBps: null, runStartK: null, runStartAt: null, gapped: 0, faultRaised: false, state: "unknown" });
    }
    if (prev) {
      this.lastComparedK = prev.lastComparedK;
      this.downIntervals = prev.trackersDownIntervals ?? 0;
    }
  }

  private key(p: Pair) {
    return `${p.gpuId}:${p.slot}`;
  }
  private get c() {
    return this.o.clock;
  }
  intervalAt(t: number): number {
    return Math.floor((t - this.c.epochTs) / this.c.slice);
  }
  intervalStart(k: number): number {
    return this.c.epochTs + k * this.c.slice;
  }
  private get settle(): number {
    return this.o.settleS ?? Math.min(120, Math.floor(this.c.slice / 4));
  }
  get rawDir(): string {
    return join(this.dir, "raw");
  }
  status(): PairStatus[] {
    return this.pairs.map((p) => this.st.get(this.key(p))!);
  }

  async tick(now: number): Promise<void> {
    this.ticks++;
    this.o.log.refresh();
    const kNow = this.intervalAt(now);
    const start = this.intervalStart(kNow);
    if (this.ticks === 1) this.reloadSaved(kNow);
    // fetch once per interval, inside [slice/20, 19 slice/20); an interval it did not see is never fetched late
    if (!this.fetched.has(kNow) && (this.lastComparedK === null || kNow > this.lastComparedK) && now >= start + this.c.slice / 20 && now < start + (19 * this.c.slice) / 20) {
      const gpus = [...new Set(this.pairs.map((p) => p.gpu))];
      const needGt = (t: IntervalTrackers) => this.pairs.some((p) => !geUsable(t, p.sourceId, p.gpu).use);
      const timeoutMs = Math.min(40, this.c.slice / 10) * 1000;
      const r = await fetchInterval({ fetch: this.o.fetch, timeoutMs, ...(this.o.trackerBaseUrl ? { base: this.o.trackerBaseUrl } : {}), rawDir: this.rawDir, now: this.o.now, retryMs: this.o.retryMs ?? 5_000 }, kNow, start, gpus, needGt);
      this.fetched.set(kNow, r.t);
      writeAtomic(join(this.rawDir, new Date(start * 1000).toISOString().slice(0, 10), String(kNow), "meta.json"), JSON.stringify({ k: kNow, at: r.t.at, fetched: r.fetched, failed: r.failed }));
      this.events.push(`fetch ${kNow}: ${r.fetched.join(",") || "-"}${r.failed.length ? ` failed ${r.failed.join(",")}` : ""}`);
    }
    for (const k of [...this.fetched.keys()].sort((a, b) => a - b)) {
      if (k >= kNow || now < this.intervalStart(k + 1) + this.settle) continue;
      this.compare(k, this.fetched.get(k)!);
      this.fetched.delete(k);
    }
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    if (today !== this.lastPrune) {
      pruneRaw(this.rawDir, now);
      this.lastPrune = today;
    }
    this.o.heartbeat?.beat(now, `interval ${kNow}`);
  }

  /** After a restart: an interval fetched before it (raw saved, not yet compared) is compared as usual. */
  private reloadSaved(kNow: number): void {
    for (const k of [kNow - 1, kNow]) {
      if (this.lastComparedK !== null && k <= this.lastComparedK) continue;
      const meta = join(this.rawDir, new Date(this.intervalStart(k) * 1000).toISOString().slice(0, 10), String(k), "meta.json");
      if (!existsSync(meta)) continue;
      try {
        const m = JSON.parse(readFileSync(meta, "utf8")) as { at: number };
        const t = loadInterval(this.rawDir, k, this.intervalStart(k), m.at);
        if (t) this.fetched.set(k, t);
      } catch {
        // a corrupt meta file: that interval is not compared
      }
    }
  }

  /** One interval: every pair with a VALID own reading and a tracker row is compared; runs and alerts follow. */
  compare(k: number, t: IntervalTrackers): void {
    const at = this.o.now();
    let anyRow = false;
    for (const p of this.pairs) {
      const s = this.st.get(this.key(p))!;
      if (trackerLists(t, p.sourceId, p.gpu)) anyRow = true;
      const own = this.o.log.validU(p.sourceId, k, p.gpu);
      if (own === null) continue;
      const row = trackerFor(t, p.sourceId, p.gpu, own);
      if (!row) continue;
      const gap = isGap(own, row.valueU);
      const line: CompareLine = { k, at, gpu: p.gpu, gpuId: p.gpuId, slot: p.slot, sourceId: p.sourceId, own, t: row.valueU, tracker: row.tracker, row: { gpu_count: row.gpuCount }, gapBps: gapBps(own, row.valueU), gap };
      if (row.listedSince) line.row.listed_since = row.listedSince;
      if (row.lastConfirmedAt) line.row.last_confirmed_at = row.lastConfirmedAt;
      if (row.tracker === "gputable") {
        const why = geUsable(t, p.sourceId, p.gpu);
        if (!why.use) line.fallback = why.why;
      }
      appendLine(join(this.dir, "compare.jsonl"), line);
      Object.assign(s, { lastK: k, own, t: row.valueU, tracker: row.tracker, gapBps: line.gapBps });
      if (gap) this.gapped(p, s, k, line);
      else this.closeRun(p, s);
    }
    this.trackersDown(anyRow, k);
    this.lastComparedK = Math.max(this.lastComparedK ?? -Infinity, k);
    this.writeStatus(at);
  }

  private gapped(p: Pair, s: PairStatus, k: number, line: CompareLine): void {
    const name = line.tracker === "gpueconomy" ? "GPU Economy" : "GPUTable";
    if (s.runStartK === null) {
      Object.assign(s, { runStartK: k, runStartAt: this.intervalStart(k), gapped: 1, faultRaised: false, state: "review" as const });
      this.o.alerts.raise({ code: CODES.REVIEW, severity: "info", gpuId: p.gpuId, slot: p.slot, message: `${p.sourceId} ${p.gpu} (slot ${p.slot}): reading ${cents(line.own)} vs ${name} ${cents(line.t)}, ${(line.gapBps / 100).toFixed(1)}% apart since ${iso(this.intervalStart(k))}: review the page and the parser`, data: line });
      this.events.push(`review ${p.sourceId} ${p.gpu} @${k}`);
    } else s.gapped++;
    const lasted = this.intervalStart(k) - this.intervalStart(s.runStartK!);
    if (!s.faultRaised && lasted >= this.c.day && s.gapped >= this.c.minReadings) {
      s.faultRaised = true;
      s.state = "fault";
      const confirmed = line.row.last_confirmed_at ? Date.parse(line.row.last_confirmed_at) / 1000 : NaN;
      const age = Number.isFinite(confirmed) ? `; the ${line.tracker} row was last confirmed ${Math.max(0, Math.round((line.at - confirmed) / 360) / 10)} h before this reading` : `; ${line.tracker} row age unknown`;
      this.o.alerts.raise({ code: CODES.FAULT, severity: "action", gpuId: p.gpuId, slot: p.slot, message: `likely parser fault: ${p.sourceId} ${p.gpu} (slot ${p.slot}) has read more than 10% off the trackers since ${iso(this.intervalStart(s.runStartK!))} (${s.gapped} gapped comparisons over ${lasted} s)${age}; the repair agent opens an incident`, data: { ...line, runStartK: s.runStartK, gapped: s.gapped } });
      this.events.push(`fault ${p.sourceId} ${p.gpu} @${k}`);
    }
  }

  private closeRun(p: Pair, s: PairStatus): void {
    if (s.runStartK !== null) {
      this.o.alerts.clearWhere((a) => (a.code === CODES.REVIEW || a.code === CODES.FAULT) && a.gpuId === p.gpuId && a.slot === p.slot);
      this.events.push(`ok ${p.sourceId} ${p.gpu}`);
    }
    Object.assign(s, { runStartK: null, runStartAt: null, gapped: 0, faultRaised: false, state: "ok" as const });
  }

  private trackersDown(anyRow: boolean, k: number): void {
    if (anyRow) {
      if (this.downIntervals > 0) this.o.alerts.clearWhere((a) => a.code === CODES.DOWN);
      this.downIntervals = 0;
      return;
    }
    this.downIntervals++;
    if (this.downIntervals * this.c.slice >= this.c.day / 4) {
      const since = k - this.downIntervals + 1;
      this.o.alerts.raise({ code: CODES.DOWN, severity: "info", message: `no tracker row for any panel pair since ${iso(this.intervalStart(since))}: the page check is blind`, data: { sinceK: since } });
      this.events.push(`trackers down @${k}`);
    }
  }

  private writeStatus(at: number): void {
    const f: StatusFile = { kind: "agate.pagecheck-status", index: this.o.index.toLowerCase(), at, lastComparedK: this.lastComparedK, trackersDownIntervals: this.downIntervals, pairs: this.status(), attribution: ATTRIBUTION };
    writeAtomic(join(this.dir, "status.json"), `${JSON.stringify(f, null, 1)}\n`);
  }
}
