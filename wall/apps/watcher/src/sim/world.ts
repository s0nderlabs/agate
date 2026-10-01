// The watcher's harness (BUILD-SPEC 12.5): scripted pages, honest and stolen writers, the watcher's log, the real
// Attester and Keeper against the in-memory index, and a scripted guardian following 6.6's procedure (R11, looks,
// R12, R3, R8). Everything runs on an injected clock; one World is one deterministic run.
import type { Address, GpuModel, Hex, WatcherReading } from "@agate/report/types";
import { AlertCode, Status } from "@agate/report/types";
import { AlertSink } from "../alerts.ts";
import { Attester } from "../attester.ts";
import { deriveClocks, type ProfileInput, wallClock, type WallClock } from "../clock.ts";
import { MemGuardianLog } from "../guardian-log.ts";
import { Keeper } from "../keeper.ts";
import { LogStore } from "../log/store.ts";
import { evaluate } from "../rule/decide.ts";
import type { Evaluation } from "../rule/types.ts";
import { buildScenario, EventIndex, type PanelRef } from "../scenario.ts";
import { FakeChain } from "./fake-chain.ts";
import { ModelIndex, Revert } from "./model-index.ts";

export type PageState = { s: "V"; v: number } | { s: "NR" } | { s: "DARK" } | { s: "FAIL" };
export type PageFn = (slot: number, t: number, net: string) => PageState;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Outage {
  slot: number;
  from: number;
  to: number;
  state: "NR" | "DARK" | "FAIL";
  nets?: string[]; // undefined = every network
}

/** Prices with steps and outages; a view split is an outage or a step limited to some networks. */
export class Pages {
  constructor(
    readonly base: number[],
    readonly steps: { slot: number; at: number; v: number; nets?: string[] }[] = [],
    readonly outages: Outage[] = [],
  ) {}
  price(i: number, t: number, net = "any"): number {
    let v = this.base[i]!;
    for (const s of this.steps) if (s.slot === i && t >= s.at && (!s.nets || s.nets.includes(net))) v = s.v;
    return v;
  }
  fn: PageFn = (i, t, net) => {
    for (const o of this.outages) if (o.slot === i && o.from <= t && t < o.to && (!o.nets || o.nets.includes(net))) return { s: o.state };
    return { s: "V", v: this.price(i, t, net) };
  };
}

export interface WriterSpec {
  net: string;
  /** a thief or a broken writer: rewrite the values it posts */
  values?: (d: number, h: number, t: number, honest: number[]) => number[];
  /** slices it never posts (process down, a lost slice) */
  skip?: (d: number, h: number) => boolean;
  /** close behaviour: honest (8.1 step 3), earliest (at the first legal second, every day), never */
  close?: "honest" | "earliest" | "never";
  /** writes held while its RPC is down are sent on recovery inside the F1 window, else lost */
  rpcDown?: (t: number) => boolean;
  /** its read second inside slice h of day d (default: random in [slice/20, slice/2)) */
  readOffset?: (d: number, h: number) => number | undefined;
}

export interface GuardianSpec {
  /** seconds after an action alert at which the guardian acts (at most GUARD_ACT) */
  delay: number;
  looks: boolean;
  lookNet?: string; // the writer's region (A7): default "look", which pages treat like the writers' networks
  r8?: boolean;
  /** the guardian acts only from this time on (default: always) */
  from?: number;
}

export interface WorldOptions {
  profile?: ProfileInput;
  nSlots?: number;
  family?: number[];
  famQ?: number[];
  liveMask?: number;
  windows?: { slot: number; liveFrom: number; liveUntil?: number }[];
  firstDay: number;
  /** registration and run start (default: dayStart(firstDay)) */
  t0?: number;
  pages: PageFn;
  writers: WriterSpec[];
  watcherMissed?: (k: number) => boolean;
  /** the watcher's read second inside interval k for a slot (default: random in [slice/20, 19 slice/20)) */
  watcherOffset?: (slot: number, k: number) => number | undefined;
  attester?: boolean | { down?: (t: number) => boolean; careless?: boolean };
  keeper?: boolean;
  guardian?: GuardianSpec | null;
  /** every RPC URL down for the attester, keeper and guardian (writers: use WriterSpec.rpcDown) */
  chainDown?: (t: number) => boolean;
  /** every process (writers, watcher, attester, keeper, guardian) stopped (machine asleep) */
  asleep?: (t: number) => boolean;
  step?: number;
  seed?: number;
}

export const W_ADDR: Address[] = ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"];
export const ATTESTER: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const GUARDIAN: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
export const KEEPER: Address = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
export const GPU_ID: Hex = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
const GPU: GpuModel = "H100";

export interface DayResult {
  day: number;
  value: number;
  final: boolean;
  carried: boolean;
  dropped: boolean;
  source: Address;
  attestedBy: Address;
  finalAt: number;
  lag: number; // finalAt - dayEnd (or now - dayEnd when not final)
}

export class World {
  readonly c: WallClock;
  readonly m: ModelIndex;
  readonly chain: FakeChain;
  readonly log: LogStore;
  readonly alerts: AlertSink;
  readonly glog = new MemGuardianLog();
  readonly attester: Attester | null;
  readonly keeper: Keeper | null;
  readonly panel: PanelRef;
  readonly evaluations: { at: number; ev: Evaluation }[] = [];
  readonly guardianActs: { at: number; day: number; act: string; writer?: Address; why?: string }[] = [];
  now = 0;
  private readonly rng: () => number;
  private readonly readT = new Map<string, number>();
  private readonly posted = new Set<string>();
  private readonly held: { w: number; d: number; h: number; t: number; values: number[] }[] = [];
  private readonly wTime = new Map<string, { t: number; t2: number | null }>();
  private readonly guardianSeen = new Map<string, number>();
  readonly n: number;

  constructor(readonly o: WorldOptions) {
    const clocks = deriveClocks(o.profile ?? { day: 2_400, slices: 12 });
    this.c = wallClock(clocks);
    this.n = o.nSlots ?? 5;
    this.rng = mulberry32(o.seed ?? 7);
    const writers: [Address, Address] = [W_ADDR[0]!, o.writers.length > 1 ? W_ADDR[1]! : "0x0000000000000000000000000000000000000000"];
    this.m = new ModelIndex(clocks, { writers, attester: ATTESTER, guardians: [GUARDIAN, "0x0000000000000000000000000000000000000000"] });
    this.now = o.t0 ?? this.dayStart(o.firstDay);
    const family = o.family ?? Array.from({ length: this.n }, (_, i) => i);
    const famQ = o.famQ ?? Array.from({ length: Math.max(...family) + 1 }, () => 1);
    this.m.registerGpu(GPU_ID, family, famQ, o.firstDay, o.liveMask ?? 2 ** this.n - 1, this.now);
    for (const w of o.windows ?? []) this.m.setWindow(GPU_ID, w.slot, w.liveFrom, w.liveUntil);
    this.chain = new FakeChain(this.m, () => this.now);
    this.log = new LogStore("/nonexistent-agate-sim");
    this.alerts = new AlertSink(null, { now: () => this.now, print: false });
    this.panel = { gpu: GPU, gpuId: GPU_ID, sources: Array.from({ length: this.n }, (_, i) => `s${i}`) };
    const step = o.step ?? Math.max(1, Math.floor(this.c.slice / 20));
    this.attester =
      o.attester === false
        ? null
        : new Attester({
            view: this.chain,
            events: this.chain,
            log: this.log,
            guardian: this.glog,
            alerts: this.alerts,
            sender: this.chain.sender(ATTESTER),
            clock: this.c,
            panels: [this.panel],
            decisionsPath: null,
            tickS: step,
            onEvaluation: (_g, ev) => this.evaluations.push({ at: this.now, ev }),
          });
    this.keeper = o.keeper === false ? null : new Keeper({ view: this.chain, sender: this.chain.sender(KEEPER), clock: this.c, gpuIds: [GPU_ID], alerts: this.alerts, tickS: step });
  }

  dayStart(d: number) {
    return Number(this.m.clocks.epochTs) + (d - this.m.clocks.epochDay) * this.m.clocks.day;
  }
  dayEnd(d: number) {
    return this.dayStart(d + 1);
  }
  sliceStart(d: number, h: number) {
    return this.dayStart(d) + h * this.c.slice;
  }
  dayOf(t: number) {
    return this.m.clocks.epochDay + Math.floor((t - Number(this.m.clocks.epochTs)) / this.m.clocks.day);
  }

  // ------------------------------------------------------------------ the watcher's log

  private watcherTick(now: number): void {
    const c = this.c;
    const k = Math.floor((now - c.epochTs) / c.slice);
    for (let i = 0; i < this.n; i++) {
      for (const kk of [k - 1, k]) {
        if (kk < 0 || this.log.has(`s${i}`, kk)) continue;
        const start = c.epochTs + kk * c.slice;
        const end = start + c.slice;
        const key = `${i}:${kk}`;
        if (this.o.watcherMissed?.(kk) || this.o.asleep?.(start + Math.floor(c.slice / 2))) {
          if (now >= end) this.write(i, kk, 0, 0, "MISSED");
          continue;
        }
        let w = this.wTime.get(key);
        if (!w) {
          const lo = start + c.slice / 20;
          const hi = start + (19 * c.slice) / 20;
          const off = this.o.watcherOffset?.(i, kk);
          w = { t: off !== undefined ? start + off : Math.floor(lo + this.rng() * (hi - lo)), t2: null };
          this.wTime.set(key, w);
        }
        if (now < w.t) continue;
        const s1 = this.o.pages(i, w.t, "watch");
        if (s1.s !== "FAIL") {
          this.write(i, kk, w.t, 1, s1);
          continue;
        }
        if (w.t2 === null) w.t2 = Math.ceil(w.t + ((30 + this.rng() * 90) * c.slice) / 3600);
        if (w.t2 >= end) {
          if (now >= w.t) this.write(i, kk, w.t, 1, s1);
          continue;
        }
        if (now < w.t2) continue;
        this.write(i, kk, w.t2, 2, this.o.pages(i, w.t2, "watch"));
      }
    }
  }

  private write(i: number, k: number, at: number, attempts: number, s: PageState | "MISSED"): void {
    const gpus: WatcherReading["gpus"] = {};
    if (s !== "MISSED") {
      gpus[GPU] = s.s === "V" ? { state: "VALID", valueU: s.v } : { state: s.s === "NR" ? "NOT_RENTABLE" : s.s === "DARK" ? "NO_ROW" : "FAILED", valueU: 0 };
    }
    this.log.add({ sourceId: `s${i}`, interval: k, scheduledAt: at, fetchedAt: at, attempts, httpStatus: s === "MISSED" ? 0 : 200, bytes: 0, sha256: "", gpus });
  }

  // ------------------------------------------------------------------ writers

  private readTime(w: number, d: number, h: number): number {
    const key = `${w}:${d}:${h}`;
    let t = this.readT.get(key);
    if (t === undefined) {
      const ss = this.sliceStart(d, h);
      const off = this.o.writers[w]?.readOffset?.(d, h);
      t = off !== undefined ? ss + off : ss + Math.floor(this.c.slice / 20) + Math.floor(this.rng() * (Math.floor(this.c.slice / 2) - Math.floor(this.c.slice / 20)));
      this.readT.set(key, t);
    }
    return t;
  }

  private writerTick(wi: number, now: number): void {
    const spec = this.o.writers[wi]!;
    const addr = W_ADDR[wi]!;
    const asleep = this.o.asleep?.(now) ?? false;
    const d = this.dayOf(now);
    const h = Math.min(this.c.slices - 1, Math.floor((now - this.dayStart(d)) / this.c.slice));
    const key = `${wi}:${d}:${h}`;
    if (!this.posted.has(key) && now >= this.readTime(wi, d, h)) {
      this.posted.add(key);
      const t = this.readTime(wi, d, h);
      if (!asleep && !(spec.skip?.(d, h) ?? false) && now - t < this.c.slice) {
        const honest = Array.from({ length: this.n }, (_, i) => {
          const s = this.o.pages(i, t, spec.net);
          return s.s === "V" ? s.v : 0;
        });
        const values = spec.values ? spec.values(d, h, t, honest) : honest;
        this.held.push({ w: wi, d, h, t, values });
      }
    }
    // send held entries (immediately, or after an RPC outage while still inside the F1 window)
    for (let j = 0; j < this.held.length; j++) {
      const e = this.held[j]!;
      if (e.w !== wi) continue;
      const deadline = this.dayEnd(e.d) + this.c.closeGrace - Math.max(1, Math.floor(this.c.slice / 12));
      if (now > deadline) {
        this.held.splice(j--, 1);
        continue;
      }
      if (asleep || spec.rpcDown?.(now)) continue;
      try {
        this.m.postReport(addr, [{ gpuId: GPU_ID, day: e.d, slice: e.h, readAt: e.t, values: e.values }], now);
      } catch (err) {
        if (!(err instanceof Revert)) throw err;
      }
      this.held.splice(j--, 1);
    }
    if (asleep || spec.rpcDown?.(now) || spec.close === "never") return;
    const g = this.m.g(GPU_ID);
    const hd = g.head;
    const closable = this.dayEnd(hd) + this.c.closeGrace;
    if (now < closable) return;
    const first = this.m.firstWriter(g, hd);
    const mine = first !== null && first.toLowerCase() === addr.toLowerCase();
    if (spec.close === "earliest" || mine || now >= this.dayEnd(hd) + this.c.tPend) {
      try {
        this.m.closeDay(GPU_ID, addr, now);
      } catch (err) {
        if (!(err instanceof Revert)) throw err;
      }
    }
  }

  // ------------------------------------------------------------------ the scripted guardian (6.6)

  private async guardianTick(now: number): Promise<void> {
    const gs = this.o.guardian;
    if (!gs || now < (gs.from ?? -Infinity)) return;
    const g = this.m.g(GPU_ID);
    const d = g.head - 1;
    const r = g.records.get(d);
    if (!r || r.carried || this.m.isFinal(r, now) || r.attestedAt !== 0) return;
    const open = this.alerts
      .open()
      .filter((a) => a.day === d && a.severity === "action" && [AlertCode.R1_NO_CANDIDATE, AlertCode.R9_UNCHANGED_NOT_STRICT, AlertCode.R5_HEAD_LAG, AlertCode.R3_VETO_REASON, AlertCode.RPC_DOWN].includes(a.code as never));
    const dropped = this.alerts.open().some((a) => a.code === AlertCode.FREEZE_LOOP);
    // the attester down (HEARTBEAT_LOST from health) counts as an alert on every pending record it did not sign
    const lost = this.alerts.open().filter((a) => a.code === AlertCode.HEARTBEAT_LOST && (a.data as { role?: string })?.role === "attest");
    const times = [...open.map((a) => a.at), ...lost.map((a) => Math.max(a.at, r.postedAt))];
    if (times.length === 0 && !dropped) return;
    const raised = times.length > 0 ? Math.min(...times) : now;
    if (now < raised + gs.delay) return;
    const key = `${d}:${r.digest}`;
    const lastAct = this.guardianSeen.get(key) ?? -Infinity;
    if (now - lastAct < this.c.slice / 4) return;
    this.guardianSeen.set(key, now);
    const built = async () => {
      const b = await buildScenario({ view: this.chain, events: new EventIndex(this.chain), log: this.log, guardian: this.glog, alerts: this.alerts, clock: this.c, panel: this.panel }, now, d);
      return b ? evaluate(b.scenario) : null;
    };
    let ev = await built();
    if (!ev) return;
    // looks from the writer's region for every slot R12 asks for (A4, A7)
    if (gs.looks) {
      const need = new Set(ev.guardian.looksNeeded);
      let took = false;
      for (const i of need) {
        const recent = this.glog.lookRows.some((l) => l.sourceId === `s${i}` && l.at >= now - this.c.slice);
        if (recent) continue;
        const s = this.o.pages(i, now, gs.lookNet ?? "look");
        this.glog.lookRows.push({
          gpu: GPU, gpuId: GPU_ID, sourceId: `s${i}`, interval: Math.floor((now - this.c.epochTs) / this.c.slice), at: now,
          state: s.s === "V" ? "VALID" : s.s === "NR" ? "NOT_RENTABLE" : s.s === "DARK" ? "NO_ROW" : "FAILED", valueU: s.s === "V" ? s.v : 0, region: "writer", writerRegion: true,
        });
        took = true;
      }
      if (took) ev = (await built())!;
    }
    const sender = this.chain.sender(GUARDIAN);
    const sign = async (c: { writer: Address; digest: Hex; value: number }, rule: "R11" | "R12") => {
      if (c.writer.toLowerCase() === r.source.toLowerCase() && !r.needsSign) {
        this.guardianActs.push({ at: now, day: d, act: `${rule} lets it stand`, writer: c.writer });
        return true;
      }
      const res = await sender.send("attest", [GPU_ID, d, c.writer, c.digest]);
      this.guardianActs.push({ at: now, day: d, act: `${rule} ${res.ok ? "signed" : "failed"}`, writer: c.writer, ...(res.error ? { why: res.error } : {}) });
      if (res.ok) this.glog.sigRows.push({ gpuId: GPU_ID, day: d, writer: c.writer, digest: c.digest, rule, at: now });
      return res.ok;
    };
    const pv = ev.candidates.find((v) => v.isPending)!;
    this.glog.r8Rows.push({ gpuId: GPU_ID, day: d, at: now, writer: r.source, fixOutside: pv.veto.fixOutside && !pv.veto.r7.fix, otherGood: ev.candidates.some((v) => !v.isPending && (v.strict.ok || v.fixOk.ok)), confirmedSlots: pv.veto.confirmed, replaced: false });
    if (gs.r8 !== false) {
      // the scripted guardian suspends only on a reason its looks have confirmed (R3, R8: from the writer's region)
      for (const x of ev.guardian.r8.filter((y) => !y.reason.includes("look from the writer's region first"))) {
        const res = await sender.send("suspend", [x.writer]);
        this.guardianActs.push({ at: now, day: d, act: `suspend ${res.ok ? "done" : "failed"}`, writer: x.writer, why: x.reason });
      }
    }
    // a record final by itself with an R3 reason: veto before its finalAt (R3, R9 (a))
    const selfFinal = !r.needsSign;
    if (ev.guardian.r11 && (await sign(ev.guardian.r11, "R11"))) return;
    if (ev.guardian.r12Ready && ev.guardian.r12 && (await sign(ev.guardian.r12, "R12"))) return;
    const r12Time = dropped || now >= raised + this.c.guardAct;
    if (ev.guardian.veto && (selfFinal || r12Time)) {
      const res = await sender.send("veto", [GPU_ID, d, ev.guardian.veto.writer, ev.guardian.veto.digest]);
      this.guardianActs.push({ at: now, day: d, act: `veto ${res.ok ? "done" : "failed"}`, writer: ev.guardian.veto.writer, why: ev.guardian.veto.reasons.join("; ") });
      return;
    }
    if (r12Time) this.guardianActs.push({ at: now, day: d, act: "nothing qualifies", why: ev.guardian.r12Why.join("; ") });
  }

  private attDownSince: number | null = null;
  /** What `watcher health` does for the attester's heartbeat (9.5): HEARTBEAT_LOST after three tick periods. */
  private healthTick(now: number, attDown: boolean): void {
    if (!attDown) {
      if (this.attDownSince !== null) this.alerts.clearWhere((a) => a.code === AlertCode.HEARTBEAT_LOST && a.slot === 1);
      this.attDownSince = null;
      return;
    }
    this.attDownSince ??= now;
    if (now - this.attDownSince > 3 * this.c.slice && !(this.o.asleep?.(now) ?? false))
      this.alerts.raise({ code: AlertCode.HEARTBEAT_LOST, severity: "action", slot: 1, message: "attest: heartbeat lost", data: { role: "attest" } });
  }

  // ------------------------------------------------------------------ the loop

  async run(t1: number): Promise<void> {
    const step = this.o.step ?? Math.max(1, Math.floor(this.c.slice / 20));
    while (this.now < t1) {
      const now = this.now;
      const asleep = this.o.asleep?.(now) ?? false;
      this.chain.down = this.o.chainDown?.(now) ?? false;
      for (let w = 0; w < this.o.writers.length; w++) this.writerTick(w, now);
      if (!asleep) this.watcherTick(now);
      else this.watcherTick(now); // MISSED lines are written for the slept intervals on wake (here: as they end)
      const attDown = this.attester === null || (typeof this.o.attester === "object" && this.o.attester.down?.(now) === true) || asleep;
      this.healthTick(now, attDown);
      if (!attDown && typeof this.o.attester === "object" && this.o.attester.careless) this.carelessTick(now);
      else if (!attDown) await this.attester!.tick(now);
      if (!asleep && this.keeper) await this.keeper.tick(now);
      if (!asleep && !this.chain.down) await this.guardianTick(now);
      this.chain.down = false;
      this.now += step;
    }
  }

  /** I28's negative control: an attester that countersigns every needsSign record at once and never selects. */
  private carelessTick(now: number): void {
    const g = this.m.g(GPU_ID);
    const r = g.records.get(g.head - 1);
    if (!r || r.carried || r.attestedAt !== 0 || !r.needsSign) return;
    try {
      this.m.attest(GPU_ID, g.head - 1, r.source, r.digest, ATTESTER, now);
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
    }
  }

  /** I28 / I28u against the honest writer: every final computed record whose source is `thief`, compared with the
   *  honest writer's record recomputed from its own readings and the same pre-state. exact: same value; shade: the
   *  thief's record was STRICT at the attester's last look (residual 11); residual: no better-tier honest record
   *  existed (6.8 items 1 to 4, 12, 15); violation: the honest record was complete and of a higher tier, or a changed
   *  thief record was signed while not STRICT or FIX-OK. */
  i28(thief: number): { exact: number; shade: number; residual: number; violation: number; days: string[] } {
    const out = { exact: 0, shade: 0, residual: 0, violation: 0, days: [] as string[] };
    const g = this.m.g(GPU_ID);
    const thiefAddr = W_ADDR[thief]!.toLowerCase();
    const honestAddr = W_ADDR[1 - thief]!;
    for (const [d, r] of g.records) {
      if (r.carried || !this.m.isFinal(r, this.now) || r.source.toLowerCase() !== thiefAddr) continue;
      const a = this.m.accOf(g, d, honestAddr);
      if (!a || this.o.writers.length < 2) continue;
      const h = this.m.compute(g, d, honestAddr, r.pre, r.postedAt);
      if (!h.quorate) continue;
      if (h.value === r.value) {
        out.exact++;
        continue;
      }
      const ev = [...this.evaluations].reverse().find((e) => e.ev.day === d)?.ev;
      const tv = ev?.candidates.find((c) => c.source.toLowerCase() === thiefAddr);
      const hv = ev?.candidates.find((c) => c.source.toLowerCase() === honestAddr.toLowerCase());
      if (!ev || !tv) {
        out.violation++;
        out.days.push(`${d}: ${r.value} vs honest ${h.value} (no evaluation)`);
      } else if (r.needsSign && r.attestedBy.toLowerCase() === ATTESTER.toLowerCase() && tv.tier < 2) {
        out.violation++;
        out.days.push(`${d}: signed tier ${tv.tier}`);
      } else if (hv && hv.complete && hv.tier > tv.tier) {
        out.violation++;
        out.days.push(`${d}: ${r.value} final over a tier ${hv.tier} honest record (${h.value})`);
      } else if (tv.tier === 3) out.shade++;
      else out.residual++;
    }
    return out;
  }

  // ------------------------------------------------------------------ results

  days(from: number, to: number): DayResult[] {
    const g = this.m.g(GPU_ID);
    const out: DayResult[] = [];
    for (let d = from; d <= to; d++) {
      const r = g.records.get(d);
      const final = this.m.isFinal(r, this.now);
      out.push({
        day: d,
        value: r?.value ?? 0,
        final,
        carried: r?.carried ?? false,
        dropped: r?.dropped ?? false,
        source: r?.source ?? "0x0000000000000000000000000000000000000000",
        attestedBy: r?.attestedBy ?? "0x0000000000000000000000000000000000000000",
        finalAt: final ? r!.finalAt : 0,
        lag: (final ? r!.finalAt : this.now) - this.dayEnd(d),
      });
    }
    return out;
  }

  drops(): number[] {
    return this.m.events.filter((e) => e.name === "FixDropped").map((e) => e.day);
  }
  vetoes(): number {
    return this.m.events.filter((e) => e.name === "Vetoed").length;
  }
  selects(): number {
    return this.m.events.filter((e) => e.name === "RecordReplaced").length;
  }
  suspensions(): number {
    return this.m.events.filter((e) => e.name === "WriterSuspended").length;
  }
  raised(code: string, day?: number): boolean {
    return this.alerts.all().some((a) => a.code === code && (day === undefined || a.day === day));
  }

  /** L1b: before every drop an R1_NO_CANDIDATE was raised for that day, and every drop raised FREEZE_LOOP. */
  l1b(): { ok: boolean; why: string[] } {
    const why: string[] = [];
    for (const e of this.m.events.filter((x) => x.name === "FixDropped")) {
      const pre = this.alerts.all().some((a) => a.code === AlertCode.R1_NO_CANDIDATE && a.day === e.day && a.at <= e.at);
      if (!pre) why.push(`drop of ${e.day} without a prior R1_NO_CANDIDATE`);
      const fl = this.alerts.all().some((a) => a.code === AlertCode.FREEZE_LOOP && a.day === e.day);
      if (!fl) why.push(`drop of ${e.day} without FREEZE_LOOP`);
    }
    return { ok: why.length === 0, why };
  }

  status(d: number): string {
    const r = this.m.g(GPU_ID).records.get(d);
    if (!r) return "none";
    return `${r.value} ${r.carried ? (r.dropped ? "CARRIED(dropped)" : "CARRIED") : r.changed ? "changed" : "unchanged"} ${this.m.isFinal(r, this.now) ? "final" : "pending"} src ${r.source.slice(0, 6)} by ${r.attestedBy.slice(0, 6)} ${r.status === Status.CARRIED ? "" : ""}`;
  }
}
