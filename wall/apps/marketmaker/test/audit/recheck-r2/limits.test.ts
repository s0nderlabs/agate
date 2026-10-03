// Recheck round 2 (cold, independent), limits lens: two books (this month and next) quoted at once from ONE dollar
// pool and a tight float, against random takers on both books, index moves and day turns.
//   R2-L1  after every tick: no maker send is refused by its own simulation for dollars or tokens (the dollar plan of
//          BOTS-SPEC 3.4 funds every book of the tick from one margin balance and one deposit, books in order, each
//          batch cancelling before it adds), no batch ever reverts post-only, |E| <= maxNetTokens and the pairs cap
//          hold per series, every maker order is on the tick inside [F, C] and crosses nothing; the run is not
//          degenerate (both books filled and quoted, the gate pressed).
// Fakes only (FakeKuru with Kuru V1's rules, FakeSeries, FakeIndex): no chain, no key, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { LOT, TICK, U } from "@agate/market";
import type { FakeKuru, FakeSeries } from "../../../src/fake/index.ts";
import { UNITS_PER_TOKEN } from "../../../src/ladder.ts";
import { C, DAY, F, H100, MONTH, type Rig, rig, START_DAY } from "../../helpers.ts";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

let r: Rig;
afterEach(() => r?.cleanup());

const MAX_NET = 5_000n;
const MAX_PAIRS = 12_000n;

function side(x: Rig, s: FakeSeries, k: FakeKuru) {
  const me = x.maker.toLowerCase();
  let Tr = 0n;
  const bids: bigint[] = [];
  const asks: bigint[] = [];
  for (const [id, o] of k.data.orders) {
    if (o.owner.toLowerCase() !== me || k.status(id) !== "ACTIVE") continue;
    if (o.isBuy) bids.push(o.price);
    else {
      asks.push(o.price);
      Tr += o.size * LOT;
    }
  }
  const E = x.w.balanceOf(s.token, x.maker) + x.w.margin(x.maker, s.token) + Tr - s.shortOf(x.maker);
  return { E, bids, asks };
}

describe("R2-L1: two books on one dollar pool and a tight float", () => {
  for (const seed of [5, 31, 77]) {
    test(`seed ${seed}: no send refused for funds, no post-only revert, limits per series, book invariants`, async () => {
      r = rig({ config: { maxNetTokens: Number(MAX_NET), maxPairsTokens: Number(MAX_PAIRS), sizesTokens: [800, 1600, 3200], staleS: 864_000, maxLossU: 1_000_000_000_000_000, dollarLowU: 1, dollarBufferU: 5_000_000_000 } });
      const rnd = prng(seed);
      // the current month (October, 31 days, 21 days applied at 3.60) on the same factory: a second book
      const oct = r.w.list(r.f, H100, MONTH - 1, { startDay: START_DAY - 31, startTs: BigInt((START_DAY - 31) * DAY), n: 31, floor: F, cap: C });
      oct.series.setPreview(21, 21n * 3_600_000n);
      const books: [FakeSeries, FakeKuru][] = [
        [r.s, r.k],
        [oct.series, oct.kuru],
      ];
      // a tight float: 120,000 tUSD for two books (each full side is 5,600 tokens: up to 40,320 of mints and 20,000 of
      // bid locks a book)
      r.w.burn(r.w.dollar, r.maker, r.w.balanceOf(r.w.dollar, r.maker) - 120_000n * U);
      // the takers: dollars and pairs of both series
      r.w.mintTo(r.w.dollar, r.user, 80_000_000n * U);
      for (const [s] of books) {
        r.w.approve(r.w.dollar, r.user, s.address, 2n ** 256n - 1n);
        s.mint(r.user, 30_000n * U, r.user);
      }
      let level = 3_600_000n;
      const fills = [0n, 0n];
      let maxAbsE = 0n;
      for (let step = 0; step < 70; step++) {
        const a = rnd();
        const b = rnd() < 0.5 ? 0 : 1;
        const [, k] = books[b]!;
        if (a < 0.35) fills[b]! += r.w.tx(() => k.takerBuy(r.user, BigInt(1 + Math.floor(rnd() * 3_000)) * UNITS_PER_TOKEN)).result;
        else if (a < 0.7) fills[b]! += r.w.tx(() => k.takerSell(r.user, BigInt(1 + Math.floor(rnd() * 3_000)) * UNITS_PER_TOKEN)).result;
        else if (a < 0.9) {
          // a day turns: the index moves up to 25 cents, final at once
          r.w.t += BigInt(DAY) / 3n;
          level += BigInt(Math.floor(rnd() * 51) - 25) * TICK;
          if (level < 2_400_000n) level = 2_400_000n;
          if (level > 5_000_000n) level = 5_000_000n;
          r.ix.put(H100, r.today() - 1, level, true);
        }
        for (const [s, k] of books) {
          const { E } = side(r, s, k);
          const abs = E < 0n ? -E : E;
          if (abs > maxAbsE) maxAbsE = abs;
          if (abs > MAX_NET * U) throw new Error(`step ${step}: a fill carried |E| to ${abs} base units on ${s.address}`);
        }
        const before = r.sender.log.length;
        await r.tick();
        for (const x of r.sender.log.slice(before)) {
          if (x.result.ok || x.result.error === "BUDGET" || x.result.error === "FLOOR") continue;
          throw new Error(`step ${step}: the maker's ${x.spec.functionName} (${x.spec.label}) was refused: ${x.result.error}`);
        }
        for (const [s, k] of books) {
          const { E, bids, asks } = side(r, s, k);
          if ((E < 0n ? -E : E) > MAX_NET * U) throw new Error(`step ${step}: after the tick |E| = ${E} on ${s.address}`);
          expect(s.shortOf(r.maker) <= MAX_PAIRS * U).toBe(true);
          for (const p of [...bids, ...asks]) {
            if (p % TICK !== 0n || p < F || p > C) throw new Error(`step ${step}: maker price ${p} off the tick or outside [F, C]`);
          }
          const bb = bids.length ? bids.reduce((m, x) => (x > m ? x : m)) : null;
          const ba = asks.length ? asks.reduce((m, x) => (x < m ? x : m)) : null;
          if (bb !== null && ba !== null && bb >= ba) throw new Error(`step ${step}: the maker crosses itself on ${s.address}`);
        }
      }
      // not degenerate: both books traded and were quoted, the gate was pressed
      expect(fills[0]! > 0n && fills[1]! > 0n).toBe(true);
      expect(maxAbsE * 2n >= MAX_NET * U).toBe(true);
      const batches = r.sender.log.filter((x) => x.spec.functionName === "batchUpdate" && x.result.ok);
      expect(batches.length).toBeGreaterThan(10);
      const marketsQuoted = new Set(batches.map((x) => x.spec.to.toLowerCase()));
      expect(marketsQuoted.size).toBe(2);
    }, 120_000);
  }
});
