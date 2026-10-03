// The e2e and chaos scenarios (BUILD-SPEC 11, 12.6): each builds a World, runs it on the warped clock, applies its
// chaos at scripted moments, then judges it. Synthetic pages are hand-written by the replay server's renderers
// (numbers only); archive runs read the live logger's archive in place through a symlink view. The Oct 3 upgrade
// scenarios (17.2 Integrate) live in upgrades.ts and run after these.
import type { ReplayScenario, ScriptedSource } from "@agate/sources/io";
import { GPUS } from "@agate/sources/pure";
import { AlertCode } from "@agate/report/types";
import { archiveView } from "./archive.ts";
import { ActionKind, ADDR, executeAction, PROFILES, queueAction, ROLE, ZERO } from "./chain.ts";
import type { WallEvent } from "@agate/watcher";
import { demoScenario, final, GUARD, guard, H100_ID, h100World, KIND, lc, NOV1, OCT1, p, relDay, runWorld, type Scenario, slotsOf, type Steps, T0, withRoles } from "./kit.ts";
import { readAlerts } from "./report.ts";
import { UPGRADE_SCENARIOS } from "./upgrades.ts";
import type { Proc, World } from "./world.ts";

export { h100World, haveSandbox, NOV1, OCT1, T0, type Scenario } from "./kit.ts";

// ------------------------------------------------------------------ the base runs

/** Every GPU of the recipe (six since 18: the price-only B300, A100 and L40S beside H100, H200 and B200). */
const ALL_GPUS = GPUS.map((gpu) => ({ gpu }));

const fastBase: Scenario = {
  name: "fast-base",
  what: "FAST profile, six GPUs (default.json), the archive replayed (finished Oct 1 hours) plus the demo's scripted step (Lambda H100 3.49 from demo day 3); the primary through the CRE path's mock forwarder, the standby direct; watcher, attester, keeper, health, guardian",
  needsArchive: true,
  run: async () => {
    const view = archiveView((date) => date === "2026-10-01");
    return runWorld(
      { name: "fast-base", profile: PROFILES.FAST, startTs: T0, epochDay: NOV1, gpus: ALL_GPUS, scenario: demoScenario(), rawDir: view.rawDir, primary: { viaForwarder: true }, standby: {}, guardian: GUARD },
      (w) => w.dayEnd(relDay(w, 12)) + 30,
      { expectAlerts: [AlertCode.R1_SIGNED], forbidAlerts: [AlertCode.R1_NO_CANDIDATE, AlertCode.HEARTBEAT_LOST, AlertCode.GAS_CAP, AlertCode.NONCE_STUCK, AlertCode.CLOCK_SKEW, AlertCode.RPC_DOWN] },
    );
  },
};

const fastArchiveFull: Scenario = {
  name: "fast-archive-full",
  what: "FAST, six GPUs, the WHOLE archive (Sep 30 17h to Oct 1): Nebius's dated 'from October 1' block flips its prices (B300's too) as the replay cycles across midnight, several times inside one 12-second slice",
  needsArchive: true,
  run: async () => {
    // pinned to the archive this scenario was written for (Sep 30 17h to Oct 1, its midnight flip); the live archive
    // keeps growing, and later hours hold real intra-day price changes the FAST replay compresses (integration.md)
    const view = archiveView((date) => date <= "2026-10-01");
    return runWorld(
      { name: "fast-archive-full", profile: PROFILES.FAST, startTs: T0, epochDay: NOV1, gpus: ALL_GPUS, scenario: demoScenario(), rawDir: view.rawDir, primary: { viaForwarder: true }, standby: {}, guardian: GUARD },
      (w) => w.dayEnd(relDay(w, 8)) + 30,
      {},
    );
  },
};

const demoBase: Scenario = {
  name: "demo-base",
  what: "DEMO profile (600 s day, 4 slices), six GPUs (default.json: six closes a demo day, the launch demo's shape) on the finished Oct 1 archive hours plus the scripted step on demo day 3 (Lambda H100 only); the primary through the CRE path's mock forwarder, the standby direct; full watcher, guardian",
  needsArchive: true,
  run: async () => {
    const view = archiveView((date) => date === "2026-10-01");
    return runWorld(
      { name: "demo-base", profile: PROFILES.DEMO, startTs: T0, epochDay: NOV1, gpus: ALL_GPUS, scenario: demoScenario(), rawDir: view.rawDir, primary: { viaForwarder: true }, standby: {}, guardian: GUARD },
      (w) => w.dayEnd(relDay(w, 5)) + 300,
      { expectAlerts: [AlertCode.R1_SIGNED], forbidAlerts: [AlertCode.R1_NO_CANDIDATE, AlertCode.HEARTBEAT_LOST, AlertCode.GAS_CAP, AlertCode.NONCE_STUCK, AlertCode.CLOCK_SKEW] },
    );
  },
};

const fastRealtime: Scenario = {
  name: "fast-realtime-viem-cache",
  what: "FAST in real time (one index second per real second) with the watcher's viem clients at their default 4 s block-number cache, as the demo would run them: does the attester see fresh closes in time?",
  run: async () =>
    runWorld(
      { name: "fast-realtime-viem-cache", profile: PROFILES.FAST, startTs: T0, epochDay: NOV1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World() }, primary: {}, standby: {}, guardian: null, realtime: true, viemCache: true },
      (w) => w.dayEnd(relDay(w, 4)) + 26,
      { forbidAlerts: [AlertCode.R1_NO_CANDIDATE] },
    ),
};

// ------------------------------------------------------------------ chaos (12.6)



/** T1 / chaos (A): slot 4 (3.80, not the median) NOT_RENTABLE from slice 5 of day D, dark for everyone D+1 to D+6,
 *  back on D+7; every page +0.60 from D+8. Nobody acting. */
const pageDark: Scenario = {
  name: "chaos-page-dark-6d",
  what: "TEST: slot 4 not rentable from slice 5 of D, dark for everyone D+1 to D+6, back D+7, every page +0.60 from D+8; nobody acting (no guardian)",
  run: async () => {
    const D = 2;
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    for (let i = 0; i < 5; i++) steps[i as 0] = [{ from: { day: D + 8 }, ...p(plus(base[i]!)) }];
    steps[4] = [{ from: { day: D, slice: 5 }, state: "not-rentable" }, { from: { day: D + 1 }, state: "missing" }, { from: { day: D + 7 }, ...p(base[4]!) }, { from: { day: D + 8 }, ...p(plus(base[4]!)) }];
    return runWorld(
      { name: "chaos-page-dark-6d", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World(steps) }, primary: {}, standby: {}, guardian: null },
      (w) => w.dayEnd(relDay(w, D + 10)) + 900,
      {
        extra: (w, ev, days) => {
          const d = relDay(w, D);
          const fD = final(days, d);
          const sD = fD && slotsOf(ev, H100_ID, d);
          const exit = final(days, d + 5);
          const sExit = exit && slotsOf(ev, H100_ID, d + 5);
          const att = ADDR[ROLE.attester]!;
          return [
            { name: "D: slot 4 HELD", ok: Boolean(fD?.final && sD && sD.kinds[4] === KIND.HELD), detail: `day ${d}: ${fD?.final ? "final" : "not final"}, slot 4 kind ${sD?.kinds[4]}` },
            { name: "D+5: slot 4 exits, signed by the attester", ok: Boolean(exit?.final && sExit && sExit.kinds[4] === KIND.OUT && (exit!.needsSign ? lc(exit!.attestedBy) === lc(att) : true)), detail: `day ${d + 5}: kind ${sExit?.kinds[4]}, needsSign ${exit?.needsSign}, attested by ${exit?.attestedBy}` },
            { name: "D+8: fixes follow the +0.60 move", ok: final(days, d + 8)?.value === 4_000_000, detail: `day ${d + 8}: ${final(days, d + 8)?.value}` },
          ];
        },
      },
    );
  },
};

/** T1 / chaos (A2): the watcher misses 7 of 12 intervals on day G, during an existing dark spell of an OUT slot;
 *  +0.60 on every page from G+2. */
const watcherGap: Scenario = {
  name: "chaos-watcher-gap-7of12",
  what: "TEST: slot 4 dark from day 1 (OUT from day 6); the watcher's logger process is down for intervals 3 to 9 of day 8 (7 of 12); every page +0.60 from day 10; guardian on",
  run: async () => {
    const G = 8;
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    for (let i = 0; i < 4; i++) steps[i as 0] = [{ from: { day: G + 2 }, ...p(plus(base[i]!)) }];
    steps[4] = [{ from: { day: 1 }, state: "missing" }];
    return runWorld(
      { name: "chaos-watcher-gap-7of12", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World(steps) }, primary: {}, standby: {}, guardian: guard(PROFILES.TEST.day) },
      (w) => {
        const from = w.sliceStart(relDay(w, G), 3);
        const to = w.sliceStart(relDay(w, G), 10);
        w.down = (pp, t) => pp === "log" && t >= from && t < to;
        return w.dayEnd(relDay(w, G + 4)) + 900;
      },
      {
        expectAlerts: [AlertCode.WATCHER_GAP],
        extra: (w, _ev, days) => {
          const g = relDay(w, G);
          const later = days.filter((x) => x.day > g && x.final && x.status !== "CARRIED").length;
          return [
            { name: "gap day final, later days computed", ok: Boolean(final(days, g)?.final) && later >= 3, detail: `day ${g}: ${final(days, g)?.status} ${final(days, g)?.final ? "final" : "not final"}; ${later} later computed final days` },
            // slot 4 is OUT: the 4-slot median (3.20 + 3.40) / 2 = 3.30 moves to 3.90
            { name: "G+2: fixes follow the move", ok: final(days, g + 2)?.value === 3_900_000, detail: `day ${g + 2}: ${final(days, g + 2)?.value}` },
          ];
        },
      },
    );
  },
};


/** T2 / chaos (G): both writers blocked from slot 3 on day X while the watcher reads it; dark for everyone from X+1;
 *  +0.60 on every page at X+9. */
const writersBlocked: Scenario = {
  name: "chaos-writers-blocked-then-dead",
  what: "TEST: both writers get HTTP 503 from slot 3's page on day X=3 while the watcher reads it; the page is dark for everyone from X+1; every page +0.60 from X+9; guardian on",
  run: async () => {
    const X = 3;
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    for (const i of [0, 1, 2, 4]) steps[i as 0] = [{ from: { day: X + 9 }, ...p(plus(base[i]!)) }];
    steps[3] = [{ from: { day: X + 1 }, state: "missing" }];
    const scripted = h100World(steps);
    return runWorld(
      { name: "chaos-writers-blocked-then-dead", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: withRoles(scripted, "p_civo", ["primary", "standby"], [{ from: { day: X }, state: "http-503" }, { from: { day: X + 1 }, state: "ok" }]), primary: {}, standby: {}, guardian: guard(PROFILES.TEST.day) },
      (w) => w.dayEnd(relDay(w, X + 10)) + 900,
      {
        expectAlerts: [AlertCode.R9_MISS_MISMATCH],
        extra: (w, ev, days) => {
          const x = relDay(w, X);
          const exit = final(days, x + 5);
          const sExit = exit && slotsOf(ev, H100_ID, x + 5);
          return [
            { name: "X final", ok: Boolean(final(days, x)?.final && final(days, x)?.status !== "CARRIED"), detail: `day ${x}: ${final(days, x)?.status}` },
            { name: "X+5: slot 3 exits, signed by the attester", ok: Boolean(exit?.final && sExit?.kinds[3] === KIND.OUT && lc(exit!.attestedBy) === lc(ADDR[ROLE.attester]!)), detail: `day ${x + 5}: kind ${sExit?.kinds[3]}, attested by ${exit?.attestedBy}` },
            // slot 3 is OUT: the 4-slot median (3.20 + 3.40) / 2 = 3.30 moves to 3.90
            { name: "X+9: fixes follow the move", ok: final(days, x + 9)?.value === 3_900_000, detail: `day ${x + 9}: ${final(days, x + 9)?.value}` },
          ];
        },
      },
    );
  },
};

/** T3 / chaos (D): slot 4 queued for Nov 1 (its page 3.40); the stolen primary types 4.50 for it on the five shadow
 *  days (thief_v42 D). The GPU is registered on Sep 28 with firstDay Oct 24 (LIVE_FROM must be queued before Oct 1). */
type PlantVariant = "standby" | "standby-blocked-nov1" | "no-standby-guardian" | "no-standby-guardian-late" | "no-standby-nobody";
function plantScenario(name: string, variant: PlantVariant): Scenario {
  const noStandby = variant.startsWith("no-standby");
  return {
    name,
    what: `TEST: H100 slot 4 queued for Nov 1 (page 3.40), the stolen primary types 4.50 for it on the shadow days Oct 27 to 31; ${
      { standby: "honest standby", "standby-blocked-nov1": "honest standby, slot 4's page blocked for the standby on Nov 1", "no-standby-guardian": "no standby, slot 4's page dark for everyone on Nov 1, the guardian acting throughout",
      "no-standby-guardian-late": "no standby, slot 4's page dark for everyone on Nov 1, the guardian acting only from Nov 1 (the plant has landed: R12)", "no-standby-nobody": "no standby, slot 4's page dark for everyone on Nov 1, nobody acting (L1b)" }[variant]
    }`,
    run: async () => {
      const day = PROFILES.TEST.day;
      const SEP1 = 20_697;
      const SEP28 = 20_724;
      const FIRST = NOV1 - 8;
      const startTs = T0;
      const epochTs = startTs - (SEP28 - SEP1) * day - 5;
      const gpuId = H100_ID as `0x${string}`;
      const k = (d: number) => d - SEP1;
      const scripted = h100World({}, ["3.00", "3.20", "3.60", "3.80", "3.40"]);
      const dark: ScriptedSource = { gpus: { H100: [{ from: { day: 0 }, ...p("3.40") }, { from: { day: k(NOV1) }, state: "missing" }, { from: { day: k(NOV1 + 1) }, ...p("3.40") }] } };
      const scenario: ReplayScenario = { archive: false, scripted };
      if (noStandby) scripted.p_hyperstack = dark;
      if (variant === "standby-blocked-nov1") scenario.roles = { standby: { p_hyperstack: dark } };
      const shadow = (d: number) => d >= NOV1 - 5 && d < NOV1;
      return runWorld(
        {
          name,
          profile: PROFILES.TEST,
          startTs,
          epochTs,
          epochDay: SEP1,
          firstDay: FIRST,
          gpus: [{ gpu: "H100", liveAtStartMask: 0b01111 }],
          scenario,
          primary: { thief: ({ dayId, values }) => (shadow(dayId) ? values.map((v, i) => (i === 4 && v ? 4_500_000 : v)) : values) },
          standby: noStandby ? null : {},
          guardian: variant === "no-standby-nobody" ? null : { ...guard(day), ...(variant === "no-standby-guardian-late" ? { from: epochTs + (NOV1 - SEP1) * day } : {}) },
          setup: async (w) => {
            const act = { kind: ActionKind.LIVE_FROM, slot: 4, addr: ZERO, gpuId, day: NOV1, mode: 0 };
            await queueAction(w.a, w.dep.index, act);
            w.now = await w.a.warp(w.now + w.wc.timelock + 1);
            await executeAction(w.a, w.dep.index, act);
            w.now = await w.a.warp(w.dayStart(FIRST) + 1);
          },
        },
        (w) => w.dayEnd(NOV1 + (variant === "no-standby-nobody" ? 8 : 3)) + 900,
        {
          // the primary reads honestly outside the shadow days: its true-page record is the reference; with no
          // standby a planted held value is residual 1 from the first shadow day on
          ...(noStandby ? { honest: ["primary"] as ("primary" | "standby")[], honestOn: (_r: string, d: number) => !shadow(d), residual: (_g: string, d: number) => (d >= NOV1 - 5 ? "residual 1: the plant lands with no honest writer" : undefined) } : {}),
          thieves: ["primary"],
          ...(variant === "no-standby-nobody" ? { l1b: true, maxDrops: 5 } : {}),
          // 12.6 expects the plant to land and R9_HELD_MISMATCH on Nov 1; with the guardian acting, 6.6's R3 step vetoes
          // the plant on the first shadow day instead (D3 makes its slot reason confirmable by a look) and R8 (c)
          // suspends the thief on the second: see the findings
          ...(variant === "no-standby-guardian" ? { expectAlerts: [AlertCode.R3_VETO_REASON, AlertCode.R8_SUSPEND_REASON] } : {}),
          ...(variant === "no-standby-nobody" || variant === "no-standby-guardian-late" ? { expectAlerts: [AlertCode.R9_UNCHANGED_NOT_STRICT, AlertCode.R9_HELD_MISMATCH] } : {}),
          lagFrom: FIRST,
          extra: (w, ev, days) => {
            const thief = lc(ADDR[ROLE.primary]!);
            const out = [];
            const nov1 = final(days, NOV1);
            const s = nov1 && slotsOf(ev, H100_ID, NOV1, undefined);
            if (!noStandby) {
              const thiefFinal = days.filter((x) => x.final && x.status !== "CARRIED" && shadow(x.day) && lc(x.source) === thief);
              out.push({ name: "shadow days: never the thief's record", ok: thiefFinal.length === 0, detail: thiefFinal.length ? thiefFinal.map((x) => x.day).join(", ") : "every shadow day final from the standby" });
              out.push({ name: "Nov 1: slot 4 enters at 3.40", ok: Boolean(nov1?.final && s && s.kinds[4] !== KIND.OUT && s.post[4]!.e === 3_400_000), detail: `kind ${s?.kinds[4]}, e ${s?.post[4]?.e}` });
            } else if (variant === "no-standby-guardian") {
              const planted = days.filter((x) => x.final && x.status !== "CARRIED" && lc(x.source) === thief && shadow(x.day));
              out.push({ name: "no planted shadow record final; Nov 1 final within LAG_MAX", ok: planted.length === 0 && Boolean(nov1?.final && (nov1.lag ?? Infinity) <= w.wc.lagMax), detail: `${planted.length} planted record(s) final; Nov 1 ${nov1?.status} ${nov1?.final ? "final" : "pending"} lag ${nov1?.lag}` });
            } else if (variant === "no-standby-guardian-late") {
              const r12 = (w.guardian?.acts ?? []).filter((a) => a.day === NOV1 && a.act.startsWith("R12") && a.code === 0);
              out.push({ name: "Nov 1 signed by R12 within GUARD_ACT of its alert; final within LAG_MAX", ok: r12.length > 0 && Boolean(nov1?.final && nov1.status !== "CARRIED" && (nov1.lag ?? Infinity) <= w.wc.lagMax), detail: `R12 signatures ${r12.map((a) => a.at).join(", ") || "none"}; Nov 1 ${nov1?.status} ${nov1?.final ? "final" : "pending"} lag ${nov1?.lag} by ${nov1?.attestedBy}; held e ${s?.post[4]?.e}` });
            } else {
              const drops = ev.filter((e) => e.name === "FixDropped").length;
              const after = days.filter((x) => x.day >= NOV1 && x.final && x.status !== "CARRIED" && x.status !== "SKIPPED");
              out.push({ name: "the drop loop ends within HOLD_DAYS drops", ok: drops <= 5 && after.length > 0, detail: `${drops} drop(s); computed final days from Nov 1: ${after.map((x) => x.day).join(", ") || "none"}` });
            }
            return out;
          },
        },
      );
    },
  };
}

/** T4 E / chaos: the honest primary misses one slice and closes at C1; the stolen standby is complete and freezes
 *  the median slot at 3.40 against the page's 3.60. */
function stolenStandby(name: string, belowQuorum: boolean): Scenario {
  return {
    name,
    what: `TEST: the median page steps 3.40 to 3.60 on day 2; the stolen standby keeps posting 3.40 for it; the honest primary ${belowQuorum ? "loses every slice of day 2 but one (below quorum)" : "loses slice 7 of day 2"}; guardian on`,
    run: async () => {
      const D = 2;
      const scripted = h100World({ 2: [{ from: { day: D }, ...p("3.60") }] });
      return runWorld(
        {
          name,
          profile: PROFILES.TEST,
          startTs: T0,
          epochDay: OCT1,
          gpus: [{ gpu: "H100" }],
          scenario: { archive: false, scripted },
          primary: { lose: (d, h) => d === OCT1 + D && (belowQuorum ? h !== 0 : h === 7) },
          standby: { thief: ({ dayId, values }) => (dayId >= OCT1 + D ? values.map((v, i) => (i === 2 && v ? 3_400_000 : v)) : values) },
          guardian: guard(PROFILES.TEST.day),
        },
        (w) => w.dayEnd(relDay(w, D + 3)) + 900,
        {
          ...(belowQuorum ? { residual: (_g: string, d: number) => (d === OCT1 + D ? "the honest primary is below quorum: a carry is honest" : undefined) } : {}),
          extra: (w, _ev, days) => {
            const thief = lc(ADDR[ROLE.standby]!);
            const bad = days.filter((x) => x.final && x.status !== "CARRIED" && lc(x.source) === thief);
            const d = final(days, relDay(w, D));
            return [
              { name: "the thief is never the source of a final record", ok: bad.length === 0, detail: bad.length ? bad.map((x) => x.day).join(", ") : "never" },
              { name: belowQuorum ? "day D: carried or the primary's (never the thief's)" : "day D: the primary is the source", ok: belowQuorum ? Boolean(d?.final && (d.status === "CARRIED" || lc(d.source) === lc(ADDR[ROLE.primary]!))) : Boolean(d?.final && lc(d.source) === lc(ADDR[ROLE.primary]!)), detail: `${d?.status} from ${d?.source} ${d?.final ? "final" : "pending"}` },
            ];
          },
        },
      );
    },
  };
}

/** chaos: the local machine asleep 3 hours, every process paused. DEMO: 18 demo days; PRODUCTION: 3 slices mid-day on a step day. */
const sleepDemo: Scenario = {
  name: "chaos-mac-asleep-demo",
  what: "DEMO: every process (both writers, logger, attester, keeper, health, guardian) paused for 3 hours (18 demo days) from mid demo day 2",
  run: async () => {
    let from = 0;
    let to = 0;
    let wv: World | undefined;
    return runWorld(
      { name: "chaos-mac-asleep-demo", profile: PROFILES.DEMO, startTs: T0, epochDay: NOV1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World({ 2: [{ from: { day: 10 }, ...p("3.50") }] }) }, primary: {}, standby: {}, guardian: guard(PROFILES.DEMO.day) },
      (w) => {
        wv = w;
        from = w.sliceStart(relDay(w, 2), 2) + 20;
        to = from + 3 * 3_600;
        w.down = (_p, t) => t >= from && t < to;
        return to + 12 * PROFILES.DEMO.day;
      },
      {
        expectAlerts: [AlertCode.CLOCK_JUMP, AlertCode.HEARTBEAT_LOST, AlertCode.R5_HEAD_LAG],
        // A1 does not hold while the keeper sleeps: days whose deadline falls in the sleep or in the catch-up (one carry
        // per STEP, 6.8 item 8) are not L1's; every later day is
        lagSkip: (d) => wv!.dayEnd(d) + wv!.wc.lagMax >= from && wv!.dayStart(d) <= to + 20 * wv!.wc.step,
        extra: async (w, ev, days) => {
          const carries = ev.filter((e): e is Extract<WallEvent, { name: "DayCarried" }> => e.name === "DayCarried");
          const times: number[] = [];
          for (const e of carries) times.push(Number((await w.a.pub.getBlock({ blockNumber: BigInt(Number(e.key.split(":")[0])) })).timestamp));
          const gaps = times.slice(1).map((t, i) => t - times[i]!);
          const minGap = gaps.length ? Math.min(...gaps) : Infinity;
          const advanced = carries.filter((e) => e.missAdvanced !== 0);
          const lastDay = days.filter((x) => x.final).at(-1);
          const caughtUp = lastDay ? w.now - w.dayEnd(lastDay.day) <= w.wc.lagMax : false;
          const openLost = readAlerts(w).filter((a) => a.code === AlertCode.HEARTBEAT_LOST);
          const stillOpen = new Map<string, boolean>();
          for (const a of openLost) stillOpen.set((a as { id?: string }).id ?? "", a.cleared === undefined);
          return [
            { name: "slept days carried, one per STEP", ok: carries.length >= 10 && minGap >= w.wc.step, detail: `${carries.length} carries, closest two ${minGap} s apart (STEP ${w.wc.step} s)` },
            { name: "no miss counter advanced (no eligible writer)", ok: advanced.length === 0, detail: advanced.length ? advanced.map((e) => `${e.day}: ${e.missAdvanced}`).join(", ") : "none" },
            { name: "lag back under LAG_MAX after the catch-up", ok: caughtUp, detail: `last final day ${lastDay?.day}, ${lastDay ? w.now - w.dayEnd(lastDay.day) : "-"} s ago` },
            { name: "HEARTBEAT_LOST raised on the wake and cleared after", ok: openLost.some((a) => a.at >= to && a.cleared === undefined) && [...stillOpen.values()].every((x) => !x), detail: `${openLost.filter((a) => a.at >= to && a.cleared === undefined).length} raised after the wake, ${[...stillOpen.values()].filter(Boolean).length} still open` },
            { name: "R5_HEAD_LAG raised on the wake", ok: readAlerts(w).some((a) => a.code === AlertCode.R5_HEAD_LAG && a.at >= to), detail: "raised by the attester or health once they run again" },
            { name: "sleep window", ok: true, detail: `${from} to ${to}` },
          ];
        },
      },
    );
  },
};

const sleepProduction: Scenario = {
  name: "chaos-mac-asleep-production",
  what: "PRODUCTION (time-warped): every process paused 3 hours over slices 11 to 13 of a day on which every page steps +0.60 at 10:00",
  run: async () => {
    const day0 = 20_727; // Oct 1 2026, epoch 0
    const startTs = day0 * 86_400 + 600;
    let from = 0;
    let to = 0;
    const D = day0 + 1;
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    // the replay counts days from the index epoch (0 on PRODUCTION): the step is on day D at slice 10
    for (let i = 0; i < 5; i++) steps[i as 0] = [{ from: { day: D, slice: 10 }, ...p(plus(base[i]!)) }];
    const scripted = h100World(steps);
    for (const s of Object.values(scripted)) s.gpus!.H100![0]!.from = { day: 0 };
    return runWorld(
      { name: "chaos-mac-asleep-production", profile: PROFILES.PRODUCTION, startTs, epochTs: 0, epochDay: 0, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted }, primary: {}, standby: {}, guardian: guard(86_400), step: 180 },
      (w) => {
        from = w.sliceStart(D, 11) + 100;
        to = from + 3 * 3_600;
        w.down = (_p, t) => t >= from && t < to;
        return w.dayEnd(D) + w.wc.lagMax + 3_600;
      },
      {
        expectAlerts: [AlertCode.CLOCK_JUMP],
        lagFrom: D,
        extra: (w, ev, days) => {
          const posted = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && e.day === D);
          const slept = posted.filter((e) => e.slice >= 12 && e.slice <= 13);
          const d = final(days, D);
          return [
            { name: "nothing posted for the slept slices", ok: slept.length === 0, detail: `${slept.length} entries for slices 12, 13 (slice 11 was read before the sleep began at +100 s if its read second came first)` },
            { name: "day D final, incomplete", ok: Boolean(d?.final && d.incomplete && d.status !== "CARRIED"), detail: `${d?.status} ${d?.final ? "final" : "pending"} incomplete ${d?.incomplete}, source ${d?.source}, attested by ${d?.attestedBy}, slices posted by the source ${posted.filter((e) => lc(e.writer) === lc(d?.source ?? "")).length}/24` },
          ];
        },
      },
    );
  },
};

/** chaos: RPC down 10 minutes (one DEMO day). (a) the first URL errors 5 minutes then hangs 5; (b) both URLs down. */
function rpcDown(name: string, both: boolean): Scenario {
  return {
    name,
    what: `DEMO: ${both ? "BOTH RPC URLs error for 10 minutes (a whole demo day)" : "the first RPC URL errors 5 minutes then hangs 5 minutes"}, from mid demo day 2; guardian on`,
    run: async () => {
      let from = 0;
      let to = 0;
      return runWorld(
        { name, profile: PROFILES.DEMO, startTs: T0, epochDay: NOV1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World({ 2: [{ from: { day: 3 }, ...p("3.50") }] }) }, primary: { viaForwarder: true }, standby: {}, guardian: guard(PROFILES.DEMO.day) },
        (w) => {
          from = w.sliceStart(relDay(w, 2), 1) + 30;
          to = from + 600;
          return w.dayEnd(relDay(w, 6)) + 300;
        },
        {
          expectAlerts: both ? [AlertCode.RPC_DOWN] : [AlertCode.RPC_FAILOVER],
          forbidAlerts: [AlertCode.NONCE_STUCK, AlertCode.GAS_CAP],
          extra: async (w, ev) => {
            const skips = await w.a.pub.getLogs({ address: w.dep.index, event: { type: "event", name: "EntrySkipped", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8", indexed: false }, { name: "reason", type: "uint8", indexed: false }] }, fromBlock: w.dep.fromBlock });
            const dup = skips.filter((l) => Number((l as { args: { reason: number } }).args.reason) === 7);
            const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted");
            const keyNonces: string[] = [];
            for (const r of [ROLE.primary, ROLE.standby, ROLE.attester, ROLE.keeper]) {
              const pending = await w.a.pub.getTransactionCount({ address: ADDR[r]!, blockTag: "pending" });
              const latest = await w.a.pub.getTransactionCount({ address: ADDR[r]! });
              if (pending !== latest) keyNonces.push(`${r}: ${pending - latest} unmined`);
            }
            const d2 = relDay(w, 2);
            const lostSlices = (["primary", "standby"] as const).map((role) => {
              const a = lc(ADDR[role === "primary" ? ROLE.primary : ROLE.standby]!);
              return `${role} ${posts.filter((e) => e.day === d2 && lc(e.writer) === a).length}/4`;
            });
            return [
              { name: "no duplicate entry (E7)", ok: dup.length === 0, detail: `${dup.length} duplicate entries skipped by the contract` },
              { name: "no transaction left unmined (no nonce gap)", ok: keyNonces.length === 0, detail: keyNonces.join(", ") || "every key's pending nonce equals its mined nonce" },
              { name: "outage day slices", ok: true, detail: `day ${d2}: ${lostSlices.join(", ")}` },
            ];
          },
        },
        (w) => {
          const [a, b] = w.proxies;
          if (w.now >= from && w.now < to) {
            a!.mode = both ? "error" : w.now < from + 300 ? "error" : "hang";
            b!.mode = both ? "error" : "ok";
          } else {
            a!.mode = "ok";
            b!.mode = "ok";
          }
        },
      );
    },
  };
}

/** chaos: RPC down 10 minutes on PRODUCTION (time-warped): both URLs error over both writers' read seconds of one
 *  slice; the posts are held, sent after recovery inside the slice, and nothing is missed or duplicated. */
const rpcDownProduction: Scenario = {
  name: "chaos-rpc-both-down-production",
  what: "PRODUCTION (time-warped, 60 s steps): both RPC URLs error for 10 minutes covering both writers' read seconds of slice 5 of a day; guardian on",
  run: async () => {
    const day0 = 20_727;
    const D = day0 + 1;
    let from = 0;
    let to = 0;
    return runWorld(
      { name: "chaos-rpc-both-down-production", profile: PROFILES.PRODUCTION, startTs: day0 * 86_400 + 600, epochTs: 0, epochDay: 0, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World() }, primary: { viaForwarder: true, seed: 5 }, standby: { seed: 6 }, guardian: guard(86_400), step: 60 },
      (w) => {
        from = w.sliceStart(D, 5) + 180;
        to = from + 600;
        return w.dayEnd(D) + w.wc.lagMax + 3_600;
      },
      {
        expectAlerts: [AlertCode.RPC_DOWN],
        forbidAlerts: [AlertCode.NONCE_STUCK, AlertCode.GAS_CAP],
        lagFrom: D,
        extra: async (w, ev) => {
          const skips = await w.a.pub.getLogs({ address: w.dep.index, event: { type: "event", name: "EntrySkipped", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8", indexed: false }, { name: "reason", type: "uint8", indexed: false }] }, fromBlock: w.dep.fromBlock });
          const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && e.day === D && e.slice === 5);
          const slots = [];
          for (const e of posts) slots.push(`${lc(e.writer) === lc(ADDR[ROLE.primary]!) ? "primary" : "standby"} read ${e.readAt - w.sliceStart(D, 5)} s into the slice`);
          return [
            { name: "slice 5 posted by both writers despite the outage", ok: posts.length === 2, detail: slots.join(", ") || "none" },
            { name: "a read fell inside the outage (the held-post path ran)", ok: posts.some((e) => e.readAt >= from && e.readAt < to), detail: `outage ${from - w.sliceStart(D, 5)} to ${to - w.sliceStart(D, 5)} s into the slice; ${posts.filter((e) => e.readAt >= from && e.readAt < to).length} read(s) inside` },
            { name: "no duplicate entry (E7)", ok: skips.length === 0, detail: `${skips.length} skipped entries` },
          ];
        },
      },
      (w) => {
        const [a, b] = w.proxies;
        const down = w.now >= from && w.now < to;
        a!.mode = down ? "error" : "ok";
        b!.mode = down ? "error" : "ok";
      },
    );
  },
};

/** chaos: a layout change on one page (its structural anchor renamed): the parser refuses it for everyone from day L. */
const layoutChange: Scenario = {
  name: "chaos-layout-change",
  what: "TEST: Nebius's page (slot 1, 3.20) changes layout from slice 4 of day 2 on; every reader's parser refuses it; guardian on",
  run: async () => {
    const L = 2;
    const scripted = h100World();
    scripted.p_nebius!.page = [{ from: { day: L, slice: 4 }, state: "broken" }];
    return runWorld(
      { name: "chaos-layout-change", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted }, primary: {}, standby: {}, guardian: guard(PROFILES.TEST.day) },
      (w) => w.dayEnd(relDay(w, L + 8)) + 900,
      {
        extra: (w, ev, days) => {
          const exit = days.find((x) => x.day > relDay(w, L) && x.final && x.status !== "CARRIED" && slotsOf(ev, H100_ID, x.day)?.kinds[1] === KIND.OUT);
          return [{ name: "slot 1 held then out; the fix moves to the 4-slot median", ok: Boolean(exit) && final(days, relDay(w, L + 8))?.value === 3_500_000, detail: `exit day ${exit?.day}; day ${relDay(w, L + 8)} value ${final(days, relDay(w, L + 8))?.value}` }];
        },
      },
    );
  },
};

/** chaos (Freeze): the stolen primary repeats day-0 prices through a real +0.60 step on every page; honest standby. */
const freezeStep: Scenario = {
  name: "chaos-stolen-primary-freeze",
  what: "TEST: every page steps +0.60 on day 3; the stolen primary keeps posting its first day's prices from day 2 on; honest standby; guardian on",
  run: async () => {
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    for (let i = 0; i < 5; i++) steps[i as 0] = [{ from: { day: 3 }, ...p(plus(base[i]!)) }];
    const frozen = base.map((v) => Math.round(Number(v) * 1e6));
    return runWorld(
      { name: "chaos-stolen-primary-freeze", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World(steps) }, primary: { thief: ({ dayId, values }) => (dayId >= OCT1 + 2 ? values.map((v, i) => (v ? frozen[i]! : v)) : values) }, standby: {}, guardian: guard(PROFILES.TEST.day) },
      (w) => w.dayEnd(relDay(w, 6)) + 900,
      {
        expectAlerts: [AlertCode.R1_SELECTED],
        extra: (_w, _ev, days) => {
          const thief = lc(ADDR[ROLE.primary]!);
          const bad = days.filter((x) => x.final && x.status !== "CARRIED" && x.day >= OCT1 + 3 && lc(x.source) === thief);
          return [{ name: "no frozen record final after the step", ok: bad.length === 0, detail: bad.length ? bad.map((x) => x.day).join(", ") : "every final day from the step on is the standby's" }];
        },
      },
    );
  },
};

/** T8: the DEMO and FAST races. A stolen primary freezes the median slot through a step and closes at the first
 *  legal second; the watcher reads at the last second of every interval (its settle reading as late as it gets). */
function race(name: string, profile: "DEMO" | "FAST"): Scenario {
  return {
    name,
    what: `${profile}: the median page steps 3.40 to 3.90 on day 2; the stolen primary keeps 3.40 (an unchanged freeze) and closes at the first legal second; the watcher reads every page at the last second of its interval; honest standby; no guardian`,
    run: async () => {
      const P = PROFILES[profile];
      return runWorld(
        {
          name,
          profile: P,
          startTs: T0,
          epochDay: NOV1,
          gpus: [{ gpu: "H100" }],
          scenario: { archive: false, scripted: h100World({ 2: [{ from: { day: 2 }, ...p("3.90") }] }) },
          primary: { thief: ({ dayId, values }) => (dayId >= NOV1 + 2 ? values.map((v, i) => (i === 2 && v ? 3_400_000 : v)) : values), seed: 0 },
          standby: {},
          guardian: null,
          watcherRand: () => 0.999,
        },
        (w) => w.dayEnd(relDay(w, 5)) + P.day / 2,
        {
          expectAlerts: [AlertCode.R1_SELECTED],
          extra: async (w, ev, days) => {
            const thief = lc(ADDR[ROLE.primary]!);
            const bad = days.filter((x) => x.final && x.status !== "CARRIED" && x.day >= NOV1 + 2 && lc(x.source) === thief);
            const out = [{ name: "the freeze is never final", ok: bad.length === 0, detail: bad.length ? bad.map((x) => x.day).join(", ") : "every final day from the step on is the standby's" }];
            if (profile === "DEMO") {
              const margins: string[] = [];
              let ok = true;
              for (const e of ev.filter((x): x is Extract<WallEvent, { name: "RecordReplaced" }> => x.name === "RecordReplaced")) {
                const closed = ev.find((x): x is Extract<WallEvent, { name: "DayClosed" }> => x.name === "DayClosed" && x.day === e.day);
                if (!closed) continue;
                const tc = Number((await w.a.pub.getBlock({ blockNumber: BigInt(Number(closed.key.split(":")[0])) })).timestamp);
                const ts = Number((await w.a.pub.getBlock({ blockNumber: BigInt(Number(e.key.split(":")[0])) })).timestamp);
                const margin = tc + w.wc.tPend - ts;
                margins.push(`${e.day}: ${margin} s`);
                if (margin < 60) ok = false;
              }
              out.push({ name: "each select lands at least 60 s before the freeze's finalAt", ok: ok && margins.length > 0, detail: margins.join(", ") || "no select" });
            }
            return out;
          },
        },
      );
    },
  };
}

/** chaos: every process crashes and is restarted by launchd (rebuilt from its files and the chain), three times a day
 *  at different offsets into the day, through a step day with a stolen primary freezing. */
const restartAll: Scenario = {
  name: "chaos-restart-all",
  what: "TEST: every process (both writers, logger, attester, keeper, health, guardian) crashes and restarts from disk at slices 2, 6 and 11 of every day and right after each day's close, through a +0.60 step on day 3 with a stolen primary freezing from day 2; guardian on",
  run: async () => {
    const plus = (v: string) => (Number(v) + 0.6).toFixed(2);
    const base = ["3.00", "3.20", "3.40", "3.60", "3.80"];
    const steps: Partial<Record<0 | 1 | 2 | 3 | 4, Steps>> = {};
    for (let i = 0; i < 5; i++) steps[i as 0] = [{ from: { day: 3 }, ...p(plus(base[i]!)) }];
    const frozen = base.map((v) => Math.round(Number(v) * 1e6));
    const at = new Set<number>();
    let rounds = 0;
    return runWorld(
      { name: "chaos-restart-all", profile: PROFILES.TEST, startTs: T0, epochDay: OCT1, gpus: [{ gpu: "H100" }], scenario: { archive: false, scripted: h100World(steps) }, primary: { thief: ({ dayId, values }) => (dayId >= OCT1 + 2 ? values.map((v, i) => (v ? frozen[i]! : v)) : values) }, standby: {}, guardian: guard(PROFILES.TEST.day) },
      (w) => {
        for (let d = w.dep.epochDay; d < relDay(w, 7); d++) for (const h of [2, 6, 11]) at.add(w.sliceStart(d, h) + 37);
        for (let d = w.dep.epochDay; d < relDay(w, 7); d++) at.add(w.dayEnd(d) + w.wc.closeGrace + 25);
        return w.dayEnd(relDay(w, 6)) + 900;
      },
      {
        expectAlerts: [AlertCode.R1_SELECTED],
        forbidAlerts: [AlertCode.NONCE_STUCK, AlertCode.GAS_CAP, AlertCode.R1_NO_CANDIDATE],
        extra: async (w, ev, days) => {
          const thief = lc(ADDR[ROLE.primary]!);
          const bad = days.filter((x) => x.final && x.status !== "CARRIED" && x.day >= OCT1 + 3 && lc(x.source) === thief);
          const skips = await w.a.pub.getLogs({ address: w.dep.index, event: { type: "event", name: "EntrySkipped", inputs: [{ name: "gpuId", type: "bytes32", indexed: true }, { name: "day", type: "uint32", indexed: true }, { name: "writer", type: "address", indexed: true }, { name: "slice", type: "uint8", indexed: false }, { name: "reason", type: "uint8", indexed: false }] }, fromBlock: w.dep.fromBlock });
          const posts = ev.filter((e): e is Extract<WallEvent, { name: "ReadingsPosted" }> => e.name === "ReadingsPosted" && lc(e.writer) === lc(ADDR[ROLE.standby]!));
          const perDay = new Map<number, number>();
          for (const e of posts) perDay.set(e.day, (perDay.get(e.day) ?? 0) + 1);
          const full = [...perDay.entries()].filter(([d]) => d > w.dep.epochDay && d < relDay(w, 6)).every(([, n]) => n === 12);
          return [
            { name: "no frozen record final after the step", ok: bad.length === 0, detail: bad.length ? bad.map((x) => x.day).join(", ") : "none" },
            { name: "no duplicate entry after a restart (E7)", ok: skips.length === 0, detail: `${skips.length} skipped entries` },
            { name: "the standby still posts every slice", ok: full, detail: [...perDay.entries()].map(([d, n]) => `${d}: ${n}/12`).join(", ") },
            { name: "restarts", ok: rounds >= 20, detail: `${rounds} rounds of every process` },
          ];
        },
      },
      async (w) => {
        for (const t of [...at]) {
          if (w.now >= t) {
            at.delete(t);
            rounds++;
            for (const pp of ["primary", "standby", "log", "attest", "keep", "health", "guardian"] as Proc[]) await w.restart(pp);
          }
        }
      },
    );
  },
};

/** Endurance: a long FAST run (150 index days, one real hour of demo time) on the archive with the scripted step;
 *  per-day processing cost early and late, and an attester restart at day 140 that rebuilds its history from the
 *  chain (the cost a launchd restart pays after weeks of running). */
const fastLong: Scenario = {
  name: "fast-long-150d",
  what: "FAST, 150 index days (one real hour of demo time compressed), six GPUs, archive plus the step; every process restarted at day 140; reports the per-day processing time early and late and the restart's rebuild time",
  needsArchive: true,
  run: async () => {
    const view = archiveView((date) => date === "2026-10-01");
    const marks: { day: number; ms: number }[] = [];
    let restartMs = 0;
    let restarted = false;
    return runWorld(
      { name: "fast-long-150d", profile: PROFILES.FAST, startTs: T0, epochDay: NOV1, gpus: ALL_GPUS, scenario: demoScenario(), rawDir: view.rawDir, primary: { viaForwarder: true }, standby: {}, guardian: GUARD },
      (w) => w.dayEnd(relDay(w, 150)) + 30,
      {
        forbidAlerts: [AlertCode.R1_NO_CANDIDATE, AlertCode.GAS_CAP, AlertCode.NONCE_STUCK, AlertCode.CLOCK_SKEW, AlertCode.RPC_DOWN],
        extra: (w) => {
          const per = marks.slice(1).map((m, i) => ({ day: m.day, ms: m.ms - marks[i]!.ms }));
          const avg = (xs: { ms: number }[]) => Math.round(xs.reduce((a, x) => a + x.ms, 0) / Math.max(1, xs.length));
          const early = avg(per.slice(1, 11));
          const late = avg(per.slice(-10));
          return [
            { name: "per-day cost does not grow (late <= 3x early)", ok: late <= 3 * early, detail: `days 2-11: ${early} ms per index day; last 10: ${late} ms; restart of every process at day 140 took ${restartMs} ms` },
            { name: "restarted at day 140", ok: restarted, detail: `alerts.jsonl lines ${readAlerts(w).length}` },
          ];
        },
      },
      async (w) => {
        const d = w.dayAt(w.now) - w.dep.epochDay;
        if (marks.length === 0 || marks.at(-1)!.day !== d) marks.push({ day: d, ms: Date.now() });
        if (!restarted && d === 140) {
          restarted = true;
          const t = Date.now();
          for (const pp of ["primary", "standby", "log", "attest", "keep", "health", "guardian"] as Proc[]) await w.restart(pp);
          // the first attester tick after the restart rebuilds its history from the chain
          await w.stepOnce();
          restartMs = Date.now() - t;
        }
      },
    );
  },
};

export const SCENARIOS: Scenario[] = [
  fastBase,
  demoBase,
  fastArchiveFull,
  fastRealtime,
  pageDark,
  watcherGap,
  writersBlocked,
  plantScenario("chaos-queued-plant", "standby"),
  plantScenario("chaos-queued-plant-standby-blocked", "standby-blocked-nov1"),
  plantScenario("chaos-queued-plant-no-standby", "no-standby-guardian"),
  plantScenario("chaos-queued-plant-guardian-late", "no-standby-guardian-late"),
  plantScenario("chaos-queued-plant-nobody", "no-standby-nobody"),
  stolenStandby("chaos-stolen-standby-missed-slice", false),
  stolenStandby("chaos-stolen-standby-primary-below-quorum", true),
  sleepDemo,
  sleepProduction,
  rpcDown("chaos-rpc-first-url-down", false),
  rpcDown("chaos-rpc-both-down", true),
  rpcDownProduction,
  layoutChange,
  freezeStep,
  race("t8-race-demo", "DEMO"),
  race("t8-race-fast", "FAST"),
  restartAll,
  fastLong,
  ...UPGRADE_SCENARIOS,
];

export type { Proc };
