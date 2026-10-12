// BOTS-SPEC 2.6: the daily MON budget: B frozen at the day's first tick, hourly pacing, the floor, persistence across
// a restart, the UTC day rollover in chain time, 7 days once runUntil has passed, and the alerts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink } from "@agate/watcher";
import { Budget, daysLeft, monToWei, paced, utcDay } from "../src/budget.ts";

const MON = 10n ** 18n;
const T0 = BigInt(Date.parse("2026-10-03T00:00:00Z") / 1000); // a UTC midnight
const RUN_UNTIL = Date.parse("2026-10-14T03:59:00Z") / 1000;

function mk(dir = mkdtempSync(join(tmpdir(), "agate-payer-budget-")), o: Partial<{ keep: number; low: number; runUntil: number }> = {}) {
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => 0, print: false });
  const b = new Budget({ dir, role: "payer", keepWei: monToWei(o.keep ?? 15), lowBalanceWei: monToWei(o.low ?? 60), runUntil: o.runUntil ?? RUN_UNTIL, alerts, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: "0x3786e99fC370506391be896E1D327a49de6A9505" });
  return { b, dir, alerts };
}

describe("budget (BOTS-SPEC 2.6)", () => {
  test("B = (balance - keep) / daysLeft, frozen for the UTC day of chain time", () => {
    const { b } = mk();
    b.tick(T0, 465n * MON); // daysLeft = ceil((Oct 14 03:59 - Oct 3 00:00) / 1 day) = 12
    expect(Budget.daysLeft(T0, RUN_UNTIL)).toBe(12n);
    expect(b.today!.budgetWei).toBe((450n * MON) / 12n);
    b.tick(T0 + 3_600n, 1_000n * MON); // a top-up the same day: B stays frozen
    expect(b.today!.budgetWei).toBe((450n * MON) / 12n);
    b.tick(T0 + 86_400n, 1_000n * MON); // next UTC day: recomputed
    expect(b.today!.day).toBe("2026-10-04");
    expect(b.today!.budgetWei).toBe((985n * MON) / 11n);
  });
  test("pacing: by second s the spend may reach B x min(1, (s + 3,600) / 86,400)", () => {
    const { b } = mk();
    b.tick(T0, 24n * MON + monToWei(15)); // B = 24 MON / 12 days = 2 MON
    const B = b.today!.budgetWei;
    expect(b.allowance()).toBe((B * 3_600n) / 86_400n); // the first hour's share
    expect(b.canSpend(B / 24n + 1n, false)).toEqual({ ok: false, why: "BUDGET" });
    expect(b.canSpend(B / 24n, false)).toEqual({ ok: true });
    b.record(B / 24n, false);
    expect(b.allowance()).toBe(0n);
    b.tick(T0 + 43_200n - 3_600n, 24n * MON); // 11:00 UTC: half the day's budget allowed in total
    expect(b.allowance()).toBe(B / 2n - B / 24n);
    b.tick(T0 + 86_399n, 24n * MON);
    expect(b.allowance()).toBe(B - B / 24n);
  });
  test("dayLeft (recheck R1-L2): what the day can still reach once pacing has freed all of it", () => {
    const { b } = mk();
    expect(b.dayLeft()).toBe(0n); // no tick yet
    b.tick(T0, 24n * MON + monToWei(15)); // B = 2 MON
    const B = b.today!.budgetWei;
    expect(b.dayLeft()).toBe(B); // at 00:00 only the first hour's share is allowed, the whole day is left
    expect(b.allowance()).toBeLessThan(b.dayLeft());
    b.record(B / 24n, false);
    expect(b.dayLeft()).toBe(B - B / 24n);
    b.record(B, true); // a safety send past B: nothing left, never negative
    expect(b.dayLeft()).toBe(0n);
  });
  test("the floor: never sign when balance - costMax < keep; safety ignores pacing, never the floor", () => {
    const { b } = mk();
    b.tick(T0, 16n * MON); // 1 MON above keep
    expect(b.canSpend(2n * MON, true)).toEqual({ ok: false, why: "FLOOR" });
    expect(b.canSpend(MON / 2n, true)).toEqual({ ok: true });
    b.record(MON / 2n, true);
    expect(b.canSpend(MON / 2n + 1n, true)).toEqual({ ok: false, why: "FLOOR" }); // the spend since the read counts
    expect(b.today!.safetyWei).toBe(MON / 2n);
    expect(b.today!.spentWei).toBe(MON / 2n); // the day's total: a safety send's cost counts too (2.6 v2)
  });
  test("a safety spend counts in the day's total, so a later non-safety send gets only what is left", () => {
    const { b } = mk();
    b.tick(T0 + 43_200n, 24n * MON + monToWei(15)); // B = 2 MON; by 12:00 UTC 13/24 of it is allowed
    const before = b.allowance();
    expect(b.canSpend(before + 1n, true)).toEqual({ ok: true }); // safety ignores pacing
    b.record(before, true);
    expect(b.allowance()).toBe(0n);
    expect(b.canSpend(1n, false)).toEqual({ ok: false, why: "BUDGET" });
  });
  test("persisted per day: a restart the same chain day does not reset the spend", () => {
    const { b, dir } = mk();
    b.tick(T0 + 7_200n, 135n * MON);
    b.record(3n * MON / 100n, false);
    b.record(2n * MON / 100n, false);
    const f = join(dir, `budget-${utcDay(T0)}.json`);
    expect(existsSync(f)).toBe(true);
    const j = JSON.parse(readFileSync(f, "utf8"));
    expect(j.spentWei).toBe((5n * MON / 100n).toString());
    expect(j.sends).toBe(2);
    const again = mk(dir).b;
    again.tick(T0 + 9_000n, 500n * MON); // a restart with more MON: the day's B and spend are kept
    expect(again.today!.spentWei).toBe(5n * MON / 100n);
    expect(again.today!.budgetWei).toBe(b.today!.budgetWei);
  });
  test("daysLeft is at least 1, and 7 once runUntil has passed", () => {
    expect(Budget.daysLeft(BigInt(RUN_UNTIL) - 10n, RUN_UNTIL)).toBe(1n);
    expect(Budget.daysLeft(BigInt(RUN_UNTIL), RUN_UNTIL)).toBe(7n);
    expect(Budget.daysLeft(BigInt(RUN_UNTIL) + 999_999n, RUN_UNTIL)).toBe(7n);
  });
  test("PAYER_KEY_LOW under lowBalanceMon (cleared above); PAYER_BUDGET_SPENT once a day", () => {
    const { b, alerts } = mk();
    b.tick(T0, 50n * MON);
    expect(alerts.open().map((a) => a.code as string)).toContain("PAYER_KEY_LOW");
    b.tick(T0 + 10n, 70n * MON);
    expect(alerts.open().map((a) => a.code as string)).not.toContain("PAYER_KEY_LOW");
    expect(b.canSpend(70n * MON, false)).toEqual({ ok: false, why: "FLOOR" }); // above the floor's room: no budget alert
    expect(b.canSpend(MON, false)).toEqual({ ok: false, why: "BUDGET" }); // over the first hour's share
    expect(b.canSpend(MON, false)).toEqual({ ok: false, why: "BUDGET" });
    expect(alerts.all().filter((a) => (a.code as string) === "PAYER_BUDGET_SPENT").length).toBe(1);
  });
  test("balance under keep: B = 0", () => {
    const { b } = mk();
    b.tick(T0, 10n * MON);
    expect(b.today!.budgetWei).toBe(0n);
    expect(b.headroom()).toBe(0n);
  });
});

describe("budget, the maker's cases (BOTS-SPEC 2.6)", () => {
  const keep = monToWei(20);
  const T1 = BigInt(Date.parse("2026-10-04T00:00:00Z") / 1000);
  const until = Date.parse("2026-10-14T03:59:00Z") / 1000;
  const mkMaker = (dir = mkdtempSync(join(tmpdir(), "agate-mm-budget-")), more: { headStartS?: number } = {}) => ({ dir, b: new Budget({ dir, role: "marketmaker", keepWei: keep, lowBalanceWei: monToWei(40), runUntil: until, lowCode: "MM_KEY_LOW", spentCode: "MM_BUDGET_SPENT", address: "0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8", ...more }) });
  test("B = (balance - keep) / days left, frozen for the UTC day of chain time, persisted across a restart", () => {
    const { b, dir } = mkMaker();
    b.tick(T1 + 10n, 200n * MON);
    expect(daysLeft(T1 + 10n, until)).toBe(11n);
    expect(b.today!.budgetWei).toBe((180n * MON) / 11n);
    b.tick(T1 + 5_000n, 10n * MON);
    expect(b.today!.budgetWei).toBe((180n * MON) / 11n); // frozen
    b.record(123n, false);
    const again = mkMaker(dir).b;
    again.tick(T1 + 30n, MON);
    expect(again.today!.spentWei).toBe(123n);
    again.tick(T1 + 86_400n, 110n * MON); // the next UTC day of chain time opens a new budget
    expect(again.today!.budgetWei).toBe((90n * MON) / 10n);
    expect(utcDay(T1 + 86_400n)).toBe("2026-10-05");
    expect(daysLeft(BigInt(until) + 1n, until)).toBe(7n);
  });
  test("a 4 h head start lets the day's first sends spend 4/24 of B; the day's total is unchanged", () => {
    const { b } = mkMaker(undefined, { headStartS: 4 * 3_600 });
    b.tick(T1 + 3n, 200n * MON);
    const B = b.today!.budgetWei;
    const fourH = (B * 14_403n) / 86_400n;
    expect(b.allowance()).toBe(fourH);
    // one hour's share would have refused this (the Oct 6-12 morning gap); four hours' allows it
    const send = (B * 2n) / 24n;
    expect(send > (B * 3_603n) / 86_400n).toBe(true);
    expect(b.canSpend(send, false)).toEqual({ ok: true });
    b.record(send, false);
    b.tick(T1 + 86_399n, 200n * MON);
    expect(b.allowance()).toBe(B - send);
  });

  test("pacing: B x min(1, (s + 3,600) / 86,400); the floor; safety ignores pacing, not the floor", () => {
    const B = 86_400n * 1_000n;
    expect(paced(B, T1)).toBe(3_600n * 1_000n);
    expect(paced(B, T1 + 43_200n)).toBe(46_800n * 1_000n);
    expect(paced(B, T1 + 86_000n)).toBe(B);
    // a longer head start frees more at the day's start, never more than B
    expect(paced(B, T1, 14_400n)).toBe(14_400n * 1_000n);
    expect(paced(B, T1 + 80_000n, 14_400n)).toBe(B);
    const { b } = mkMaker();
    b.tick(T1, 200n * MON);
    const room = b.allowance();
    expect(b.canSpend(room, false)).toEqual({ ok: true });
    expect(b.canSpend(room + 1n, false)).toEqual({ ok: false, why: "BUDGET" });
    expect(b.canSpend(room + 1n, true)).toEqual({ ok: true });
    b.tick(T1 + 1n, keep + 5n);
    expect(b.canSpend(6n, true)).toEqual({ ok: false, why: "FLOOR" });
  });
});

// Oct 4 2026, live on Monad testnet: the payer's budget paced for the production horizon (about 1.36 MON a day) refused
// the demo session's listings (about 0.53 MON each). A demo session adds its own MON, once per session and unpaced, until
// its end; what it used is kept in session-<until>.json (review finding Oct 5: never granted again on a new UTC day).
describe("budget, a demo session's MON (AGATE_*_SESSION_MON / _UNTIL)", () => {
  const UNTIL = Number(T0) + 5 * 3_600;
  const withSession = (sessionMon: number, dir = mkdtempSync(join(tmpdir(), "agate-budget-session-")), until = UNTIL) =>
    new Budget({ dir, role: "payer", keepWei: monToWei(15), lowBalanceWei: monToWei(60), runUntil: RUN_UNTIL, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: "0x3786e99fC370506391be896E1D327a49de6A9505", session: { wei: monToWei(sessionMon), until } });

  test("the session's MON is allowed at once, on top of the paced share; the day file keeps the frozen B only", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-budget-session-"));
    const b = withSession(10, dir);
    b.tick(T0, 24n * MON + monToWei(15)); // B = 2 MON, 1/24 of it allowed in the first hour
    const B = b.today!.budgetWei;
    const first = (B * 3_600n) / 86_400n;
    expect(b.allowance()).toBe(first + 10n * MON);
    expect(b.dayLeft()).toBe(B + 10n * MON);
    expect(b.canSpend(6n * MON, false)).toEqual({ ok: true }); // six listings' worth at 00:00
    b.record(6n * MON, false); // the paced share first, the rest from the session
    expect(b.sessionLeft()).toBe(10n * MON - (6n * MON - first));
    expect(b.allowance()).toBe(10n * MON - (6n * MON - first));
    const saved = JSON.parse(readFileSync(join(dir, `budget-${utcDay(T0)}.json`), "utf8")) as Record<string, string>;
    expect(saved.budgetWei).toBe(B.toString());
    const sess = JSON.parse(readFileSync(join(dir, `session-${UNTIL}.json`), "utf8")) as Record<string, string>;
    expect(BigInt(sess.usedWei!)).toBe(6n * MON - first);
  });

  test("granted once: a restart keeps what was used, and a new UTC day grants no second session", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-budget-session-"));
    const until = Number(T0) + 2 * 86_400; // a session that would span two days
    const a = withSession(10, dir, until);
    a.tick(T0 + 82_800n, 24n * MON + monToWei(15)); // 23:00 UTC: all of B is paced free
    a.record(a.today!.budgetWei + 8n * MON, false); // B, then 8 MON of the session
    expect(a.sessionLeft()).toBe(2n * MON);
    const b = withSession(10, dir, until); // restarted with the same session
    b.tick(T0 + 86_400n, 16n * MON + monToWei(15)); // the next UTC day
    expect(b.sessionLeft()).toBe(2n * MON); // not 10 again
    expect(b.allowance()).toBe((b.today!.budgetWei * 3_600n) / 86_400n + 2n * MON);
  });

  test("after its end the session grants nothing; spend past B waits for pacing", () => {
    const b = withSession(10);
    b.tick(BigInt(UNTIL) + 1n, 24n * MON + monToWei(15));
    expect(b.sessionLeft()).toBe(0n);
    expect(b.allowance()).toBe((b.today!.budgetWei * (BigInt(UNTIL) + 1n - T0 + 3_600n)) / 86_400n);
  });

  test("the floor still holds with a session; safety sends never use the session's MON", () => {
    const b = withSession(100);
    b.tick(T0, 16n * MON); // 1 MON above keep
    expect(b.canSpend(2n * MON, false)).toEqual({ ok: false, why: "FLOOR" });
    const c = withSession(10);
    c.tick(T0, 24n * MON + monToWei(15));
    c.record(5n * MON, true);
    expect(c.sessionLeft()).toBe(10n * MON);
  });

  test("an unreadable session record grants nothing more (fail closed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-budget-session-"));
    writeFileSync(join(dir, `session-${UNTIL}.json`), "{not json");
    const b = withSession(10, dir);
    b.tick(T0, 24n * MON + monToWei(15));
    expect(b.sessionLeft()).toBe(0n);
  });
});

describe("sessionFromEnv", () => {
  test("neither set is none; MON in [0, 1000] with a unix UNTIL; anything else is refused", async () => {
    const { sessionFromEnv } = await import("../src/budget.ts");
    expect(sessionFromEnv({}, "X")).toBeUndefined();
    expect(sessionFromEnv({ X_SESSION_MON: "", X_SESSION_UNTIL: "" }, "X")).toBeUndefined();
    expect(sessionFromEnv({ X_SESSION_MON: "39.5", X_SESSION_UNTIL: "1791160000" }, "X")).toEqual({ wei: monToWei(39.5), until: 1791160000 });
    for (const bad of ["-1", "1001", "abc", "NaN", "Infinity"]) expect(() => sessionFromEnv({ X_SESSION_MON: bad, X_SESSION_UNTIL: "1791160000" }, "X")).toThrow("X_SESSION_MON is not a MON amount");
    expect(() => sessionFromEnv({ X_SESSION_MON: "10" }, "X")).toThrow("X_SESSION_UNTIL is not a unix time");
    expect(() => sessionFromEnv({ X_SESSION_UNTIL: "1791160000" }, "X")).toThrow("X_SESSION_MON is not a MON amount");
    expect(() => sessionFromEnv({ X_SESSION_MON: "10", X_SESSION_UNTIL: "soon" }, "X")).toThrow("X_SESSION_UNTIL is not a unix time");
  });
});
