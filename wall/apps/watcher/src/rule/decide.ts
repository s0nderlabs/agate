// Rule R v4.3: evaluate(scenario) -> the full verdict table, R1's action, the guardian's view (R3, R7, R8, R11,
// R12) and the alert drafts. Pure: no I/O, no clock other than scenario.now.
import { digestOf } from "@agate/report";
import type { Address } from "@agate/report/types";
import { Kind } from "@agate/report/types";
import { vetoBy as vetoByOf, vetoDue } from "../clock.ts";
import { cent, computeRecord, median } from "../formula.ts";
import { lower, RuleContext } from "./context.ts";
import type {
  AlertDraft,
  CandidateRecord,
  CandidateVerdict,
  Evaluation,
  HistoryDay,
  RuleAction,
  RuleScenario,
  SlotView,
} from "./types.ts";
import { fixOk, gate, hand, near, strict, vetoView } from "./verdicts.ts";

export class ScenarioError extends Error {}

function assertShape(sc: RuleScenario): void {
  const n = sc.gpu.nSlots;
  const bad = (m: string) => {
    throw new ScenarioError(`bad scenario: ${m}`);
  };
  if (sc.version !== 1) bad("version");
  if (!(n >= 1 && n <= 15)) bad("nSlots");
  for (const [k, a] of [["family", sc.gpu.family], ["liveFrom", sc.gpu.liveFrom], ["liveUntil", sc.gpu.liveUntil], ["pre", sc.pre], ["log", sc.log]] as const) {
    if (!Array.isArray(a) || a.length !== n) bad(`${k} length`);
  }
  if (sc.gpu.family.some((f) => !(f >= 0 && f < sc.gpu.famQ.length))) bad("family id");
  const recs: CandidateRecord[] = [...(sc.pending ? [sc.pending] : []), ...sc.candidates];
  for (const c of recs) {
    for (const k of ["p", "kinds", "counts", "post"] as const) if (!Array.isArray(c[k]) || c[k].length !== n) bad(`candidate ${k} length`);
    if (!Number.isFinite(c.value)) bad("candidate value");
  }
  for (const w of sc.writers) {
    for (const k of ["sums", "counts", "slotSlices"] as const) if (!Array.isArray(w[k]) || w[k].length !== n) bad(`writer ${k} length`);
  }
  if (!(sc.clock.slices >= 1 && sc.clock.slices <= 52)) bad("slices");
}

/** The record 4.6 gives this candidate's writer from the scenario's readings, for the formula self-check (9.2). */
function recompute(sc: RuleScenario, c: CandidateRecord): string | null {
  const w = sc.writers.find((x) => lower(x.address) === lower(c.source));
  if (!w) return null;
  const r = computeRecord({
    params: { slices: sc.clock.slices, minReadings: sc.clock.minReadings, qMin: sc.clock.qMin, signAll: sc.clock.signAll, tPend: sc.clock.tPend },
    gpu: { nSlots: sc.gpu.nSlots, family: sc.gpu.family, famQ: sc.gpu.famQ, liveFrom: sc.gpu.liveFrom, liveUntil: sc.gpu.liveUntil },
    gpuId: sc.gpu.gpuId,
    day: sc.day,
    writer: c.source,
    postedAt: 0,
    pre: sc.pre,
    acc: { sums: w.sums, counts: w.counts, sliceBits: w.sliceBits, late: false, anyValid: true },
    prev: null,
    firstRecordDay: sc.firstRecordDay,
    firstWriter: null,
  });
  return r.digest;
}

function prevComputed(ctx: RuleContext, before: number): HistoryDay | null {
  for (let j = before - 1; j >= ctx.sc.gpu.firstDay; j--) {
    const h = ctx.hist.get(j);
    if (!h) return null;
    if (!h.carried) return h;
  }
  return null;
}

function familyValues(ctx: RuleContext, kinds: readonly Kind[], e: readonly number[]): Map<number, number> {
  const by = new Map<number, number[]>();
  kinds.forEach((k, i) => {
    if (k === Kind.OUT) return;
    const f = ctx.gpu.family[i]!;
    by.set(f, [...(by.get(f) ?? []), e[i]!]);
  });
  const out = new Map<number, number>();
  for (const [f, vs] of by) out.set(f, cent(median(vs)));
  return out;
}

export function evaluate(sc: RuleScenario): Evaluation {
  assertShape(sc);
  const ctx = new RuleContext(sc);
  const d = sc.day;
  const W = ctx.W();
  const alerts: AlertDraft[] = [];
  const guardAct = ctx.guardAct;
  const vetoBy = vetoByOf({ day: sc.clock.day, grace: sc.clock.grace ?? sc.clock.day, reopenWait: sc.clock.reopenWait ?? Math.floor(sc.clock.day / 4), epochTs: sc.clock.epochTs, epochDay: sc.clock.epochDay }, d, sc.gpu.registeredAt ?? 0);

  const slots: SlotView[] = [];
  for (let i = 0; i < ctx.n; i++) {
    const rd = ctx.readable(i);
    const e = ctx.expected(i);
    const rem = rd ? ctx.remembered(i) : null;
    const v: SlotView = {
      slot: i,
      readable: rd,
      cls: rd ? ctx.cls(i) : null,
      blind: rd ? ctx.blind(i) : false,
      exp: e.exp,
      complete: rd ? ctx.complete(i) : { t: "unknown" },
      partial: rd ? ctx.partial(i) : { t: "unknown" },
      remembered: rem ? rem.range : { t: "unknown" },
      anchor: rem ? rem.anchor : null,
      vouched: rem ? rem.vouched : null,
      walked: rd ? ctx.walked(i) : null,
    };
    if (e.expAlt !== undefined) v.expAlt = e.expAlt;
    slots.push(v);
  }

  const pending = sc.pending;
  const others = sc.candidates.filter((c) => !pending || lower(c.source) !== lower(pending.source));
  const order: { c: CandidateRecord; isPending: boolean }[] = [
    ...(pending ? [{ c: pending as CandidateRecord, isPending: true }] : []),
    ...others.map((c) => ({ c, isPending: false })),
  ];
  const all = order.map((o) => o.c);
  const lookW = sc.watcherDown && pending ? ctx.lookW(pending) : 0;
  const ref = W !== 0 ? W : lookW;

  const verdicts: CandidateVerdict[] = order.map(({ c, isPending }) => {
    const s = strict(ctx, c);
    const f = fixOk(ctx, c, isPending);
    const nr = near(ctx, c);
    const g = gate(ctx, c, all);
    // H: an incomplete pending record cannot be STRICT, so when FIX-OK it ranks with the STRICT candidates and a
    // STRICT b replaces it only when nearer W(d)
    let tier: 0 | 1 | 2 | 3 = s.ok ? 3 : f.ok ? (isPending && !c.complete ? 3 : 2) : nr.ok ? 1 : 0;
    if (!g.ok) tier = 0;
    return {
      source: c.source,
      digest: c.digest,
      value: c.value,
      isPending,
      complete: c.complete,
      changed: c.changed,
      needsSign: c.needsSign,
      strict: s,
      fixOk: f,
      near: nr,
      gate: g,
      tier,
      dist: ref === 0 ? 0 : Math.abs(c.value - ref),
      r11: hand(ctx, c, false),
      r12: hand(ctx, c, true),
      veto: vetoView(ctx, c, all),
    };
  });

  // ---------------------------------------------------------------- formula self-check (9.2)
  const mismatch: string[] = [];
  for (const c of all) {
    const dg = recompute(sc, c);
    if (dg !== null && dg.toLowerCase() !== c.digest.toLowerCase()) mismatch.push(c.source);
    const own = digestOf({ gpuId: sc.gpu.gpuId, day: d, source: c.source, p: c.p, kinds: c.kinds, counts: c.counts, post: c.post, value: c.value });
    if (own.toLowerCase() !== c.digest.toLowerCase()) mismatch.push(`${c.source} (digest of its own fields)`);
  }

  // ---------------------------------------------------------------- R1
  const better = (a: CandidateVerdict, b: CandidateVerdict) => (a.tier !== b.tier ? b.tier - a.tier : a.dist - b.dist);
  const pick = (vs: CandidateVerdict[]) => [...vs].sort(better)[0] ?? null; // stable: pending first, then slot order
  let action: RuleAction = { kind: "none", why: "no pending record" };
  const pv = verdicts.find((v) => v.isPending) ?? null;
  const othersComplete = verdicts.filter((v) => !v.isPending && v.complete);
  if (mismatch.length > 0) {
    action = { kind: "none", why: `formula mismatch for ${mismatch.join(", ")}: refusing to act` };
    alerts.push({ code: "R1_NO_CANDIDATE", severity: "action", deadline: sc.now + guardAct, message: `day ${d}: offchain formula differs from the chain for ${mismatch.join(", ")}; the attester refuses (9.2)`, data: { mismatch } });
  } else if (pending && pv) {
    if (pending.attestedAt > 0) action = { kind: "none", why: "already attested" };
    else if (pending.needsSign) {
      const best = pick([pv, ...othersComplete].filter((v) => v.tier >= 2));
      if (best) action = best.isPending ? { kind: "attest", writer: best.source, digest: best.digest, why: `countersign, tier ${best.tier}` } : { kind: "select", writer: best.source, digest: best.digest, why: `select, tier ${best.tier} over the pending tier ${pv.tier}` };
      else {
        action = { kind: "none", why: "needsSign and no STRICT or FIX-OK candidate" };
        alerts.push({ code: "R1_NO_CANDIDATE", severity: "action", deadline: (sc.alertRaisedAt ?? sc.now) + guardAct, message: `day ${d}: needsSign record of ${pending.source} (${pending.value}) has no candidate the attester can sign; guardian procedure (6.6): R11, then R12 with looks, then R3; else the liveness veto (step 3b), which may wait until ${vetoBy}`, data: { tiers: verdicts.map((v) => ({ source: v.source, tier: v.tier, why: [...v.strict.why.slice(0, 2), ...v.fixOk.why.slice(0, 2)] })), vetoBy } });
      }
    } else {
      const b = pick(othersComplete);
      if (b && (b.tier > pv.tier || (pv.tier === 3 && b.tier === 3 && b.value !== pv.value && b.dist < pv.dist))) {
        action = { kind: "select", writer: b.source, digest: b.digest, why: b.tier > pv.tier ? `select tier ${b.tier} over the pending tier ${pv.tier}` : "both STRICT, nearer W(d) (D6)" };
      } else action = { kind: "none", why: pv.tier === 3 ? "pending record STRICT; final by itself" : "nothing better to select" };
      if (pv.tier < 3) {
        const selected = action.kind === "select";
        alerts.push({ code: "R9_UNCHANGED_NOT_STRICT", severity: selected ? "info" : "action", writer: pending.source, ...(selected ? {} : { deadline: pending.finalAt }), message: `day ${d}: unchanged record of ${pending.source} is not STRICT (${pv.strict.why.slice(0, 3).join("; ")})${selected ? `; selected ${action.writer}` : "; a person acts before its finalAt (R3, R8)"}` });
      }
    }
  }

  // ---------------------------------------------------------------- guardian view
  const handPick = (key: "r11" | "r12", filter: (v: CandidateVerdict) => boolean) => {
    const ok = verdicts.filter((v) => v[key].ok && filter(v));
    const best = [...ok].sort((a, b) => a.dist - b.dist)[0];
    return best ? { writer: best.source, digest: best.digest, value: best.value } : null;
  };
  const r3open = (v: CandidateVerdict) => v.veto.actionable;
  // R11 has no R3 exclusion: its strict hand range already takes the writer-region looks (a view split the writer
  // really saw); only R12 must never sign a candidate with an R3 reason R7 does not excuse
  const r11 = handPick("r11", () => true);
  const looksNeeded = new Set<number>();
  for (let i = 0; i < ctx.n; i++) {
    if (!ctx.readable(i)) continue;
    const pr = ctx.partial(i);
    if (sc.watcherDown || ctx.blind(i) || (pr.t === "int" && pr.open) || pr.t === "unknown") looksNeeded.add(i);
    // W1: a slot some candidate holds (or takes OUT) while the watcher reads it FRESH: R12's HELD/FRESH row needs a look
    else if (ctx.cls(i) === "FRESH" && all.some((c) => c.counts[i]! < ctx.MR)) looksNeeded.add(i);
  }
  for (const v of verdicts) for (const i of [...v.veto.slotReasons, ...v.veto.darkReasons]) if (!v.veto.confirmed.includes(i)) looksNeeded.add(i);
  const missingLooks = [...looksNeeded].filter((i) => ctx.looksOf(i).length === 0);
  const r12Why: string[] = [];
  if (r11) r12Why.push("a candidate passes R11");
  const timeCame = sc.droppedSinceLastComputed === true || (sc.alertRaisedAt !== undefined && sc.now >= sc.alertRaisedAt + guardAct);
  if (!timeCame) r12Why.push(sc.alertRaisedAt === undefined ? "no R1_NO_CANDIDATE, R9 (a) or R5 alert yet" : `R12's time comes at ${sc.alertRaisedAt + guardAct}`);
  if (missingLooks.length > 0) r12Why.push(`looks missing for slots ${missingLooks.join(",")}`);
  const r12Ready = r12Why.length === 0;
  const r12 = handPick("r12", (v) => !r3open(v) && v.veto.slotReasons.every((i) => v.veto.confirmed.includes(i) || ctx.looksOf(i).length > 0));
  let vetoTarget: Evaluation["guardian"]["veto"] = pv && pv.veto.actionable && pending && !(pending.finalAt > 0 && sc.now >= pending.finalAt)
    ? { writer: pv.source, digest: pv.digest, reasons: [...(pv.veto.fixOutside && !pv.veto.r7.fix ? ["fix"] : []), ...pv.veto.confirmed.map((i) => `slot ${i}`)] }
    : null;
  // 6.6 step 3b (N1, N2): a needsSign record that nothing signs under R11 or R12 (its looks taken) is vetoed by name,
  // whatever R7 says (it judges values; this veto judges nothing, round 2); the day then closes from the next writer
  // (which gets the same steps) or carries within B instead of dropping at HOLD_MOVE. Never an R8 reason.
  if (!vetoTarget && pv && pending && pending.needsSign && pending.attestedAt === 0 && r12Ready && !r12)
    vetoTarget = { writer: pv.source, digest: pv.digest, reasons: ["liveness: no candidate passes R11 or R12 (6.6 step 3b; never an R8 reason)"], liveness: true };
  // Oct 3: with no R11 or R12 candidate the liveness veto may be deferred to VETO_BY (the guardian checks the kept
  // evidence meanwhile); it is due by the later of VETO_BY and the alert plus GUARD_ACT
  const stuck = pending && pending.needsSign && pending.attestedAt === 0 && !r11 && !r12 ? { vetoBy, due: vetoDue(vetoBy, sc.alertRaisedAt ?? sc.now, guardAct) } : undefined;

  // R8 (a) (b) (c): with R7 not applying
  const r8: { writer: Address; reason: string }[] = [];
  const pc = prevComputed(ctx, d);
  for (const v of verdicts) {
    if (!v.isPending) continue;
    const otherGood = verdicts.some((o) => o !== v && (o.strict.ok || o.fixOk.ok));
    // a fix outside the VETO range that comes from slots a writer-region look shows at the writer's own value is a
    // view split (HF-5, HF-6: the watcher's view is not the writer's), never a reason to suspend; until such a look
    // exists the reason stands but says to look first
    const split = v.veto.slotReasons.length > 0 && v.veto.slotReasons.every((i) => !v.veto.confirmed.includes(i) && ctx.looksOf(i).some((lk) => lk.cell === all.find((c) => c.source === v.source)!.p[i]));
    const fixBad = v.veto.fixOutside && !v.veto.r7.fix && !split;
    const lookFirst = v.veto.slotReasons.some((i) => !v.veto.confirmed.includes(i)) ? " (look from the writer's region first: a look showing the writer's own value is a view split, not a theft)" : "";
    if (fixBad && otherGood) r8.push({ writer: v.source, reason: `R8 (a): fix outside the VETO fix range while another record was STRICT or FIX-OK${lookFirst}` });
    // R8 memory of the day before (its pending record may since have been vetoed, dropped or replaced)
    const memo = ctx.hist.get(d - 1)?.r8?.find((m) => lower(m.writer) === lower(v.source));
    if (fixBad && memo?.fixOutside) r8.push({ writer: v.source, reason: `R8 (b): fix outside the VETO fix range on ${d - 1} and ${d}${lookFirst}` });
    if (memo && !memo.replaced) {
      for (const i of v.veto.confirmed) {
        const r7 = v.veto.slotReasons.includes(i) ? v.veto.r7.slot : v.veto.r7.dark;
        if (!r7 && memo.confirmedSlots.includes(i)) r8.push({ writer: v.source, reason: `R8 (c): slot ${i} reason confirmed on ${d - 1} and ${d}` });
      }
    }
  }

  // ---------------------------------------------------------------- alerts
  if (pv && pending) {
    const reasons: string[] = [];
    if (pv.veto.fixOutside && !pv.veto.r7.fix) reasons.push("fix outside the VETO fix range");
    for (const i of pv.veto.slotReasons) if (!pv.veto.r7.slot) reasons.push(`slot ${i} outside its VETO range${pv.veto.confirmed.includes(i) ? " (confirmed by a writer-region look)" : " (needs a writer-region look first)"}`);
    for (const i of pv.veto.darkReasons) if (!pv.veto.r7.dark) reasons.push(`slot ${i} fresh only from dark slices${pv.veto.confirmed.includes(i) ? " (confirmed)" : " (needs a writer-region look first)"}`);
    const fin = pending.finalAt > 0 ? pending.finalAt : Infinity;
    if (reasons.length > 0 && !(pending.finalAt > 0 && sc.now >= pending.finalAt))
      alerts.push({ code: "R3_VETO_REASON", severity: "action", writer: pending.source, deadline: Math.min(sc.now + guardAct, fin), message: `day ${d}: ${pending.source}: ${reasons.join("; ")}. Veto only the record you checked: veto(gpu, ${d}, ${pending.source}, ${pending.digest})`, data: { digest: pending.digest, confirmed: pv.veto.confirmed } });
  }
  for (const x of r8) alerts.push({ code: "R8_SUSPEND_REASON", severity: "action", writer: x.writer, message: `day ${d}: ${x.reason}` });

  for (let i = 0; i < ctx.n; i++) {
    const sv = slots[i]!;
    if (!sv.readable) continue;
    const heldSomewhere = sv.exp === Kind.HELD || sv.expAlt === Kind.HELD || all.some((c) => c.kinds[i] === Kind.HELD);
    const rem = ctx.remembered(i);
    if (heldSomewhere && rem.mismatch)
      alerts.push({ code: "R9_HELD_MISMATCH", severity: "action", slot: i, message: `day ${d} slot ${i}: held value ${ctx.pre[i]!.e} is not vouched and lies outside the watcher's range of its anchor day ${rem.anchor} (F9)` });
    if (heldSomewhere && rem.unvouched)
      alerts.push({ code: "R9_HELD_UNVOUCHED", severity: "action", slot: i, message: `day ${d} slot ${i}: held value ${ctx.pre[i]!.e} taken at its onchain value; anchor day ${rem.anchor} is not checkable` });
    if (sv.walked !== null && sv.walked !== ctx.pre[i]!.miss)
      alerts.push({ code: "R9_MISS_MISMATCH", severity: "action", slot: i, message: `day ${d} slot ${i}: walked count ${sv.walked} differs from the onchain miss ${ctx.pre[i]!.miss} (find the record whose freshness differed: R4, R4b)` });
    if (sv.cls === "UNKNOWN") {
      const readers = verdicts.filter((v) => all.find((c) => c.source === v.source)!.counts[i]! >= ctx.MR);
      const allUnver = readers.length > 0 && readers.every((v) => v.strict.slots[i]?.result === "unverifiable");
      alerts.push({ code: "R9_UNCLASSIFIABLE", severity: allUnver ? "action" : "info", slot: i, ...(allUnver ? { deadline: sc.now + guardAct } : {}), message: `day ${d} slot ${i}: the watcher cannot classify it; checked against its partial range${allUnver ? "; unverifiable for every candidate (R11, R12 with looks)" : ""}` });
    }
    if (sv.cls !== "FRESH") {
      const comp = all.filter((c) => c.complete);
      const split = comp.some((a) => comp.some((b) => a !== b && (a.kinds[i] !== b.kinds[i] || a.p[i] !== b.p[i])));
      if (split) alerts.push({ code: "R9B_BLIND_SLOT_SPLIT", severity: "action", slot: i, deadline: sc.now + guardAct, message: `day ${d} slot ${i}: complete records differ on a slot the watcher cannot read fresh; look from the writer's region and select the matching record (R9b, R11)` });
    }
  }

  // finding I: two STRICT records whose fixes differ only through slots judged on the partial range (the complete
  // range UNKNOWN): W(d) cannot tell which side of a step the watcher slept through, so a person looks (R9b, R11)
  const strictC = verdicts.filter((v) => v.strict.ok && v.complete);
  const viaPartial = (i: number) => slots[i]!.readable && (slots[i]!.cls === "UNKNOWN" || slots[i]!.complete.t !== "int");
  const partialSplit = new Set<number>();
  for (const a of strictC) {
    for (const b of strictC) {
      if (a === b || a.value === b.value) continue;
      const ca = all.find((c) => c.source === a.source)!;
      const cb = all.find((c) => c.source === b.source)!;
      const diff = [...Array(ctx.n).keys()].filter((i) => ctx.readable(i) && (ca.kinds[i] !== cb.kinds[i] || ca.p[i] !== cb.p[i]));
      if (diff.length > 0 && diff.every(viaPartial)) for (const i of diff) partialSplit.add(i);
    }
  }
  for (const i of partialSplit) {
    if (slots[i]!.cls !== "FRESH") continue; // raised above
    const fin = pending && pending.finalAt > 0 ? pending.finalAt : Infinity;
    alerts.push({ code: "R9B_BLIND_SLOT_SPLIT", severity: "action", slot: i, deadline: Math.min(sc.now + guardAct, fin), message: `day ${d} slot ${i}: two STRICT records differ only on slots judged on the partial range (the watcher missed part of the day); look from the writer's region and select the matching record (R9b, R11)` });
  }


  if (pc) {
    for (let i = 0; i < ctx.n; i++) {
      if (!ctx.readable(i) || !ctx.readable(i, pc.day)) continue;
      if (ctx.cls(i) === "FRESH" && ctx.cls(i, pc.day) === "FRESH") {
        for (const w of sc.writers) {
          const wPrev = pc.writers?.find((x) => lower(x.address) === lower(w.address));
          if (w.eligible && wPrev && w.counts[i]! < ctx.MR && wPrev.counts[i]! < ctx.MR)
            alerts.push({ code: "R4_WRITER_FETCH", severity: "action", slot: i, writer: w.address, message: `slot ${i} fresh for the watcher, not for ${w.address}, on ${pc.day} and ${d}: reroute that writer's fetch (R4)` });
        }
      }
      if (ctx.live(i) && ctx.cls(i) === "NOT_FRESH" && ctx.cls(i, pc.day) === "NOT_FRESH") {
        const a = ctx.ev[i]!.darkCount(d);
        const b = ctx.ev[i]!.darkCount(pc.day);
        if (a.dark * 2 > ctx.geom.slices && b.dark * 2 > ctx.geom.slices)
          alerts.push({ code: "R4B_WATCHER_DARK", severity: "action", slot: i, deadline: sc.now + guardAct, message: `slot ${i} dark in the watcher's log on ${pc.day} and ${d}: open it from the writer's region (R4b)` });
      }
    }
    if (pending && pc.value !== undefined && pc.kinds && pc.post && pending.value !== pc.value) {
      const before = familyValues(ctx, pc.kinds, pc.post.map((s) => s.e));
      const after = familyValues(ctx, pending.kinds, pending.post.map((s) => s.e));
      const up = pending.value > pc.value;
      let moved = 0;
      for (const [f, v] of after) {
        const b = before.get(f);
        if (b !== undefined && (up ? v > b : v < b)) moved++;
      }
      if (moved < 2) alerts.push({ code: "R10_SPLIT_STEP", severity: "action", message: `day ${d}: the fix moved ${pc.value} -> ${pending.value} with ${moved} famil${moved === 1 ? "y" : "ies"} moving: open the pages (R10)` });
    }
  }

  return {
    day: d,
    now: sc.now,
    W,
    slots,
    candidates: verdicts,
    action,
    guardian: { r11, r12: r12Ready ? r12 : null, r12Ready, r12Why, looksNeeded: [...looksNeeded], veto: vetoTarget, r8, ...(stuck ? { stuck } : {}) },
    alerts,
  };
}
