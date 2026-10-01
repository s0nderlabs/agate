// The attester (BUILD-SPEC 9.2, rule R1): on every interval, every new event and on wake, for each GPU, evaluate the
// pending record once the day is settled (or at postedAt + T_PEND - margin for a record final by itself), and attest
// or select per R1. Never vetoes, suspends or posts. Also raises the lag, freeze-loop, writer-gap and onchain alerts.
import { rmSync } from "node:fs";
import type { Address, Hex } from "@agate/report/types";
import { ActionKind, AlertCode, Status, WriterMode } from "@agate/report/types";
import type { AlertSink } from "./alerts.ts";
import type { EventSource, IndexView, Sender } from "./chain/types.ts";
import { dayEnd, dayIdAt, fetchTimeoutS, fullBits, intervalAt, intervalStart, settleInterval, type WallClock } from "./clock.ts";
import { appendLine, type Heartbeat, writeAtomic } from "./fsutil.ts";
import type { GuardianLogView } from "./guardian-log.ts";
import type { LogSource } from "./log/store.ts";
import { evaluate } from "./rule/decide.ts";
import type { Evaluation, HistoryDay } from "./rule/types.ts";
import { buildScenario, EventIndex, type PanelRef } from "./scenario.ts";

const lc = (a: string) => a.toLowerCase();
/** Chainlink's KeystoneForwarders on Monad, the only forwarders that authenticate WORKFLOW_OWNER metadata (mainnet,
 *  testnet; from `cre workflow supported-chains`). The simulation forwarders (0x9eF6..., 0xB9F7...) do not. */
const KEYSTONE_FORWARDERS = ["0x76c9cf548b4179F8901cda1f8623568b58215E62", "0xF8344CFd5c43616a4366C34E3EEE75af79a74482"];

export interface AttesterDeps {
  view: IndexView;
  events: EventSource;
  log: LogSource & { refresh?: () => void };
  guardian?: GuardianLogView;
  alerts: AlertSink;
  sender: Sender;
  clock: WallClock;
  panels: PanelRef[];
  decisionsPath: string | null;
  /** LV-3: where the attester notes the pick it is about to send, per GPU (read by the keeper, 9.3); null: none */
  pickPath?: ((gpuId: Hex) => string) | null;
  heartbeat?: Heartbeat;
  tickS: number;
  /** test hook: every evaluation */
  onEvaluation?: (gpuId: Hex, ev: Evaluation) => void;
}

export class Attester {
  readonly idx: EventIndex;
  private readonly cache = new Map<string, HistoryDay>();
  private readonly lastKey = new Map<string, string>();
  private readonly lastLogged = new Map<string, string>();
  private lastTick: number | null = null;
  private seenEvents = -1;
  readonly decisions: { at: number; gpuId: Hex; day: number; action: string; writer?: Address; ok?: boolean; error?: string }[] = [];

  constructor(readonly x: AttesterDeps) {
    this.idx = new EventIndex(x.events);
  }

  async tick(now: number): Promise<void> {
    const woke = this.lastTick !== null && now - this.lastTick > 3 * this.x.tickS;
    if (woke) {
      this.x.alerts.raise({ code: AlertCode.CLOCK_JUMP, severity: "info", message: `attester woke after ${now - this.lastTick!} s`, data: { slept: now - this.lastTick!, role: "attest" } });
      this.lastKey.clear();
    }
    this.lastTick = now;
    try {
      await this.x.events.sync();
    } catch (e) {
      this.x.heartbeat?.beat(now, `events sync failed: ${String(e)}`);
      return; // the pool raised RPC alerts; retry next tick
    }
    this.x.log.refresh?.();
    this.onchainAlerts(now);
    for (const p of this.x.panels) {
      try {
        await this.gpuTick(p, now);
      } catch (e) {
        this.x.heartbeat?.beat(now, `gpu ${p.gpu} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.x.heartbeat?.beat(now, "ok");
  }

  /** The watcher's states are known through interval k(d, SLICES-1) + 1 + GAP: every source of the panel has its
   *  line, or that interval ended a fetch timeout ago (a line still missing then is UNK, which only widens). */
  private settled(p: PanelRef, d: number, now: number): boolean {
    const c = this.x.clock;
    const kS = settleInterval(c, d);
    if (now >= intervalStart(c, kS + 1) + fetchTimeoutS(c)) return true;
    return p.sources.every((s) => this.x.log.has(s, kS)) && now >= intervalStart(c, kS);
  }

  private async gpuTick(p: PanelRef, now: number): Promise<void> {
    const c = this.x.clock;
    const g = p.gpuId;
    const head = await this.x.view.head(g);
    const d = head - 1;
    await this.lagAlert(p, head, now);
    await this.writerGap(p, now);
    const r = await this.x.view.record(g, d);
    if (!r.exists || r.isFinal || r.rec.status === Status.CARRIED || r.rec.attestedAt !== 0n) return;
    const postedAt = Number(r.rec.postedAt);
    const deadline = r.rec.needsSign ? Infinity : postedAt + c.tPend - c.margin;
    const settled = this.settled(p, d, now);
    if (!settled && now < deadline) return;
    const key = `${d}:${r.rec.digest}:${this.idx.count()}:${intervalAt(c, now)}:${now >= deadline}`;
    const gk = lc(g);
    if (this.lastKey.get(gk) === key) return;
    this.lastKey.set(gk, key);

    const built = await buildScenario({ view: this.x.view, events: this.idx, log: this.x.log, guardian: this.x.guardian, alerts: this.x.alerts, clock: c, panel: p, cache: this.cache }, now, d);
    if (!built) return;
    if (built.inconsistent.length > 0) {
      this.x.alerts.raise({ code: AlertCode.R1_NO_CANDIDATE, severity: "action", gpuId: g, day: d, deadline: now + c.guardAct, message: `day ${d}: the attester refuses: ${built.inconsistent.join("; ")} (9.2)` });
      this.logDecision(now, g, d, { refused: built.inconsistent });
      return;
    }
    const ev = evaluate(built.scenario);
    this.x.onEvaluation?.(g, ev);
    for (const a of ev.alerts) this.x.alerts.raise({ ...a, gpuId: g, day: d });
    const summary = JSON.stringify([ev.action, ev.candidates.map((v) => [v.source, v.tier, v.value])]);
    if (this.lastLogged.get(gk) !== summary || ev.action.kind !== "none") {
      this.lastLogged.set(gk, summary);
      this.logDecision(now, g, d, { evaluation: ev });
    }
    if (ev.action.kind === "none") return;
    if (!r.rec.needsSign && now >= Number(r.rec.finalAt)) return; // final by itself already
    // LV-3: the keeper holds a case-1 drop of this record while a fresh pick for it is noted here
    const pickFile = this.x.pickPath?.(g);
    if (pickFile) writeAtomic(pickFile, JSON.stringify({ day: d, digest: r.rec.digest, at: now }));
    let res: Awaited<ReturnType<Sender["send"]>>;
    try {
      res = await this.x.sender.send("attest", [g, d, ev.action.writer!, ev.action.digest!]);
    } catch (e) {
      res = { ok: false, sent: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!res.ok && !res.sent && r.rec.needsSign && /RPC/.test(res.error ?? "")) {
      // LV-3: a pick the attester cannot send is the guardian's within GUARD_ACT, as R1_NO_CANDIDATE would be
      this.x.alerts.raise({ code: AlertCode.RPC_DOWN, severity: "action", gpuId: g, day: d, deadline: now + c.guardAct, message: `day ${d}: the attester has a pick (${ev.action.kind} ${ev.action.writer}) for a needsSign record but cannot reach any RPC URL: sign it from the guardian's network (R11) before it drops`, data: { role: "attest", action: ev.action } });
    }
    if (!res.ok && !/RPC/.test(res.error ?? "")) {
      // LV-3: a send that failed for any other reason (funds, gas cap, nonce, revert) must not hold the keeper's drop
      if (pickFile) rmSync(pickFile, { force: true });
      this.x.alerts.raise({ code: AlertCode.R1_NO_CANDIDATE, severity: "action", gpuId: g, day: d, deadline: now + c.guardAct, message: `day ${d}: the attester's ${ev.action.kind} of ${ev.action.writer} failed (${res.error ?? "unknown"}): sign it by hand (R11) or the keeper drops it on schedule`, data: { role: "attest", action: ev.action } });
    }
    this.decisions.push({ at: now, gpuId: g, day: d, action: ev.action.kind, writer: ev.action.writer!, ok: res.ok, ...(res.error ? { error: res.error } : {}) });
    this.logDecision(now, g, d, { sent: { action: ev.action, result: res } });
    if (res.ok) {
      this.x.alerts.raise({ code: ev.action.kind === "attest" ? AlertCode.R1_SIGNED : AlertCode.R1_SELECTED, severity: "info", gpuId: g, day: d, writer: ev.action.writer!, message: `day ${d}: ${ev.action.kind} ${ev.action.writer} ${ev.action.digest} (${ev.action.why})` });
      this.x.alerts.clearWhere((a) => a.gpuId !== undefined && lc(a.gpuId) === gk && a.day === d && (a.code === AlertCode.R1_NO_CANDIDATE || a.code === AlertCode.R9_UNCHANGED_NOT_STRICT));
    }
  }

  private logDecision(at: number, gpuId: Hex, day: number, body: unknown): void {
    if (this.x.decisionsPath) appendLine(this.x.decisionsPath, { at, gpuId, day, ...(body as object) });
  }

  /** R5_HEAD_LAG: the oldest day without a final record ended one DAY ago; deadline dayEnd + LAG_MAX. */
  private async lagAlert(p: PanelRef, head: number, now: number): Promise<void> {
    const c = this.x.clock;
    const r = await this.x.view.record(p.gpuId, head - 1);
    const d0 = r.exists && !r.isFinal ? head - 1 : head;
    this.x.alerts.clearWhere((a) => a.code === AlertCode.R5_HEAD_LAG && a.gpuId !== undefined && lc(a.gpuId) === lc(p.gpuId) && (a.day ?? 0) < d0);
    if (now >= dayEnd(c, d0) + c.day)
      this.x.alerts.raise({ code: AlertCode.R5_HEAD_LAG, severity: "action", gpuId: p.gpuId, day: d0, deadline: dayEnd(c, d0) + c.lagMax, message: `${p.gpu}: day ${d0} has no final record ${now - dayEnd(c, d0)} s after it ended (LAG_MAX ${c.lagMax} s): guardian procedure (6.6) on every pending record` });
  }

  /** WRITER_GAP: a writer's slice bit still missing after the repost window of the last ended day. */
  private readonly gapChecked = new Map<string, number>();
  private async writerGap(p: PanelRef, now: number): Promise<void> {
    const c = this.x.clock;
    const d = dayIdAt(c, now) - 1;
    if (now < dayEnd(c, d) + c.closeGrace) return;
    if (this.gapChecked.get(lc(p.gpuId)) === d) return; // once per day per GPU, after its repost window
    this.gapChecked.set(lc(p.gpuId), d);
    if (d < Number((await this.x.view.gpu(p.gpuId)).firstDay)) return;
    const ws = await this.x.view.writers();
    for (const w of ws) {
      if (lc(w) === "0x0000000000000000000000000000000000000000" || (await this.x.view.isSuspended(w))) continue;
      const r = await this.x.view.readings(p.gpuId, d, w);
      if (Number(r.sliceBits) !== fullBits(c)) {
        const missing = c.slices - [...Number(r.sliceBits).toString(2)].filter((b) => b === "1").length;
        this.x.alerts.raise({ code: AlertCode.WRITER_GAP, severity: "action", gpuId: p.gpuId, day: d, writer: w, message: `${p.gpu} day ${d}: ${w} is missing ${missing} of ${c.slices} slices after the repost window` });
      }
    }
  }

  /** FREEZE_LOOP on every FixDropped, ONCHAIN_EVENT (info) for vetoes, suspensions, drops, carries, queued actions. */
  private onchainAlerts(now: number): void {
    const all = this.x.events.all();
    if (this.seenEvents < 0) this.seenEvents = all.length; // history before this process started is not re-announced
    for (; this.seenEvents < all.length; this.seenEvents++) {
      const e = all[this.seenEvents]!;
      if (e.name === "FixDropped") {
        const lastComputed = this.lastComputedDay(e.gpuId, e.day);
        const inRow = this.idx.of("FixDropped", e.gpuId).filter((x) => x.day > lastComputed && x.day <= e.day).length;
        this.x.alerts.raise({ code: AlertCode.FREEZE_LOOP, severity: "action", gpuId: e.gpuId, day: e.day, deadline: now + this.x.clock.guardAct, message: `day ${e.day} dropped (${inRow} drop${inRow === 1 ? "" : "s"} in a row): R12 applies at once to the next pending record`, data: { inRow, source: e.source, value: e.value } });
      }
      // R6 (review): WORKFLOW_OWNER mode takes the writer from caller-supplied metadata, safe only behind a real DON's
      // KeystoneForwarder; queued with any other forwarder, anyone could post as any writer once it executes
      if (e.name === "ActionQueued" && e.kind === ActionKind.FORWARDER && e.mode === WriterMode.WORKFLOW_OWNER && !KEYSTONE_FORWARDERS.some((f) => lc(f) === lc(e.addr ?? "")))
        this.x.alerts.raise({ code: AlertCode.ONCHAIN_EVENT, severity: "action", deadline: e.eta, message: `queued FORWARDER ${e.addr} in WORKFLOW_OWNER mode (action ${e.id}, eta ${e.eta}): that mode is safe only behind a KeystoneForwarder (${KEYSTONE_FORWARDERS.join(", ")}); cancel it (4.11, R6 of the Oct 1 review)`, data: { id: e.id } });
      // K: an unchanged record closed with needsSign (no signAll) means the day's first writer was below quorum; on two
      // computed days running that is a stolen or broken first writer, and with the attester down every such day drops
      if (e.name === "DayClosed" && e.needsSign && !e.changed && !this.x.clock.signAll) {
        const prev = this.idx.of("DayClosed", e.gpuId, e.day - 1).some((x) => x.needsSign && !x.changed);
        if (prev)
          this.x.alerts.raise({ code: AlertCode.WRITER_GAP, severity: "action", gpuId: e.gpuId, day: e.day, deadline: now + this.x.clock.guardAct, message: `day ${e.day}: for the second day running the day's first writer was below quorum and ${e.source}'s record needs the countersign: a stolen or broken first writer (check its readings, R4 or R8); keep the attester up or sign by R11` });
      }
      if (["Vetoed", "WriterSuspended", "FixDropped", "DayCarried", "ActionQueued"].includes(e.name)) {
        const who = "writer" in e ? (e.writer as Address) : "source" in e ? (e.source as Address) : undefined;
        this.x.alerts.raise({ code: AlertCode.ONCHAIN_EVENT, severity: "info", ...(e.gpuId && e.gpuId !== "0x" ? { gpuId: e.gpuId } : {}), day: e.day, ...(who ? { writer: who } : {}), message: `${e.name} ${JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` });
      }
    }
  }

  /** The newest day before `before` whose record, by the events so far, is a computed one (closed or selected and
   *  neither vetoed nor dropped since). */
  private lastComputedDay(g: Hex, before: number): number {
    const state = new Map<number, boolean>();
    for (const e of this.x.events.all()) {
      if (e.gpuId === undefined || lc(e.gpuId) !== lc(g)) continue;
      if (e.name === "DayClosed" || e.name === "RecordReplaced") state.set(e.day, true);
      else if (e.name === "Vetoed" || e.name === "FixDropped") state.set(e.day, false);
    }
    let best = -1;
    for (const [d, ok] of state) if (ok && d < before) best = Math.max(best, d);
    return best;
  }
}
