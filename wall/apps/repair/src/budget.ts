// Claude call budgets (BUILD-SPEC 15.2): at most AGATE_REPAIR_MAX_CALLS_INCIDENT (3) per incident and
// AGATE_REPAIR_MAX_CALLS_DAY (8) per UTC day, persisted in <repair>/budget.json so a restart does not reset them.
import { existsSync, readFileSync } from "node:fs";
import { writeAtomic } from "@agate/watcher";
import type { Budgets } from "./config.ts";

interface BudgetFile {
  day: string;
  calls: number;
  incidents: Record<string, number>;
}

export class Budget {
  private f: BudgetFile;
  constructor(
    readonly path: string,
    readonly limits: Budgets,
  ) {
    let f: BudgetFile = { day: "", calls: 0, incidents: {} };
    try {
      if (existsSync(path)) f = { ...f, ...(JSON.parse(readFileSync(path, "utf8")) as BudgetFile) };
    } catch {
      // a corrupt file starts a fresh day count (the per-incident count also lives in the incident)
    }
    this.f = f;
  }

  private today(now: number): string {
    return new Date(now * 1000).toISOString().slice(0, 10);
  }

  /** Null when a call may be made now, else why not. */
  refusal(incidentId: string, now: number): string | null {
    const day = this.today(now);
    const usedToday = this.f.day === day ? this.f.calls : 0;
    if ((this.f.incidents[incidentId] ?? 0) >= this.limits.perIncident) return `budget: ${this.limits.perIncident} Claude calls already made for this incident`;
    if (usedToday >= this.limits.perDay) return `budget: ${this.limits.perDay} Claude calls already made on ${day} (UTC)`;
    return null;
  }

  spend(incidentId: string, now: number): void {
    const day = this.today(now);
    if (this.f.day !== day) this.f = { ...this.f, day, calls: 0 };
    this.f.calls++;
    this.f.incidents[incidentId] = (this.f.incidents[incidentId] ?? 0) + 1;
    writeAtomic(this.path, JSON.stringify(this.f));
  }

  used(incidentId: string): number {
    return this.f.incidents[incidentId] ?? 0;
  }
}
