// BOTS-SPEC 3.3: the quote ladder around fair, then the two clamps (never crossing anyone; inventory gates).
// Prices in u per token (Kuru pricePrecision units), sizes in Kuru size units (one unit = LOT = 100 base units).
import { KURU_MAX_SIZE, KURU_MIN_SIZE, LOT, TICK } from "@agate/market";

export interface Level {
  price: bigint;
  size: bigint; // Kuru size units
}
export interface Ladder {
  bids: Level[]; // best (highest) first
  asks: Level[]; // best (lowest) first
}
export interface LadderParams {
  spreadBps: number;
  levels: number;
  levelStepTicks: number;
  sizesTokens: number[];
}

export const UNITS_PER_TOKEN = 10_000n; // Kuru size units per whole token

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** h = max(TICK, ceil(fair * spreadBps / 10,000)). */
export function halfSpread(fair: bigint, spreadBps: number): bigint {
  const h = ceilDiv(fair * BigInt(spreadBps), 10_000n);
  return h > TICK ? h : TICK;
}

/** The band a ladder is placed around: lo <= fair <= hi (audit M-H1: a newer public value widens it). */
export interface Band {
  lo: bigint;
  hi: bigint;
}

/** The target ladder before the crossing clamp: bids under the band's lo, asks over its hi (both fair when no newer
 *  value is public), h from fair, all on the tick, inside [F, C]. */
export function targetLadder(fair: bigint, floor: bigint, cap: bigint, p: LadderParams, band: Band = { lo: fair, hi: fair }): Ladder {
  const h = halfSpread(fair, p.spreadBps);
  const step = BigInt(p.levelStepTicks) * TICK;
  const bids: Level[] = [];
  const asks: Level[] = [];
  const lo = band.lo < fair ? band.lo : fair;
  const hi = band.hi > fair ? band.hi : fair;
  if (lo - h >= TICK) {
    const bid0 = ((lo - h) / TICK) * TICK;
    for (let i = 0; i < p.levels; i++) {
      const price = bid0 - BigInt(i) * step;
      if (price < floor || price <= 0n) break;
      bids.push({ price, size: BigInt(p.sizesTokens[i]!) * UNITS_PER_TOKEN });
    }
  }
  const ask0 = ceilDiv(hi + h, TICK) * TICK;
  for (let i = 0; i < p.levels; i++) {
    const price = ask0 + BigInt(i) * step;
    if (price > cap) break;
    asks.push({ price, size: BigInt(p.sizesTokens[i]!) * UNITS_PER_TOKEN });
  }
  return { bids, asks };
}

/** Clamp 1: against the others' best bid ob and best ask oa (the book minus the maker's own resting sizes):
 *  bid_i = min(bid_i, oa - TICK), ask_i = max(ask_i, ob + TICK); a level that leaves [F, C] or repeats a price already
 *  kept on its side is dropped. */
export function clampCrossing(l: Ladder, others: { bid: bigint | null; ask: bigint | null }, floor: bigint, cap: bigint): Ladder {
  const bids: Level[] = [];
  const asks: Level[] = [];
  const seenB = new Set<bigint>();
  const seenA = new Set<bigint>();
  for (const b of l.bids) {
    const price = others.ask !== null && b.price > others.ask - TICK ? others.ask - TICK : b.price;
    if (price < floor || price > cap || price <= 0n || seenB.has(price)) continue;
    seenB.add(price);
    bids.push({ price, size: b.size });
  }
  for (const a of l.asks) {
    const price = others.bid !== null && a.price < others.bid + TICK ? others.bid + TICK : a.price;
    if (price < floor || price > cap || seenA.has(price)) continue;
    seenA.add(price);
    asks.push({ price, size: a.size });
  }
  return { bids, asks };
}

/** Clamp 2, the inventory gates (audit M-M1): each side is cut to the room it has left, so no fill of it can carry
 *  |E| past maxNet: asks to maxNet + E tokens, bids to maxNet - E (token base units in, whole tokens out, the
 *  outermost levels cut first). A side with less than one token of room is closed. */
export function gate(l: Ladder, exposure: bigint, maxNetBase: bigint): { ladder: Ladder; bidsClosed: boolean; asksClosed: boolean; bidsCut: boolean; asksCut: boolean } {
  const room = (r: bigint) => (r > 0n ? r / LOT : 0n); // Kuru size units
  const askRoom = room(maxNetBase + exposure);
  const bidRoom = room(maxNetBase - exposure);
  const asks = cutAsks(l.asks, askRoom);
  const bids = cutAsks(l.bids, bidRoom);
  const sum = (xs: readonly Level[]) => xs.reduce((s, x) => s + x.size, 0n);
  return {
    ladder: { bids, asks },
    bidsClosed: bidRoom < KURU_MIN_SIZE,
    asksClosed: askRoom < KURU_MIN_SIZE,
    bidsCut: sum(bids) < sum(l.bids),
    asksCut: sum(asks) < sum(l.asks),
  };
}

/** One side cut to `units` Kuru size units in total, from the outermost level in (a level kept only if >= one
 *  token): the asks for the tokens there are, either side for the inventory gate. */
export function cutAsks(asks: readonly Level[], units: bigint): Level[] {
  const out: Level[] = [];
  let left = units;
  for (const a of asks) {
    if (left <= 0n) break;
    const take = a.size <= left ? a.size : (left / UNITS_PER_TOKEN) * UNITS_PER_TOKEN;
    if (take < KURU_MIN_SIZE) break;
    out.push({ price: a.price, size: take });
    left -= take;
  }
  return out;
}

/** Bids cut to `dollars` u of lock in total, from the outermost level in (whole tokens, >= one token each). */
export function cutBids(bids: readonly Level[], dollars: bigint): Level[] {
  const out: Level[] = [];
  let left = dollars;
  for (const b of bids) {
    const lock = lockOf(b);
    if (lock <= left) {
      out.push(b);
      left -= lock;
      continue;
    }
    const units = ((left * 10_000n) / b.price / UNITS_PER_TOKEN) * UNITS_PER_TOKEN;
    if (units >= KURU_MIN_SIZE) out.push({ price: b.price, size: units });
    break;
  }
  return out;
}

/** Dollars a resting bid locks: price * size / 10^4 u (exact: price is a multiple of 10^4). */
export function lockOf(b: Level): bigint {
  return (b.price * b.size) / 10_000n;
}

/** The invariants of 3.3, for tests and a last check before a send: null when they hold. With a band (M-H1) every
 *  bid is under its lo and every ask over its hi. */
export function ladderProblem(l: Ladder, fair: bigint, floor: bigint, cap: bigint, others: { bid: bigint | null; ask: bigint | null }, band: Band = { lo: fair, hi: fair }): string | null {
  const lo = band.lo < fair ? band.lo : fair;
  const hi = band.hi > fair ? band.hi : fair;
  for (const s of [l.bids, l.asks]) {
    for (const x of s) {
      if (x.price % TICK !== 0n) return `price ${x.price} off the tick`;
      if (x.size < KURU_MIN_SIZE || x.size > KURU_MAX_SIZE || x.size % UNITS_PER_TOKEN !== 0n) return `size ${x.size} not whole tokens in Kuru's range`;
    }
  }
  for (const b of l.bids) {
    if (b.price < floor) return `bid ${b.price} under F`;
    if (b.price >= lo) return `bid ${b.price} not under ${lo === fair ? "fair" : "the band's low"} ${lo}`;
    if (others.ask !== null && b.price >= others.ask) return `bid ${b.price} crosses an ask at ${others.ask}`;
  }
  for (const a of l.asks) {
    if (a.price > cap) return `ask ${a.price} over C`;
    if (a.price <= hi) return `ask ${a.price} not over ${hi === fair ? "fair" : "the band's high"} ${hi}`;
    if (others.bid !== null && a.price <= others.bid) return `ask ${a.price} crosses a bid at ${others.bid}`;
  }
  const bb = l.bids.reduce<bigint | null>((m, b) => (m === null || b.price > m ? b.price : m), null);
  const ba = l.asks.reduce<bigint | null>((m, a) => (m === null || a.price < m ? a.price : m), null);
  if (bb !== null && ba !== null && bb >= ba) return "the ladder crosses itself";
  if (new Set(l.bids.map((b) => b.price)).size !== l.bids.length) return "a repeated bid price";
  if (new Set(l.asks.map((a) => a.price)).size !== l.asks.length) return "a repeated ask price";
  return null;
}
