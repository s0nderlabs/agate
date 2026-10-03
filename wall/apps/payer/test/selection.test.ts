// BOTS-SPEC 4.3 to 4.5 as pure rules, against the reference model's payer_pick and payer_should_claim
// (docs/market/model/market_model.py; TestPayerRules, test_budget_bounds_the_payer_whatever_strangers_open,
// TestP1DustPositionsAgainstThePayer), with "budget" in the model's unit (claims) through a unit cost per id.
import { describe, expect, test } from "bun:test";
import { CENT, LOT, owed, U } from "@agate/market";
import { type Candidate, chunks, pick, qualifies, selectWithinBudget, seriesBatches, sortCandidates } from "../src/payer.ts";
import type { Pos } from "../src/positions.ts";

// plain_world: November (N = 30), band F 1.80 / C 7.20, the index 3.60 on days 1 to 10, then 4.20
const T = { n: 30, floor: 1_800_000n, cap: 7_200_000n };
const fixes = Array.from({ length: 30 }, (_, i) => (i < 10 ? 3_600_000n : 4_200_000n));
const S = (k: number) => fixes.slice(0, k).reduce((a, b) => a + b, 0n);
const SER = "0x00000000000000000000000000000000000000aa";
const A = "0x00000000000000000000000000000000000000a1" as const;

let nextId = 1n;
function open(side: 0 | 1, q: bigint, daily: boolean, k = 0): Pos {
  return { id: nextId++, owner: A, payee: A, side, q, paid: owed(side, q, k, S(k), T), daily, open: true };
}
const unit = { syncCostWei: () => 0n, claimCostWei: (n: number) => BigInt(n), maxIds: 50 };
const pickB = (ps: Pos[], k: number, budget: number | null) => selectWithinBudget(sortCandidates(pick(SER, ps, k, S(k), T)), { ...unit, budgetWei: budget === null ? null : BigInt(budget) }).map((c) => c.id);

describe("TestPayerRules (model)", () => {
  test("daily and final rules: daily >= $0.01; daily = false left to the month end; the sweep's two thresholds; dust left", () => {
    const big = open(0, 720n * U, true);
    const lazy = open(0, 100n * U, false);
    const dust = open(0, LOT, true);
    const at3 = pick(SER, [big, lazy, dust], 3, S(3), T).map((c) => c.id);
    expect(at3).toEqual([big.id]);
    const at30 = pick(SER, [big, lazy, dust], 30, S(30), T).map((c) => c.id);
    expect(at30).toContain(lazy.id);
    expect(at30).not.toContain(dust.id);
    // the dust stays claimable by its owner for ever
    expect(owed(0, LOT, 30, S(30), T) - dust.paid).toBeGreaterThan(0n);
  });
  test("qualifies: q >= one token and anything claimable in the sweep, even under a cent", () => {
    expect(qualifies({ daily: false, q: U }, 1n, true)).toBe(true);
    expect(qualifies({ daily: false, q: U - 1n }, CENT - 1n, true)).toBe(false);
    expect(qualifies({ daily: true, q: U }, CENT - 1n, false)).toBe(false);
    expect(qualifies({ daily: true, q: U }, CENT, false)).toBe(true);
    expect(qualifies({ daily: true, q: 10n * U }, 0n, true)).toBe(false);
  });
});

describe("test_budget_bounds_the_payer_whatever_strangers_open (model)", () => {
  const big = open(0, 720n * U, true);
  const spam = Array.from({ length: 300 }, () => open(0, U, true));
  const ids = [...spam.slice(0, 150), big, ...spam.slice(150)];
  test("every one qualifies (one token earns 0.06 a day at this band)", () => {
    expect(pickB(ids, 1, null).length).toBe(301);
  });
  test("a budget of b claims takes exactly b, the largest first", () => {
    for (const b of [0, 1, 8, 50]) {
      const picked = pickB(ids, 1, b);
      expect(picked.length).toBe(b);
      if (b) expect(picked[0]).toBe(big.id);
    }
    expect(pickB(ids, 1, 10_000)).toEqual(pickB(ids, 1, 301));
  });
  test("what the payer leaves is never lost; in the sweep a budget of 1 takes the big one", () => {
    expect(pickB(ids, 30, 1)).toEqual([big.id]);
    for (const p of spam) expect(owed(0, p.q, 30, S(30), T) - p.paid).toBeGreaterThan(0n);
  });
});

describe("TestP1DustPositionsAgainstThePayer (model)", () => {
  test("1,000 one-LOT positions are never selected, daily or in the sweep", () => {
    const ps: Pos[] = [];
    for (let i = 0; i < 500; i++) ps.push(open(0, LOT, true), open(1, LOT, true));
    for (const k of [1, 15]) expect(pick(SER, ps, k, S(k), T)).toEqual([]);
    expect(pick(SER, ps, 30, S(30), T)).toEqual([]);
    for (const p of ps) {
      const c = owed(p.side, p.q, 30, S(30), T) - p.paid;
      expect(c > 0n && c < CENT).toBe(true);
    }
  });
});

describe("ordering, batching and the budget's cost model", () => {
  test("largest claimable first; ties by the lower id, then the lower series address", () => {
    const c = (series: string, id: bigint, claimable: bigint): Candidate => ({ series, id, claimable, q: U });
    const sorted = sortCandidates([c("0xbb", 5n, 10n), c("0xaa", 5n, 10n), c("0xaa", 2n, 10n), c("0xcc", 9n, 50n), c("0xaa", 1n, 1n)]);
    expect(sorted.map((x) => `${x.series}:${x.id}`)).toEqual(["0xcc:9", "0xaa:2", "0xaa:5", "0xbb:5", "0xaa:1"]);
  });
  test("batches of at most 50: 120 ids give 50, 50, 20", () => {
    expect(chunks(Array.from({ length: 120 }, (_, i) => i), 50).map((x) => x.length)).toEqual([50, 50, 20]);
  });
  test("a series' first id carries its sync; a new batch every maxIds", () => {
    const cs: Candidate[] = [
      { series: "0xaa", id: 1n, claimable: 9n, q: U },
      { series: "0xbb", id: 1n, claimable: 8n, q: U },
      { series: "0xaa", id: 2n, claimable: 7n, q: U },
      { series: "0xaa", id: 3n, claimable: 6n, q: U },
    ];
    const cost = { syncCostWei: (s: string) => (s === "0xaa" ? 100n : 0n), claimCostWei: (n: number) => 10n + BigInt(n), maxIds: 2 };
    // 0xaa#1: 100 + 11 = 111; 0xbb#1: 11 -> 122; 0xaa#2: 12 - 11 = 1 -> 123; 0xaa#3: a new batch 11 -> 134
    expect(selectWithinBudget(cs, { ...cost, budgetWei: 134n }).length).toBe(4);
    expect(selectWithinBudget(cs, { ...cost, budgetWei: 133n }).length).toBe(3);
    expect(selectWithinBudget(cs, { ...cost, budgetWei: 110n }).length).toBe(0); // a strict prefix: nothing skips ahead
  });
});

describe("seriesBatches (recheck R1-L2, per series since R2-L1): whole batches, no partial claimMany", () => {
  const c = (series: string, n: number): Candidate[] => Array.from({ length: n }, (_, i) => ({ series, id: BigInt(i + 1), claimable: 1n, q: 1n }));
  const shape = (xs: ReturnType<typeof seriesBatches>) => xs.map((b) => `${b.series}${b.first ? "*" : ""}:${b.items.length}`);
  test("one series: batches of maxIds, the last one all that is left", () => {
    expect(shape(seriesBatches(c("a", 140), 50))).toEqual(["a*:50", "a:50", "a:40"]);
    expect(shape(seriesBatches(c("a", 30), 50))).toEqual(["a*:30"]);
    expect(shape(seriesBatches(c("a", 100), 50))).toEqual(["a*:50", "a:50"]);
  });
  test("several series interleaved in claimable order: each series' batches, ordered by their largest candidate", () => {
    const xs = [...c("a", 10), ...c("b", 60)];
    expect(shape(seriesBatches(xs, 50))).toEqual(["a*:10", "b*:50", "b:10"]);
    // interleaved a b a b a b: one batch per series (a first: its largest candidate comes first), not one prefix of 6
    const ab: Candidate[] = [];
    for (let i = 0; i < 3; i++) ab.push(...c("a", 1).map((x) => ({ ...x, id: BigInt(i) })), ...c("b", 1).map((x) => ({ ...x, id: BigInt(i) })));
    const bs = seriesBatches(ab, 50);
    expect(shape(bs)).toEqual(["a*:3", "b*:3"]);
    expect(bs[0]!.items.map((x) => x.id)).toEqual([0n, 1n, 2n]);
    // with maxIds 1 every candidate is its own batch, in the sorted order
    expect(seriesBatches(ab, 1).map((b) => `${b.series}${b.items[0]!.id}`)).toEqual(["a0", "b0", "a1", "b1", "a2", "b2"]);
  });
});
