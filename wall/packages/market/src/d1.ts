// MS 6.6 (v2, finding D1), as fixed by the audit (P-H1, M-H2): our own bots never send a sync-bearing call
// (sync, claimMany, settle) that would FORCE a day the wall has not provided yet. The call applies days
// startDay + kState .. startDay + kPrev - 1 (previewSync counts forced days in kPrev). A day can only be forced once
// it is past its last resort (end + lastResort); every other day in that range is applied because it is final. Of
// the days at or near their last resort, a day is held when:
//   - the wall has not closed it (index.head <= day): the wall is catching up and will close it;
//   - the wall closed it and its record exists but is not final yet (pending, waiting for the attester): finality
//     comes, so forcing now would make the series and the index disagree for good;
//   - head does not answer (a MockIndex reverts it): we cannot tell, so we hold. No answer from any RPC URL (RpcDown)
//     propagates instead: the caller's tick tries again.
// A closed day with no record (the wall skipped it) is not held: forcing it is the last resort doing its job.
// "Near" is a margin (default one hour) so a day that crosses its last resort between this check and the send is
// still counted: this check needs no fresh chain time. (Recheck R1-L1) Such a day is usually day kPrev itself, or a
// later one: previewSync stopped at kPrev because it is neither final nor past its last resort yet, and the call's own
// _sync(all) forces it (and then any later day that has crossed too) if it crosses before the call lands. So the check
// runs from kState over every day of the month at or within the margin of its last resort, past kPrev, and even when
// the call has nothing to apply now (kState == kPrev).
import type { Address, Hex } from "viem";
import { RpcDown } from "@agate/watcher";
import type { MarketReads } from "./types.ts";

export const D1_MARGIN_S = 3_600n;

export interface D1Terms {
  index: Address;
  gpuId: Hex;
  startDay: number;
  startTs: bigint;
  day: number;
  lastResort: bigint;
  /** the month's days N: no day at or past N is checked (absent: the margin alone bounds the walk, the safe side) */
  n?: number;
}

export interface D1Held {
  day: number;
  head: number | null;
  why: "not closed" | "closed, not final yet" | "index head unreadable" | "record unreadable";
}

/** The first day a sync-bearing call from kState would force by the time it lands while the wall has not provided it,
 *  or null when it forces nothing the wall will provide. `_kPrev` (previewSync's k) no longer bounds the walk (R1-L1):
 *  the days the call applies now are kState .. kPrev - 1, but a day at or past kPrev that crosses its last resort before
 *  the call lands is forced as well, so the walk goes on while days are within the margin. Reads head once (only when
 *  some day is near its last resort) and a record per such closed day. */
export async function forcedDay(reads: Pick<MarketReads, "indexHead" | "indexRecord">, terms: D1Terms, kState: number, _kPrev: number, t: bigint, marginS: bigint = D1_MARGIN_S): Promise<D1Held | null> {
  let head: number | null | undefined;
  const n = terms.n ?? Number.MAX_SAFE_INTEGER;
  for (let j = kState; j < n; j++) {
    const end = terms.startTs + BigInt(j + 1) * BigInt(terms.day);
    if (end + terms.lastResort > t + marginS) break; // this day and every later one can only be in kPrev as final
    const day = terms.startDay + j;
    if (head === undefined) {
      try {
        head = await reads.indexHead(terms.index, terms.gpuId);
      } catch (e) {
        if (e instanceof RpcDown) throw e; // no answer at all: the caller's tick tries again
        head = null;
      }
    }
    if (head === null) return { day, head, why: "index head unreadable" };
    if (head <= day) return { day, head, why: "not closed" };
    let r: { exists: boolean; isFinal: boolean };
    try {
      r = await reads.indexRecord(terms.index, terms.gpuId, day);
    } catch (e) {
      if (e instanceof RpcDown) throw e;
      return { day, head, why: "record unreadable" };
    }
    if (r.exists && !r.isFinal) return { day, head, why: "closed, not final yet" };
  }
  return null;
}
