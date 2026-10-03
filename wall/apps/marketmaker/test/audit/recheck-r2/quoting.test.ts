// Recheck round 2 (cold, independent), quoting lens. The band of a newer public value (audit M-H1, widened by recheck
// R1-M1) against the index's own rules (contracts/src/lib/IndexDays.sol, IndexViews.sol):
//   - closeDay(d) reverts C2_PreviousNotFinal while day d - 1 is pending, so at most ONE record (head - 1) is pending,
//     and previewFix shows only the head day;
//   - attest(gpuId, head - 1, writer, ...) with writer != the record's source is the attester's select: RecordReplaced
//     writes the OTHER writer's value and makes it final at max(postedAt + tPend, now), so at once for a NEEDS_SIGN
//     record that waited longer than tPend; that value is public before the select through
//     previewRecord(gpuId, head - 1, writer);
//   - a day past head cannot be closed before head (sequential closes), but its readings are posted on chain.
//   R2-Q1a (finding R2-M1, fixed): the band held the pending record's own value, not the other writer's value the
//          attester may select (measured -3,820 tUSD); now each other writer's previewRecord for an unattested pending
//          day is in the band, and the same sequence ends with no loss.
//   R2-Q1b (finding R2-M1, fixed): with the wall two or more ended days behind (head < today - 1: the closer down, or
//          a countersign slower than one DAY, ten minutes on the demo clock) the days past head were in no view and
//          outside the band (measured -4,520 tUSD); now the band is every fair [F, C] allows, MM_INDEX_BEHIND (action).
//   R2-Q2  (holds) every state the real index can be in WITHOUT those two cases (at most head - 1 pending, previewFix
//          only for an ended head day, head >= today - 1, no select): the band holds the fair of every value that can
//          turn final next, in every order the index allows.
// Each pinned assertion says what a fix flips. Fakes only: no chain, no key, no network.
import { afterEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { U } from "@agate/market";
import { FairBook } from "../../../src/fair.ts";
import { UNITS_PER_TOKEN } from "../../../src/ladder.ts";
import { DAY, H100, makerBook, type Rig, rig } from "../../helpers.ts";

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

describe("R2-Q1 (finding R2-M1, fixed): public values that can turn final next are inside the band", () => {
  test("a: the attester selects the other writer's value for the pending day (RecordReplaced, final at once)", async () => {
    r = rig({ config: { staleS: 864_000 } });
    const W1 = "0x00000000000000000000000000000000000000b1" as Address;
    const W2 = "0x00000000000000000000000000000000000000b2" as Address;
    r.ix.data.writers = [W1, W2];
    r.ix.data.head = r.today(); // the wall is current: every ended day closed
    await r.tick(); // 3.56 / 3.64 around the final 3.60
    r.w.t += BigInt(DAY);
    const today = r.today();
    // the day that just ended is closed at 3.70 by writer 1 and waits for the countersign (NEEDS_SIGN): head = today
    r.ix.put(H100, today - 1, 3_700_000n, false);
    r.ix.data.recs.get(`${H100.toLowerCase()}:${today - 1}`)!.source = W1;
    r.ix.data.head = today;
    // writer 2's value for the same day, 4.30, is public through previewRecord(gpuId, today - 1, writer2): the
    // attester's select would make it final at once
    r.ix.setPreviewRecord(H100, today - 1, W2, 4_300_000n);
    await r.tick();
    const b = makerBook(r);
    // before the fix the band was [3.60, 3.70] (asks at 3.74 to 3.76, measured -3,820 tUSD after the select); now
    // it holds 4.30: every ask rests over 4.30 + h
    expect(b.asks.length).toBeGreaterThan(0);
    expect(b.asks.map((a) => a[0])).toEqual([4_340_000n, 4_350_000n, 4_360_000n]);
    expect(b.bids.every((x) => x[0] < 3_600_000n)).toBe(true);
    // a taker who read previewRecord lifts the asks
    const bought = r.w.tx(() => r.k.takerBuy(r.user, 7_000n * UNITS_PER_TOKEN)).result;
    expect(bought).toBe(7_000n * UNITS_PER_TOKEN);
    // the person countersigning selects writer 2 (postedAt + tPend long past: final at once)
    r.ix.put(H100, today - 1, 4_300_000n, true);
    await r.tick();
    // sold at 4.34 to 4.36, worth 4.30 now: no loss
    expect(r.mm.report.pnl!).toBeGreaterThanOrEqual(0n);
  });

  test("a, attested: once the record is attested no select can follow, so the other writer's value leaves the band", async () => {
    r = rig({ config: { staleS: 864_000 } });
    const W2 = "0x00000000000000000000000000000000000000b2" as Address;
    r.ix.data.writers = [W2];
    r.ix.data.head = r.today();
    await r.tick();
    r.w.t += BigInt(DAY);
    const today = r.today();
    r.ix.put(H100, today - 1, 3_700_000n, false);
    r.ix.data.recs.get(`${H100.toLowerCase()}:${today - 1}`)!.attestedAt = 1n;
    r.ix.data.head = today;
    r.ix.setPreviewRecord(H100, today - 1, W2, 4_300_000n);
    await r.tick();
    expect(makerBook(r).asks.map((a) => a[0])).toEqual([3_740_000n, 3_750_000n, 3_760_000n]);
  });

  test("b: the wall two ended days behind: the band spans every value the days past head can take", async () => {
    r = rig({ config: { staleS: 864_000 } });
    r.ix.data.head = r.today();
    await r.tick();
    r.w.t += 3n * BigInt(DAY);
    const today = r.today();
    // the closer stopped: days today-3, today-2 and today-1 ended, none closed (head = today - 3); previewFix shows the
    // head day at 3.70; the readings of today-2 (4.10) and today-1 (4.40) are posted on chain, in no single view
    r.ix.data.head = today - 3;
    r.ix.setPreview(H100, 3_700_000n);
    await r.tick();
    const b = makerBook(r);
    // before the fix the asks rested at 3.74 to 3.76 (measured -4,520 tUSD after the catch-up); before the month the
    // band is now all of [F, C], so nothing rests on either side
    expect(b.asks).toEqual([]);
    expect(b.bids).toEqual([]);
    expect(r.alerts.open().some((a) => (a.code as string) === "MM_INDEX_BEHIND")).toBe(true);
    expect(r.w.tx(() => r.k.takerBuy(r.user, 7_000n * UNITS_PER_TOKEN)).result).toBe(0n);
    // the closer comes back and catches up, one close per day, each final in turn
    r.ix.put(H100, today - 3, 3_700_000n, true);
    r.ix.put(H100, today - 2, 4_100_000n, true);
    r.ix.put(H100, today - 1, 4_400_000n, true);
    r.ix.data.head = today;
    r.ix.setPreview(H100, null);
    await r.tick();
    expect(r.mm.report.pnl!).toBeGreaterThanOrEqual(0n);
    // caught up: the alert clears and the book quotes around 4.40 again
    expect(r.alerts.open().some((a) => (a.code as string) === "MM_INDEX_BEHIND")).toBe(false);
    expect(makerBook(r).asks.length).toBeGreaterThan(0);
  });
});

describe("R2-Q2 (holds): without a select and with the wall at most one day behind, the band is complete", () => {
  test("3,000 random index states the real index can be in: every value that can turn final next is inside [lo, hi]", async () => {
    const rnd = prng(0x2b2);
    const IX = "0x00000000000000000000000000000000000000a1" as Address;
    const G = "0x0b" as Hex;
    const F = 1_800_000n;
    const C = 7_200_000n;
    const START = 20_000;
    let checked = 0;
    for (let n = 0; n < 3_000; n++) {
      const N = 28 + Math.floor(rnd() * 4);
      const today = START + Math.floor(rnd() * (N + 6)) - 3; // before, inside and just after the month
      const lag = rnd() < 0.5 ? 0 : 1; // head = today or today - 1 (the wall at most one ended day behind)
      const head = today - lag;
      const val = () => BigInt(100 + Math.floor(rnd() * 800)) * 10_000n; // 1.00 .. 9.00, beyond [F, C] too
      // records: every day below head - 1 final; head - 1 final or pending (C2: the only one that can be pending)
      const recs = new Map<number, { exists: boolean; isFinal: boolean; value: bigint; status: number }>();
      for (let d = head - 40; d < head - 1; d++) recs.set(d, { exists: true, isFinal: true, value: val(), status: 1 });
      const pendingTop = rnd() < 0.5;
      recs.set(head - 1, { exists: true, isFinal: !pendingTop, value: val(), status: 1 });
      const preview = lag === 1 && rnd() < 0.8 ? val() : null; // previewFix of the ended head day (null: below quorum)
      // k and S: previewSync applies the final days of the month in order, never past today
      let k = 0;
      let S = 0n;
      for (let j = 0; j < N; j++) {
        const d = START + j;
        if (d >= today) break;
        const x = recs.get(d);
        if (!x?.isFinal) break;
        S += x.value < F ? F : x.value > C ? C : x.value;
        k++;
      }
      if (k >= N) continue;
      const reads = {
        async indexRecord(_i: Address, _g: Hex, d: number) {
          return recs.get(d) ?? { exists: false, isFinal: false, value: 0n, status: 0 };
        },
        async indexHead() {
          return head;
        },
        async indexPreviewFix() {
          return preview === null ? null : { value: preview };
        },
      };
      const fb = new FairBook(reads);
      const f = await fb.fair(IX, G, { t: BigInt(today) * 600n + 1n, startDay: START, startTs: BigInt(START) * 600n, day: 600, n: N, floor: F, cap: C, k, sum: S });
      if (f === null) continue;
      // what can be final next, in the order the index allows: the pending head - 1 (its own value: no select), then,
      // once it is final, the head day closed (its previewFix value) and final T_PEND later; each moves x alone
      const next: bigint[] = [];
      const pend = recs.get(head - 1)!;
      const clamp = (x: bigint) => (x < F ? F : x > C ? C : x);
      const fairAt = (kk: number, ss: bigint, x: bigint) => (ss + BigInt(N - kk) * clamp(x)) / BigInt(N);
      // the month's own k, S after a day d turns final (only when d is the next unapplied day of the month)
      const apply = (d: number, x: bigint, kk: number, ss: bigint): [number, bigint] => (d === START + kk && d < today && kk < N ? [kk + 1, ss + clamp(x)] : [kk, ss]);
      let kk = k;
      let ss = S;
      if (!pend.isFinal) {
        [kk, ss] = apply(head - 1, pend.value, kk, ss);
        next.push(fairAt(kk, ss, pend.value));
      }
      if (preview !== null) {
        const [k2, s2] = apply(head, preview, kk, ss);
        next.push(fairAt(k2, s2, preview));
      }
      for (const v of next) {
        if (v < f.lo || v > f.hi) throw new Error(`state ${n}: a fair of ${v} can follow, outside the band [${f.lo}, ${f.hi}] (today ${today}, head ${head}, k ${k})`);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(1_500);
  });
});
