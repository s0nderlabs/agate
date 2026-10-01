// What a run is judged on (BUILD-SPEC 12.6 pass conditions): every day final within LAG_MAX, every final fix equal
// to the honest reference recomputed from what the replayed pages truly showed at each honest reading's second, no
// veto or suspension of an honest writer, the expected alerts raised, and the honest writers' posted values equal to
// the pages. The reference is independent of what the writers posted: only the honest writers' read seconds are
// taken from the chain.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Address, Hex, SlotState } from "@agate/report/types";
import { AlertCode, Status } from "@agate/report/types";
import { computeRecord, decodeWallEvent, type GpuShape, initialState, type WallEvent } from "@agate/watcher";
import type { Abi, Log } from "viem";
import { ADDR, ROLE } from "./chain.ts";
import type { World } from "./world.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DayRow {
  gpu: string;
  day: number;
  value: number;
  status: string;
  source: string;
  final: boolean;
  dropped: boolean;
  incomplete: boolean;
  needsSign: boolean;
  attestedBy: string;
  lag: number | null; // finalAt - dayEnd
  lagChained: number | null; // finalAt - max(dayEnd, previous day's finalAt): 6.6 (vi)'s weaker form
  ref: string; // the honest reference verdict
}

export interface RunReport {
  name: string;
  profile: string;
  ok: boolean;
  checks: Check[];
  days: DayRow[];
  alertCounts: Record<string, number>;
  guardianActs: { at: number; gpu: string; day: number; act: string; code?: number; detail?: string }[];
  timeline: { at: number; what: string }[];
  errors: string[];
  stats: Record<string, number | string>;
}

const STATUS = ["NONE", "FULL", "DEGRADED", "DEMO", "CARRIED"];
const lc = (a: string) => a.toLowerCase();
const $ = (u: number) => (u / 1e6).toFixed(2);

export async function allEvents(w: World): Promise<WallEvent[]> {
  const out: WallEvent[] = [];
  const latest = await w.a.pub.getBlockNumber();
  for (let from = w.dep.fromBlock; from <= latest; from += 5_000n) {
    const to = from + 4_999n < latest ? from + 4_999n : latest;
    const logs = await w.a.pub.getLogs({ address: w.dep.index, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const e = decodeWallEvent(l as Log, agateIndexAbi as Abi);
      if (e) out.push(e);
    }
  }
  return out;
}

async function read<T>(w: World, functionName: string, args: readonly unknown[]): Promise<T> {
  return (await w.a.pub.readContract({ address: w.dep.index, abi: agateIndexAbi as Abi, functionName, args: args as unknown[] })) as T;
}

export function readAlerts(w: World): { code: string; severity: string; gpuId?: string; day?: number; at: number; cleared?: number; message: string; data?: unknown }[] {
  const p = join(w.home, "alerts", "alerts.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export interface JudgeOptions {
  /** roles whose readings form the honest reference (default: every writer without a thief) */
  honest?: ("primary" | "standby")[];
  /** roles whose key is stolen: a veto or suspension of any other writer fails (default: writers with a thief) */
  thieves?: ("primary" | "standby")[];
  /** a reference writer counts only on the days this allows (a stolen key that reads honestly on other days) */
  honestOn?: (role: "primary" | "standby", day: number) => boolean;
  /** alert codes that must have been raised at least once */
  expectAlerts?: string[];
  /** alert codes that must never be raised */
  forbidAlerts?: string[];
  /** the most drops allowed (default 0) */
  maxDrops?: number;
  /** days from which the lag check starts (default firstDay) and before which it ends (default: every day ended
   *  LAG_MAX ago) */
  lagFrom?: number;
  lagSkip?: (day: number) => boolean;
  /** L1b instead of L1: nobody acting */
  l1b?: boolean;
  /** extra checks */
  extra?: (w: World, ev: WallEvent[], days: DayRow[]) => Promise<Check[]> | Check[];
  /** days whose fix may differ from the honest reference (a stated residual); value: why */
  residual?: (gpu: string, day: number) => string | undefined;
}

export async function judge(w: World, o: JudgeOptions = {}): Promise<RunReport> {
  const checks: Check[] = [];
  const ev = await allEvents(w);
  const c = w.wc;
  const honestRoles = o.honest ?? w.writers.filter((x) => !x.spec.thief).map((x) => x.role);
  const honestAddr = honestRoles.map((r) => lc(ADDR[r === "primary" ? ROLE.primary : ROLE.standby]!));
  const thiefRoles = o.thieves ?? w.writers.filter((x) => x.spec.thief).map((x) => x.role);
  const thiefAddr = thiefRoles.map((r) => lc(ADDR[r === "primary" ? ROLE.primary : ROLE.standby]!));
  const roleOf = (a: string) => (lc(a) === lc(ADDR[ROLE.primary]!) ? "primary" : lc(a) === lc(ADDR[ROLE.standby]!) ? "standby" : "other");
  const days: DayRow[] = [];
  const refFails: string[] = [];
  const readFails: string[] = [];
  const lagFails: string[] = [];
  let maxLag = 0;
  let maxLagChained = 0;
  const weak = 2 * (c.keeperPeriod + c.slice + Math.max(c.guardAct, c.tPend)) > c.day; // DEMO and FAST (6.6 (vi))

  for (const p of w.panels) {
    const g = p.gpuId;
    const cfg = await read<{ nSlots: number; firstDay: number; head: number }>(w, "gpu", [g]);
    const n = Number(cfg.nSlots);
    const family: number[] = [];
    const famQByFam = new Map<number, number>();
    const liveFrom: number[] = [];
    const liveUntil: number[] = [];
    for (let i = 0; i < n; i++) {
      const [f, q] = await read<[number, number]>(w, "familyOf", [g, i]);
      family.push(Number(f));
      famQByFam.set(Number(f), Number(q));
      const [lf, lu] = await read<[number, number]>(w, "slotWindow", [g, i]);
      liveFrom.push(Number(lf));
      liveUntil.push(Number(lu));
    }
    const famQ = Array.from({ length: Math.max(...family) + 1 }, (_, f) => famQByFam.get(f) ?? 1);
    const shape: GpuShape = { nSlots: n, family, famQ, liveFrom, liveUntil };
    const [frdOk, frdDay] = await read<[boolean, number]>(w, "firstRecordDay", [g]);
    const frd = frdOk ? Number(frdDay) : null;
    const params = { slices: c.slices, minReadings: c.minReadings, qMin: c.qMin, signAll: c.signAll, tPend: c.tPend };
    let pre: SlotState[] = initialState(n);
    let prevValue: number | null = null;
    let prevFinalAt = 0;
    const head = Number(cfg.head);
    for (let d = Number(cfg.firstDay); d < head; d++) {
      const [exists, isFinal, rec] = await read<[boolean, boolean, { value: number; status: number; source: Address; finalAt: bigint; postedAt: bigint; digest: Hex; dropped: boolean; incomplete: boolean; needsSign: boolean; attestedBy: Address }]>(w, "record", [g, d]);
      if (!exists) {
        // a day carried before the GPU's first record is skipped (DaySkipped), never recorded: final at the skip
        const sk = ev.find((e) => e.name === "DaySkipped" && lc(e.gpuId) === lc(g) && e.day === d);
        if (!sk) break;
        const at = Number((await w.a.pub.getBlock({ blockNumber: BigInt(Number(sk.key.split(":")[0])) })).timestamp);
        days.push({ gpu: p.gpu, day: d, value: 0, status: "SKIPPED", source: "0x0000000000000000000000000000000000000000", final: true, dropped: false, incomplete: false, needsSign: false, attestedBy: "", lag: at - w.dayEnd(d), lagChained: at - Math.max(w.dayEnd(d), prevFinalAt), ref: "skipped before the first record" });
        prevFinalAt = at;
        pre = pre.map((x) => ({ ...x }));
        continue;
      }
      const finalAt = isFinal ? Number(rec.finalAt) : null;
      const lag = finalAt === null ? null : finalAt - w.dayEnd(d);
      const lagChained = finalAt === null ? null : finalAt - Math.max(w.dayEnd(d), prevFinalAt);
      const row: DayRow = {
        gpu: p.gpu,
        day: d,
        value: Number(rec.value),
        status: STATUS[Number(rec.status)]!,
        source: rec.source,
        final: isFinal,
        dropped: rec.dropped,
        incomplete: rec.incomplete,
        needsSign: rec.needsSign,
        attestedBy: rec.attestedBy,
        lag,
        lagChained,
        ref: "",
      };
      days.push(row);
      if (!isFinal) {
        row.ref = "pending";
        break;
      }
      prevFinalAt = finalAt!;
      // the honest reference: each honest writer's record from the TRUE page values at its read seconds
      const refs: { w: string; value: number; digest: Hex; quorate: boolean; post: SlotState[] }[] = [];
      for (const hw of honestAddr) {
        if (o.honestOn && !o.honestOn(roleOf(hw) as "primary" | "standby", d)) continue;
        const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && lc(e.gpuId) === lc(g) && e.day === d && lc(e.writer) === hw);
        if (posts.length === 0) continue;
        if (await read<boolean>(w, "isVoided", [g, d, hw])) {
          refFails.push(`${p.gpu} ${d}: honest writer ${roleOf(hw)} voided`);
          continue;
        }
        const sums = Array(n).fill(0);
        const counts = Array(n).fill(0);
        let bits = 0;
        let late = false;
        for (const e of posts) {
          bits += 2 ** e.slice;
          late ||= e.late;
          for (let i = 0; i < n; i++) {
            const tv = w.truth.value(p.sources[i]!, p.gpu, e.readAt, roleOf(hw));
            if (tv > 0) {
              sums[i] += tv;
              counts[i] += 1;
            }
            if ((e.values[i] ?? 0) !== tv) readFails.push(`${p.gpu} ${d}/${e.slice} ${roleOf(hw)} slot ${i} (${p.sources[i]}): posted ${e.values[i]} page ${tv} at ${e.readAt}`);
          }
        }
        const R = computeRecord({
          params,
          gpu: shape,
          gpuId: g,
          day: d,
          writer: hw as Address,
          postedAt: Number(rec.postedAt),
          pre,
          acc: { sums, counts, sliceBits: bits, late, anyValid: counts.some((x) => x > 0) },
          prev: prevValue === null ? null : { value: prevValue },
          firstRecordDay: frd,
          firstWriter: null,
        });
        refs.push({ w: hw, value: R.value, digest: R.digest, quorate: R.quorate, post: R.post });
      }
      if (rec.status !== Status.CARRIED) {
        const exact = refs.find((r) => lc(r.digest) === lc(rec.digest));
        const sameValue = refs.find((r) => r.quorate && r.value === Number(rec.value));
        if (exact) {
          row.ref = `= ${roleOf(exact.w)}`;
          pre = exact.post;
        } else if (sameValue) {
          row.ref = `value = ${roleOf(sameValue.w)} (source ${roleOf(rec.source)}, other digest)`;
          pre = sameValue.post;
        } else {
          const why = o.residual?.(p.gpu, d);
          row.ref = `${why ? "residual" : "WRONG"}: ${$(Number(rec.value))} vs honest ${refs.map((r) => `${roleOf(r.w)} ${$(r.value)}${r.quorate ? "" : " (below quorum)"}`).join(", ") || "none"}`;
          if (!why) refFails.push(`${p.gpu} ${d}: final ${$(Number(rec.value))} from ${roleOf(rec.source)}, honest reference ${refs.map((r) => `${$(r.value)}`).join("/") || "none"}`);
          const slots = ev.find((e): e is Extract<WallEvent, { name: "RecordSlots" }> => e.name === "RecordSlots" && lc(e.gpuId) === lc(g) && e.day === d && lc(e.digest) === lc(rec.digest));
          if (slots) pre = slots.post.map((s) => ({ ...s }));
        }
      } else {
        if (prevValue !== null && Number(rec.value) !== prevValue) refFails.push(`${p.gpu} ${d}: carried ${$(Number(rec.value))}, previous ${$(prevValue)}`);
        const quorate = refs.filter((r) => r.quorate);
        row.ref = rec.dropped ? `dropped (honest ${quorate.map((r) => roleOf(r.w)).join(",") || "none"} quorate)` : quorate.length ? `carried with honest ${quorate.map((r) => roleOf(r.w)).join(",")} quorate` : "carried (no honest quorate writer)";
        const carry = ev.find((e): e is Extract<WallEvent, { name: "DayCarried" }> => e.name === "DayCarried" && lc(e.gpuId) === lc(g) && e.day === d);
        pre = pre.map((s, i) => (carry && Math.floor(carry.missAdvanced / 2 ** i) % 2 === 1 ? { ...s, miss: s.miss + 1 } : { ...s }));
      }
      prevValue = Number(rec.value);
    }
    // lag: every day that ended LAG_MAX (or the weak bound) ago must be final
    for (let d = o.lagFrom ?? Number(cfg.firstDay); w.dayEnd(d) + c.lagMax <= w.now; d++) {
      if (o.lagSkip?.(d)) continue;
      const row = days.find((x) => x.gpu === p.gpu && x.day === d);
      const lag = row?.lag ?? w.now - w.dayEnd(d);
      maxLag = Math.max(maxLag, lag);
      if (row?.lagChained != null) maxLagChained = Math.max(maxLagChained, row.lagChained);
      const bad = weak ? row?.lagChained == null || row.lagChained > c.lagBound : lag > c.lagMax;
      if (bad) lagFails.push(`${p.gpu} ${d}: ${row?.final ? `final ${lag} s after its end${weak ? ` (${row.lagChained} s after the later of its end and the previous finality)` : ""}` : `not final ${lag} s after its end`}`);
    }
  }

  const label = weak ? `the weak form of 6.6 (vi): within B = ${c.lagBound} s of the later of its end and the previous day's finality` : `LAG_MAX = ${c.lagMax} s`;
  if (!o.l1b) checks.push({ name: "L1 lag", ok: lagFails.length === 0, detail: lagFails.length ? lagFails.slice(0, 12).join("; ") : `every day final within ${label}; max lag ${maxLag} s${weak ? `, max chained lag ${maxLagChained} s` : ""}` });
  checks.push({ name: "fixes = honest reference", ok: refFails.length === 0, detail: refFails.length ? refFails.slice(0, 12).join("; ") : `${days.filter((x) => x.final && x.status !== "CARRIED").length} computed final days, all equal to an honest writer's record from the true pages` });
  checks.push({ name: "honest reads = pages", ok: readFails.length === 0, detail: readFails.length ? `${readFails.length}: ${readFails.slice(0, 6).join("; ")}` : "every value an honest writer posted equals what its page showed at its read second" });
  const vetoes = ev.filter((e): e is Extract<WallEvent, { name: "Vetoed" }> => e.name === "Vetoed");
  const honestVeto = vetoes.filter((e) => !thiefAddr.includes(lc(e.source)));
  checks.push({ name: "no honest veto", ok: honestVeto.length === 0, detail: `${vetoes.length} veto(es), ${honestVeto.length} of an honest writer${vetoes.length ? `: ${vetoes.map((e) => `${e.day} ${roleOf(e.source)}`).join(", ")}` : ""}` });
  const susp = ev.filter((e): e is Extract<WallEvent, { name: "WriterSuspended" }> => e.name === "WriterSuspended");
  const honestSusp = susp.filter((e) => !thiefAddr.includes(lc(e.writer)));
  checks.push({ name: "no honest suspension", ok: honestSusp.length === 0, detail: `${susp.length} suspension(s)${susp.length ? `: ${susp.map((e) => roleOf(e.writer)).join(", ")}` : ""}` });
  const drops = ev.filter((e): e is Extract<WallEvent, { name: "FixDropped" }> => e.name === "FixDropped");
  checks.push({ name: "drops", ok: drops.length <= (o.maxDrops ?? 0), detail: `${drops.length} drop(s) (allowed ${o.maxDrops ?? 0})${drops.length ? `: ${drops.map((e) => `${e.day} ${roleOf(e.source)}`).join(", ")}` : ""}` });

  const alerts = readAlerts(w);
  const counts: Record<string, number> = {};
  const firsts = new Map<string, string>();
  const latest = new Map<string, (typeof alerts)[number]>();
  for (const a of alerts) latest.set((a as { id?: string }).id ?? `${a.code}:${a.at}`, a);
  for (const a of latest.values()) counts[a.code] = (counts[a.code] ?? 0) + 1;
  const bootEnd = w.startedAt + 2 * w.step;
  const bootAlerts = [...new Set(alerts.filter((a) => a.at <= bootEnd && a.severity === "action").map((a) => a.code))];
  for (const code of o.expectAlerts ?? []) {
    const hit = alerts.find((a) => a.code === code);
    if (hit) firsts.set(code, `${hit.at} day ${hit.day ?? "-"}`);
    checks.push({ name: `alert ${code} raised`, ok: Boolean(hit), detail: hit ? `first at ${hit.at} (day ${hit.day ?? "-"}): ${hit.message.slice(0, 160)}` : "never raised" });
  }
  for (const code of o.forbidAlerts ?? []) {
    const hit = alerts.filter((a) => a.code === code && a.at > bootEnd);
    checks.push({ name: `alert ${code} not raised`, ok: hit.length === 0, detail: hit.length ? `${hit.length}: ${hit[0]!.message.slice(0, 160)}` : "not raised" });
  }
  // L1b: no drop without a prior R1_NO_CANDIDATE for its day; FREEZE_LOOP on every drop
  const l1b: string[] = [];
  for (const e of drops) {
    const blk = await w.a.pub.getBlock({ blockNumber: BigInt(Number(e.key.split(":")[0])) });
    const at = Number(blk.timestamp);
    if (!alerts.some((a) => a.code === AlertCode.R1_NO_CANDIDATE && a.day === e.day && a.at <= at)) l1b.push(`drop of ${e.day} without a prior R1_NO_CANDIDATE`);
    if (!alerts.some((a) => a.code === AlertCode.FREEZE_LOOP && a.day === e.day)) l1b.push(`drop of ${e.day} without FREEZE_LOOP`);
  }
  if (drops.length > 0 || o.l1b) checks.push({ name: "L1b (no silent drop)", ok: l1b.length === 0, detail: l1b.length ? l1b.join("; ") : `${drops.length} drop(s), each after R1_NO_CANDIDATE and with FREEZE_LOOP` });
  if (w.errors.length > 0) checks.push({ name: "harness: no process threw out of its tick", ok: false, detail: w.errors.slice(0, 5).join("; ") });
  if (o.extra) checks.push(...(await o.extra(w, ev, days)));

  const stats: Record<string, number | string> = {
    profile: w.o.profile.name,
    days: days.length,
    computedFinal: days.filter((x) => x.final && x.status !== "CARRIED").length,
    carried: days.filter((x) => x.status === "CARRIED").length,
    drops: drops.length,
    selects: ev.filter((e) => e.name === "RecordReplaced").length,
    attested: ev.filter((e) => e.name === "Attested").length,
    vetoes: vetoes.length,
    suspensions: susp.length,
    maxLag,
    lagMax: c.lagMax,
    lagBound: c.lagBound,
    simSeconds: w.now - w.dep.epochTs,
    bootActionAlerts: bootAlerts.join(",") || "none",
    alertLines: alerts.length,
  };
  return {
    name: w.o.name,
    profile: w.o.profile.name,
    ok: checks.every((x) => x.ok),
    checks,
    days,
    alertCounts: counts,
    guardianActs: w.guardian?.acts ?? [],
    timeline: w.timeline.slice(-80),
    errors: w.errors.slice(0, 40),
    stats,
  };
}

export function printReport(r: RunReport, verbose = false): string {
  const out: string[] = [];
  out.push(`== ${r.name} (${r.profile}): ${r.ok ? "PASS" : "FAIL"}`);
  for (const c of r.checks) out.push(`  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`);
  out.push(`  stats ${JSON.stringify(r.stats)}`);
  out.push(`  alerts ${JSON.stringify(r.alertCounts)}`);
  if (verbose) {
    for (const d of r.days) out.push(`    ${d.gpu} ${d.day} ${$(d.value)} ${d.status}${d.dropped ? " dropped" : ""} ${d.final ? "final" : "pending"} lag ${d.lag} src ${d.source.slice(0, 8)} by ${d.attestedBy.slice(0, 8)} ref ${d.ref}`);
    for (const g of r.guardianActs.slice(-30)) out.push(`    guardian ${g.at} ${g.gpu} ${g.day} ${g.act} ${g.code ?? ""} ${g.detail ?? ""}`);
    for (const e of r.errors.slice(0, 10)) out.push(`    error ${e}`);
  }
  return out.join("\n");
}
