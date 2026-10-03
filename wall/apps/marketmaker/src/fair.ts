// BOTS-SPEC 3.2: the fair value of a token = the month's expected average, (S + (N - k) x xc) / N, xc the newest final
// index value clamped into [F, C]. Before the month k = 0 and S = 0, so fair = xc; at k = N it is S / N.
// The guard (audit M-H1): a newer value is public before it is final (a closed day's record waits T_PEND, and
// index.previewFix shows an ended day before the wall closes it). Fair stays on the final value, but the ladder is
// placed around the band [lo, hi] = the fair and the fair each newer value would give, so no bid rests at or over the
// lowest of them and no ask at or under the highest until they are final. (Recheck R1-M1) Every newer public value
// counts, not only one: two can be public at once (a closed day waiting for its countersign while the next day ends and
// previewFix shows it, or two pending records), and whichever turns final first moves fair to it.
// (Recheck R2-M1) Two more values can turn final next: (a) while the pending record (head - 1) is not attested, the
// attester may select another writer's value for that day (RecordReplaced, final at once when the record has waited
// past T_PEND), which index.previewRecord(gpuId, head - 1, writer) shows before the select: each other writer's value
// joins the band; (b) while the wall is two or more ended days behind (head < today - 1), the days past head are in no
// view, yet their readings are on chain and x jumps to the newest of them after the catch-up: the band is then the
// whole [fair at F, fair at C] (every value is clamped into [F, C]), so nothing rests inside what can follow.
import type { Address, Hex } from "viem";
import { clamp, dayIdAt, fair as sharedFair, type MarketReads, type PreviewReads } from "@agate/market";

export { clamp };

/** startDay + floor((t - startTs) / DAY), floored toward minus infinity (the shared dayIdAt). */
export function todayOf(t: bigint, startDay: number, startTs: bigint, day: number): number {
  return dayIdAt({ startDay, startTs, day }, t);
}

/** The newest closed day to start the walk at: min(today - 1, head - 1), or today - 1 when head does not answer. */
export function walkTop(today: number, head: number | null): number {
  return head === null ? today - 1 : Math.min(today - 1, head - 1);
}

/** floor((S + (N - k) * xc) / N), u per token. */
export function fairValue(sum: bigint, k: number, n: number, xc: bigint): bigint {
  if (k < 0 || k > n || n <= 0) throw new Error(`fairValue: k ${k} outside 0..${n}`);
  return (sum + BigInt(n - k) * xc) / BigInt(n);
}

export const WALK_DAYS = 31;

/** A value that is public on chain but not final yet: a closed day's pending record, previewFix of an ended day, or
 *  (R2-M1) another writer's value for the pending day that the attester may select (previewRecord). */
export interface Pending {
  day: number;
  value: bigint;
  source: "record" | "preview" | "select";
  /** a pending record's writer and whether it is attested (the attester's select is possible only before) */
  writer?: Address;
  attested?: boolean;
}

export interface Walk {
  x: bigint | null; // the newest final value in the window (null: MM_NO_INDEX)
  /** every value above it that is public but not final, newest first: each record that exists and is not final, and
   *  (FairBook.indexWalk) an ended head day's previewFix (R1-M1: all of them, not only the newest) and the other
   *  writers' values for an unattested pending head - 1 (R2-M1) */
  pending: Pending[];
  /** (R2-M1) ended days the wall has not closed: today - head (0 or 1 is current); null when head does not answer */
  lag?: number | null;
}

/** The walk of 3.2 over days top down to top - 31: the newest record with exists and isFinal, and every record newer
 *  than it that exists but is not final yet. */
export async function walkIndex(reads: Pick<MarketReads, "indexRecord">, index: Address, gpuId: Hex, top: number): Promise<Walk> {
  const pending: Pending[] = [];
  for (let d = top; d >= top - WALK_DAYS; d--) {
    if (d < 0) break;
    const r = await reads.indexRecord(index, gpuId, d);
    if (r.exists && r.isFinal) return { x: r.value, pending };
    if (r.exists) pending.push({ day: d, value: r.value, source: "record", ...(r.source ? { writer: r.source } : {}), attested: (r.attestedAt ?? 0n) !== 0n });
  }
  return { x: null, pending };
}

/** The value of the newest record of (index, gpuId) with exists and isFinal among days top down to top - 31; null
 *  when none (MM_NO_INDEX). */
export async function latestFinal(reads: Pick<MarketReads, "indexRecord">, index: Address, gpuId: Hex, top: number): Promise<bigint | null> {
  return (await walkIndex(reads, index, gpuId, top)).x;
}

export interface FairInput {
  t: bigint;
  startDay: number;
  startTs: bigint;
  day: number;
  n: number;
  floor: bigint;
  cap: bigint;
  k: number; // previewSync().k
  sum: bigint; // previewSync().sum
}

export interface FairView {
  fair: bigint;
  x: bigint;
  xc: bigint;
  /** the band the ladder is placed around: lo <= fair <= hi (both fair when nothing newer is public) */
  lo: bigint;
  hi: bigint;
  /** every newer public value the band covers, newest first (empty: lo = hi = fair) */
  pending: Pending[];
  /** (R2-M1) ended days not closed (today - head); >= 2: the band is the whole [fair at F, fair at C] */
  lag: number | null;
}

/** (R2-M1) The wall lags this many ended days or more: the days past head are in no view. */
export const LAG_UNBOUNDED = 2;

type FairReads = Pick<MarketReads, "indexRecord" | "indexHead"> & Partial<PreviewReads>;

/** The whole of 3.2 over a MarketReads, with a per-tick cache of the walk per (index, gpuId, today). */
export class FairBook {
  private walk = new Map<string, Walk>();
  constructor(private readonly reads: FairReads) {}

  /** Clears the per-tick cache (call once per tick). */
  reset(): void {
    this.walk.clear();
  }

  async indexWalk(index: Address, gpuId: Hex, today: number): Promise<Walk> {
    const key = `${index.toLowerCase()}:${gpuId.toLowerCase()}:${today}`;
    const hit = this.walk.get(key);
    if (hit) return hit;
    const head = await this.reads.indexHead(index, gpuId);
    const w = await walkIndex(this.reads, index, gpuId, walkTop(today, head));
    w.lag = head === null ? null : today - head;
    // the head day has ended but the wall has not closed it: its value is public through previewFix, as well as (not
    // instead of) any closed record still waiting for finality (R1-M1)
    if (w.x !== null && head !== null && head < today && this.reads.indexPreviewFix) {
      const p = await this.reads.indexPreviewFix(index, gpuId);
      if (p !== null) w.pending.unshift({ day: head, value: p.value, source: "preview" });
    }
    // R2-M1 (a): the pending record (only head - 1 can be pending: closeDay reverts while the day before is) is not
    // attested yet, so the attester may still select another writer's value for it, final at once; each other
    // writer's value is public through previewRecord: it joins the band
    const rec = head === null ? undefined : w.pending.find((p) => p.source === "record" && p.day === head - 1);
    if (w.x !== null && rec && !rec.attested && this.reads.indexWriters && this.reads.indexPreviewRecord) {
      const src = rec.writer?.toLowerCase();
      const others = (await this.reads.indexWriters(index)).filter((x) => x.toLowerCase() !== src);
      const vals = await Promise.all(others.map((x) => this.reads.indexPreviewRecord!(index, gpuId, rec.day, x)));
      for (const v of vals) if (v !== null && v.value !== rec.value) w.pending.push({ day: rec.day, value: v.value, source: "select" });
    }
    this.walk.set(key, w);
    return w;
  }

  async indexValue(index: Address, gpuId: Hex, today: number): Promise<bigint | null> {
    return (await this.indexWalk(index, gpuId, today)).x;
  }

  async fair(index: Address, gpuId: Hex, f: FairInput): Promise<FairView | null> {
    if (f.k >= f.n) {
      const settle = f.sum / BigInt(f.n);
      return { fair: settle, x: 0n, xc: 0n, lo: settle, hi: settle, pending: [], lag: null };
    }
    const today = todayOf(f.t, f.startDay, f.startTs, f.day);
    const w = await this.indexWalk(index, gpuId, today);
    if (w.x === null) return null;
    const terms = { n: f.n, floor: f.floor, cap: f.cap };
    // the shared formula of BOTS-SPEC 3.2 (@agate/market math.fair), the one P1 and P3 use
    const fair = sharedFair(f.sum, f.k, w.x, terms);
    let lo = fair;
    let hi = fair;
    // each newer value's fair alone (the one that turns final first) bounds the band; two of them final together give a
    // fair between those two (a convex mix), so the min and max of the set cover every order of finality
    for (const p of w.pending) {
      const fp = sharedFair(f.sum, f.k, p.value, terms);
      if (fp < lo) lo = fp;
      if (fp > hi) hi = fp;
    }
    const lag = w.lag ?? null;
    if (lag !== null && lag >= LAG_UNBOUNDED) {
      // R2-M1 (b): the days past head bound nothing we can read; each of the N - k days left, and x after them, is
      // clamped into [F, C], so every fair that can follow lies in [fair at F, fair at C]
      lo = sharedFair(f.sum, f.k, f.floor, terms);
      hi = sharedFair(f.sum, f.k, f.cap, terms);
    }
    return { fair, x: w.x, xc: clamp(w.x, f.floor, f.cap), lo, hi, pending: w.pending, lag };
  }
}
