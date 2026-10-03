// Recheck round 1 (cold, independent), limits lens: the maker's tick against a hostile market for many ticks.
//   R1-L1  random takers lift and hit the maker's book, the index moves up and down (final days, some days first
//          public as pending records), and the kill switch is pulled and released at random. After every fill and every
//          tick: |E| <= maxNetTokens (audit M-M1's room rule holds over time, not only per ladder), the pairs cap holds,
//          every maker order is on the tick, inside [F, C], never crossing its own other side or a stranger's order, and
//          a KILL file empties the maker's book within one tick with nothing placed.
// Fakes only (FakeKuru with Kuru V1's rules, FakeSeries, FakeIndex): no chain, no key, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { LOT, TICK, U } from "@agate/market";
import { UNITS_PER_TOKEN } from "../../../src/ladder.ts";
import { C, DAY, F, H100, makerBook, type Rig, rig } from "../../helpers.ts";

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

const MAX_NET = 3_000n;
const MAX_PAIRS = 9_000n;

function exposureOf(x: Rig): bigint {
  const Tw = x.w.balanceOf(x.s.token, x.maker);
  const Tm = x.w.margin(x.maker, x.s.token);
  let Tr = 0n;
  for (const [id, o] of x.k.data.orders) if (o.owner.toLowerCase() === x.maker.toLowerCase() && !o.isBuy && x.k.status(id) === "ACTIVE") Tr += o.size * LOT;
  return Tw + Tm + Tr - x.s.shortOf(x.maker);
}

function checkBook(x: Rig, where: string): void {
  const mine = makerBook(x);
  for (const [p] of [...mine.bids, ...mine.asks]) {
    if (p % TICK !== 0n) throw new Error(`${where}: maker price ${p} off the tick`);
    if (p < F || p > C) throw new Error(`${where}: maker price ${p} outside [F, C]`);
  }
  const bb = mine.bids[0]?.[0];
  const ba = mine.asks[0]?.[0];
  if (bb !== undefined && ba !== undefined && bb >= ba) throw new Error(`${where}: the maker crosses itself (${bb} >= ${ba})`);
  // strangers' resting orders (the user's), by Kuru's own rule
  for (const [id, o] of x.k.data.orders) {
    if (o.owner.toLowerCase() === x.maker.toLowerCase() || x.k.status(id) !== "ACTIVE") continue;
    if (o.isBuy && ba !== undefined && o.price >= ba) throw new Error(`${where}: a stranger's bid ${o.price} crosses the maker's ask ${ba}`);
    if (!o.isBuy && bb !== undefined && o.price <= bb) throw new Error(`${where}: a stranger's ask ${o.price} crosses the maker's bid ${bb}`);
  }
}

describe("R1-L1: limits hold over 60 hostile ticks", () => {
  for (const seed of [11, 29, 47]) {
    test(`seed ${seed}: |E| <= maxNet after every fill, pairs cap, book invariants, kill empties the book in one tick`, async () => {
      r = rig({ config: { maxNetTokens: Number(MAX_NET), maxPairsTokens: Number(MAX_PAIRS), sizesTokens: [500, 1000, 1500], staleS: 864_000, maxLossU: 1_000_000_000_000_000 } });
      const rnd = prng(seed);
      const T = UNITS_PER_TOKEN;
      // the taker: plenty of dollars and 20,000 pairs to sell from
      r.w.mintTo(r.w.dollar, r.user, 50_000_000n * U);
      r.w.approve(r.w.dollar, r.user, r.s.address, 2n ** 256n - 1n);
      r.s.mint(r.user, 20_000n * U, r.user);
      let level = 3_600_000n;
      let killed = false;
      let strangerAsk: bigint | null = null;
      let filled = 0n;
      let maxAbsE = 0n;
      let kills = 0;
      await r.tick();
      checkBook(r, "first quote");
      for (let step = 0; step < 60; step++) {
        const a = rnd();
        if (a < 0.3) {
          filled += r.w.tx(() => r.k.takerBuy(r.user, BigInt(1 + Math.floor(rnd() * 4_000)) * T)).result;
        } else if (a < 0.6) {
          filled += r.w.tx(() => r.k.takerSell(r.user, BigInt(1 + Math.floor(rnd() * 4_000)) * T)).result;
        } else if (a < 0.8) {
          // a new day: the index moves by up to 30 cents, first public as a pending record, final a tick later
          r.w.t += BigInt(DAY) / 2n;
          const d = BigInt(Math.floor(rnd() * 61) - 30) * TICK;
          level = level + d < 2_000_000n ? 2_000_000n : level + d > 6_000_000n ? 6_000_000n : level + d;
          r.ix.put(H100, r.today() - 1, level, rnd() < 0.5);
        } else if (a < 0.9) {
          // a stranger rests a post-only ask just above the maker's best bid (never crossing: Kuru refuses that)
          const mb = makerBook(r).bids[0]?.[0];
          if (mb !== undefined && strangerAsk === null) {
            try {
              r.w.tx(() => r.k.addSell(r.user, mb + TICK, 1_000n * T, true));
              strangerAsk = mb + TICK;
            } catch {
              // a maker ask already rests there: post-only refused, nothing changes
            }
          }
        } else {
          killed = !killed;
          if (killed) {
            writeFileSync(r.mm.killPath(), "recheck");
            kills++;
          }
          else rmSync(r.mm.killPath(), { force: true });
        }
        const E1 = exposureOf(r);
        maxAbsE = E1 > maxAbsE ? E1 : -E1 > maxAbsE ? -E1 : maxAbsE;
        if (E1 > MAX_NET * U || E1 < -MAX_NET * U) throw new Error(`step ${step}: after a fill |E| = ${E1} base units > maxNet ${MAX_NET} tokens`);
        // every pending record becomes final before the next tick half the time
        if (rnd() < 0.5) for (let d = r.today() - 3; d < r.today(); d++) if (r.ix.record(H100, d).exists) r.ix.put(H100, d, r.ix.record(H100, d).value, true);
        await r.tick();
        const E2 = exposureOf(r);
        if (E2 > MAX_NET * U || E2 < -MAX_NET * U) throw new Error(`step ${step}: after the tick |E| = ${E2} > maxNet`);
        expect(r.s.shortOf(r.maker) <= MAX_PAIRS * U).toBe(true);
        checkBook(r, `step ${step}`);
        if (killed) {
          const b = makerBook(r);
          if (b.bids.length + b.asks.length !== 0) throw new Error(`step ${step}: KILL on, the maker still rests ${b.bids.length + b.asks.length} orders`);
        }
      }
      // not a degenerate run: fills happened, the gate was pressed hard, the kill switch was pulled, the maker sent
      expect(filled).toBeGreaterThan(0n);
      expect(maxAbsE * 2n >= MAX_NET * U).toBe(true);
      expect(kills).toBeGreaterThan(0);
      expect(r.sender.landed().filter((f) => f === "batchUpdate").length).toBeGreaterThan(5);
    }, 120_000);
  }
});
