// Builds rule R's JSON scenario for one GPU and one day from the chain (views and events), the watcher's log, the
// guardian's log and the open alerts, and checks the chain against the offchain formula (9.2).
import type { Address, GpuModel, Hex, IndexRecord, SlotState } from "@agate/report/types";
import { AlertCode, Status } from "@agate/report/types";
import type { AlertSink } from "./alerts.ts";
import type { EventSource, IndexView, WallEvent } from "./chain/types.ts";
import { fullBits, kOf, type WallClock } from "./clock.ts";
import { initialState, sameState } from "./formula.ts";
import type { GuardianLogView } from "./guardian-log.ts";
import type { LogSource } from "./log/store.ts";
import type { CandidateRecord, HistoryDay, Look, PendingRecord, RuleScenario, WriterDay } from "./rule/types.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a: string) => a.toLowerCase();

export interface PanelRef {
  gpu: GpuModel;
  gpuId: Hex;
  sources: string[]; // slot -> sourceId
}

/** Events indexed by (name, gpu, day), built incrementally from an EventSource. */
export class EventIndex {
  private n = 0;
  private readonly by = new Map<string, WallEvent[]>();
  constructor(readonly src: EventSource) {}
  private update() {
    const all = this.src.all();
    for (; this.n < all.length; this.n++) {
      const e = all[this.n]!;
      for (const k of [`${e.name}:${lc(e.gpuId ?? "")}:${e.day}`, `${e.name}:${lc(e.gpuId ?? "")}`, e.name]) {
        let a = this.by.get(k);
        if (!a) this.by.set(k, (a = []));
        a.push(e);
      }
    }
  }
  of<N extends WallEvent["name"]>(name: N, gpuId?: Hex, day?: number): Extract<WallEvent, { name: N }>[] {
    this.update();
    const k = gpuId === undefined ? name : day === undefined ? `${name}:${lc(gpuId)}` : `${name}:${lc(gpuId)}:${day}`;
    return (this.by.get(k) ?? []) as Extract<WallEvent, { name: N }>[];
  }
  count(): number {
    this.update();
    return this.n;
  }
}

export interface BuildDeps {
  view: IndexView;
  events: EventIndex;
  log: LogSource;
  guardian?: GuardianLogView;
  alerts?: AlertSink;
  clock: WallClock;
  panel: PanelRef;
  /** Final records never change: their history rows are cached here across calls. */
  cache?: Map<string, HistoryDay>;
  historyDays?: number;
}

export interface Built {
  scenario: RuleScenario;
  pending: IndexRecord | null;
  head: number;
  /** 9.2: differences between the chain and the offchain recomputation; the attester refuses when non-empty. */
  inconsistent: string[];
}

async function writerDay(x: BuildDeps, d: number, w: Address, n: number): Promise<WriterDay> {
  const g = x.panel.gpuId;
  const r = await x.view.readings(g, d, w);
  const suspended = await x.view.isSuspended(w);
  const voided = await x.view.isVoided(g, d, w);
  const slotSlices: number[] = Array(n).fill(0);
  for (const e of x.events.of("ReadingsPosted", g, d)) {
    if (lc(e.writer) !== lc(w)) continue;
    for (let i = 0; i < n; i++) if (Math.floor(e.validMask / 2 ** i) % 2 === 1) slotSlices[i] += 2 ** e.slice;
  }
  return {
    address: w,
    slot: -1,
    eligible: !suspended && !voided && r.sliceBits !== 0n,
    sums: r.sums.map(Number),
    counts: r.counts.map(Number),
    sliceBits: Number(r.sliceBits),
    slotSlices,
  };
}

async function writersOfDay(x: BuildDeps, d: number, n: number): Promise<WriterDay[]> {
  const ws = await x.view.writers();
  const out: WriterDay[] = [];
  for (let s = 0; s < ws.length; s++) {
    if (lc(ws[s]!) === ZERO) continue;
    const wd = await writerDay(x, d, ws[s]!, n);
    wd.slot = s;
    out.push(wd);
  }
  return out;
}

function slotsEvent(x: BuildDeps, d: number, digest: Hex) {
  const evs = x.events.of("RecordSlots", x.panel.gpuId, d).filter((e) => lc(e.digest) === lc(digest));
  return evs[evs.length - 1] ?? null;
}

async function historyDay(x: BuildDeps, j: number, n: number): Promise<HistoryDay | null> {
  const key = `${lc(x.panel.gpuId)}:${j}`;
  const hit = x.cache?.get(key);
  if (hit) {
    if (!hit.carried && x.guardian) hit.handSigned = x.guardian.handSigned(x.panel.gpuId, j, hit.digest as Hex);
    if (x.guardian) hit.r8 = x.guardian.r8(x.panel.gpuId, j);
    return hit;
  }
  const r = await x.view.record(x.panel.gpuId, j);
  if (!r.exists || !r.isFinal) return null;
  let h: HistoryDay;
  if (r.rec.status === Status.CARRIED) {
    const ev = x.events.of("DayCarried", x.panel.gpuId, j);
    const last = ev[ev.length - 1];
    h = { day: j, carried: true, dropped: r.rec.dropped, value: r.rec.value };
    if (last) h.missAdvanced = last.missAdvanced;
    h.writers = await writersOfDay(x, j, n);
  } else {
    const ev = slotsEvent(x, j, r.rec.digest);
    if (!ev) return null; // events not indexed that far yet
    h = {
      day: j,
      carried: false,
      source: r.rec.source,
      value: r.rec.value,
      p: ev.p.map(Number),
      kinds: ev.kinds,
      counts: ev.counts.map(Number),
      post: ev.post.map((s) => ({ e: Number(s.e), miss: Number(s.miss), inMedian: s.inMedian, wasIn: s.wasIn })),
      writers: await writersOfDay(x, j, n),
      digest: r.rec.digest,
    };
  }
  x.cache?.set(key, h);
  if (!h.carried && x.guardian) h.handSigned = x.guardian.handSigned(x.panel.gpuId, j, h.digest!);
  if (x.guardian) h.r8 = x.guardian.r8(x.panel.gpuId, j);
  return h;
}

/** The post-state after day j's final record, rebuilt from events: RecordSlots for a computed record, the previous
 *  post plus DayCarried.missAdvanced for each carried one, the initial state before the first record (a carry always
 *  follows a record, so a day without a record lies before the first one). */
export function postAfter(hist: Map<number, HistoryDay>, j: number, firstDay: number, n: number): SlotState[] {
  const carries: HistoryDay[] = [];
  let k = j;
  let h = hist.get(k);
  while (k >= firstDay && h && h.carried) {
    carries.push(h);
    k--;
    h = hist.get(k);
  }
  let st: SlotState[] = h && !h.carried && k >= firstDay ? h.post!.map((s) => ({ ...s })) : initialState(n);
  for (const c of carries.reverse()) {
    st = st.map((s, i) => (Math.floor((c.missAdvanced ?? 0) / 2 ** i) % 2 === 1 ? { ...s, miss: s.miss + 1 } : s));
  }
  return st;
}

export async function buildScenario(x: BuildDeps, now: number, day?: number): Promise<Built | null> {
  const g = x.panel.gpuId;
  const cfg = await x.view.gpu(g);
  const n = Number(cfg.nSlots);
  if (n === 0) return null;
  if (n !== x.panel.sources.length) throw new Error(`panel ${x.panel.gpu} has ${x.panel.sources.length} slots, the index ${n}`);
  const head = Number(cfg.head);
  const c = x.clock;
  const firstDay = Number(cfg.firstDay);
  const inconsistent: string[] = [];

  let d = day ?? head - 1;
  const r = d >= firstDay ? await x.view.record(g, d) : { exists: false, isFinal: false, rec: null as unknown as IndexRecord };
  const isPending = r.exists && !r.isFinal && r.rec.status !== Status.CARRIED && d === head - 1;
  if (day === undefined && !isPending) d = head; // nothing pending: preview the head day
  if (d < firstDay) return null;

  const family: number[] = [];
  const famQ: number[] = [];
  const liveFrom: number[] = [];
  const liveUntil: number[] = [];
  for (let i = 0; i < n; i++) {
    const w = await x.view.slotWindow(g, i);
    const f = await x.view.familyOf(g, i);
    liveFrom.push(Number(w.liveFrom));
    liveUntil.push(Number(w.liveUntil));
    family.push(Number(f.family));
    famQ[Number(f.family)] = Number(f.famQ);
  }

  const hist = new Map<number, HistoryDay>();
  const back = Math.max(firstDay, d - (x.historyDays ?? 400));
  for (let j = d - 1; j >= back; j--) {
    const h = await historyDay(x, j, n);
    if (!h) {
      const rr = await x.view.record(g, j);
      if (rr.exists) inconsistent.push(`history day ${j}: final record without its RecordSlots event (events lag)`);
      break; // no record before the index started
    }
    hist.set(j, h);
  }

  const states = await x.view.slotStates(g);
  let pre: SlotState[];
  if (isPending) pre = states.base;
  else if (d === head) pre = states.last;
  else pre = postAfter(hist, d - 1, firstDay, n);
  const rebuilt = postAfter(hist, d - 1, firstDay, n);
  if ((isPending || d === head) && !sameState(rebuilt, pre)) inconsistent.push(`slotStates of day ${d} differ from the post-state rebuilt from events`);

  const writers = await writersOfDay(x, d, n);
  const full = fullBits(c);
  let pending: PendingRecord | null = null;
  if (isPending) {
    const ev = slotsEvent(x, d, r.rec.digest);
    const pv = await x.view.previewRecord(g, d, r.rec.source);
    const src = ev ?? (pv.ok ? { p: pv.detail.p, kinds: pv.detail.kinds, counts: pv.detail.counts, post: pv.detail.post } : null);
    if (!src) {
      inconsistent.push(`pending record of ${d}: no RecordSlots event and previewRecord not ok`);
      return null;
    }
    if (pv.ok && lc(pv.detail.rec.digest) !== lc(r.rec.digest)) inconsistent.push(`previewRecord(${d}, source) digest differs from the pending record`);
    const w = writers.find((x2) => lc(x2.address) === lc(r.rec.source));
    pending = {
      source: r.rec.source,
      digest: r.rec.digest,
      value: Number(r.rec.value),
      p: src.p.map(Number),
      kinds: [...src.kinds],
      counts: src.counts.map(Number),
      post: src.post.map((s) => ({ e: Number(s.e), miss: Number(s.miss), inMedian: s.inMedian, wasIn: s.wasIn })),
      complete: w ? w.sliceBits === full : !r.rec.incomplete,
      changed: r.rec.changed,
      needsSign: r.rec.needsSign,
      postedAt: Number(r.rec.postedAt),
      finalAt: Number(r.rec.finalAt),
      attestedAt: Number(r.rec.attestedAt),
    };
    if (!sameState(pending.post, states.last)) inconsistent.push(`slotStates.last differs from the pending record's post-state`);
  }
  const candidates: CandidateRecord[] = [];
  if (isPending || d === head) {
    for (const w of writers) {
      if (pending && lc(w.address) === lc(pending.source)) continue;
      const pv = await x.view.previewRecord(g, d, w.address);
      if (!pv.ok) continue;
      candidates.push({
        source: w.address,
        digest: pv.detail.rec.digest,
        value: Number(pv.detail.rec.value),
        p: pv.detail.p.map(Number),
        kinds: [...pv.detail.kinds],
        counts: pv.detail.counts.map(Number),
        post: pv.detail.post.map((s) => ({ e: Number(s.e), miss: Number(s.miss), inMedian: s.inMedian, wasIn: s.wasIn })),
        complete: w.sliceBits === full,
        changed: pv.detail.rec.changed,
        needsSign: pv.detail.rec.needsSign,
        quorate: true,
      });
    }
  }

  const minDay = Math.min(d, ...hist.keys());
  const from = kOf(c, minDay, 0) - c.slices;
  const to = Number.MAX_SAFE_INTEGER;
  const log = x.panel.sources.map((s) => x.log.slotLog(s, x.panel.gpu, from, to));
  const looks: Look[] = [];
  if (x.guardian) {
    for (const l of x.guardian.looks(g)) {
      const slot = x.panel.sources.indexOf(l.sourceId);
      if (slot < 0) continue;
      looks.push({ slot, interval: l.interval, at: l.at, cell: l.state === "VALID" ? l.valueU : l.state === "MISSED" ? "MISSED" : l.state, region: l.region, writerRegion: l.writerRegion });
    }
  }
  const frd = await x.view.firstRecordDay(g);
  const blocked = (x.guardian?.flags?.(g) ?? []).map((f) => ({ slot: x.panel.sources.indexOf(f.sourceId), from: f.from, to: f.to })).filter((f) => f.slot >= 0);

  const scenario: RuleScenario = {
    version: 1,
    clock: { day: c.day, slices: c.slices, minReadings: c.minReadings, qMin: c.qMin, signAll: c.signAll, epochTs: c.epochTs, epochDay: c.epochDay, tPend: c.tPend, grace: c.grace },
    gpu: { gpuId: g, nSlots: n, family, famQ, liveFrom, liveUntil, firstDay },
    day: d,
    now,
    firstRecordDay: frd.exists ? Number(frd.day) : null,
    pre: pre.map((s) => ({ e: Number(s.e), miss: Number(s.miss), inMedian: s.inMedian, wasIn: s.wasIn })),
    log,
    looks,
    writers,
    pending,
    candidates,
    history: [...hist.values()],
    guardAct: c.guardAct,
    ...(blocked.length > 0 ? { blockedForWatcher: blocked } : {}),
  };
  if (x.alerts) {
    const open = x.alerts.all().filter((a) => a.gpuId && lc(a.gpuId) === lc(g) && a.day === d && a.severity === "action" && (a.code === AlertCode.R1_NO_CANDIDATE || a.code === AlertCode.R9_UNCHANGED_NOT_STRICT || a.code === AlertCode.R5_HEAD_LAG || a.code === AlertCode.RPC_DOWN));
    const times = open.map((a) => a.at);
    // the attester down: every pending record it did not sign is the guardian's from max(lost, postedAt) (6.6)
    if (pending) for (const a of x.alerts.open()) if (a.code === AlertCode.HEARTBEAT_LOST && (a.data as { role?: string } | undefined)?.role === "attest") times.push(Math.max(a.at, pending.postedAt));
    if (times.length > 0) scenario.alertRaisedAt = Math.min(...times);
    scenario.watcherDown = x.alerts.open().some((a) => a.code === AlertCode.WATCHER_GAP || (a.code === AlertCode.HEARTBEAT_LOST && (a.data as { role?: string } | undefined)?.role === "log"));
  }
  let lastComputed = -1;
  for (const h of hist.values()) if (!h.carried) lastComputed = Math.max(lastComputed, h.day);
  scenario.droppedSinceLastComputed = x.events.of("FixDropped", g).some((e) => e.day > lastComputed);
  return { scenario, pending: isPending ? r.rec : null, head, inconsistent };
}
