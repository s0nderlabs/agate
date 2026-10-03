// Audit (phase 2b, rules and liveness lens). The fix round turned the audit's test.failing cases into plain tests that
// assert the fixed behaviour (M1: J on an entry day).
import { describe, expect, test } from "bun:test";
import { Kind, NEVER } from "@agate/report/types";
import { vetoBy, vetoDue } from "../../src/clock.ts";
import { RuleContext } from "../../src/rule/context.ts";
import { evaluate } from "../../src/rule/decide.ts";
import { hand } from "../../src/rule/verdicts.ts";
import { A, scen, slotLog, TEST, writer } from "../helpers.ts";

const OCT1 = 20_727; // 2026-10-01, a first of the month (an entry day, 4.6)
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];
const flat = (d: number) => BASE.map((v) => slotLog(TEST, d - 1, d + 1, () => v));
const steadyIn = () => BASE.map((e) => ({ e, miss: 0, inMedian: true, wasIn: true }));
const withholding = (slot: number) => writer(TEST, A, 0, (_h, i) => (i === slot ? 0 : BASE[i]!));

describe("J on an entry day: a never-IN live slot the watcher reads FRESH", () => {
  // slot 4 went live on the 1st and was never fresh before (initial state miss HOLD_DAYS + 1, wasIn false), as every
  // slot is on an index's first record day; the only writer leaves it out although the watcher reads 3.80 all day
  const pre = () => {
    const p = steadyIn();
    p[4] = { e: 0, miss: 6, inMedian: false, wasIn: false };
    return p;
  };
  const sc = () => scen({ d: OCT1, log: flat(OCT1), pre: pre(), writers: [withholding(4)], liveFrom: [0, 0, 0, 0, OCT1], liveUntil: Array(5).fill(NEVER) });

  test("the record keeps slot 4 OUT, needs the countersign, and the attester refuses it on membership", () => {
    const s = sc();
    expect(s.pending!.kinds[4]).toBe(Kind.OUT);
    expect(s.pending!.needsSign).toBe(true);
    const ctx = new RuleContext(s);
    expect(ctx.cls(4)).toBe("FRESH");
    expect(ctx.expected(4).exp).toBe(Kind.FRESH); // an honest writer brings it IN today
    const ev = evaluate(s);
    expect(ev.candidates[0]!.strict.ok).toBe(false);
    expect(ev.candidates[0]!.fixOk.ok).toBe(false);
    expect(ev.action.kind).toBe("none");
  });

  test("R11 and R12 refuse the exclusion without a confirmed block (fixed: withheld follows the expected membership)", () => {
    const s = sc();
    const ctx = new RuleContext(s);
    expect(ctx.withheld(s.pending!, 4)).toBe(true);
    expect(hand(ctx, s.pending!, false).ok).toBe(false);
    expect(hand(ctx, s.pending!, true).ok).toBe(false);
    expect(evaluate(s).guardian.r11).toBeNull();
  });

  test("not an entry day: the same never-IN slot kept OUT is not withheld (it could not enter today anyway)", () => {
    const d = OCT1 + 1;
    const p = pre();
    const s = scen({ d, log: flat(d), pre: p, writers: [withholding(4)], liveFrom: [0, 0, 0, 0, OCT1], liveUntil: Array(5).fill(NEVER) });
    const ctx = new RuleContext(s);
    expect(ctx.expected(4).exp).toBe(Kind.OUT);
    expect(ctx.withheld(s.pending!, 4)).toBe(false);
  });

  test("contrast: with a fresh shadow reading (pre.miss 0) the same withholding is HELD and J refuses it", () => {
    const p = pre();
    p[4] = { e: 3_800_000, miss: 0, inMedian: false, wasIn: false };
    const s = scen({ d: OCT1, log: flat(OCT1), pre: p, writers: [withholding(4)], liveFrom: [0, 0, 0, 0, OCT1], liveUntil: Array(5).fill(NEVER) });
    expect(s.pending!.kinds[4]).toBe(Kind.HELD);
    const ctx = new RuleContext(s);
    expect(ctx.withheld(s.pending!, 4)).toBe(true);
    expect(hand(ctx, s.pending!, false).ok).toBe(false);
  });
});

describe("VETO_BY (6.6 step 3b) on all four profiles and both epochs", () => {
  // 2.2: GRACE = DAY, REOPEN_WAIT = DAY / 4; a veto by VETO_BY carries at graceStart + GRACE, never later
  const profiles = [
    { name: "PRODUCTION", day: 86_400, slices: 24 },
    { name: "DEMO", day: 600, slices: 4 },
    { name: "FAST", day: 24, slices: 2 },
    { name: "TEST", day: 2_400, slices: 12 },
  ];
  for (const p of profiles) {
    for (const epoch of [{ epochTs: 0, epochDay: 0 }, { epochTs: 1_790_812_800 + 37, epochDay: OCT1 }]) {
      test(`${p.name}, epochTs ${epoch.epochTs}: VETO_BY + REOPEN_WAIT = graceStart + GRACE; a backfilled day counts from registration`, () => {
        const c = { day: p.day, grace: p.day, reopenWait: p.day / 4, ...epoch };
        const d = Math.max(OCT1, epoch.epochDay) + 3;
        const dayEnd = epoch.epochTs + (d + 1 - epoch.epochDay) * p.day;
        expect(vetoBy(c, d, 0) + c.reopenWait).toBe(dayEnd + c.grace);
        const reg = dayEnd + 5 * p.day; // registered after the day ended (launch backfill, 8.4)
        expect(vetoBy(c, d, reg) + c.reopenWait).toBe(reg + c.grace);
        // due = the later of VETO_BY and alert + GUARD_ACT (GUARD_ACT = DAY / 4)
        expect(vetoDue(vetoBy(c, d, 0), dayEnd + p.day, p.day / 4)).toBe(dayEnd + p.day + p.day / 4);
        expect(vetoDue(vetoBy(c, d, 0), dayEnd, p.day / 4)).toBe(vetoBy(c, d, 0));
      });
    }
  }

  test("a second record that closes as late as REPOST_END still carries within B on every profile (6.6 (v) with 8.1)", () => {
    // first record liveness-vetoed at VETO_BY; the other writer becomes quorate only through reposts that land up to
    // REPOST_END = graceStart + GRACE - slice, closes then, is refused, vetoed at alert + GUARD_ACT, carried after
    // REOPEN_WAIT plus one keeper period (DAY / 12). (v) states GRACE + P + DAY/12; this path can exceed it, never B.
    for (const p of [
      { name: "PRODUCTION", day: 86_400, slices: 24, tPend: 21_600 },
      { name: "DEMO", day: 600, slices: 4, tPend: 210 },
      { name: "FAST", day: 24, slices: 2, tPend: 6 },
      { name: "TEST", day: 2_400, slices: 12, tPend: 600 },
    ]) {
      const slice = p.day / p.slices;
      const grace = p.day;
      const guardAct = p.day / 4;
      const reopen = p.day / 4;
      const P = p.day / 12 + slice + Math.max(guardAct, p.tPend);
      const B = grace + 2 * P;
      const late = grace - slice + guardAct + reopen + p.day / 12;
      expect(late).toBeLessThanOrEqual(B);
      if (p.name === "PRODUCTION") expect(late).toBeGreaterThan(grace + P + p.day / 12); // 37 h against (v)'s 35 h
    }
  });
});
