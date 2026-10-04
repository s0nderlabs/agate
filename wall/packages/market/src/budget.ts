// BOTS-SPEC 2.6: the MON budget of one bot key. Spend is counted from receipts into budget-<UTC day of chain time>.json,
// so a restart never resets the day. The day's budget B = (balance - keep) / daysLeft is computed at the first tick
// of the day and frozen; daysLeft = max(1, ceil((runUntil - t) / 86,400)), and 7 once runUntil has passed. By second
// s of the day the spend may reach B x min(1, (s + 3,600) / 86,400). Floor: never sign when balance - costMax < keep.
// Safety actions (the maker's) ignore B and pacing, never the floor; what they spend still counts in spentWei (the
// day's total, so a non-safety send after them gets only what is left) and also in safetyWei (BOTS-SPEC 2.6 v2).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AlertSink, alertId, writeAtomic } from "@agate/watcher";
import type { SpendGuard } from "./sender.ts";
import type { BudgetDay } from "./types.ts";

export const WEI_PER_MON = 10n ** 18n;
const DAY = 86_400n;

export function monToWei(mon: number): bigint {
  // to the gwei, exactly for any decimal MON amount a config holds
  return BigInt(Math.round(mon * 1e9)) * 10n ** 9n;
}

export function utcDay(t: bigint): string {
  return new Date(Number(t) * 1000).toISOString().slice(0, 10);
}

/** max(1, ceil((runUntil - t) / 86,400)) days, and 7 once runUntil has passed (a week of judging). */
export function daysLeft(t: bigint, runUntil: number): bigint {
  const left = BigInt(runUntil) - t;
  if (left <= 0n) return 7n;
  const d = (left + DAY - 1n) / DAY;
  return d < 1n ? 1n : d;
}

/** What the day's spend may reach by chain time t: B x min(1, (s + 3,600) / 86,400), s the second of the UTC day. */
export function paced(budgetWei: bigint, t: bigint): bigint {
  const s = ((t % DAY) + DAY) % DAY;
  const frac = s + 3_600n >= DAY ? DAY : s + 3_600n;
  return (budgetWei * frac) / DAY;
}

export interface BudgetOptions {
  /** <home>/market/<role> */
  dir: string;
  role: string;
  keepWei: bigint;
  lowBalanceWei: bigint;
  /** unix seconds */
  runUntil: number;
  alerts?: AlertSink;
  /** alert codes: MM_KEY_LOW / PAYER_KEY_LOW and MM_BUDGET_SPENT / PAYER_BUDGET_SPENT */
  lowCode: string;
  spentCode: string;
  /** the key's address (alert key) */
  address: string;
  /** A demo session's MON (sessionFromEnv): once per session, on top of the paced budget and unpaced (a session lists
   *  and quotes in bursts that a budget paced for the production horizon refuses), until `until`. What the session has
   *  used is kept in session-<until>.json, so a restart or a new UTC day never grants it again. The floor holds. */
  session?: { wei: bigint; until: number };
}

/** A demo session's MON for one bot from <prefix>_SESSION_MON and <prefix>_SESSION_UNTIL (unix seconds), both set by
 *  demo-session.sh from its plan; neither set = none. A MON amount outside [0, 1000], or a MON amount without its
 *  UNTIL, is refused at start. */
export function sessionFromEnv(env: Record<string, string | undefined>, prefix: string): { wei: bigint; until: number } | undefined {
  const mon = env[`${prefix}_SESSION_MON`]?.trim() ?? "";
  const until = env[`${prefix}_SESSION_UNTIL`]?.trim() ?? "";
  if (mon === "" && until === "") return undefined;
  const n = Number(mon);
  if (mon === "" || !Number.isFinite(n) || n < 0 || n > 1_000) throw new Error(`${prefix}_SESSION_MON is not a MON amount in [0, 1000]`);
  const u = Number(until);
  if (until === "" || !Number.isSafeInteger(u) || u <= 0) throw new Error(`${prefix}_SESSION_UNTIL is not a unix time (seconds)`);
  return { wei: monToWei(n), until: u };
}

export class Budget implements SpendGuard {
  private day: BudgetDay | null = null;
  private t = 0n;
  private balance = 0n;
  /** spent since the balance was read (the floor uses balance minus this) */
  private sinceRead = 0n;
  private spentAlertDay: string | null = null;
  /** what the session's MON has paid for so far (session-<until>.json) */
  private sessionUsed = 0n;

  constructor(readonly o: BudgetOptions) {
    if (o.session) {
      const f = this.sessionFile();
      try {
        if (existsSync(f)) this.sessionUsed = BigInt((JSON.parse(readFileSync(f, "utf8")) as { usedWei: string }).usedWei);
      } catch {
        this.sessionUsed = o.session.wei; // an unreadable record grants nothing more (fail closed)
      }
    }
  }

  private sessionFile(): string {
    return join(this.o.dir, `session-${this.o.session!.until}.json`);
  }

  /** What the session's MON still holds now (0 without a session or after its end). */
  sessionLeft(): bigint {
    const s = this.o.session;
    if (!s || this.t >= BigInt(s.until)) return 0n;
    return s.wei > this.sessionUsed ? s.wei - this.sessionUsed : 0n;
  }

  /** What pacing allows the day's own budget now (B's share, before the session's MON). */
  private pacedLeft(): bigint {
    const d = this.day;
    if (!d) return 0n;
    const allowed = paced(d.budgetWei, this.t);
    return allowed > d.spentWei ? allowed - d.spentWei : 0n;
  }

  private file(day: string): string {
    return join(this.o.dir, `budget-${day}.json`);
  }

  private load(day: string): BudgetDay | null {
    const f = this.file(day);
    if (!existsSync(f)) return null;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, string | number>;
      return { day, budgetWei: BigInt(j.budgetWei!), spentWei: BigInt(j.spentWei!), safetyWei: BigInt(j.safetyWei!), sends: Number(j.sends) };
    } catch {
      return null;
    }
  }

  private save(): void {
    const d = this.day!;
    writeAtomic(this.file(d.day), JSON.stringify({ day: d.day, budgetWei: d.budgetWei.toString(), spentWei: d.spentWei.toString(), safetyWei: d.safetyWei.toString(), sends: d.sends }));
  }

  static daysLeft(t: bigint, runUntil: number): bigint {
    return daysLeft(t, runUntil);
  }

  /** Once per tick, with chain time and the key's balance. */
  tick(t: bigint, balanceWei: bigint): void {
    this.t = t;
    this.balance = balanceWei;
    this.sinceRead = 0n;
    const day = utcDay(t);
    if (!this.day || this.day.day !== day) {
      const old = this.load(day);
      if (old) this.day = old;
      else {
        const free = balanceWei > this.o.keepWei ? balanceWei - this.o.keepWei : 0n;
        this.day = { day, budgetWei: free / Budget.daysLeft(t, this.o.runUntil), spentWei: 0n, safetyWei: 0n, sends: 0 };
        this.save();
      }
    }
    const lowId = alertId({ code: this.o.lowCode, key: this.o.address });
    if (balanceWei < this.o.lowBalanceWei) {
      this.o.alerts?.raise({ code: this.o.lowCode, severity: "action", key: this.o.address, message: `${this.o.role}: key ${this.o.address} holds less than ${fmtMon(this.o.lowBalanceWei)} MON`, data: { balanceMon: fmtMon(balanceWei) } });
    } else this.o.alerts?.clearWhere((a) => a.id === lowId);
  }

  get today(): BudgetDay | null {
    return this.day;
  }

  /** What pacing still allows the non-safety spend now, plus what a demo session's MON still holds (unpaced). */
  allowance(): bigint {
    if (!this.day) return 0n;
    return this.pacedLeft() + this.sessionLeft();
  }

  /** (Recheck R1-L2) What the day's budget still holds once pacing has freed all of it (B - spentWei), plus what the
   *  session's MON still holds: the most the non-safety spend can still reach today, waiting included. */
  dayLeft(): bigint {
    const d = this.day;
    if (!d) return 0n;
    return (d.budgetWei > d.spentWei ? d.budgetWei - d.spentWei : 0n) + this.sessionLeft();
  }

  /** Room above the floor. */
  headroom(): bigint {
    const bal = this.balance - this.sinceRead;
    return bal > this.o.keepWei ? bal - this.o.keepWei : 0n;
  }

  canSpend(costMaxWei: bigint, safety: boolean): { ok: true } | { ok: false; why: string } {
    if (!this.day) return { ok: false, why: "BUDGET (no tick yet)" };
    if (costMaxWei > this.headroom()) return { ok: false, why: "FLOOR" };
    if (!safety && costMaxWei > this.allowance()) {
      this.spent(`a send of up to ${fmtMon(costMaxWei)} MON`);
      return { ok: false, why: "BUDGET" };
    }
    return { ok: true };
  }

  record(costWei: bigint, safety: boolean): void {
    if (!this.day) return;
    // a non-safety send first takes what pacing allows the day; the rest is the session's (kept across days)
    if (!safety && this.o.session && this.sessionLeft() > 0n) {
      const fromDay = this.pacedLeft();
      const over = costWei > fromDay ? costWei - fromDay : 0n;
      if (over > 0n) {
        this.sessionUsed += over;
        writeAtomic(this.sessionFile(), JSON.stringify({ until: this.o.session.until, wei: this.o.session.wei.toString(), usedWei: this.sessionUsed.toString() }));
      }
    }
    this.day.spentWei += costWei;
    if (safety) this.day.safetyWei += costWei;
    this.day.sends += 1;
    this.sinceRead += costWei;
    this.save();
  }

  /** The info alert of a day whose budget or pacing stopped a send (once per day). */
  spent(what: string): void {
    const d = this.day;
    if (!d || this.spentAlertDay === d.day) return;
    this.spentAlertDay = d.day;
    this.o.alerts?.raise({ code: this.o.spentCode, severity: "info", key: this.o.address, day: Number(BigInt(Date.parse(`${d.day}T00:00:00Z`)) / 1000n / DAY), message: `${this.o.role}: the day's budget (${fmtMon(d.budgetWei)} MON, ${fmtMon(d.spentWei)} spent, paced hourly) stopped ${what} on ${d.day}` });
  }
}

export function fmtMon(wei: bigint): string {
  const whole = wei / WEI_PER_MON;
  const frac = ((wei % WEI_PER_MON) * 10_000n) / WEI_PER_MON;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
}
