// Day labels for the app (BUILD-SPEC 9.6, Oct 3): one label per index day from views alone (record and reopenedAt),
// so the indexer and the app compute the same thing without any offchain log.
import type { IndexRecord } from "@agate/report/types";
import { Status } from "@agate/report/types";

export type DayLabel = "open" | "skipped" | "pending" | "final" | "carried, unverified" | "carried";

/**
 * rec: record(gpuId, d).rec when it exists, else null; isFinal: record(gpuId, d).isFinal; reopenedAt:
 * reopenedAt(gpuId, d); head: head(gpuId).
 * - no record: "open" (d >= head) or "skipped" (d < head: DaySkipped, before the first record)
 * - not final: "pending"
 * - final, not CARRIED: "final"
 * - final, CARRIED, dropped or vetoed (reopenedAt > 0): "carried, unverified" (a record existed and was vetoed, by R3
 *   or the liveness veto of 6.6 step 3b, or dropped: that day's honest price was never verified)
 * - final, CARRIED otherwise: "carried" (no quorate data that day)
 */
export function dayLabel(rec: Pick<IndexRecord, "status" | "dropped"> | null, isFinal: boolean, reopenedAt: number, head: number, d: number): DayLabel {
  if (!rec || rec.status === Status.NONE) return d >= head ? "open" : "skipped";
  if (!isFinal) return "pending";
  if (rec.status !== Status.CARRIED) return "final";
  return rec.dropped || reopenedAt > 0 ? "carried, unverified" : "carried";
}
