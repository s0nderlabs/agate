// Recheck round 1 (cold, independent), quoting lens. Two probes of the maker's quote path:
//   R1-Q1  the whole pure pipeline (targetLadder, clampCrossing, gate, planTokens, planDollars) on 20,000 random and
//          hostile cases never yields a ladder that the last check (ladderProblem) refuses, never leaves [F, C], never
//          crosses the band of a newer public value, and the gate's room bounds both sides.
//   R1-Q2  (finding R1-M1, fixed) the band of a newer public value (audit M-H1) held only ONE newer value: walkIndex
//          kept the newest pending record, and an ended head day's previewFix then overwrote it. A pending record and a
//          previewFix at once (an attester slow on a NEEDS_SIGN day while the next day ends), or two pending records,
//          left a public value out of the band. The recheck round pinned that; the fix round flipped each assertion to
//          the fixed behaviour (the band covers every newer public value).
// Fakes only: no chain, no key, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { LOT, TICK, U } from "@agate/market";
import { exposure, planDollars, planTokens } from "../../../src/inventory.ts";
import { clampCrossing, gate, ladderProblem, type Ladder, type LadderParams, targetLadder, UNITS_PER_TOKEN } from "../../../src/ladder.ts";
import { DAY, H100, makerBook, type Rig, rig } from "../../helpers.ts";

// a small deterministic PRNG so a failure reproduces from its seed
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
const GRID = 50_000n;

describe("R1-Q1: the quote pipeline never produces a ladder its own last check refuses", () => {
  test("20,000 random cases: hostile others' books, bands beyond [F, C], any exposure, short tokens and dollars", () => {
    const rnd = prng(0x5eed);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const big = (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(rnd() * Number(hi - lo + 1n)));
    let quoted = 0;
    for (let n = 0; n < 20_000; n++) {
      const F = BigInt(int(1, 60)) * GRID; // 0.05 to 3.00
      const C = F + BigInt(int(1, 120)) * GRID;
      const fair = big(F, C);
      // a newer public value may lie anywhere, even beyond the band edges (the maker clamps it, but be hostile)
      const p = big(F > 200_000n ? F - 200_000n : 0n, C + 200_000n);
      const lo = p < fair ? p : fair;
      const hi = p > fair ? p : fair;
      const params: LadderParams = { spreadBps: int(0, 500), levels: int(1, 5), levelStepTicks: int(1, 4), sizesTokens: Array.from({ length: 5 }, () => int(1, 5_000)) };
      // the others' book: never crossed itself (Kuru), but its bid may sit above our hi and its ask below our lo
      const mid = big(F > 100_000n ? F - 100_000n : TICK, C + 100_000n);
      const ob = rnd() < 0.25 ? null : ((mid - BigInt(int(1, 30)) * TICK) / TICK) * TICK;
      const oa = rnd() < 0.25 ? null : ((mid + BigInt(int(0, 30)) * TICK) / TICK) * TICK;
      const others = { bid: ob !== null && ob > 0n ? ob : null, ask: oa };
      if (others.bid !== null && others.ask !== null && others.bid >= others.ask) continue;
      const raw = targetLadder(fair, F, C, params, { lo, hi });
      const clamped = clampCrossing(raw, others, F, C);
      const maxNet = BigInt(int(0, 20_000)) * U;
      const inv = { Tw: BigInt(int(0, 30_000)) * U, Tm: BigInt(int(0, 10_000)) * U, Tr: 0n, Sh: BigInt(int(0, 30_000)) * U };
      const E = exposure(inv);
      const g = gate(clamped, E, maxNet);
      const tp = planTokens(g.ladder.asks, inv, { cap: C, maxPairsBase: BigInt(int(0, 40_000)) * U, walletDollars: BigInt(int(0, 200_000)) * U });
      const dp = planDollars([{ market: "m", bids: g.ladder.bids, currentBidLock: BigInt(int(0, 50_000)) * U }], { marginDollars: BigInt(int(0, 100_000)) * U, walletDollars: BigInt(int(0, 100_000)) * U, mintCosts: tp.mintCost, bufferU: 0n });
      const final: Ladder = { bids: dp.bids.get("m") ?? [], asks: tp.asks };
      const why = ladderProblem(final, fair, F, C, others, { lo, hi });
      if (why !== null) throw new Error(`case ${n}: ${why} (F ${F} C ${C} fair ${fair} band ${lo}..${hi} others ${others.bid}/${others.ask})`);
      // the gate's room (audit M-M1): no fill of either side can carry |E| past maxNet
      const askBase = final.asks.reduce((s, a) => s + a.size, 0n) * LOT;
      const bidBase = final.bids.reduce((s, b) => s + b.size, 0n) * LOT;
      expect(E - askBase >= -maxNet || askBase === 0n).toBe(true);
      expect(E + bidBase <= maxNet || bidBase === 0n).toBe(true);
      for (const x of [...final.bids, ...final.asks]) expect(x.size % UNITS_PER_TOKEN).toBe(0n);
      if (final.bids.length + final.asks.length > 0) quoted++;
    }
    expect(quoted).toBeGreaterThan(5_000); // the generator is not degenerate
  });
});

let r: Rig;
afterEach(() => r?.cleanup());

describe("R1-Q2 (finding R1-M1, fixed): the band holds every newer public value", () => {
  test("a pending record 40 cents up AND an ended head day whose previewFix is back at 3.60: both are in the band", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick(); // 3.56 / 3.64 around the final 3.60
    r.w.t += BigInt(DAY);
    const today = r.today();
    // day today-2 was closed at 4.00 and is NEEDS_SIGN (exists, not final: the attester has not signed yet); day
    // today-1 has ended and the wall has not closed it (head = today-1); its previewFix reads 3.60 again
    r.ix.put(H100, today - 2, 4_000_000n, false);
    r.ix.data.recs.delete(`${H100.toLowerCase()}:${today - 1}`);
    r.ix.data.head = today - 1;
    r.ix.setPreview(H100, 3_600_000n);
    await r.tick();
    const b = makerBook(r);
    // FIXED: the band is [3.60, 4.00] (was [3.60, 3.60], previewFix replacing the pending record, asks at 3.64 to 3.66
    // under a public 4.00): asks above 4.00 + h, bids under 3.60 - h, as audit M-H1's own test asserts
    expect(b.asks.map((a) => a[0])).toEqual([4_040_000n, 4_050_000n, 4_060_000n]);
    expect(b.bids.map((x) => x[0])).toEqual([3_560_000n, 3_550_000n, 3_540_000n]);
    // anyone who read the pending record buys the side; the attester signs; fair jumps to 4.00
    r.w.tx(() => r.k.takerBuy(r.user, 7_000n * UNITS_PER_TOKEN));
    r.ix.put(H100, today - 2, 4_000_000n, true);
    await r.tick();
    // sold at 4.04 to 4.06, worth 4.00: the maker is up (was down about $2,420 of test dollars)
    expect(r.mm.report.pnl!).toBeGreaterThan(0n);
  });

  test("two pending records (4.00 newest, 3.20 older): both widen the band", async () => {
    r = rig({ config: { staleS: 864_000 } });
    await r.tick();
    r.w.t += BigInt(DAY);
    const today = r.today();
    r.ix.put(H100, today - 1, 4_000_000n, false); // newest, pending
    r.ix.put(H100, today - 2, 3_200_000n, false); // older, still pending (NEEDS_SIGN)
    await r.tick();
    const b = makerBook(r);
    // FIXED: band [3.20, 4.00] (was [3.60, 4.00], bids at 3.56 above the 3.20 that may turn final first): bids under
    // 3.20 - h, asks over 4.00 + h
    expect(b.bids.map((x) => x[0])).toEqual([3_160_000n, 3_150_000n, 3_140_000n]);
    expect(b.asks.map((a) => a[0])).toEqual([4_040_000n, 4_050_000n, 4_060_000n]);
    // the older record turns final first at 3.20: a taker who sold into the bids gains nothing
    r.w.mintTo(r.s.token, r.user, 7_000n * UNITS_PER_TOKEN * LOT);
    const sold = r.w.tx(() => r.k.takerSell(r.user, 7_000n * UNITS_PER_TOKEN)).result;
    expect(sold).toBeGreaterThan(1_000n * UNITS_PER_TOKEN); // the maker's bids took a real size
    r.ix.put(H100, today - 2, 3_200_000n, true);
    await r.tick();
    expect(r.mm.report.pnl!).toBeGreaterThan(0n);
  });
});
