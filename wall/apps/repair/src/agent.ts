// The repair agent (BUILD-SPEC 15.2): watches each served index every min(3,600 s, slice), opens incidents from the
// watcher's log and the page check, diagnoses them deterministically, drafts a reader v2 with Claude Code headless
// for a redesign or a wrong cell, gates and sandboxes the draft, shadow-runs it beside the reader in force, then
// writes an approval note with the exact owner commands. It never holds or reads a key, never sends a transaction,
// never commits, and never edits the repo (only `repair install`, run by hand, writes there).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GpuModel, Hex } from "@agate/report/types";
import { ACTION_WINDOW_DAYS } from "@agate/report/types";
import { type IntervalTrackers, loadInterval, readStatus, trackerFor, WatchLog } from "@agate/pagecheck";
import { httpsHost, readerInForce, SOURCES } from "@agate/sources/pure";
import type { Panel } from "@agate/sources/types";
import { type AlertSink, appendLine, type Heartbeat, writeAtomic } from "@agate/watcher";
import { Budget } from "./budget.ts";
import { type ChainView, readerSwapId } from "./chain.ts";
import { callClaude, checkCli, childEnv } from "./claude.ts";
import { index8, type RepairConfig } from "./config.ts";
import { diagnose } from "./diagnose.ts";
import { fixturePages, gate1, gate2, gate3, gate4, gate5, judgeNew, type RunCtx, shadowFile } from "./gates.ts";
import { closes, detect, type Diagnosis, type Incident, incidentId, incidentsPath, IncidentStore, type SourceSlots, servedSources } from "./incidents.ts";
import { type ActionFile, commandsText, type CommandIndex, type NoteJson, noteMarkdown, type NoteReader, notificationScript, reasonString, visible } from "./note.ts";
import { archivePages, fetchedPages, pageText, type SavedPage, sha256Hex, watcherPage, watcherPages, watcherRawName } from "./pages.ts";
import { buildPrompt, type PromptNote, type PromptPage } from "./untrusted.ts";
import { highestVersion, nameOfVersion, prepareScratch } from "./scratch.ts";
import type { BatchPage } from "./sandbox.ts";
import { runBatch, sandboxAvailable } from "./sandbox.ts";
import type { Spawner } from "./spawn.ts";

export const SHADOW_MIN = 6;
export const SHADOW_MAX = 24;
export const USER_AGENT = "agate-wall/repair/0.1 (+https://github.com/s0nderlabs/agate)";
export const CODES = { INCIDENT: "REPAIR_INCIDENT", NOTE: "REPAIR_NOTE", REFUSED: "REPAIR_REFUSED", WINDOW: "REPAIR_WINDOW" } as const;

export interface IndexClock {
  day: number;
  slice: number;
  slices: number;
  minReadings: number;
  epochTs: number;
  epochDay: number;
  timelock: number;
}

/** The clocks the watcher cached from clocks() (<home>/watcher/<index>/clocks.json), read only. */
export function readIndexClock(watcherDir: string): IndexClock | null {
  try {
    const j = JSON.parse(readFileSync(join(watcherDir, "clocks.json"), "utf8")) as Record<string, unknown>;
    const c: IndexClock = { day: Number(j.day), slice: Number(j.slice), slices: Number(j.slices), minReadings: Number(j.minReadings), epochTs: Number(j.epochTs), epochDay: Number(j.epochDay), timelock: Number(j.timelock) };
    return c.day > 0 && c.slice > 0 && Number.isFinite(c.epochTs) && Number.isFinite(c.epochDay) && c.timelock > 0 ? c : null;
  } catch {
    return null;
  }
}

export type FetchMoved = (url: string, timeoutMs: number) => Promise<{ status: number; body: Uint8Array } | null>;

/** GET one URL, honest user agent, no redirect followed (the agent fetches only that exact URL). */
export const httpFetchMoved: FetchMoved = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "*/*" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  } catch {
    return null;
  }
};

export interface AgentDeps {
  cfg: RepairConfig;
  spawner: Spawner;
  /** the environment the Claude child's variables are taken from (only PATH, HOME, USER, LOGNAME, LANG, TMPDIR, TERM) */
  env: Record<string, string | undefined>;
  now: () => number;
  sink: (index: string | null) => AlertSink;
  chain?: (index: string) => ChainView | null;
  fetchMoved?: FetchMoved;
  heartbeat?: Heartbeat;
  say?: (event: string, data?: Record<string, unknown>) => void;
}

interface Ctx {
  index: string;
  clock: IndexClock;
  now: number;
  kNow: number;
  kDone: number;
  dayNow: number;
  log: WatchLog;
  logDir: string;
  panels: Panel[];
  sources: SourceSlots[];
}

const GPUS_OF = (sourceId: string): GpuModel[] => {
  const d = SOURCES.find((s) => s.id === sourceId);
  return (["H100", "H200", "B200"] as GpuModel[]).filter((g) => d?.rules[g]);
};

export class RepairAgent {
  readonly store: IncidentStore;
  readonly budget: Budget;
  private readonly logs = new Map<string, WatchLog>();
  private readonly lastRun = new Map<string, number>();
  private readonly compareOff = new Map<string, number>();
  private readonly gaps = new Map<string, Map<string, boolean>>();
  private readonly trackerCache = new Map<string, IntervalTrackers | null>();
  private readonly history = new Map<string, { at: number; entries: { fromDay: number; url: string; parserVersion: string }[] }>();
  private requestsOff = 0;
  private alertsSize = 0;
  cli: { ok: true } | { ok: false; why: string } | null = null;
  private ticks = 0;

  constructor(readonly d: AgentDeps) {
    mkdirSync(d.cfg.dir, { recursive: true });
    this.store = new IncidentStore(incidentsPath(d.cfg.dir));
    this.budget = new Budget(join(d.cfg.dir, "budget.json"), d.cfg.budgets);
  }

  private say(event: string, data?: Record<string, unknown>): void {
    this.d.say?.(event, data);
  }

  /** The start check: the CLI must list every required flag, else no call is ever made. */
  async start(): Promise<void> {
    this.cli = await checkCli({ spawner: this.d.spawner, cwdRoot: join(this.d.cfg.dir, "claude-cwd"), env: this.d.env, timeoutS: 30 });
    // a standing refusal from an earlier start is cleared once the CLI or the sandbox is fine again
    this.d.sink(null).clearWhere((a) => a.code === CODES.REFUSED && a.index === undefined && ((this.cli!.ok && a.message.includes("Claude CLI")) || (sandboxAvailable(this.d.cfg.sandboxExec) && a.message.includes("no sandbox"))));
    if (!this.cli.ok) this.d.sink(null).raise({ code: CODES.REFUSED, severity: "action", message: `repair agent: ${this.cli.why}; no Claude call will be made` });
    if (!sandboxAvailable(this.d.cfg.sandboxExec)) this.d.sink(null).raise({ code: CODES.REFUSED, severity: "action", message: "repair agent: no sandbox (sandbox-exec is missing): drafts are refused" });
  }

  /** True when the alerts file gained a PAGECHECK_FAULT, READER_MISSING or READER_REFUSED of a served index. */
  alertsWake(): boolean {
    const path = join(this.d.cfg.home, "alerts", "alerts.jsonl");
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    if (size <= this.alertsSize) {
      this.alertsSize = size;
      return false;
    }
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - this.alertsSize);
    readSync(fd, buf, 0, buf.length, this.alertsSize);
    closeSync(fd);
    this.alertsSize = size;
    return buf
      .toString("utf8")
      .split("\n")
      .some((l) => /"code":"(PAGECHECK_FAULT|READER_MISSING|READER_REFUSED)"/.test(l) && this.d.cfg.indexes.some((i) => l.includes(`"index":"${i}"`)));
  }

  async tick(now: number, force = false): Promise<void> {
    this.ticks++;
    if (this.cli === null) await this.start();
    this.readRequests();
    for (const index of this.d.cfg.indexes) {
      const clock = readIndexClock(join(this.d.cfg.home, "watcher", index));
      if (!clock) continue;
      const period = Math.min(3_600, clock.slice);
      if (!force && now - (this.lastRun.get(index) ?? -Infinity) < period) continue;
      this.lastRun.set(index, now);
      try {
        await this.runIndex(index, clock, now);
      } catch (e) {
        this.say("index_error", { index, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.d.heartbeat?.beat(now, `${this.store.open().length} open incidents`);
  }

  private ctxOf(index: string, clock: IndexClock, now: number): Ctx {
    const logDir = this.d.cfg.logDirOf(index);
    let log = this.logs.get(index);
    if (!log) this.logs.set(index, (log = new WatchLog(logDir)));
    log.refresh();
    const kNow = Math.floor((now - clock.epochTs) / clock.slice);
    const settled = now >= clock.epochTs + kNow * clock.slice + Math.min(120, Math.floor(clock.slice / 4));
    const panels = this.d.cfg.panels[index] ?? [];
    return { index, clock, now, kNow, kDone: settled ? kNow - 1 : kNow - 2, dayNow: clock.epochDay + Math.floor((now - clock.epochTs) / clock.day), log, logDir, panels, sources: servedSources(index, panels) };
  }

  private async runIndex(index: string, clock: IndexClock, now: number): Promise<void> {
    const ctx = this.ctxOf(index, clock, now);
    this.readCompares(index);
    const faults = this.faults(ctx);
    for (const s of ctx.sources) {
      const open = this.store.open(index, s.sourceId)[0];
      const fault = faults.get(s.sourceId) ?? null;
      const hit = detect(ctx.log, s, ctx.kDone, clock, fault);
      if (open) {
        if (closes(ctx.log, s, open, ctx.kDone, (k, g) => this.gapAt(index, k, s.sourceId, g)) && !(open.kind === "wrong_cell" && fault)) {
          this.close(open, ctx, "the source reads VALID, within 10% of the trackers where compared, for 3 intervals");
          continue;
        }
        if (hit && hit.kind !== open.kind && (open.status === "watch" || open.status === "refused")) {
          this.close(open, ctx, `superseded by a ${hit.kind} incident`);
          await this.openIncident(s, hit, ctx);
          continue;
        }
        if (hit && hit.kind === open.kind) open.evidence = hit.evidence;
        await this.advance(open, s, ctx);
      } else if (hit) await this.openIncident(s, hit, ctx);
    }
  }

  // ---------------------------------------------------------------- evidence from the page check

  private readCompares(index: string): void {
    const path = join(this.d.cfg.home, "pagecheck", index8(index), "compare.jsonl");
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    const off = this.compareOff.get(index) ?? 0;
    if (size <= off) return;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - off);
    readSync(fd, buf, 0, buf.length, off);
    closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return;
    this.compareOff.set(index, off + Buffer.byteLength(text.slice(0, end + 1)));
    let m = this.gaps.get(index);
    if (!m) this.gaps.set(index, (m = new Map()));
    for (const ln of text.slice(0, end).split("\n")) {
      try {
        const c = JSON.parse(ln) as { k: number; sourceId: string; gpu: string; gap: boolean };
        m.set(`${c.k}:${c.sourceId}:${c.gpu}`, c.gap);
      } catch {
        // skip
      }
    }
    if (m.size > 50_000) for (const k of [...m.keys()].slice(0, m.size - 25_000)) m.delete(k); // the oldest lines first
  }

  private gapAt(index: string, k: number, sourceId: string, g: GpuModel): boolean | null {
    return this.gaps.get(index)?.get(`${k}:${sourceId}:${g}`) ?? null;
  }

  /** Open PAGECHECK_FAULT alerts of the index, by source, with the run's first interval. */
  private faults(ctx: Ctx): Map<string, { sinceK: number }> {
    const out = new Map<string, { sinceK: number }>();
    const st = readStatus(join(this.d.cfg.home, "pagecheck", index8(ctx.index), "status.json"));
    for (const a of this.d.sink(ctx.index).open()) {
      if (a.code !== "PAGECHECK_FAULT" || a.index !== ctx.index) continue;
      const src = ctx.sources.find((s) => s.slots.some((x) => x.gpuId === a.gpuId && x.slot === a.slot));
      if (!src) continue;
      const fromData = (a.data as { runStartK?: number } | undefined)?.runStartK;
      const fromStatus = st?.pairs.find((p) => p.gpuId === a.gpuId && p.slot === a.slot)?.runStartK ?? undefined;
      const sinceK = typeof fromData === "number" ? fromData : typeof fromStatus === "number" ? fromStatus : ctx.kDone;
      const prev = out.get(src.sourceId);
      if (!prev || sinceK < prev.sinceK) out.set(src.sourceId, { sinceK });
    }
    return out;
  }

  /** The tracker value for a pair in interval k, from the page check's saved files of that interval. */
  private trackerAt(ctx: Ctx, k: number, sourceId: string, g: GpuModel, own: number): number | null {
    const key = `${ctx.index}:${k}`;
    let t = this.trackerCache.get(key);
    if (t === undefined) {
      const raw = join(this.d.cfg.home, "pagecheck", index8(ctx.index), "raw");
      const start = ctx.clock.epochTs + k * ctx.clock.slice;
      let at = start;
      try {
        at = (JSON.parse(readFileSync(join(raw, new Date(start * 1000).toISOString().slice(0, 10), String(k), "meta.json"), "utf8")) as { at: number }).at;
      } catch {
        // no meta: the interval's start
      }
      t = loadInterval(raw, k, start, at);
      if (this.trackerCache.size > 2_000) this.trackerCache.clear();
      if (t) this.trackerCache.set(key, t); // a miss is read again later (the page check may not have saved it yet)
    }
    return t ? (trackerFor(t, sourceId, g, own)?.valueU ?? null) : null;
  }

  // ---------------------------------------------------------------- readers in force

  private async historyOf(ctx: Ctx, gpuId: Hex, slot: number): Promise<{ fromDay: number; url: string; parserVersion: string }[]> {
    const key = `${ctx.index}:${gpuId}:${slot}`;
    const c = this.history.get(key);
    if (c && ctx.now - c.at < ctx.clock.slice) return c.entries;
    const chain = this.d.chain?.(ctx.index);
    if (!chain) return [];
    try {
      const entries = await chain.readerHistory(gpuId, slot);
      this.history.set(key, { at: ctx.now, entries });
      return entries;
    } catch (e) {
      this.say("rpc_error", { index: ctx.index, error: (e as Error).message });
      return c?.entries ?? [];
    }
  }

  private async readerOf(ctx: Ctx, s: SourceSlots, which = 0): Promise<{ url: string; parserVersion: string }> {
    const x = s.slots[which]!;
    const panel = ctx.panels.find((p) => p.gpuId === x.gpuId)!;
    const ps = panel.slots.find((y) => y.slot === x.slot)!;
    return readerInForce(ps, await this.historyOf(ctx, x.gpuId, x.slot), ctx.dayNow);
  }

  // ---------------------------------------------------------------- incidents

  private refId(s: SourceSlots): { gpuId: Hex; slot: number } {
    return { gpuId: s.slots[0]!.gpuId, slot: s.slots[0]!.slot };
  }

  private async openIncident(s: SourceSlots, hit: ReturnType<typeof detect> & {}, ctx: Ctx): Promise<void> {
    const since = ctx.clock.epochTs + hit.sinceK * ctx.clock.slice;
    const inc: Incident = { id: incidentId(ctx.index, s.sourceId, since), index: ctx.index, sourceId: s.sourceId, kind: hit.kind, gpus: s.gpus, sinceK: hit.sinceK, since, openedAt: ctx.now, openedK: ctx.kDone, evidence: hit.evidence, status: "new", calls: 0, updatedAt: ctx.now };
    this.store.put(inc);
    this.say("incident", { id: inc.id, kind: inc.kind });
    await this.advance(inc, s, ctx);
  }

  private put(inc: Incident, now: number): void {
    inc.updatedAt = now;
    this.store.put(inc);
  }

  private refuse(inc: Incident, s: SourceSlots, ctx: Ctx, why: string, next: Incident["status"]): void {
    inc.lastRefusal = why;
    inc.status = next;
    this.d.sink(ctx.index).raise({ code: CODES.REFUSED, severity: "action", ...this.refId(s), message: `repair ${s.sourceId} (${inc.kind}, incident ${inc.id}): ${why}`, data: { incident: inc.id } });
    this.put(inc, ctx.now);
  }

  private close(inc: Incident, ctx: Ctx, why: string): void {
    inc.status = "closed";
    inc.closedAt = ctx.now;
    inc.closedWhy = why;
    this.put(inc, ctx.now);
    const s = ctx.sources.find((x) => x.sourceId === inc.sourceId);
    if (s) {
      const r = this.refId(s);
      this.d.sink(ctx.index).clearWhere((a) => (Object.values(CODES) as string[]).includes(a.code) && a.gpuId === r.gpuId && a.slot === r.slot);
    }
    this.say("closed", { id: inc.id, why });
  }

  private readRequests(): void {
    const path = join(this.d.cfg.dir, "requests.jsonl");
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    if (text.length <= this.requestsOff) return;
    const fresh = text.slice(this.requestsOff);
    this.requestsOff = text.length;
    for (const ln of fresh.split("\n")) {
      try {
        const r = JSON.parse(ln) as { incidentId: string };
        const inc = this.store.get(r.incidentId);
        if (!inc || inc.status === "closed") continue;
        if (this.budget.used(inc.id) >= this.d.cfg.budgets.perIncident) continue;
        inc.status = "draft";
        delete inc.lastAttemptK;
        this.store.put(inc);
      } catch {
        // skip
      }
    }
  }

  private async advance(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    if (inc.status === "new") await this.diagnoseStep(inc, s, ctx);
    if (inc.status === "draft") await this.draftStep(inc, s, ctx);
    else if (inc.status === "moved") await this.movedStep(inc, s, ctx);
    if (inc.status === "shadow") await this.shadowStep(inc, s, ctx);
    if (inc.status === "noted") await this.followStep(inc, s, ctx);
  }

  private async diagnoseStep(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    const rf = await this.readerOf(ctx, s);
    const def = SOURCES.find((x) => x.id === s.sourceId)!;
    const rawName = watcherRawName(s.sourceId, rf.url, def.url);
    let last;
    let page: SavedPage | null = null;
    for (let k = ctx.kDone; k >= inc.sinceK - 1 && (!last || !page); k--) {
      const ls = ctx.log.at(s.sourceId, k);
      if (!last && ls.length) last = ls[ls.length - 1];
      if (!page) page = watcherPage(ctx.logDir, ctx.log, ctx.clock, s.sourceId, k, rawName);
    }
    const body = page ? pageText(page) : null;
    const validShas = new Set<string>();
    for (let k = inc.sinceK - 1; k >= inc.sinceK - Math.ceil((14 * ctx.clock.day) / ctx.clock.slice); k--)
      for (const l of ctx.log.at(s.sourceId, k)) if (l.sha256 && s.gpus.every((g) => l.gpus[g]?.state === "VALID")) validShas.add(l.sha256);
    const st = readStatus(join(this.d.cfg.home, "pagecheck", index8(ctx.index), "status.json"));
    const support = (st?.pairs ?? []).filter((p) => p.sourceId === s.sourceId && p.t !== null && p.lastK !== null && ctx.kDone - p.lastK! <= 24).map((p) => `${p.tracker} ${p.gpu} ${(p.t! / 1e6).toFixed(2)} (interval ${p.lastK})`);
    const dg = diagnose({ incident: inc, last, lastBody: body, lastSha: page?.line?.sha256 || (body !== null ? sha256Hex(body) : null), validShas, support });
    inc.diagnosis = dg;
    this.d.sink(ctx.index).raise({ code: CODES.INCIDENT, severity: "info", ...this.refId(s), message: `repair: ${s.sourceId} ${inc.kind} since interval ${inc.sinceK}: ${dg.kind}`, data: { incident: inc.id, kind: inc.kind, diagnosis: dg.kind, evidence: inc.evidence } });
    if (dg.kind === "redesign" || dg.kind === "wrong_cell") inc.status = "draft";
    else if (dg.kind === "moved") {
      const host = dg.location ? httpsHost(dg.location) : null;
      if (dg.location && host && def.hosts.includes(host)) {
        inc.status = "moved";
        inc.proposedUrl = dg.location;
      } else return this.refuse(inc, s, ctx, "moved off the source's hosts, or to an unknown URL; a code change to `hosts` or SOURCES is the operator's call", "refused");
    } else {
      inc.status = "watch";
      this.writeInfoNote(inc, s, ctx, dg);
    }
    this.put(inc, ctx.now);
  }

  /** A note with no swap: sold out, blocked or unsure. */
  private writeInfoNote(inc: Incident, s: SourceSlots, ctx: Ctx, dg: Diagnosis): void {
    const n: NoteJson = { kind: "agate.repair-note", version: 1, incident: pick(inc), diagnosis: dg, modelNotes: null, draft: null, urlOnly: false, nothingToDo: true, gates: {}, shadow: null, readers: [], actionFiles: [], commands: null, writtenAt: ctx.now };
    writeAtomic(join(this.d.cfg.dir, "notes", `${inc.id}.json`), `${JSON.stringify(n, null, 1)}\n`);
    writeAtomic(join(this.d.cfg.dir, "notes", `${inc.id}.md`), noteMarkdown(n));
  }

  private runCtx(draftDir: string, pkg: string): RunCtx {
    return { spawner: this.d.spawner, bun: this.d.cfg.bun, draftDir, pkg };
  }

  private toBatch(p: SavedPage): BatchPage {
    return { id: p.id, file: p.file, utcDate: p.utcDate, nowSec: p.nowSec };
  }

  /** Saved pages before the incident: the watcher's (14 days) and, for the registered URL, the logger archive. */
  private oldPages(inc: Incident, s: SourceSlots, ctx: Ctx, rf: { url: string }): SavedPage[] {
    const def = SOURCES.find((x) => x.id === s.sourceId)!;
    const kMin = inc.sinceK - Math.ceil((14 * ctx.clock.day) / ctx.clock.slice);
    const w = watcherPages(ctx.logDir, ctx.log, ctx.clock, s.sourceId, kMin, inc.sinceK - 1, watcherRawName(s.sourceId, rf.url, def.url));
    const a = rf.url === def.url ? archivePages(this.d.cfg.rawDir, s.sourceId, inc.since) : [];
    return [...w, ...a].sort((x, y) => y.t - x.t).slice(0, 200);
  }

  /** Saved pages since the incident: the agent's own fetches for a moved source, else the watcher's. */
  private newPages(inc: Incident, s: SourceSlots, ctx: Ctx, rf: { url: string }): SavedPage[] {
    if (inc.proposedUrl && inc.proposedUrl !== rf.url) return fetchedPages(join(this.d.cfg.dir, "fetched", inc.id)).filter((p) => p.k! <= ctx.kNow);
    const def = SOURCES.find((x) => x.id === s.sourceId)!;
    return watcherPages(ctx.logDir, ctx.log, ctx.clock, s.sourceId, inc.sinceK, ctx.kDone, watcherRawName(s.sourceId, rf.url, def.url), 24);
  }

  private trackerFn(ctx: Ctx, s: SourceSlots, pages: SavedPage[]): (id: string, g: GpuModel, own: number) => number | null {
    const byId = new Map(pages.map((p) => [p.id, p]));
    return (id, g, own) => {
      const p = byId.get(id);
      return p?.k !== undefined ? this.trackerAt(ctx, p.k, s.sourceId, g, own) : null;
    };
  }

  private async draftStep(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    const other = this.store.open().find((x) => x.sourceId === inc.sourceId && x.index !== inc.index && ["draft", "moved", "shadow", "noted"].includes(x.status));
    if (other) {
      inc.status = "watch";
      inc.lastRefusal = `covered by incident ${other.id} on another index (one draft serves every index)`;
      return this.put(inc, ctx.now);
    }
    if (inc.lastAttemptK === ctx.kDone) return;
    inc.lastAttemptK = ctx.kDone;
    if (!sandboxAvailable(this.d.cfg.sandboxExec)) return this.refuse(inc, s, ctx, "no sandbox", "refused");
    if (!this.cli?.ok) return this.refuse(inc, s, ctx, this.cli && !this.cli.ok ? this.cli.why : "the Claude CLI was not checked", "refused");
    if (SOURCES.find((x) => x.id === s.sourceId)?.currency !== "USD") return this.refuse(inc, s, ctx, "a non-USD source: the repair agent drafts only for USD sources in this build", "refused");
    const over = this.budget.refusal(inc.id, ctx.now);
    if (over) return this.refuse(inc, s, ctx, over, this.budget.used(inc.id) >= this.d.cfg.budgets.perIncident ? "refused" : "draft");
    const rf = await this.readerOf(ctx, s);
    const nv = nameOfVersion(rf.parserVersion);
    if (!nv) return this.refuse(inc, s, ctx, `the reader in force has an odd version ${rf.parserVersion}`, "refused");
    const newPages = this.newPages(inc, s, ctx, rf);
    if (newPages.length < 3) {
      this.put(inc, ctx.now);
      return; // wait for three pages since the incident
    }
    const n = highestVersion(join(this.d.cfg.wallRoot, "packages", "sources"), nv.name) + 1;
    const version = `${nv.name}/${n}`;
    const draftId = `${nv.name}-v${n}-${ctx.now}-${[...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const draftDir = join(this.d.cfg.dir, "drafts", draftId);
    mkdirSync(draftDir, { recursive: true });
    const oldPages = this.oldPages(inc, s, ctx, rf);
    const tracker = this.trackerFn(ctx, s, newPages);
    const prompt = this.prompt(inc, s, ctx, rf, version, newPages, oldPages, tracker);
    writeFileSync(join(draftDir, "prompt.txt"), prompt);
    this.budget.spend(inc.id, ctx.now);
    inc.calls++;
    this.put(inc, ctx.now);
    const res = await callClaude({ spawner: this.d.spawner, cwdRoot: join(this.d.cfg.dir, "claude-cwd"), env: this.d.env, timeoutS: this.d.cfg.budgets.timeoutS, ...(this.d.cfg.model ? { model: this.d.cfg.model } : {}) }, prompt);
    writeFileSync(join(draftDir, "response.json"), res.raw);
    const retry = this.budget.used(inc.id) < this.d.cfg.budgets.perIncident ? "draft" : "refused";
    if (!res.ok) return this.refuse(inc, s, ctx, `Claude: ${res.why}`, retry);
    const a = res.answer;
    writeFileSync(join(draftDir, "notes.txt"), visible(a.notes)); // controls shown as escapes
    if (a.extractorSource.trim() === "") return this.refuse(inc, s, ctx, `the model did not draft (it says ${a.diagnosis})`, retry);
    if (a.proposedUrl !== undefined) {
      const g5 = gate5(s.sourceId, a.proposedUrl);
      if (!g5.ok) return this.refuse(inc, s, ctx, `gate 5: ${g5.why}`, retry);
      if (a.proposedUrl !== (inc.proposedUrl ?? rf.url)) return this.refuse(inc, s, ctx, "gate 5: a new URL is taken only from a redirect's Location, never from the model", retry);
    }
    writeFileSync(join(draftDir, "extractor.ts"), a.extractorSource);
    const sha = sha256Hex(a.extractorSource);
    writeFileSync(join(draftDir, "sha256"), `${sha}\n`);
    const gates: Record<string, string> = {};
    const fail = (g: string, why: string) => {
      gates[g] = `FAILED: ${why}`;
      writeAtomic(join(draftDir, "gates.json"), JSON.stringify({ draftId, version, sha256: sha, gates }, null, 1));
      return this.refuse(inc, s, ctx, `${g}: ${why}`, retry);
    };
    let pkg: string;
    try {
      pkg = prepareScratch(this.d.cfg.wallRoot, draftDir, nv.name, n, s.sourceId, a.extractorSource).pkg;
    } catch (e) {
      return fail("gate 1", (e as Error).message);
    }
    const g1 = await gate1(this.d.spawner, a.extractorSource, pkg, this.toolEnv());
    if (!g1.ok) return fail("gate 1", g1.why);
    gates["gate 1"] = g1.detail;
    const x = this.runCtx(draftDir, pkg);
    const g2 = await gate2(x, version, rf.parserVersion, s.gpus, oldPages.filter((p) => inc.kind !== "wrong_cell" || p.t < inc.since).map((p) => this.toBatch(p)));
    if (!g2.ok) return fail("gate 2", g2.why);
    gates["gate 2"] = g2.detail;
    const g3 = await gate3(x, version, s.gpus, newPages.map((p) => this.toBatch(p)), tracker);
    if (!g3.ok) return fail("gate 3", g3.why);
    gates["gate 3"] = g3.detail;
    if (inc.kind === "wrong_cell" || inc.diagnosis?.kind === "moved") {
      const g4 = await gate4(x, version, rf.parserVersion, GPUS_OF(s.sourceId), fixturePages(s.sourceId, ctx.now));
      if (!g4.ok) return fail("gate 4", g4.why);
      gates["gate 4"] = g4.detail;
    } else gates["gate 4"] = "not run: a redesign changes the layout the synthetic pages render";
    const g5 = gate5(s.sourceId, inc.proposedUrl);
    if (!g5.ok) return fail("gate 5", g5.why);
    gates["gate 5"] = g5.detail;
    writeAtomic(join(draftDir, "gates.json"), JSON.stringify({ draftId, version, sha256: sha, gates }, null, 1));
    inc.draftId = draftId;
    inc.status = "shadow";
    inc.shadow = { fromK: ctx.kDone + 1, lastK: ctx.kDone, good: 0, seen: 0 };
    delete inc.lastRefusal;
    this.put(inc, ctx.now);
    this.say("draft_passed", { id: inc.id, draftId });
  }

  private toolEnv(): Record<string, string> {
    const e = childEnv(this.d.env);
    const binDir = this.d.cfg.bun.replace(/\/[^/]+$/, "");
    e.PATH = [e.PATH, binDir, "/usr/bin", "/bin"].filter(Boolean).join(":");
    return e;
  }

  private prompt(inc: Incident, s: SourceSlots, ctx: Ctx, rf: { url: string; parserVersion: string }, version: string, newPages: SavedPage[], oldPages: SavedPage[], tracker: (id: string, g: GpuModel, own: number) => number | null): string {
    const def = SOURCES.find((x) => x.id === s.sourceId)!;
    const nv = nameOfVersion(rf.parserVersion)!;
    const vNew = nameOfVersion(version)!;
    const parsers = join(this.d.cfg.wallRoot, "packages", "sources", "src", "pure", "parsers");
    const inForceFile = join(parsers, nv.n === 1 ? `${nv.name}.ts` : `${nv.name}.v${nv.n}.ts`);
    const code = existsSync(inForceFile) ? readFileSync(inForceFile, "utf8") : "(the in-force extractor's file was not found)";
    const textTs = readFileSync(join(this.d.cfg.wallRoot, "packages", "sources", "src", "pure", "text.ts"), "utf8");
    const sigs = textTs.split("\n").filter((l) => /^export (function|class|type)/.test(l)).map((l) => l.replace(/\s*\{\s*$/, ";")).join("\n");
    const cellType = /export type Cell =[\s\S]*?;\n/.exec(textTs)?.[0] ?? "";
    const sample = newPages.slice(0, 3);
    const before = oldPages.find((p) => p.origin === "watcher" && p.line && s.gpus.some((g) => p.line!.gpus[g]?.state === "VALID")) ?? oldPages[0];
    const pages: PromptPage[] = [];
    const expect: string[] = [];
    let id = 1;
    // the last VALID reading before the incident picks the tracker row nearest to it (several sizes or regions)
    const hint = (g: GpuModel) => oldPages.find((p) => p.line?.gpus[g]?.state === "VALID")?.line?.gpus[g]?.valueU ?? 0;
    for (const p of sample) {
      const text = pageText(p);
      if (text === null) continue;
      const tv = s.gpus.map((g) => {
        const t = tracker(p.id, g, p.line?.gpus[g]?.state === "VALID" ? p.line.gpus[g]!.valueU : hint(g));
        return `${g} ${t === null ? "not listed" : (t / 1e6).toFixed(4)}`;
      });
      pages.push({ id, label: `page ${id}: ${p.origin} page of ${new Date(p.t * 1000).toISOString()} (since the incident)`, text });
      expect.push(`page ${id}: the trackers list ${tv.join(", ")} (USD per GPU-hour; the reading must be within 10%)`);
      id++;
    }
    if (before) {
      const text = pageText(before);
      if (text !== null) {
        pages.push({ id, label: `page ${id}: ${before.origin} page of ${new Date(before.t * 1000).toISOString()} (before the incident)`, text });
        const got = before.line ? s.gpus.map((g) => `${g} ${before.line!.gpus[g]?.state ?? "?"} ${((before.line!.gpus[g]?.valueU ?? 0) / 1e6).toFixed(2)}`).join(", ") : "VALID rows as the reader in force reads them";
        expect.push(`page ${id}: the reader in force (${rf.parserVersion}) read ${got}; the new extractor must read the same`);
      }
    }
    const rule = s.gpus.map((g) => `${g}: ${JSON.stringify(def.rules[g])}`).join("\n");
    const task = [
      `Source ${s.sourceId} (${def.company}), currency ${def.currency}, GPUs ${s.gpus.join(", ")}. Incident: ${inc.kind} since ${new Date(inc.since * 1000).toISOString()}; diagnosis by the program: ${inc.diagnosis?.kind ?? "?"} (${inc.diagnosis?.why ?? ""}).`,
      `Evidence: ${inc.evidence.intervals} intervals, served ${inc.evidence.served}, no row ${inc.evidence.noRow}, bad value ${inc.evidence.badValue}, not rentable ${inc.evidence.notRentable}, failed ${inc.evidence.failed}, valid ${inc.evidence.valid}.`,
      `The reader in force is ${rf.parserVersion}, on the URL in NOTE 1. Write ${version}: the file src/pure/parsers/${vNew.name}.v${vNew.n}.ts, exporting exactly one \`export const extract: Extractor = (body, ctx) => { ... }\` (import type { Extractor, ParseContext } from "../../types.ts"; import type { GpuModel } from "@agate/report/types"; helpers only from "../text.ts").`,
      "It must read the pages since the incident (VALID within 10% of the trackers on every GPU they list) and read every older page exactly as the reader in force read it (same state and value). Money math, bounds and row states are added by parse(): return cells (kind price with the native decimal string and the GPU count it was quoted for, not-rentable, missing or error).",
      inc.lastRefusal ? "The previous draft was refused; NOTE 2 holds the refusal." : "",
    ].filter(Boolean).join("\n");
    // 15.3 rules 1 and 2: an onchain or redirect URL and a refusal (which can quote a page or a draft)
    // are untrusted text, wrapped like a page, never part of TASK
    const notes: PromptNote[] = [{ id: 1, label: `NOTE 1: the URL the reader in force fetches (${inc.proposedUrl ? "a redirect's Location" : "the chain's reader history or the panel"})`, text: inc.proposedUrl ?? rf.url }];
    if (inc.lastRefusal) notes.push({ id: 2, label: "NOTE 2: why the previous draft was refused (program text that may quote a page or the draft)", text: inc.lastRefusal });
    const codeText = `The extractor in force (${rf.parserVersion}):\n${code}\n\nHelpers exported by ../text.ts:\n${cellType}${sigs}`;
    const anchors = s.gpus.map((g) => def.rules[g]!.product);
    return buildPrompt({ task, rule, code: codeText, expect: expect.join("\n"), pages, anchors, notes }).prompt;
  }

  private async fetchOnce(inc: Incident, ctx: Ctx): Promise<void> {
    if (!inc.proposedUrl || (inc.movedFetchK ?? -Infinity) >= ctx.kNow) return;
    inc.movedFetchK = ctx.kNow;
    const r = await (this.d.fetchMoved ?? httpFetchMoved)(inc.proposedUrl, Math.min(40, ctx.clock.slice / 10) * 1000);
    if (r && r.status >= 200 && r.status < 300 && r.body.length > 0) {
      const dir = join(this.d.cfg.dir, "fetched", inc.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ctx.kNow}-${ctx.now}.gz`), Bun.gzipSync(r.body as Uint8Array<ArrayBuffer>));
    }
    this.put(inc, ctx.now);
  }

  /** A moved source: fetch the new URL once per interval; with three pages, try the reader in force on it. */
  private async movedStep(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    await this.fetchOnce(inc, ctx);
    const rf = await this.readerOf(ctx, s);
    const pages = this.newPages(inc, s, ctx, rf);
    if (pages.length < 3 || !sandboxAvailable(this.d.cfg.sandboxExec)) return;
    const draftId = `url-${index8(ctx.index)}-${s.sourceId}-${ctx.now}`;
    const draftDir = join(this.d.cfg.dir, "drafts", draftId);
    mkdirSync(draftDir, { recursive: true });
    const nv = nameOfVersion(rf.parserVersion)!;
    const pkg = prepareScratch(this.d.cfg.wallRoot, draftDir, nv.name, nv.n + 1, s.sourceId, null).pkg;
    const g5 = gate5(s.sourceId, inc.proposedUrl);
    const g3 = g5.ok ? await gate3(this.runCtx(draftDir, pkg), rf.parserVersion, s.gpus, pages.map((p) => this.toBatch(p)), this.trackerFn(ctx, s, pages)) : g5;
    writeAtomic(join(draftDir, "gates.json"), JSON.stringify({ draftId, urlOnly: true, url: inc.proposedUrl, version: rf.parserVersion, gates: { "gate 3": g3.ok ? g3.detail : `FAILED: ${g3.why}`, "gate 5": g5.ok ? g5.detail : `FAILED: ${g5.why}` } }, null, 1));
    if (!g5.ok) return this.refuse(inc, s, ctx, `gate 5: ${g5.why}`, "refused");
    if (g3.ok) {
      inc.draftId = draftId;
      inc.status = "shadow";
      inc.shadow = { fromK: ctx.kDone + 1, lastK: ctx.kDone, good: 0, seen: 0 };
    } else {
      inc.status = "draft"; // the reader in force cannot read the new page: a redesign on the new URL
      inc.lastRefusal = `the reader in force on the new URL: ${g3.why}`;
    }
    this.put(inc, ctx.now);
  }

  private async shadowStep(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    if (!inc.draftId || !inc.shadow) return;
    const urlOnly = inc.draftId.startsWith("url-");
    const rf = await this.readerOf(ctx, s);
    if (inc.proposedUrl && inc.proposedUrl !== rf.url) await this.fetchOnce(inc, ctx);
    const draftDir = join(this.d.cfg.dir, "drafts", inc.draftId);
    const pkg = join(draftDir, "pkg");
    const gates = JSON.parse(readFileSync(join(draftDir, "gates.json"), "utf8")) as { version: string };
    const version = gates.version;
    const sh = inc.shadow;
    const fetched = inc.proposedUrl && inc.proposedUrl !== rf.url ? fetchedPages(join(this.d.cfg.dir, "fetched", inc.id)) : null;
    const def = SOURCES.find((x) => x.id === s.sourceId)!;
    for (let k = sh.lastK + 1; k <= ctx.kDone; k++) {
      sh.lastK = k;
      const page = fetched ? (fetched.find((p) => p.k === k) ?? null) : watcherPage(ctx.logDir, ctx.log, ctx.clock, s.sourceId, k, watcherRawName(s.sourceId, rf.url, def.url));
      if (!page) continue;
      sh.seen++;
      const r = await runBatch(this.d.spawner, this.d.cfg.bun, draftDir, pkg, [version], [this.toBatch(page)]);
      const rows = r.ok ? r.rows.get(page.id)?.[version] : undefined;
      const j = r.ok ? judgeNew(rows, s.gpus, (g, own) => this.trackerAt(ctx, k, s.sourceId, g, own)) : { ok: false as const, why: r.why };
      appendLine(shadowFile(draftDir), { k, page: page.id, version, rows: rows ?? null, inForce: page.line?.gpus ?? null, ok: j.ok, why: j.ok ? undefined : j.why });
      sh.good = j.ok ? sh.good + 1 : 0;
      if (sh.good >= SHADOW_MIN) {
        this.put(inc, ctx.now);
        return this.writeNote(inc, s, ctx, version, urlOnly);
      }
      if (sh.seen >= SHADOW_MAX) return this.refuse(inc, s, ctx, `shadow failed: ${SHADOW_MIN} good intervals in a row not reached in ${SHADOW_MAX}`, this.budget.used(inc.id) < this.d.cfg.budgets.perIncident ? "draft" : "refused");
    }
    this.put(inc, ctx.now);
  }

  private async writeNote(inc: Incident, s: SourceSlots, ctx: Ctx, version: string, urlOnly: boolean): Promise<void> {
    const draftDir = join(this.d.cfg.dir, "drafts", inc.draftId!);
    const sha = urlOnly ? null : readFileSync(join(draftDir, "sha256"), "utf8").trim();
    const readers: NoteReader[] = [];
    const cmdIdx: CommandIndex[] = [];
    const files: string[] = [];
    for (const index of this.d.cfg.indexes) {
      const panels = this.d.cfg.panels[index] ?? [];
      const ss = servedSources(index, panels).find((x) => x.sourceId === s.sourceId);
      const clock = readIndexClock(join(this.d.cfg.home, "watcher", index));
      if (!ss || !clock) continue;
      const ictx = index === ctx.index ? ctx : this.ctxOf(index, clock, ctx.now);
      const entries: ActionFile["actions"] = [];
      for (let i = 0; i < ss.slots.length; i++) {
        const x = ss.slots[i]!;
        const inForce = await this.readerOf(ictx, ss, i);
        const proposed = { url: inc.proposedUrl ?? inForce.url, parserVersion: urlOnly ? inForce.parserVersion : version };
        readers.push({ index, gpu: x.gpu, gpuId: x.gpuId, slot: x.slot, inForce, proposed });
        entries.push({ kind: "READER", gpuId: x.gpuId, slot: x.slot, url: proposed.url, parserVersion: proposed.parserVersion, reason: reasonString(inc.kind, inc.since, inc.evidence, inc.draftId!) });
      }
      const file = join(this.d.cfg.dir, "actions", `${inc.id}-${index8(index)}.json`);
      // no trailing newline: the shell's $(cat file) passes these exact bytes, so the note's sha256 pin matches
      const json = JSON.stringify({ actions: entries } satisfies ActionFile, null, 1);
      writeAtomic(file, json);
      files.push(file);
      cmdIdx.push({ index, actionFile: file, actionSha256: sha256Hex(json), clock });
    }
    const notes = existsSync(join(draftDir, "notes.txt")) ? readFileSync(join(draftDir, "notes.txt"), "utf8") : null;
    const gates = (JSON.parse(readFileSync(join(draftDir, "gates.json"), "utf8")) as { gates: Record<string, string> }).gates;
    let commands: string;
    try {
      commands = commandsText({ home: this.d.cfg.home, repo: this.d.cfg.repo, draft: sha ? { id: inc.draftId!, sha256: sha } : null, urlOnly, indexes: cmdIdx, now: ctx.now });
    } catch (e) {
      return this.refuse(inc, s, ctx, `no note: ${(e as Error).message}`, "refused");
    }
    const n: NoteJson = {
      kind: "agate.repair-note",
      version: 1,
      incident: pick(inc),
      diagnosis: inc.diagnosis ?? null,
      modelNotes: notes,
      draft: sha ? { id: inc.draftId!, path: join(draftDir, "extractor.ts"), sha256: sha } : null,
      urlOnly,
      nothingToDo: false,
      gates,
      shadow: inc.shadow ? { good: inc.shadow.good, seen: inc.shadow.seen, fromK: inc.shadow.fromK, lastK: inc.shadow.lastK } : null,
      readers,
      actionFiles: files,
      commands,
      writtenAt: ctx.now,
    };
    writeAtomic(join(this.d.cfg.dir, "notes", `${inc.id}.json`), `${JSON.stringify(n, null, 1)}\n`);
    writeAtomic(join(this.d.cfg.dir, "notes", `${inc.id}.md`), noteMarkdown(n));
    inc.status = "noted";
    inc.noteAt = ctx.now;
    this.put(inc, ctx.now);
    this.d.sink(ctx.index).raise({ code: CODES.NOTE, severity: "action", ...this.refId(s), message: `repair note ready: ${s.sourceId} ${inc.kind} (${urlOnly ? "URL-only swap" : `draft ${version}`}): ${join(this.d.cfg.dir, "notes", `${inc.id}.md`)}`, data: { incident: inc.id, note: join(this.d.cfg.dir, "notes", `${inc.id}.md`), actions: files } });
    if (this.d.cfg.notify) {
      try {
        await this.d.spawner.run("osascript", ["-e", notificationScript(index8(ctx.index), s.sourceId, inc.kind)], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 });
      } catch {
        // the alert is already in the file and through AGATE_NOTIFY_CMD
      }
    }
    this.say("note", { id: inc.id });
  }

  /** After the note: REPAIR_WINDOW when a proposed swap is past its eta, unexecuted, with less than 2 DAY left. */
  private async followStep(inc: Incident, s: SourceSlots, ctx: Ctx): Promise<void> {
    const chain = this.d.chain?.(ctx.index);
    if (!chain) return;
    const file = join(this.d.cfg.dir, "actions", `${inc.id}-${index8(ctx.index)}.json`);
    if (!existsSync(file)) return;
    const f = JSON.parse(readFileSync(file, "utf8")) as ActionFile;
    for (const e of f.actions) {
      let eta: number;
      try {
        eta = await chain.queuedEta(readerSwapId(e.gpuId, e.slot, e.url, e.parserVersion));
      } catch {
        return;
      }
      if (eta === 0) continue;
      const end = eta + ACTION_WINDOW_DAYS * ctx.clock.day;
      if (ctx.now > eta && ctx.now <= end && end - ctx.now < 2 * ctx.clock.day) {
        this.d.sink(ctx.index).raise({ code: CODES.WINDOW, severity: "action", ...this.refId(s), deadline: end, message: `the reader swap for ${s.sourceId} (${e.parserVersion}) is executable and its window ends ${new Date(end * 1000).toISOString()}: execute it (note step 6) or queue it again`, data: { incident: inc.id, eta, windowEnd: end } });
        return;
      }
    }
    // executed, cancelled or expired (queuedEta 0), or not yet due: no reminder stands
    const r = this.refId(s);
    this.d.sink(ctx.index).clearWhere((a) => a.code === CODES.WINDOW && a.gpuId === r.gpuId && a.slot === r.slot);
  }
}

function pick(inc: Incident): NoteJson["incident"] {
  return { id: inc.id, index: inc.index, sourceId: inc.sourceId, kind: inc.kind, gpus: inc.gpus, sinceK: inc.sinceK, since: inc.since, evidence: inc.evidence };
}
