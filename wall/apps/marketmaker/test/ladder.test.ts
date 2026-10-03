// BOTS-SPEC 3.3: the ladder, the crossing clamp and the gates; the invariants on 10,000 random cases.
import { describe, expect, test } from "bun:test";
import { TICK } from "@agate/market";
import { clampCrossing, cutAsks, cutBids, gate, halfSpread, ladderProblem, lockOf, targetLadder, UNITS_PER_TOKEN } from "../src/ladder.ts";

const P = { spreadBps: 100, levels: 3, levelStepTicks: 1, sizesTokens: [1000, 2000, 4000] };
const F = 1_800_000n;
const C = 7_200_000n;
const T = UNITS_PER_TOKEN;

describe("targetLadder", () => {
  test("the worked example: fair 3.60, h 0.036", () => {
    expect(halfSpread(3_600_000n, 100)).toBe(36_000n);
    const l = targetLadder(3_600_000n, F, C, P);
    expect(l.bids).toEqual([
      { price: 3_560_000n, size: 1_000n * T },
      { price: 3_550_000n, size: 2_000n * T },
      { price: 3_540_000n, size: 4_000n * T },
    ]);
    expect(l.asks).toEqual([
      { price: 3_640_000n, size: 1_000n * T },
      { price: 3_650_000n, size: 2_000n * T },
      { price: 3_660_000n, size: 4_000n * T },
    ]);
  });
  test("h is at least one tick, and exact multiples of the tick stay put", () => {
    expect(halfSpread(500_000n, 100)).toBe(TICK); // 1 % of 0.50 is half a tick
    expect(halfSpread(100_000n, 0)).toBe(TICK);
    // fair - h and fair + h exactly on the tick
    const l = targetLadder(1_000_000n, 500_000n, 2_000_000n, { ...P, levels: 1 });
    expect(l.bids[0]!.price).toBe(990_000n);
    expect(l.asks[0]!.price).toBe(1_010_000n);
    // one u off the grid rounds away from fair on both sides
    const m = targetLadder(1_000_001n, 500_000n, 2_000_000n, { ...P, levels: 1 });
    expect(m.bids[0]!.price).toBe(990_000n);
    expect(m.asks[0]!.price).toBe(1_020_000n);
  });
  test("levels outside [F, C] are not quoted; no bids under one tick", () => {
    const top = targetLadder(C, F, C, P);
    expect(top.asks).toEqual([]);
    expect(top.bids[0]!.price).toBe(7_120_000n);
    const bottom = targetLadder(F, F, C, P);
    expect(bottom.bids).toEqual([]);
    expect(targetLadder(5_000n, 0n, C, P).bids).toEqual([]);
    const near = targetLadder(1_830_000n, F, C, P); // bids 1.81, 1.80, (1.79 < F)
    expect(near.bids.map((b) => b.price)).toEqual([1_810_000n, 1_800_000n]);
  });
});

describe("clampCrossing", () => {
  test("a hostile book: the others' ask under our bids and bid over our asks", () => {
    const l = targetLadder(3_600_000n, F, C, P);
    const c = clampCrossing(l, { bid: 3_700_000n, ask: 3_550_000n }, F, C);
    expect(c.bids.map((b) => b.price)).toEqual([3_540_000n]); // 3.56 and 3.55 -> 3.54, then 3.54 repeats
    expect(c.asks.map((a) => a.price)).toEqual([3_710_000n]);
    expect(ladderProblem(c, 3_600_000n, F, C, { bid: 3_700_000n, ask: 3_550_000n })).toBe(null);
  });
  test("a clamp that leaves [F, C] drops the level", () => {
    const l = targetLadder(3_600_000n, F, C, P);
    const c = clampCrossing(l, { bid: C, ask: F }, F, C);
    expect(c).toEqual({ bids: [], asks: [] });
  });
});

describe("gates and cuts", () => {
  test("no bids at E >= maxNet, no asks at E <= -maxNet", () => {
    const l = targetLadder(3_600_000n, F, C, P);
    expect(gate(l, 14_000_000_000n, 14_000_000_000n).ladder.bids).toEqual([]);
    expect(gate(l, 14_000_000_000n, 14_000_000_000n).ladder.asks.length).toBe(3);
    expect(gate(l, -14_000_000_000n, 14_000_000_000n).ladder.asks).toEqual([]);
    expect(gate(l, 0n, 14_000_000_000n)).toMatchObject({ bidsClosed: false, asksClosed: false, bidsCut: false, asksCut: false });
  });
  test("each side is cut to the room left (audit M-M1): asks to maxNet + E, bids to maxNet - E, outermost first", () => {
    const l = targetLadder(3_600_000n, F, C, P); // 1,000 / 2,000 / 4,000 a side
    const U = 1_000_000n;
    const g = gate(l, -11_500n * U, 14_000n * U); // ask room 2,500, bid room 25,500
    expect(g.ladder.asks).toEqual([
      { price: 3_640_000n, size: 1_000n * T },
      { price: 3_650_000n, size: 1_500n * T },
    ]);
    expect(g.ladder.bids).toEqual(l.bids);
    expect(g).toMatchObject({ asksCut: true, asksClosed: false, bidsCut: false });
    const h = gate(l, 13_999n * U + 500_000n, 14_000n * U); // bid room half a token: closed
    expect(h).toMatchObject({ bidsClosed: true, bidsCut: true });
    expect(h.ladder.bids).toEqual([]);
    // whatever fills, |E| stays within maxNet on 2,000 random exposures
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 2_000; i++) {
      const max = BigInt(1 + Math.floor(rnd() * 20_000)) * U;
      const e = BigInt(Math.floor((rnd() * 2 - 1) * Number(max / U))) * U;
      const x = gate(l, e, max).ladder;
      const asks = x.asks.reduce((s, a) => s + a.size, 0n) * 100n;
      const bids = x.bids.reduce((s, b) => s + b.size, 0n) * 100n;
      expect(e - asks >= -max).toBe(true);
      expect(e + bids <= max).toBe(true);
    }
  });
  test("cutAsks keeps whole tokens from the best level out; cutBids by the dollars", () => {
    const l = targetLadder(3_600_000n, F, C, P);
    expect(cutAsks(l.asks, 2_500n * T + 1n)).toEqual([
      { price: 3_640_000n, size: 1_000n * T },
      { price: 3_650_000n, size: 1_500n * T },
    ]);
    expect(cutAsks(l.asks, T - 1n)).toEqual([]);
    const lock0 = lockOf(l.bids[0]!);
    expect(lock0).toBe(3_560_000_000n);
    expect(cutBids(l.bids, lock0 + 3_550_000n * 100n)).toEqual([
      { price: 3_560_000n, size: 1_000n * T },
      { price: 3_550_000n, size: 100n * T },
    ]);
  });
});

describe("the band of a newer public value (audit M-H1)", () => {
  test("bids under lo - h, asks over hi + h, h from fair; ladderProblem checks the band", () => {
    const l = targetLadder(3_600_000n, F, C, P, { lo: 3_600_000n, hi: 4_000_000n });
    expect(l.bids.map((b) => b.price)).toEqual([3_560_000n, 3_550_000n, 3_540_000n]);
    expect(l.asks.map((a) => a.price)).toEqual([4_040_000n, 4_050_000n, 4_060_000n]);
    expect(ladderProblem(l, 3_600_000n, F, C, { bid: null, ask: null }, { lo: 3_600_000n, hi: 4_000_000n })).toBe(null);
    // the plain ladder is a problem under that band: its asks are not over the band's high
    expect(ladderProblem(targetLadder(3_600_000n, F, C, P), 3_600_000n, F, C, { bid: null, ask: null }, { lo: 3_600_000n, hi: 4_000_000n })).toContain("band's high");
    const down = targetLadder(3_600_000n, F, C, P, { lo: 3_200_000n, hi: 3_600_000n });
    expect(down.bids[0]!.price).toBe(3_160_000n);
    expect(down.asks[0]!.price).toBe(3_640_000n);
    // a band at C quotes no ask
    expect(targetLadder(3_600_000n, F, C, P, { lo: 3_600_000n, hi: C }).asks).toEqual([]);
  });
});

describe("the invariants on 10,000 random cases", () => {
  test("tick, band, bid < fair < ask, never crossing anyone, sizes whole tokens", () => {
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let quoted = 0;
    for (let i = 0; i < 10_000; i++) {
      const f = 50_000n * BigInt(1 + Math.floor(rnd() * 40)); // F on the grid
      const c = f + 50_000n * BigInt(1 + Math.floor(rnd() * 120)); // C > F
      const fair = f + BigInt(Math.floor(rnd() * Number(c - f + 1n)));
      const p = { spreadBps: Math.floor(rnd() * 500), levels: 1 + Math.floor(rnd() * 5), levelStepTicks: 1 + Math.floor(rnd() * 3), sizesTokens: [1, 7, 100, 1_000_000, 3] };
      const ob = rnd() < 0.5 ? null : f + TICK * BigInt(Math.floor(rnd() * Number((c - f) / TICK + 2n)));
      const oaRaw = rnd() < 0.5 ? null : f + TICK * BigInt(Math.floor(rnd() * Number((c - f) / TICK + 2n)));
      const oa = oaRaw !== null && ob !== null && oaRaw <= ob ? ob + TICK : oaRaw; // a real book never crosses itself
      const others = { bid: ob, ask: oa };
      // half the cases with the band of a newer public value inside [F, C]
      const other = f + BigInt(Math.floor(rnd() * Number(c - f + 1n)));
      const band = rnd() < 0.5 ? { lo: fair, hi: fair } : { lo: other < fair ? other : fair, hi: other > fair ? other : fair };
      const l = clampCrossing(targetLadder(fair, f, c, p, band), others, f, c);
      const problem = ladderProblem(l, fair, f, c, others, band);
      if (problem) throw new Error(`case ${i}: ${problem} (fair ${fair}, F ${f}, C ${c}, book ${ob}/${oa})`);
      if (l.bids.length + l.asks.length > 0) quoted++;
    }
    expect(quoted).toBeGreaterThan(8_500);
  });
});
