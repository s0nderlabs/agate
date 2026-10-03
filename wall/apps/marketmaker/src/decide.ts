// BOTS-SPEC 3.5: when to cancel and replace, pure. Per book and tick: one batchUpdate cancelling every active order and
// placing the whole target ladder when one condition holds, in this priority. Condition 1 is a safety action (cancel
// only). Condition 2 (orders crossed by fair or by the band of a newer public value, outside [F, C], or on a side the
// inventory gate closed) is urgent (audit M-M2): it goes first and is sent under the day's budget as a full requote;
// when the budget (or anything else) stops that, only the cancel of the crossed orders goes out, as a safety action.
// Conditions 3 to 6 are the daily budget's, largest |fair - quotedFair| first. At most one requote per book per
// minRequoteS.
import type { OwnOrder } from "./book.ts";
import type { Ladder } from "./ladder.ts";

export interface QuotedRec {
  fair: bigint;
  /** the band of that requote (M-H1); absent in an older state file: fair */
  lo?: bigint;
  hi?: bigint;
  at: number; // chain time of the requote
  topBid: { id: bigint; size: bigint } | null; // the best bid placed then
  topAsk: { id: bigint; size: bigint } | null;
  closed?: { bids: boolean; asks: boolean }; // the inventory gates at that requote
}

export interface BookView {
  market: string;
  t: number; // chain time
  nowMs: number; // local clock, for minRequoteS
  fair: bigint | null; // null: no fair (no index): nothing new is placed
  /** the band (M-H1): lo <= fair <= hi; absent: fair */
  lo?: bigint;
  hi?: bigint;
  floor: bigint;
  cap: bigint;
  orders: readonly OwnOrder[]; // the maker's active orders on this book (reconciled)
  quoted: QuotedRec | null;
  target: Ladder; // after both clamps
  bidsClosed: boolean;
  asksClosed: boolean;
  cancelOnly: string | null; // kill, wind-down, routerCanUse false, not ACTIVE, no index: the reason
  lastRequoteMs: number | null;
}

export interface DecideConfig {
  requoteMoveU: bigint;
  replenishBelowPct: number;
  staleS: number;
  minRequoteS: number;
}

export type Decision =
  | { act: "none"; why?: string }
  | { act: "cancel"; cond: 1; safety: true; why: string }
  | { act: "requote"; cond: 2; safety: false; urgent: true; crossed: bigint[]; why: string; priority: bigint }
  | { act: "requote"; cond: 3 | 4 | 5 | 6; safety: false; urgent?: false; why: string; priority: bigint };

const abs = (x: bigint) => (x < 0n ? -x : x);
const max = (...xs: bigint[]) => xs.reduce((m, x) => (x > m ? x : m), 0n);
export const NEVER_QUOTED = 2n ** 200n;

function topRemaining(orders: readonly OwnOrder[], top: { id: bigint } | null): bigint | null {
  if (!top) return null;
  return orders.find((o) => o.id === top.id)?.remaining ?? 0n;
}

/** Condition 2's orders: crossed by the band, outside [F, C], or on a side the gate closed (ids, ascending). */
export function crossedOrders(v: Pick<BookView, "orders" | "floor" | "cap" | "bidsClosed" | "asksClosed">, lo: bigint, hi: bigint): bigint[] {
  const out = v.orders.filter((o) => (o.isBuy ? o.price >= lo || v.bidsClosed : o.price <= hi || v.asksClosed) || o.price < v.floor || o.price > v.cap);
  return out.map((o) => o.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function decide(v: BookView, c: DecideConfig): Decision {
  if (v.cancelOnly !== null) {
    if (v.orders.length > 0) return { act: "cancel", cond: 1, safety: true, why: v.cancelOnly };
    return { act: "none", why: v.cancelOnly };
  }
  if (v.fair === null) return v.orders.length > 0 ? { act: "cancel", cond: 1, safety: true, why: "no fair value" } : { act: "none", why: "no fair value" };
  if (v.lastRequoteMs !== null && v.nowMs - v.lastRequoteMs < c.minRequoteS * 1000) return { act: "none", why: "minRequoteS" };
  const fair = v.fair;
  const lo = v.lo !== undefined && v.lo < fair ? v.lo : fair;
  const hi = v.hi !== undefined && v.hi > fair ? v.hi : fair;
  const q = v.quoted;
  const moved = q ? max(abs(fair - q.fair), abs(lo - (q.lo ?? q.fair)), abs(hi - (q.hi ?? q.fair))) : NEVER_QUOTED;
  const priority = moved;
  const req = (cond: 3 | 4 | 5 | 6, why: string): Decision => ({ act: "requote", cond, safety: false, why, priority });
  const bids = v.orders.filter((o) => o.isBuy);
  const asks = v.orders.filter((o) => !o.isBuy);
  // 2: fair (or the band of a newer public value) moved through the quotes, an order outside [F, C], or a gate closed a
  // side that still rests: urgent, the crossed orders named for the safety fallback
  const crossed = crossedOrders(v, lo, hi);
  if (crossed.length > 0) {
    const why = bids.some((o) => o.price >= lo) || asks.some((o) => o.price <= hi) ? (lo < fair || hi > fair ? "a newer public index value moved through the quotes" : "fair moved through the quotes") : v.orders.some((o) => o.price < v.floor || o.price > v.cap) ? "an order outside [F, C]" : "inventory gate closed a side";
    return { act: "requote", cond: 2, safety: false, urgent: true, crossed, why, priority };
  }
  // 3: fair (or the band) moved more than requoteMoveU
  if (q && moved > c.requoteMoveU) return req(3, `fair moved ${fair - q.fair} u${lo !== fair || hi !== fair || q.lo !== undefined ? ` (band ${lo} to ${hi})` : ""}`);
  // 4: the top order of a side under replenishBelowPct % of its placed size (a filled one counts 0)
  if (q) {
    for (const [top, side, want] of [
      [q.topBid, "bid", v.target.bids.length > 0],
      [q.topAsk, "ask", v.target.asks.length > 0],
    ] as const) {
      const rem = topRemaining(v.orders, top);
      if (want && top && rem !== null && rem * 100n < BigInt(c.replenishBelowPct) * top.size) return req(4, `top ${side} at ${rem} of ${top.size} units`);
    }
  }
  const wants = v.target.bids.length + v.target.asks.length > 0;
  // 5: stale
  if (q && wants && v.t - q.at >= c.staleS) return req(5, "stale");
  // 6: no orders but should have some, or a side the gate had closed is open again
  if (v.orders.length === 0 && wants) return req(6, q ? "the book emptied" : "first quote");
  if (q?.closed?.bids && !v.bidsClosed && v.target.bids.length > 0) return req(6, "the bid gate reopened");
  if (q?.closed?.asks && !v.asksClosed && v.target.asks.length > 0) return req(6, "the ask gate reopened");
  return { act: "none" };
}

/** Safety and urgent first (in the given order), then the daily-budget books by priority, largest first. */
export function order<T extends { d: Decision }>(xs: readonly T[]): T[] {
  const first = xs.filter((x) => x.d.act === "cancel" || (x.d.act === "requote" && x.d.urgent === true));
  const daily = xs.filter((x) => x.d.act === "requote" && x.d.urgent !== true);
  daily.sort((a, b) => {
    const pa = (a.d as { priority: bigint }).priority;
    const pb = (b.d as { priority: bigint }).priority;
    return pa === pb ? 0 : pa > pb ? -1 : 1;
  });
  return [...first, ...daily];
}
