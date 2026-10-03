// Display rules (BOTS-SPEC 5.5): enum names from the contracts' integers, the GPU label from a symbol, and the
// day label of the app (the wall's dayLabel, wall spec 9.6) from a DailyFix's stored fields.

export const VENUE = ["NONE", "KURU_V1", "OTHER"] as const;
export const BAND_GRADE = ["RULE", "STALE", "SEEDED"] as const;
export const SIDE = ["LONG", "SHORT"] as const;
export const CLOSE_STATUS = ["CLOSED_FINAL", "CLOSED_WITH_TOKEN", "UNSTREAMED"] as const; // CloseKind FINAL, WITH_TOKEN, UNSTREAMED
export const FIX_STATUS = ["NONE", "FULL", "DEGRADED", "DEMO", "CARRIED"] as const; // IAgateIndex.Status
export const FLOW = ["OPEN_LONG", "OPEN_LONG_DAILY", "OPEN_SHORT", "CLOSE_LONG", "CLOSE_SHORT", "CLOSE_LONG_DAILY"] as const;
export const KURU_STATE = ["ACTIVE", "SOFT_PAUSED", "HARD_PAUSED"] as const;

/** The name at position v of an enum table; throws on a value the contracts cannot emit. */
export function enumOf<T extends readonly string[]>(table: T, v: bigint | number, what: string): T[number] {
  const name = table[Number(v)];
  if (name === undefined) throw new Error(`${what}: unknown value ${v.toString()}`);
  return name;
}

/** The name at position v, or `fallback` (logged by the caller) for a value this table does not know: for Kuru's
 *  enums, whose proxies Kuru can upgrade, so a new value never halts the indexer (audit L-5). */
export function enumOr<T extends readonly string[]>(table: T, v: bigint | number, fallback: T[number]): { name: T[number]; known: boolean } {
  const name = table[Number(v)];
  return name === undefined ? { name: fallback, known: false } : { name, known: true };
}

/** FixApplied flag bits (MS 8.2). */
export const FLAGS = { late: 1, incomplete: 2, forced: 4, belowFloor: 8, aboveCap: 16, carried: 32 } as const;
export function splitFlags(flags: number) {
  return {
    late: (flags & FLAGS.late) !== 0,
    incomplete: (flags & FLAGS.incomplete) !== 0,
    forced: (flags & FLAGS.forced) !== 0,
    belowFloor: (flags & FLAGS.belowFloor) !== 0,
    aboveCap: (flags & FLAGS.aboveCap) !== 0,
    carried: (flags & FLAGS.carried) !== 0,
  };
}

/** The GPU label of a symbol (NameLib, MS 4.2): "[tag letter]" + label + "-" + MON + YY, so dH100-NOV26 gives H100.
 *  Cut from both ends, since a label may itself contain a hyphen. */
export function labelOfSymbol(symbol: string, tag: string): string {
  return symbol.slice(tag.length > 0 ? 1 : 0, symbol.length - 6);
}

export type DayLabel = "open" | "skipped" | "pending" | "final" | "carried" | "carried, unverified";

/** The app's label of one index day from its DailyFix (null: no row), at chain time t (BOTS-SPEC 5.5). */
export function dayLabel(fix: { state: string; finalAt: bigint | undefined } | null | undefined, t: bigint): DayLabel {
  if (!fix) return "open";
  switch (fix.state) {
    case "SKIPPED":
      return "skipped";
    case "CARRIED":
      return "carried";
    case "CARRIED_UNVERIFIED":
      return "carried, unverified";
    case "FINAL":
      return "final";
    case "PENDING":
      return fix.finalAt !== undefined && t >= fix.finalAt ? "final" : "pending";
    default:
      return "pending"; // NEEDS_SIGN, VETOED, DROPPED
  }
}
