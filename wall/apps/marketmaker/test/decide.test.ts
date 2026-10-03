// BOTS-SPEC 3.5: the six conditions in priority, the budget ordering, the per-book throttle.
import { describe, expect, test } from "bun:test";
import type { OwnOrder } from "../src/book.ts";
import { type BookView, decide, NEVER_QUOTED, order } from "../src/decide.ts";
import { targetLadder } from "../src/ladder.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const cfg = { requoteMoveU: 10_000n, replenishBelowPct: 50, staleS: 21_600, minRequoteS: 10 };
const target = targetLadder(3_600_000n, F, C, { spreadBps: 100, levels: 3, levelStepTicks: 1, sizesTokens: [1000, 2000, 4000] });
const resting: OwnOrder[] = [
  ...target.bids.map((b, i) => ({ id: BigInt(i + 1), isBuy: true, price: b.price, size: b.size, remaining: b.size })),
  ...target.asks.map((a, i) => ({ id: BigInt(i + 4), isBuy: false, price: a.price, size: a.size, remaining: a.size })),
];
const quoted = { fair: 3_600_000n, at: 1_000, topBid: { id: 1n, size: 10_000_000n }, topAsk: { id: 4n, size: 10_000_000n } };

function view(p: Partial<BookView> = {}): BookView {
  return { market: "0xm", t: 2_000, nowMs: 100_000, fair: 3_600_000n, floor: F, cap: C, orders: resting, quoted, target, bidsClosed: false, asksClosed: false, cancelOnly: null, lastRequoteMs: null, ...p };
}

describe("decide", () => {
  test("a quiet book: nothing", () => {
    expect(decide(view(), cfg)).toEqual({ act: "none" });
  });
  test("1: kill, wind-down, routerCanUse false cancel only (safety); nothing when no orders", () => {
    expect(decide(view({ cancelOnly: "kill" }), cfg)).toMatchObject({ act: "cancel", cond: 1, safety: true });
    expect(decide(view({ cancelOnly: "wind-down", orders: [] }), cfg).act).toBe("none");
    expect(decide(view({ fair: null }), cfg)).toMatchObject({ act: "cancel", cond: 1 });
  });
  test("2: fair through the quotes, an order outside the band, a closed side with orders: urgent, under the day's budget, the crossed ids named for the safety fallback (audit M-M2)", () => {
    // fair 3.65: the 3.64 and 3.65 asks (ids 4, 5) are at or under it; the 3.66 ask and the bids are not
    expect(decide(view({ fair: 3_650_000n }), cfg)).toMatchObject({ act: "requote", cond: 2, safety: false, urgent: true, crossed: [4n, 5n] });
    // fair 3.55: the 3.56 and 3.55 bids (ids 1, 2) are at or over it
    expect(decide(view({ fair: 3_550_000n }), cfg)).toMatchObject({ act: "requote", cond: 2, safety: false, urgent: true, crossed: [1n, 2n] });
    // F 3.545: the 3.54 bid (id 3) is outside [F, C]
    expect(decide(view({ floor: 3_545_000n }), cfg)).toMatchObject({ cond: 2, crossed: [3n] });
    expect(decide(view({ asksClosed: true }), cfg)).toMatchObject({ cond: 2, crossed: [4n, 5n, 6n] });
    expect(decide(view({ bidsClosed: true }), cfg)).toMatchObject({ cond: 2, crossed: [1n, 2n, 3n] });
  });
  test("2 with the band of a newer public value (audit M-H1): fair unchanged, a pending 3.70 crosses the asks", () => {
    const d = decide(view({ hi: 3_700_000n }), cfg);
    expect(d).toMatchObject({ act: "requote", cond: 2, urgent: true, crossed: [4n, 5n, 6n], why: "a newer public index value moved through the quotes" });
    expect(decide(view({ lo: 3_500_000n }), cfg)).toMatchObject({ cond: 2, crossed: [1n, 2n, 3n] });
    // a band inside the half-spread crosses nothing; once quoted with that band, an unchanged band sends nothing
    expect(decide(view({ hi: 3_630_000n, quoted: { ...quoted, hi: 3_630_000n } }), cfg)).toEqual({ act: "none" });
    // the band moving more than requoteMoveU against the quoted one is condition 3
    expect(decide(view({ hi: 3_630_000n }), cfg)).toMatchObject({ act: "requote", cond: 3, priority: 30_000n });
  });
  test("3: fair moved more than requoteMoveU (one tick: no; two: yes)", () => {
    expect(decide(view({ fair: 3_610_000n }), cfg).act).toBe("none");
    expect(decide(view({ fair: 3_620_000n }), cfg)).toMatchObject({ act: "requote", cond: 3, safety: false, priority: 20_000n });
  });
  test("4: the top order under replenishBelowPct of its size, or filled", () => {
    const part = resting.map((o) => (o.id === 4n ? { ...o, remaining: 4_999_999n } : o));
    expect(decide(view({ orders: part }), cfg)).toMatchObject({ cond: 4 });
    const half = resting.map((o) => (o.id === 4n ? { ...o, remaining: 5_000_000n } : o));
    expect(decide(view({ orders: half }), cfg).act).toBe("none");
    expect(decide(view({ orders: resting.filter((o) => o.id !== 1n) }), cfg)).toMatchObject({ cond: 4 });
    // a side the target does not want is not replenished
    expect(decide(view({ orders: resting.filter((o) => o.id !== 4n), target: { bids: target.bids, asks: [] } }), cfg).act).toBe("none");
  });
  test("5: stale after staleS of chain time", () => {
    expect(decide(view({ t: 1_000 + 21_600 }), cfg)).toMatchObject({ cond: 5 });
    expect(decide(view({ t: 1_000 + 21_599 }), cfg).act).toBe("none");
  });
  test("6: no orders and a target: first quote (never quoted: top priority)", () => {
    expect(decide(view({ orders: [], quoted: null }), cfg)).toMatchObject({ cond: 6, priority: NEVER_QUOTED });
    expect(decide(view({ orders: [], quoted: null, target: { bids: [], asks: [] } }), cfg).act).toBe("none");
  });
  test("6: a side the inventory gate had closed at the last requote is open again", () => {
    const gatedAsks = { ...quoted, topAsk: null, closed: { bids: false, asks: true } };
    const bidsOnly = resting.filter((o) => o.isBuy);
    expect(decide(view({ quoted: gatedAsks, orders: bidsOnly }), cfg)).toMatchObject({ act: "requote", cond: 6, why: "the ask gate reopened" });
    expect(decide(view({ quoted: gatedAsks, orders: bidsOnly, asksClosed: true, target: { bids: target.bids, asks: [] } }), cfg).act).toBe("none");
  });
  test("at most one requote per book per minRequoteS, whatever wakes the loop", () => {
    expect(decide(view({ fair: 3_700_000n, lastRequoteMs: 95_000 }), cfg)).toEqual({ act: "none", why: "minRequoteS" });
    expect(decide(view({ fair: 3_700_000n, lastRequoteMs: 90_000 }), cfg).act).toBe("requote");
  });
});

test("order: safety and urgent first, then the daily books by |fair - quotedFair|, largest first", () => {
  const xs = [
    { n: "small", d: decide(view({ fair: 3_620_000n }), cfg) },
    { n: "kill", d: decide(view({ cancelOnly: "kill" }), cfg) },
    { n: "big", d: decide(view({ fair: 3_635_000n }), cfg) },
    { n: "first", d: decide(view({ orders: [], quoted: null }), cfg) },
    { n: "safety", d: decide(view({ fair: 3_800_000n }), cfg) },
    { n: "none", d: decide(view(), cfg) },
  ];
  expect(order(xs).map((x) => x.n)).toEqual(["kill", "safety", "first", "big", "small", "none"].filter((n) => n !== "none"));
});
