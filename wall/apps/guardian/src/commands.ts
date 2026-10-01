// The guardian CLI's commands (BUILD-SPEC 10), written against injected dependencies so tests can drive them on the
// fake index. The CLI shows the rule and the person decides: it never vetoes or signs on its own, and every send
// re-checks the chain and asks the operator to confirm.
import type { Address, GpuModel, Hex } from "@agate/report/types";
import { Kind, Status } from "@agate/report/types";
import {
  type AlertSink,
  buildScenario,
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
  /** Fetch every page of the panel now from this machine and parse it: per source, per GPU, a state and value. */
  (sourceIds: string[]): Promise<Record<string, Partial<Record<GpuModel, { state: string; valueU: number }>>>>;
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
  const b = await buildScenario({ view: d.view, events: new EventIndex(d.events), log: d.log, guardian: d.glog, alerts: d.alerts, clock: d.clock, panel: p }, d.now(), day);
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
      printEvaluation(d, evaluate(b.scenario), false);
    }
    const fixes: string[] = [];
    for (let j = head - 1; j >= head - 8 && fixes.length < 7; j--) {
      const x = await d.view.record(p.gpuId, j);
      if (x.exists && x.isFinal) fixes.push(`${j}: ${$(x.rec.value)}${x.rec.status === Status.CARRIED ? (x.rec.dropped ? " CARRIED (dropped)" : " CARRIED") : ""}`);
    }
    d.out(`  last final fixes: ${fixes.join(" | ") || "none"}`);
  }
  const ws = await d.view.writers();
  for (const w of ws) if (!/^0x0{40}$/i.test(w)) d.out(`writer ${w}: suspended ${await d.view.isSuspended(w)} balance ${await d.view.balance(w)} wei`);
  const voided = d.events.all().filter((e) => e.name === "Vetoed");
  for (const e of voided.slice(-5)) if (e.name === "Vetoed") d.out(`voided: ${e.source} for day ${e.day} (veto by ${e.by})`);
  for (const e of d.events.all()) if (e.name === "ActionQueued") d.out(`queued owner action ${e.id}: eta ${e.eta}${e.eta > now ? ` (in ${e.eta - now} s)` : " (executable)"}`);
  for (const b of d.beats ?? []) {
    const hb = readBeat(b.path);
    d.out(`heartbeat ${b.role}: ${hb ? `${now - hb.at} s old (${hb.lastAction})` : "missing"}${hb && now - hb.at > 3 * b.periodS ? " LOST" : ""}`);
  }
  await alerts(d, []);
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
  if (!d.look) throw new Error("look needs the sources package (builder B) to fetch and parse pages");
  const p = panelOf(d, args[0]);
  const region = flag(args, "--region");
  if (!region) throw new Error("look needs --region <label> (where this machine is; R3 and R4b need the writer's region)");
  const only = flag(args, "--source");
  const ids = [...new Set(p.sources)].filter((s) => !only || s === only);
  const now = d.now();
  const res = await d.look(ids);
  const writerRegion = region === (d.writerRegion ?? "writer") || args.includes("--writer-region");
  for (const id of ids) {
    const row = res[id]?.[p.gpu];
    const state = (row?.state ?? "FAILED") as never;
    const valueU = row?.state === "VALID" ? row.valueU : 0;
    d.glog.addLook({ gpu: p.gpu, gpuId: p.gpuId, sourceId: id, interval: intervalAt(d.clock, now), at: now, state, valueU, region, writerRegion });
    d.out(`look ${id} (slot ${p.sources.indexOf(id)}): ${row?.state ?? "FAILED"} ${valueU ? $(valueU) : ""}`);
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
  if (evidence === 0) d.out("WARNING: no R8 memo for this writer on the last two days (R8 (c) needs both days, each confirmed by a writer-region look)");
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

export const HELP = `guardian <command>
  status [--gpu H100]                                   head, lag, pending record, verdicts, heartbeats, alerts
  alerts [--all]                                        open alerts by deadline
  check <gpu> <day>                                     the full rule R table for every candidate
  look <gpu> --region <label> [--source id] [--writer-region]   fetch pages now from this machine; logged as looks
  veto <gpu> <day> --source <addr> --digest <hex>       veto only the record you checked (AGATE_GUARDIAN_KEY)
  suspend <writer>                                      R8 evidence, then suspend (AGATE_GUARDIAN_KEY)
  attest <gpu> <day> --writer <addr> --digest <hex> [--r12]   R11 (or R12) by hand (AGATE_GUARDIAN_KEY)
  block <gpu> --source <id> --from <day> [--to <day>]   R4b: flag a page blocked for the watcher (needs a writer-region look)
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
