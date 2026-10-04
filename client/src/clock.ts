// The index's clock (contracts/src/lib/IndexLib.sol) and when a day's price is expected to close and turn final
// (contracts/src/lib/IndexDays.sol). On the PRODUCTION clock: a day ends at 00:00 UTC; closeDay is open from the end
// plus CLOSE_GRACE (one slice, 01:00 UTC), which publishes the record; the record is final at postedAt + T_PEND
// (about 07:00 UTC) when it needs no countersign, and when it does, at max(postedAt + T_PEND, the countersign). So
// the earliest any day can be final is end + CLOSE_GRACE + T_PEND; a day whose writer missed slices may wait to
// close until end + T_PEND (then final at end + 2 T_PEND, 12:00 UTC); a countersign later than postedAt + T_PEND
// moves it to the countersign.

export interface IndexClocks {
  day: number;
  slice: number;
  tPend: number;
  closeGrace: number;
  slices: number;
  minReadings: number;
  epochTs: bigint;
  epochDay: number;
}

export interface RecordTimes {
  exists: boolean;
  isFinal: boolean;
  postedAt: bigint;
  finalAt: bigint;
}

export function dayStart(c: IndexClocks, d: number): bigint {
  return c.epochTs + BigInt(d - c.epochDay) * BigInt(c.day);
}

export function dayIdAt(c: IndexClocks, t: bigint): number {
  if (t < c.epochTs) return c.epochDay;
  return c.epochDay + Number((t - c.epochTs) / BigInt(c.day));
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** When day d's record is expected to be published (closed): its postedAt once it exists, else the close opens at
 *  the day's end plus CLOSE_GRACE (never before now). */
export function expectedClose(c: IndexClocks, d: number, rec: RecordTimes | null, now: bigint): bigint {
  if (rec?.exists) return rec.postedAt;
  return max(dayStart(c, d + 1) + BigInt(c.closeGrace), now);
}

/** When day d's price is expected to be final: finalAt once known; for a record waiting for its countersign,
 *  postedAt + T_PEND at the earliest (never before now); before the close, the expected close (never before now)
 *  plus T_PEND. */
export function expectedFinal(c: IndexClocks, d: number, rec: RecordTimes | null, now: bigint): bigint {
  if (rec?.exists) {
    if (rec.finalAt !== 0n) return rec.finalAt;
    return max(rec.postedAt + BigInt(c.tPend), now);
  }
  return max(dayStart(c, d + 1) + BigInt(c.closeGrace), now) + BigInt(c.tPend);
}
