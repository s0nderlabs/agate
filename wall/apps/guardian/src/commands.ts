// The guardian CLI's commands (BUILD-SPEC 10), written against injected dependencies so tests can drive them on the
// fake index. The CLI shows the rule and the person decides: it never vetoes or signs on its own, and every send
// re-checks the chain and asks the operator to confirm.
import type { Address, GpuModel, Hex } from "@agate/report/types";
import { Kind, Status } from "@agate/report/types";
import { existsSync } from "node:fs";
import { readStatus } from "../../pagecheck/src/index.ts";
import {
  ACTION_KIND_NAME,
  actionFieldsText,
  printable,
  type AlertSink,
  buildScenario,
  dayLabel,
  entryWhen,
  ownerEntries,
  type ReaderBook,
  readerUrlFromEvents,
  type CandidateRecord,
  computeRecord,
  dayEnd,
  dayIdAt,
  type Evaluation,
  evaluate,
  EventIndex,
  type EventSource,
  type GuardianLog,
  type IndexView,
  intervalAt,
  type LogSource,
  type PanelRef,
  type Range,
  type RuleScenario,
  type Sender,
  type WallClock,
  readBeat,
  type RoleBeat,
} from "@agate/watcher";

export interface LookReader {
  /** Fetch every page of the panel now from this machine and parse it: per source, per GPU, a state and value.
   *  readers (8.6): a source's reader in force when a swap applies today (url and parserVersion). */
  (sourceIds: string[], readers?: Record<string, { url: string; parserVersion: string }>): Promise<Record<string, Partial<Record<GpuModel, { state: string; valueU: number; why?: string }>>>>;
}

export interface CliDeps {
  view: IndexView;
  events: EventSource;
  log: LogSource & { refresh?: () => void };
  glog: GuardianLog;
  alerts: AlertSink;
  clock: WallClock;
  panels: PanelRef[];
  now: () => number;
  out: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  /** A sender for the key in that variable, built at the moment of sending (the key is read there and dropped). */
  senderFor: (keyEnv: "AGATE_GUARDIAN_KEY" | "AGATE_KICK_KEY") => Sender;
  look?: LookReader;
  beats?: RoleBeat[];
  writerRegion?: string; // the label that marks a look as taken from the writer's region (default "writer")
  /** 15.1: the page check's status file of this index (<home>/pagecheck/<index 8 hex>/status.json) */
  pagecheckStatus?: string;
  /** keycheck: a transaction's sender and block (read only) */
  tx?: (hash: Hex) => Promise<{ from: Address; blockNumber: bigint | null } | null>;
  /** 8.6: readers in force, so rule R reads each swapped slot from its own reader's log line */
  readers?: ReaderBook;
}

const $ = (u: number) => (u / 1e6).toFixed(2);
const KIND = ["OUT", "FRESH", "HELD"];
const rng = (r: Range | undefined) => (!r ? "-" : r.t === "int" ? `${$(r.lo)}..${$(r.hi)}${r.open ? " (open)" : ""}` : r.t);
const lc = (a: string) => a.toLowerCase();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function panelOf(d: CliDeps, gpu: string | undefined): PanelRef {
  const p = gpu ? d.panels.find((x) => x.gpu === gpu.toUpperCase() || lc(x.gpuId) === lc(gpu)) : d.panels[0];
  if (!p) throw new Error(`unknown GPU ${gpu}; panels: ${d.panels.map((x) => x.gpu).join(", ")}`);
  return p;
}

async function scenarioFor(d: CliDeps, p: PanelRef, day?: number) {
  await d.events.sync();
  d.log.refresh?.();
  const idx = new EventIndex(d.events);
  const readerUrl = d.readers ? readerUrlFromEvents(d.readers, p, idx.of("ReaderSwapped", p.gpuId)) : null;
  const b = await buildScenario({ view: d.view, events: idx, log: d.log, guardian: d.glog, alerts: d.alerts, clock: d.clock, panel: p, ...(readerUrl ? { readerUrl } : {}) }, d.now(), day);
  if (!b) throw new Error(`${p.gpu}: nothing to evaluate`);
  return b;
}

/** A final day's records recomputed from readings() and the pre-state rebuilt from events (F8). */
export function recomputeAll(sc: RuleScenario): CandidateRecord[] {
  const out: CandidateRecord[] = [];
  for (const w of sc.writers) {
    if (w.sliceBits === 0) continue;
    const r = computeRecord({
      params: { slices: sc.clock.slices, minReadings: sc.clock.minReadings, qMin: sc.clock.qMin, signAll: sc.clock.signAll, tPend: sc.clock.tPend },
      gpu: sc.gpu,
      gpuId: sc.gpu.gpuId,
      day: sc.day,
      writer: w.address,
      postedAt: 0,
      pre: sc.pre,
      acc: { sums: w.sums, counts: w.counts, sliceBits: w.sliceBits, late: false, anyValid: true },
      prev: null,
      firstRecordDay: sc.firstRecordDay,
      firstWriter: null,
    });
    out.push({ source: w.address, digest: r.digest, value: r.value, p: r.p, kinds: r.kinds, counts: r.counts, post: r.post, complete: !r.incomplete, changed: r.changed, needsSign: r.needsSign, quorate: r.quorate });
  }
  return out;
}

function printEvaluation(d: CliDeps, ev: Evaluation, detail: boolean): void {
  d.out(`  W(d) ${$(ev.W)}   R1 action: ${ev.action.kind}${ev.action.writer ? ` ${ev.action.writer}` : ""} (${ev.action.why})`);
  d.out("  slot class      blind exp        complete        partial              remembered (anchor, vouched)   walked");
  for (const s of ev.slots) {
    if (!s.readable) {
      d.out(`  ${String(s.slot).padEnd(4)} not readable`);
      continue;
    }
    d.out(
      `  ${String(s.slot).padEnd(4)} ${String(s.cls).padEnd(9)} ${s.blind ? "yes" : "no "}   ${(KIND[s.exp!] + (s.expAlt !== undefined ? `/${KIND[s.expAlt]}` : "")).padEnd(10)} ${rng(s.complete).padEnd(15)} ${rng(s.partial).padEnd(20)} ${rng(s.remembered)} (${s.anchor ?? "-"}, ${s.vouched ?? "-"})  ${s.walked ?? "-"}`,
    );
  }
  for (const c of ev.candidates) {
    d.out(`  candidate ${c.source}${c.isPending ? " (pending)" : ""}: value ${$(c.value)} tier ${c.tier} dist ${$(c.dist)} complete ${c.complete} changed ${c.changed} needsSign ${c.needsSign}`);
    d.out(`    STRICT ${c.strict.ok} ${c.strict.why.slice(0, 3).join("; ")}`);
    d.out(`    FIX-OK ${c.fixOk.ok} ${c.fixOk.why.slice(0, 3).join("; ")}`);
    d.out(`    NEAR   ${c.near.ok} ${c.near.why.slice(0, 2).join("; ")}   R1b gate ${c.gate.ok}${c.gate.why ? ` (${c.gate.why})` : ""}`);
    d.out(`    R11 strict hand range ${c.r11.ok} ${c.r11.fixRange ? `${$(c.r11.fixRange[0])}..${$(c.r11.fixRange[1])}` : "-"} ${c.r11.why.slice(0, 2).join("; ")}`);
    d.out(`    R12 relaxed hand range ${c.r12.ok} ${c.r12.fixRange ? `${$(c.r12.fixRange[0])}..${$(c.r12.fixRange[1])}` : "-"} ${c.r12.why.slice(0, 2).join("; ")}`);
    const v = c.veto;
    d.out(`    VETO fix range ${v.fixRange === "inconclusive" ? "inconclusive (an any-value fresh slot)" : `${$(v.fixRange[0])}..${$(v.fixRange[1])}`}; fix outside ${v.fixOutside}; slot reasons [${v.slotReasons}] dark reasons [${v.darkReasons}] confirmed by look [${v.confirmed}]; R7 fix ${v.r7.fix} slot ${v.r7.slot} dark ${v.r7.dark}`);
    if (detail) {
      for (const s of c.strict.slots) if (s.cls !== null) d.out(`      slot ${s.slot}: kind ${KIND[s.kind]} counts ${s.counts} p ${$(s.p)} ${s.result} ${s.from ?? ""} ${rng(s.range)}`);
      for (const r of v.slotRanges) d.out(`      VETO range slot ${r.slot}: ${rng(r.range)}`);
      for (const x of v.darkCounts) d.out(`      dark count slot ${x.slot}: n_c ${x.nc}, dark ${x.dark}`);
    }
  }
  const g = ev.guardian;
  d.out(`  guardian: R11 ${g.r11 ? `${g.r11.writer} ${$(g.r11.value)}` : "none"}; R12 ${g.r12 ? `${g.r12.writer} ${$(g.r12.value)}` : "none"} (ready ${g.r12Ready}${g.r12Why.length ? `: ${g.r12Why.join("; ")}` : ""}); looks needed [${g.looksNeeded}]`);
  if (g.veto) d.out(`  R3: veto reasons on ${g.veto.writer}: ${g.veto.reasons.join(", ")} (digest ${g.veto.digest})`);
  for (const x of g.r8) d.out(`  R8: ${x.writer}: ${x.reason}`);
}

export async function status(d: CliDeps, args: string[]): Promise<void> {
  const c = d.clock;
  const now = d.now();
  // the queued entries, voided writers and reader history below come from the events: read them now, not as of the
  // attester's (or an earlier command's) last sync
  try {
    await d.events.sync();
  } catch (e) {
    d.out(`events not synced (${e instanceof Error ? e.message.split("\n")[0] : String(e)}): owner entries and reader history may be stale`);
  }
  const panels = flag(args, "--gpu") ? [panelOf(d, flag(args, "--gpu"))] : d.panels;
  for (const p of panels) {
    const head = await d.view.head(p.gpuId);
    const r = await d.view.record(p.gpuId, head - 1);
    const d0 = r.exists && !r.isFinal ? head - 1 : head;
    const lag = now - dayEnd(c, d0);
    d.out(`${p.gpu} ${p.gpuId}: head ${head}, today ${dayIdAt(c, now)}, oldest day without a final record ${d0}: ${lag} s after its end (LAG_MAX ${c.lagMax} s${lag > c.lagMax ? ", OVER" : ""})`);
    if (r.exists && !r.isFinal && r.rec.status !== Status.CARRIED) {
      const x = r.rec;
      d.out(`  pending ${head - 1}: source ${x.source} digest ${x.digest} value ${$(x.value)} changed ${x.changed} needsSign ${x.needsSign} postedAt ${x.postedAt} finalAt ${x.finalAt} attestedAt ${x.attestedAt}`);
      const b = await scenarioFor(d, p);
      if (b.inconsistent.length) d.out(`  INCONSISTENT: ${b.inconsistent.join("; ")}`);
      const ev = evaluate(b.scenario);
      printEvaluation(d, ev, false);
      const st = ev.guardian.stuck;
      if (st)
        d.out(`  step 3b: no R11 or R12 candidate: liveness veto due by ${st.due} (VETO_BY ${st.vetoBy} = graceStart + GRACE - REOPEN_WAIT, or the alert + GUARD_ACT if later; ${st.due >= now ? `in ${st.due - now} s` : `${now - st.due} s late`}). Meanwhile check the day's kept evidence (the logger's hourly page copies, the trackers, the looks) and sign by R11 or R12 where a look settles a slot; vetoed, the day is carried at the last value and labelled "carried, unverified" (6.6, 9.6)`);
    }
    const fixes: string[] = [];
    for (let j = head - 1; j >= head - 8 && fixes.length < 7; j--) {
      const x = await d.view.record(p.gpuId, j);
      if (x.exists && x.isFinal) fixes.push(`${j}: ${$(x.rec.value)} ${dayLabel(x.rec, x.isFinal, await d.view.reopenedAt(p.gpuId, j), head, j)}${x.rec.status === Status.CARRIED && x.rec.dropped ? " (dropped)" : ""}`);
    }
    d.out(`  last final fixes: ${fixes.join(" | ") || "none"}`);
  }
  const ws = await d.view.writers();
  for (const w of ws) if (!/^0x0{40}$/i.test(w)) d.out(`writer ${w}: suspended ${await d.view.isSuspended(w)} balance ${await d.view.balance(w)} wei`);
  const voided = d.events.all().filter((e) => e.name === "Vetoed");
  for (const e of voided.slice(-5)) if (e.name === "Vetoed") d.out(`voided: ${e.source} for day ${e.day} (veto by ${e.by})`);
  await ownerQueue(d, args.includes("--all"));
  readerHistory(d);
  pagecheck(d);
  for (const b of d.beats ?? []) {
    const hb = readBeat(b.path);
    d.out(`heartbeat ${b.role}: ${hb ? `${now - hb.at} s old (${hb.lastAction})` : "missing"}${hb && now - hb.at > 3 * b.periodS ? " LOST" : ""}`);
  }
  const notes = d.alerts.open().filter((a) => a.code === "REPAIR_NOTE");
  for (const a of notes) d.out(`repair note: ${a.message}`);
  await alerts(d, []);
}

const gpuName = (d: CliDeps) => (g: Hex) => d.panels.find((p) => lc(p.gpuId) === lc(g))?.gpu ?? g;

/** 10 (Oct 3): only entries the chain still holds (queuedEta(id) != 0), with kind and fields, eta, window end and
 *  "in N s" / "executable, window ends in N s"; executed and cancelled ones never; expired ones only with --all. */
export async function ownerQueue(d: CliDeps, all: boolean): Promise<void> {
  const now = d.now();
  const xs = await ownerEntries(d.events.all(), (id) => d.view.queuedEta(id), d.clock.day, now);
  const live = xs.filter((x) => x.state !== "expired");
  const name = gpuName(d);
  const line = (x: (typeof xs)[number]) => {
    if (x.type === "action") {
      const k = x.action!.kind!;
      return `${ACTION_KIND_NAME[k] ?? `kind ${k}`} ${actionFieldsText(x.action!, name)}: id ${x.id} eta ${x.eta}, ${entryWhen(x, now)}`;
    }
    const r = x.reader!;
    const p = d.panels.find((q) => lc(q.gpuId) === lc(r.gpuId));
    return `reader swap ${name(r.gpuId)} slot ${r.slot}${p?.sources[r.slot] ? ` (${p.sources[r.slot]})` : ""}: url ${printable(r.url)} parserVersion ${printable(r.parserVersion)} reason "${printable(r.reason)}": id ${x.id} eta ${x.eta}, ${entryWhen(x, now)}`;
  };
  d.out(`queued owner actions and reader swaps (live): ${live.length === 0 ? "none" : ""}`);
  for (const x of live) d.out(`  ${line(x)}`);
  if (all) {
    const dead = xs.filter((x) => x.state === "expired");
    d.out(`expired (queue again to use): ${dead.length === 0 ? "none" : ""}`);
    for (const x of dead) d.out(`  ${line(x)}`);
  }
}

/** 10 (Oct 3): every swapped slot's reader history (fromDay, url, parserVersion, reason), from ReaderSwapped. */
export function readerHistory(d: CliDeps): void {
  const by = new Map<string, string[]>();
  const name = gpuName(d);
  for (const e of d.events.all()) {
    if (e.name !== "ReaderSwapped") continue;
    const p = d.panels.find((q) => lc(q.gpuId) === lc(e.gpuId));
    const k = `${name(e.gpuId)} slot ${e.slot}${p?.sources[e.slot] ? ` (${p.sources[e.slot]})` : ""}`;
    by.set(k, [...(by.get(k) ?? []), `from day ${e.fromDay}: ${printable(e.url)} ${printable(e.parserVersion)} "${printable(e.reason)}"`]);
  }
  for (const [k, v] of by) d.out(`reader history ${k}: ${v.join(" | ")}`);
}

/** 15.1: the page check's status file (@agate/pagecheck's StatusFile): the pairs in a gap run (review or fault), one
 *  line each; a pair never compared yet ("unknown": no tracker row or no VALID reading) is counted apart, not a run. */
export function pagecheck(d: CliDeps): void {
  if (!d.pagecheckStatus || !existsSync(d.pagecheckStatus)) return;
  const st = readStatus(d.pagecheckStatus);
  if (!st || !Array.isArray(st.pairs)) {
    d.out("page check: status.json unreadable");
    return;
  }
  const runs = st.pairs.filter((p) => p.state === "review" || p.state === "fault");
  const unknown = st.pairs.filter((p) => p.state === "unknown").length;
  d.out(`page check (as of ${st.at}): ${st.pairs.length} pair(s), ${runs.length} in a gap run${unknown ? `, ${unknown} not compared yet` : ""}${st.trackersDownIntervals ? `, trackers down ${st.trackersDownIntervals} interval(s)` : ""}`);
  for (const p of runs)
    d.out(`  ${p.sourceId} ${p.gpu} (slot ${p.slot}): ${p.state}, ${p.gapBps === null ? "-" : `${(p.gapBps / 100).toFixed(1)}%`} apart (reading ${p.own === null ? "-" : $(p.own)} vs ${p.tracker ?? "tracker"} ${p.t === null ? "-" : $(p.t)}) since ${p.runStartAt ?? "-"}, ${p.gapped} gapped comparison(s)`);
}

export async function alerts(d: CliDeps, args: string[]): Promise<void> {
  const list = (args.includes("--all") ? d.alerts.all() : d.alerts.open()).sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.at - b.at);
  d.out(`${list.length} ${args.includes("--all") ? "" : "open "}alert(s)`);
  for (const a of list) d.out(`  [${a.severity}] ${a.code} day ${a.day ?? "-"} ${a.deadline ? `deadline ${a.deadline} (${a.deadline - d.now()} s)` : ""} ${a.message}`);
}

export async function check(d: CliDeps, args: string[]): Promise<Evaluation> {
  const p = panelOf(d, args[0]);
  const day = args[1] !== undefined ? Number(args[1]) : undefined;
  const b = await scenarioFor(d, p, day);
  let sc = b.scenario;
  if (!sc.pending) {
    // a final day: judge every writer's record recomputed from its readings (F8)
    const recs = recomputeAll(sc);
    const fin = await d.view.record(p.gpuId, sc.day);
    const src = fin.exists && fin.rec.status !== Status.CARRIED ? recs.find((r) => lc(r.source) === lc(fin.rec.source)) : recs[0];
    if (src) sc = { ...sc, pending: { ...src, postedAt: Number(fin.rec.postedAt), finalAt: Number(fin.rec.finalAt), attestedAt: Number(fin.rec.attestedAt) }, candidates: recs.filter((r) => r !== src) };
  }
  if (b.inconsistent.length) d.out(`INCONSISTENT: ${b.inconsistent.join("; ")}`);
  const ev = evaluate(sc);
  if (b.scenario.pending) {
    // R8's memory of this day: the next day's check reads it (two computed days running)
    const pv = ev.candidates.find((c) => c.isPending)!;
    d.glog.addR8({ gpuId: p.gpuId, day: sc.day, at: d.now(), writer: pv.source, fixOutside: pv.veto.fixOutside && !pv.veto.r7.fix, otherGood: ev.candidates.some((c) => !c.isPending && (c.strict.ok || c.fixOk.ok)), confirmedSlots: pv.veto.confirmed, replaced: false });
  }
  d.out(`${p.gpu} day ${sc.day} (rule R v4.3)`);
  printEvaluation(d, ev, true);
  for (const a of ev.alerts) d.out(`  alert ${a.code} [${a.severity}] ${a.message}`);
  return ev;
}

export async function look(d: CliDeps, args: string[]): Promise<void> {
  if (!d.look) throw new Error("look needs the sources package to fetch and parse pages");
  const p = panelOf(d, args[0]);
  const region = flag(args, "--region");
  if (!region) throw new Error("look needs --region <label> (where this machine is; R3 and R4b need the writer's region)");
  const only = flag(args, "--source");
  const ids = [...new Set(p.sources)].filter((s) => !only || s === only);
  const now = d.now();
  // the looks are the evidence R3, R4b and R12 need, often during an RPC outage: an unreachable chain never stops them
  // being fetched and recorded (the readers then come from the events already on disk)
  try {
    await d.events.sync();
  } catch (e) {
    d.out(`events not synced (${e instanceof Error ? e.message.split("\n")[0] : String(e)}): readers in force from the events on disk, which may miss a swap executed since`);
  }
  // 8.6: each slot with its reader in force today (the newest executed swap whose fromDay has begun)
  const today = dayIdAt(d.clock, now);
  const readers: Record<string, { url: string; parserVersion: string }> = {};
  for (const e of d.events.all()) {
    if (e.name !== "ReaderSwapped" || lc(e.gpuId) !== lc(p.gpuId) || e.fromDay > today) continue;
    const src = p.sources[e.slot];
    if (src) readers[src] = { url: e.url, parserVersion: e.parserVersion };
  }
  const res = await d.look(ids, readers);
  const writerRegion = region === (d.writerRegion ?? "writer") || args.includes("--writer-region");
  for (const id of ids) {
    const row = res[id]?.[p.gpu];
    const state = (row?.state ?? "FAILED") as never;
    const valueU = row?.state === "VALID" ? row.valueU : 0;
    d.glog.addLook({ gpu: p.gpu, gpuId: p.gpuId, sourceId: id, interval: intervalAt(d.clock, now), at: now, state, valueU, region, writerRegion });
    d.out(`look ${id} (slot ${p.sources.indexOf(id)}): ${row?.state ?? "FAILED"} ${valueU ? $(valueU) : ""}${readers[id] ? ` (reader ${printable(readers[id]!.parserVersion)} at ${printable(readers[id]!.url)})` : ""}${row?.why ? ` (${printable(row.why)})` : ""}`);
  }
  d.out(`recorded ${ids.length} look(s) from region ${region}${writerRegion ? " (the writer's region)" : ""}`);
  const head = await d.view.head(p.gpuId);
  const r = await d.view.record(p.gpuId, head - 1);
  if (r.exists && !r.isFinal && r.rec.status !== Status.CARRIED) {
    const ev = evaluate((await scenarioFor(d, p)).scenario);
    for (const c of ev.candidates) d.out(`  ${c.source}: R11 ${c.r11.ok} ${c.r11.fixRange ? `${$(c.r11.fixRange[0])}..${$(c.r11.fixRange[1])}` : ""}; R12 ${c.r12.ok} ${c.r12.fixRange ? `${$(c.r12.fixRange[0])}..${$(c.r12.fixRange[1])}` : ""}`);
  }
}

async function confirm(d: CliDeps, expect: string, what: string): Promise<boolean> {
  const a = (await d.prompt(`${what}\nType ${expect === "yes" ? "yes" : `the first 8 hex digits of the digest (${expect.length} characters)`} to send: `)).trim().toLowerCase();
  if (a !== expect.toLowerCase()) {
    d.out("not confirmed; nothing sent");
    return false;
  }
  return true;
}

export async function veto(d: CliDeps, args: string[]): Promise<boolean> {
  const p = panelOf(d, args[0]);
  const day = Number(args[1]);
  const source = flag(args, "--source") as Address | undefined;
  const digest = flag(args, "--digest") as Hex | undefined;
  if (!source || !digest) throw new Error("veto <gpu> <day> --source <addr> --digest <hex>");
  d.out("Rule: veto only the record you checked (F2). If it was replaced by a select before your veto lands, do not veto again: apply R8 to the replaced writer.");
  const r = await d.view.record(p.gpuId, day);
  if (!r.exists || r.isFinal || r.rec.status === Status.CARRIED) {
    d.out(`refused: day ${day} has no pending record`);
    return false;
  }
  if (lc(r.rec.source) !== lc(source) || lc(r.rec.digest) !== lc(digest)) {
    d.out(`refused: the pending record is now ${r.rec.source} ${r.rec.digest}, not the one named (VetoStale); apply R8 to the replaced writer`);
    return false;
  }
  const b = await scenarioFor(d, p, day);
  const ev = evaluate(b.scenario);
  const pv = ev.candidates.find((c) => c.isPending)!;
  d.out(`R3 reasons: fix outside ${pv.veto.fixOutside} (R7 ${pv.veto.r7.fix}); slot [${pv.veto.slotReasons}] (R7 ${pv.veto.r7.slot}); dark [${pv.veto.darkReasons}] (R7 ${pv.veto.r7.dark}); confirmed by a writer-region look [${pv.veto.confirmed}]`);
  if (!pv.veto.actionable && ev.guardian.veto?.liveness)
    d.out("Liveness veto (6.6 step 3b): this needsSign record passes neither R11 nor R12 with the looks taken (R7 does not gate it: it judges no value); vetoing it lets the day close from the next writer or carry within LAG_MAX instead of dropping after HOLD_MOVE. Never an R8 reason: do not suspend for it.");
  else if (!pv.veto.actionable) d.out("WARNING: rule R finds no actionable R3 reason (a slot or dark reason needs a look from the writer's region first; R7 may apply)");
  if (!(await confirm(d, digest.slice(2, 10), `veto ${p.gpu} day ${day} source ${source} digest ${digest}`))) return false;
  const res = await d.senderFor("AGATE_GUARDIAN_KEY").send("veto", [p.gpuId, day, source, digest]);
  d.out(res.ok ? `vetoed: ${res.txHash}` : `not sent or failed: ${res.error}`);
  return res.ok;
}

export async function suspend(d: CliDeps, args: string[]): Promise<boolean> {
  const writer = args[0] as Address | undefined;
  if (!writer) throw new Error("suspend <writer>");
  const ws = await d.view.writers();
  if (!ws.some((w) => lc(w) === lc(writer))) {
    d.out(`refused: ${writer} is not a writer slot address`);
    return false;
  }
  let evidence = 0;
  for (const p of d.panels) {
    const head = await d.view.head(p.gpuId);
    for (const day of [head - 1, head - 2]) {
      for (const m of d.glog.r8(p.gpuId, day)) {
        if (lc(m.writer) !== lc(writer)) continue;
        evidence++;
        d.out(`R8 memo ${p.gpu} day ${day}: fix outside ${m.fixOutside}, another record STRICT or FIX-OK ${m.otherGood}, confirmed slot reasons [${m.confirmedSlots}], replaced ${m.replaced}`);
      }
    }
  }
  const keyAlerts = d.alerts.open().filter((a) => a.code === "KEY_MISMATCH" && a.writer && lc(a.writer) === lc(writer));
  for (const a of keyAlerts) d.out(`R8 (d) evidence: ${a.message} (run guardian keycheck ${writer} first; confirmed: suspend at once, R7 does not apply)`);
  if (evidence === 0 && keyAlerts.length === 0) d.out("WARNING: no R8 memo for this writer on the last two days (R8 (c) needs both days, each confirmed by a writer-region look) and no KEY_MISMATCH (R8 (d))");
  if (!(await confirm(d, "yes", `suspend writer ${writer}: it posts and closes nothing until the owner appoints a NEW address (R6)`))) return false;
  const res = await d.senderFor("AGATE_GUARDIAN_KEY").send("suspend", [writer]);
  d.out(res.ok ? `suspended: ${res.txHash}` : `not sent or failed: ${res.error}`);
  return res.ok;
}

export async function attest(d: CliDeps, args: string[]): Promise<boolean> {
  const p = panelOf(d, args[0]);
  const day = Number(args[1]);
  const writer = flag(args, "--writer") as Address | undefined;
  const digest = flag(args, "--digest") as Hex | undefined;
  const r12 = args.includes("--r12");
  if (!writer || !digest) throw new Error("attest <gpu> <day> --writer <addr> --digest <hex> [--r12]");
  const b = await scenarioFor(d, p, day);
  if (!b.scenario.pending) {
    d.out(`refused: day ${day} has no pending record`);
    return false;
  }
  if (b.inconsistent.length) {
    d.out(`refused: the chain differs from the offchain formula: ${b.inconsistent.join("; ")}`);
    return false;
  }
  const ev = evaluate(b.scenario);
  const c = ev.candidates.find((x) => lc(x.source) === lc(writer));
  if (!c || lc(c.digest) !== lc(digest)) {
    d.out(`refused: no candidate ${writer} with digest ${digest} on day ${day}`);
    return false;
  }
  const passing = ev.candidates.filter((x) => x.r11.ok);
  // 6.4 (Oct 3): a record that withholds a slot is never hand-signed until a writer-region look confirms the block
  const withheld = (r12 ? c.r12 : c.r11).slots.filter((s) => s.why === "withheld").map((s) => s.slot);
  if (withheld.length > 0) {
    d.out(`refused: ${writer}'s record withholds slot ${withheld.join(", ")} (held, or taken out after being in, while the watcher reads it FRESH) and no look from the writer's region confirms a block: run look from the writer's region (6.4); without one, step 3b applies`);
    return false;
  }
  if (!r12) {
    if (!c.r11.ok) {
      d.out(`refused: ${writer}'s value ${$(c.value)} is outside its strict hand range (${c.r11.why.join("; ")})`);
      return false;
    }
    if (c.veto.actionable) d.out("WARNING: the candidate shows an R3 reason against the watcher's VETO ranges; R11's hand range already counts the writer-region looks (a view split), check them before you confirm");
    const nearer = ev.candidates.filter((x) => x.r11.ok && x.dist < c.dist);
    if (nearer.length > 0) {
      d.out(`refused: ${nearer[0]!.source} also passes R11 and is nearer W(d)`);
      return false;
    }
  } else {
    const why: string[] = [];
    if (passing.length > 0) why.push(`a candidate passes R11 (${passing[0]!.source}): use R11`);
    if (!ev.guardian.r12Ready) why.push(...ev.guardian.r12Why);
    if (c.veto.actionable) why.push("the candidate has an R3 reason with R7 not applying (veto it)");
    if (!c.r12.ok) why.push(`outside its relaxed hand range (${c.r12.why.join("; ")})`);
    const nearer = ev.candidates.filter((x) => x.r12.ok && !x.veto.actionable && x.dist < c.dist);
    if (nearer.length > 0) why.push(`${nearer[0]!.source} passes R12 and is nearer W(d)`);
    if (why.length > 0) {
      d.out(`refused (R12): ${why.join("; ")}`);
      return false;
    }
  }
  d.out(`${r12 ? "R12" : "R11"}: ${writer} value ${$(c.value)} inside its ${r12 ? "relaxed" : "strict"} hand range ${(r12 ? c.r12 : c.r11).fixRange?.map($).join("..")}`);
  if (!(await confirm(d, "yes", `attest ${p.gpu} day ${day} writer ${writer} digest ${digest}`))) return false;
  const res = await d.senderFor("AGATE_GUARDIAN_KEY").send("attest", [p.gpuId, day, writer, digest]);
  if (res.ok) d.glog.addSignature({ gpuId: p.gpuId, day, writer, digest, rule: r12 ? "R12" : "R11", at: d.now(), ...(res.txHash ? { txHash: res.txHash } : {}) });
  d.out(res.ok ? `attested: ${res.txHash}` : `not sent or failed: ${res.error}`);
  return res.ok;
}

/** R4b: flag a slot "blocked for the watcher" (found readable from the writer's region) from a day; `--to` closes it. */
export async function block(d: CliDeps, args: string[]): Promise<boolean> {
  const p = panelOf(d, args[0]);
  const src = flag(args, "--source");
  const from = flag(args, "--from");
  if (!src || from === undefined || !p.sources.includes(src)) throw new Error("block <gpu> --source <id> --from <day> [--to <day>]");
  const to = flag(args, "--to");
  const looks = d.glog.looks(p.gpuId).filter((l) => l.sourceId === src && l.writerRegion && l.state === "VALID");
  if (looks.length === 0) {
    d.out(`refused: no look from the writer's region read ${src}; R4b flags a page only after a look there could read it`);
    return false;
  }
  d.glog.addFlag({ gpuId: p.gpuId, sourceId: src, from: Number(from), to: to === undefined ? 4_294_967_295 : Number(to), at: d.now() });
  d.out(`flagged ${src} (slot ${p.sources.indexOf(src)}) blocked for the watcher from day ${from}${to === undefined ? "" : ` to ${to}`}; reroute the watcher and take one look per day until it reads the page again`);
  return true;
}

export async function kick(d: CliDeps, args: string[]): Promise<boolean> {
  const p = panelOf(d, args[0]);
  const s = d.senderFor("AGATE_KICK_KEY");
  for (const fn of ["closeDay", "carryDay"] as const) {
    const sim = await s.simulate(fn, [p.gpuId]);
    d.out(`${fn}: ${sim.ok ? "would succeed" : `would revert: ${sim.error}`}`);
    if (sim.ok) {
      const res = await s.send(fn, [p.gpuId]);
      d.out(res.ok ? `${fn} sent: ${res.txHash}` : `${fn} failed: ${res.error}`);
      return res.ok;
    }
  }
  return false;
}

export async function replaced(d: CliDeps, args: string[]): Promise<Evaluation | null> {
  const p = panelOf(d, args[0]);
  const day = Number(args[1]);
  await d.events.sync();
  const ev = d.events.all().filter((e) => e.name === "RecordReplaced" && lc(e.gpuId) === lc(p.gpuId) && e.day === day);
  const rep = ev[ev.length - 1];
  if (!rep || rep.name !== "RecordReplaced") {
    d.out(`no select replaced a record of day ${day}`);
    return null;
  }
  const b = await scenarioFor(d, p, day);
  const recs = recomputeAll(b.scenario);
  const old = recs.find((r) => lc(r.source) === lc(rep.oldSource));
  if (!old) {
    d.out(`cannot recompute ${rep.oldSource}: no readings`);
    return null;
  }
  const ok = lc(old.digest) === lc(rep.oldDigest);
  d.out(`replaced writer ${rep.oldSource}: recomputed from readings() and the pre-state rebuilt from events: value ${$(old.value)} digest ${old.digest} ${ok ? "(matches RecordReplaced.oldDigest)" : `(DIFFERS from ${rep.oldDigest})`}`);
  const fin = await d.view.record(p.gpuId, day);
  const sc: RuleScenario = { ...b.scenario, pending: { ...old, postedAt: Number(fin.rec.postedAt), finalAt: Number(fin.rec.finalAt), attestedAt: 0 }, candidates: recs.filter((r) => r !== old) };
  const out = evaluate(sc);
  const v = out.candidates.find((c) => c.isPending)!;
  d.out(`R8 view: fix outside the VETO fix range ${v.veto.fixOutside} (R7 ${v.veto.r7.fix}); another record STRICT or FIX-OK ${out.candidates.some((c) => !c.isPending && (c.strict.ok || c.fixOk.ok))}; slot reasons [${v.veto.slotReasons}]; dark reasons [${v.veto.darkReasons}]`);
  const otherGood = out.candidates.some((c) => !c.isPending && (c.strict.ok || c.fixOk.ok));
  if (v.veto.fixOutside && !v.veto.r7.fix && otherGood) d.out(`R8 (a) met: suspend ${rep.oldSource} (guardian suspend ${rep.oldSource})`);
  d.out("A slot reason alone never suspends after a select (R8, HF-3, HF-5).");
  d.glog.addR8({ gpuId: p.gpuId, day, at: d.now(), writer: rep.oldSource, fixOutside: v.veto.fixOutside && !v.veto.r7.fix, otherGood: out.candidates.some((c) => !c.isPending && (c.strict.ok || c.fixOk.ok)), confirmedSlots: v.veto.confirmed, replaced: true });
  return out;
}

interface KeySide {
  values?: number[];
  readAt?: number;
  txHash?: string;
}

/** The writer's accumulator backstop (8.5 step 2, its getLogs failed): a day, not a slice. Either the onchain counts
 *  and sums differ from what its log explains, or bits are set for slices it never read. */
interface AccData {
  slots?: number[];
  onchain?: { counts?: number[]; sums?: number[] };
  logged?: { counts?: number[]; sums?: number[] };
  slices?: number[];
}

/** keycheck for a backstop alert: readings() now beside the alert's two sides, and the writer's ReadingsPosted events
 *  of the day with their senders. Confirmed: every slice it says it never read still has its bit set; or the chain
 *  still shows the alert's counts and sums and they differ from the log's. Read only. */
async function keycheckDay(d: CliDeps, message: string, writer: Address, gpuId: Hex, day: number, data: AccData): Promise<boolean> {
  const arr = (x: readonly number[] | undefined, f: (n: number) => string = String) => `[${(x ?? []).map((v) => f(Number(v))).join(", ")}]`;
  d.out(`KEY_MISMATCH ${gpuName(d)(gpuId)} day ${day} (accumulator check) writer ${writer}: ${message}`);
  const r = await d.view.readings(gpuId, day, writer);
  const counts = r.counts.map(Number);
  const sums = r.sums.map(Number);
  d.out(`  readings() now: sliceBits ${r.sliceBits.toString(2)} counts ${arr(counts)} sums ${arr(sums, $)}`);
  const evs = d.events.all().filter((e) => e.name === "ReadingsPosted" && lc(e.gpuId) === lc(gpuId) && e.day === day && lc(e.writer) === lc(writer));
  let foreign = false;
  for (const ev of evs) {
    if (ev.name !== "ReadingsPosted") continue;
    const tx = ev.tx && d.tx ? await d.tx(ev.tx) : null;
    if (tx && lc(tx.from) !== lc(writer)) foreign = true;
    d.out(`  event: slice ${ev.slice} readAt ${ev.readAt} values [${ev.values.map($).join(", ")}]${ev.tx ? ` tx ${ev.tx}` : ""}${tx ? ` from ${tx.from}` : ""}`);
  }
  if (evs.length === 0) d.out("  no ReadingsPosted event of that day by this writer in the event index (events may lag: sync)");
  let ok: boolean;
  let why: string;
  if (data.slices && data.slices.length > 0) {
    ok = data.slices.every((h) => ((r.sliceBits >> BigInt(h)) & 1n) === 1n);
    why = ok ? "" : "a listed slice has no bit set onchain";
    d.out(`  slices the writer never read, per the alert: ${data.slices.join(", ")}`);
  } else {
    d.out(`  onchain per the alert: counts ${arr(data.onchain?.counts)} sums ${arr(data.onchain?.sums, $)}`);
    d.out(`  expected from the writer's log: counts ${arr(data.logged?.counts)} sums ${arr(data.logged?.sums, $)}`);
    const same = (x: readonly number[] | undefined, y: readonly number[]) => x !== undefined && x.length === y.length && x.every((v, i) => Number(v) === y[i]);
    const sameAsAlert = same(data.onchain?.counts, counts) && same(data.onchain?.sums, sums);
    const differsFromLog = !(same(data.logged?.counts, counts) && same(data.logged?.sums, sums));
    ok = sameAsAlert && differsFromLog;
    why = !sameAsAlert ? "the chain moved since the alert (later posts that day); compare the events above with the writer's log" : "the chain matches the writer's log";
  }
  if (ok && foreign) {
    ok = false;
    why = "an event of that day was not sent by the writer's key";
  }
  if (ok) d.out(`  confirmed: the chain holds readings ${writer}'s log does not explain. R8 (d): guardian suspend ${writer} at once, then the owner appoints a new key (R6)`);
  else d.out(`  NOT confirmed (${why})`);
  return ok;
}

/** 8.5, 10 (Oct 3): the KEY_MISMATCH evidence. For each open alert of the writer (optionally one day), re-read the
 *  ReadingsPosted event of that slice, its transaction and readings(), print it beside the alert's logged side, and
 *  say "confirmed" when the chain still shows what the alert says it showed (and that differs from the log).
 *  Read only, no key. Returns the number confirmed. */
export async function keycheck(d: CliDeps, args: string[]): Promise<number> {
  const writer = args[0] as Address | undefined;
  if (!writer || !/^0x[0-9a-fA-F]{40}$/.test(writer)) throw new Error("keycheck <writer> [--day d]");
  const dayArg = flag(args, "--day");
  await d.events.sync();
  const list = d.alerts.open().filter((a) => a.code === "KEY_MISMATCH" && a.writer && lc(a.writer) === lc(writer) && (dayArg === undefined || a.day === Number(dayArg)));
  if (list.length === 0) {
    d.out(`no open KEY_MISMATCH alert for ${writer}${dayArg !== undefined ? ` on day ${dayArg}` : ""}`);
    return 0;
  }
  let confirmed = 0;
  for (const a of list) {
    const data = (a.data ?? {}) as { gpuId?: Hex; day?: number; slice?: number; onchain?: KeySide; logged?: KeySide | null; txHash?: string; via?: string };
    const gpuId = (data.gpuId ?? a.gpuId) as Hex | undefined;
    const day = data.day ?? a.day;
    const slice = data.slice ?? a.slot;
    if (gpuId && day !== undefined && slice === undefined && data.via === "accumulators") {
      if (await keycheckDay(d, a.message, writer, gpuId, day, a.data as AccData)) confirmed++;
      continue;
    }
    if (!gpuId || day === undefined || slice === undefined) {
      d.out(`${a.id}: the alert does not name gpu, day and slice; cannot check`);
      continue;
    }
    const name = gpuName(d)(gpuId);
    d.out(`KEY_MISMATCH ${name} day ${day} slice ${slice} writer ${writer}: ${a.message}`);
    const logged = data.logged ?? null;
    d.out(`  logged by the writer: ${logged ? `readAt ${logged.readAt} values [${(logged.values ?? []).map($).join(", ")}]` : "no reading line (a slice it never read)"}`);
    const said = data.onchain ?? {};
    d.out(`  onchain per the alert: readAt ${said.readAt ?? "-"} values [${(said.values ?? []).map($).join(", ")}] tx ${said.txHash ?? data.txHash ?? "-"}`);
    const evs = d.events.all().filter((e) => e.name === "ReadingsPosted" && lc(e.gpuId) === lc(gpuId) && e.day === day && lc(e.writer) === lc(writer) && e.slice === slice);
    const ev = evs[evs.length - 1];
    if (!ev || ev.name !== "ReadingsPosted") {
      d.out("  chain now: no ReadingsPosted event of that slice by this writer (events may lag: sync, or check readings())");
      continue;
    }
    const txh = ev.tx ?? (said.txHash as Hex | undefined) ?? (data.txHash as Hex | undefined);
    const tx = txh && d.tx ? await d.tx(txh) : null;
    d.out(`  chain now: ReadingsPosted readAt ${ev.readAt} values [${ev.values.map($).join(", ")}]${txh ? ` tx ${txh}` : ""}${tx ? ` from ${tx.from} block ${tx.blockNumber ?? "pending"}` : ""}`);
    const r = await d.view.readings(gpuId, day, writer);
    d.out(`  readings(): sliceBits ${r.sliceBits.toString(2)} counts [${r.counts.join(", ")}]`);
    const sameAsAlert = (said.readAt === undefined || said.readAt === ev.readAt) && (said.values === undefined || JSON.stringify(said.values) === JSON.stringify(ev.values));
    const differsFromLog = !logged || logged.readAt !== ev.readAt || JSON.stringify(logged.values ?? []) !== JSON.stringify(ev.values);
    const fromOk = !tx || lc(tx.from) === lc(writer); // TX_ORIGIN: the writer's own key signed it
    if (sameAsAlert && differsFromLog && fromOk) {
      confirmed++;
      d.out(`  confirmed: another party posted with ${writer}'s key. R8 (d): guardian suspend ${writer} at once, then the owner appoints a new key (R6)`);
    } else d.out(`  NOT confirmed (${!sameAsAlert ? "the chain differs from the alert" : !differsFromLog ? "the chain matches the writer's log" : "the transaction was not sent by the writer's key"})`);
  }
  return confirmed;
}

export const HELP = `guardian <command>
  status [--gpu H100] [--all] [--index addr]           head, lag, pending record, verdicts, step 3b deadline, day labels,
                                                        live owner actions and reader swaps (--all: expired ones too),
                                                        reader history, page check, heartbeats, alerts
  alerts [--all]                                        open alerts by deadline
  check <gpu> <day>                                     the full rule R table for every candidate
  look <gpu> --region <label> [--source id] [--writer-region]   fetch pages now from this machine; logged as looks
  veto <gpu> <day> --source <addr> --digest <hex>       veto only the record you checked (AGATE_GUARDIAN_KEY)
  suspend <writer>                                      R8 evidence, then suspend (AGATE_GUARDIAN_KEY)
  attest <gpu> <day> --writer <addr> --digest <hex> [--r12]   R11 (or R12) by hand (AGATE_GUARDIAN_KEY)
  block <gpu> --source <id> --from <day> [--to <day>]   R4b: flag a page blocked for the watcher (needs a writer-region look)
  keycheck <writer> [--day d]                           KEY_MISMATCH evidence re-read from the chain (read only)
  kick <gpu>                                            the keeper's job by hand (AGATE_KICK_KEY)
  replaced <gpu> <day>                                  recompute a replaced writer's record (F8) and its R8 view`;

export async function run(d: CliDeps, argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "status":
        await status(d, args);
        return 0;
      case "alerts":
        await alerts(d, args);
        return 0;
      case "check":
        await check(d, args);
        return 0;
      case "look":
        await look(d, args);
        return 0;
      case "veto":
        return (await veto(d, args)) ? 0 : 1;
      case "suspend":
        return (await suspend(d, args)) ? 0 : 1;
      case "attest":
        return (await attest(d, args)) ? 0 : 1;
      case "kick":
        return (await kick(d, args)) ? 0 : 1;
      case "keycheck":
        await keycheck(d, args);
        return 0;
      case "block":
        return (await block(d, args)) ? 0 : 1;
      case "replaced":
        return (await replaced(d, args)) ? 0 : 1;
      default:
        d.out(HELP);
        return cmd ? 2 : 0;
    }
  } catch (e) {
    d.out(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export { Kind };
