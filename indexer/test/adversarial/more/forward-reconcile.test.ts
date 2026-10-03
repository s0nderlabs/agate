// Recheck round 2, indexer reconciliation lens: the forward curve and the price points.
//   R2-I2  one GPU's curve on the demo factory through a market replacement and a month turn: October and November
//          listed with their Kuru books, random post-only adds and taker fills on every book, November's market
//          replaced mid-run by a new one (MarketRecorded with previous) while strangers keep trading on the old book,
//          then the month turning (the clock) and December listed with its own book. After every batch, against an
//          independent model: each PricePoint names its series' CURRENT market, its best bid and ask are that book's
//          only (the replaced book's later orders and fills never leak in), its mark follows audit M-1's rule with the
//          series' last trade on a current book (a replaced book's late fills never move it); the MarketForward's
//          month is the month of the clock's time, near and next are that month's and the next month's series, and
//          nearMarkU / nextMarkU equal their price points' marks (the operator's "the market's own prices").
// Every event is a real ABI encoding (test/ev.ts); no chain, no Docker, no network.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { CLOCK_EVERY } from "../../../src/lib/clock.ts";
import { firstDayOf, monthOf } from "../../../src/lib/math.ts";
import { DEC, NOV, OCT, demoTs, listed, recorded } from "../../build.ts";
import { ev } from "../../ev.ts";
import { DEMO, DOLLAR, H100, START, U, market, series, token, user } from "../../world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });

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

const TICK = 10_000n;
const V = 10n ** 12n;

interface O {
  id: bigint;
  isBuy: boolean;
  price: bigint;
  remaining: bigint;
}
class Book {
  next = 1n;
  orders = new Map<bigint, O>();
  best(isBuy: boolean): bigint | undefined {
    let b: bigint | undefined;
    for (const o of this.orders.values()) if (o.isBuy === isBuy && o.remaining > 0n) b = b === undefined || (isBuy ? o.price > b : o.price < b) ? o.price : b;
    return b;
  }
  queue(takerIsBuy: boolean): O[] {
    return [...this.orders.values()].filter((o) => o.isBuy !== takerIsBuy && o.remaining > 0n).sort((a, b) => (a.price !== b.price ? ((takerIsBuy ? a.price < b.price : a.price > b.price) ? -1 : 1) : a.id < b.id ? -1 : 1));
  }
}

describe("R2-I2: price points and the forward curve through a market replacement and a month turn", () => {
  for (const seed of [8, 21, 64]) {
    it(`seed ${seed}`, async () => {
      const rnd = prng(seed);
      const i = createTestIndexer();
      const oct1 = demoTs(firstDayOf(OCT));
      const nov1 = demoTs(firstDayOf(NOV));
      let now = oct1 - 3_000; // September 30 on the demo clock
      let blk = START + 10;
      let rangeStart = START;
      const S = { oct: series(200 + seed), nov: series(300 + seed), dec: series(400 + seed) };
      const books = new Map<string, Book>(); // market -> book
      const currentOf = new Map<string, string>(); // series -> its current market
      const seriesOfMonth = new Map<number, string>([[OCT, S.oct], [NOV, S.nov]]);
      const lastTrade = new Map<string, bigint>(); // series -> its last trade on a book that was current then
      const first: unknown[] = [
        listed({ series: S.oct, token: token(200 + seed), block: blk++, ts: now, month: OCT }),
        listed({ series: S.nov, token: token(300 + seed), block: blk++, ts: now, month: NOV }),
        recorded({ series: S.oct, market: market(200 + seed), block: blk++, ts: now }),
        recorded({ series: S.nov, market: market(300 + seed), block: blk++, ts: now }),
      ];
      books.set(market(200 + seed), new Book());
      books.set(market(300 + seed), new Book());
      currentOf.set(S.oct, market(200 + seed));
      currentOf.set(S.nov, market(300 + seed));
      const marketSeries = new Map<string, string>([[market(200 + seed), S.oct], [market(300 + seed), S.nov]]);
      let pendingFirst: unknown[] | null = first;
      let replaced = false;
      let turned = false;
      let lateFills = 0;
      for (let batch = 0; batch < 10; batch++) {
        const items: unknown[] = pendingFirst ?? [];
        pendingFirst = null;
        if (batch === 4) {
          // November's market replaced; the old book keeps its orders and strangers keep trading there
          const nm = market(500 + seed);
          items.push(recorded({ series: S.nov, market: nm, block: blk++, ts: now, previous: market(300 + seed) }));
          books.set(nm, new Book());
          marketSeries.set(nm, S.nov);
          currentOf.set(S.nov, nm);
          replaced = true;
        }
        if (batch === 6) {
          // the month turns to November; December is listed with its own book
          now = nov1 + 400;
          items.push(listed({ series: S.dec, token: token(400 + seed), block: blk++, ts: now, month: DEC }));
          items.push(recorded({ series: S.dec, market: market(400 + seed), block: blk++, ts: now }));
          books.set(market(400 + seed), new Book());
          marketSeries.set(market(400 + seed), S.dec);
          currentOf.set(S.dec, market(400 + seed));
          seriesOfMonth.set(DEC, S.dec);
          turned = true;
        }
        for (let n = 0; n < 30; n++) {
          blk++;
          now += 7;
          const mk = [...books.keys()][Math.floor(rnd() * books.size)]!;
          const b = books.get(mk)!;
          const s = marketSeries.get(mk)!;
          const k = (name: string, args: Record<string, unknown>) => items.push(ev("KuruOrderBook", name, args, { src: mk, block: blk, ts: now }));
          if (rnd() < 0.55) {
            const isBuy = rnd() < 0.5;
            let price = BigInt(300 + Math.floor(rnd() * 120)) * TICK;
            const opp = b.best(!isBuy);
            if (opp !== undefined && (isBuy ? price >= opp : price <= opp)) price = isBuy ? opp - TICK : opp + TICK;
            const size = BigInt(1 + Math.floor(rnd() * 40)) * 10_000n;
            const id = b.next++;
            b.orders.set(id, { id, isBuy, price, remaining: size });
            k("OrderCreated", { orderId: Number(id), owner: user(1 + Math.floor(rnd() * 3)), size, price: Number(price), isBuy });
          } else {
            const takerIsBuy = rnd() < 0.5;
            let left = BigInt(1 + Math.floor(rnd() * 60)) * 10_000n;
            for (const o of b.queue(takerIsBuy)) {
              if (left === 0n) break;
              const filled = left < o.remaining ? left : o.remaining;
              o.remaining -= filled;
              left -= filled;
              if (currentOf.get(s) === mk) lastTrade.set(s, o.price);
              else lateFills++;
              k("Trade", { orderId: Number(o.id), makerAddress: user(1), isBuy: takerIsBuy, price: o.price * V, updatedSize: o.remaining, takerAddress: user(9), txOrigin: user(9), filledSize: filled });
            }
          }
        }
        // the clock at the batch's time (filler before the clock block; one after it so simulate runs it in this batch)
        const nextClock = rangeStart + Math.ceil((blk + 2 - rangeStart) / CLOCK_EVERY) * CLOCK_EVERY;
        const drip = (bb: number) => ev("AgateDollar", "Dripped", { to: user(3), amount: 1n * U, nextAt: BigInt(now + 86_400) }, { src: DOLLAR, block: bb, ts: now, logIndex: 0 });
        items.push(drip(nextClock - 1), drip(nextClock + 1));
        rangeStart = nextClock + 2;
        blk = rangeStart;
        await run(i, items);
        // ---- reconcile
        const marks = new Map<string, bigint | undefined>();
        for (const [s, mk] of currentOf) {
          const pp = await i.PricePoint.getOrThrow(s);
          const b = books.get(mk)!;
          const bid = b.best(true);
          const ask = b.best(false);
          expect(pp.market_id, `price point of ${s} after batch ${batch}`).toBe(mk);
          expect([pp.bestBidU, pp.bestAskU], `best of ${s} after batch ${batch}`).toEqual([bid, ask]);
          const last = lastTrade.get(s);
          const mid = bid !== undefined && ask !== undefined ? ((bid + ask) / 2n / TICK) * TICK : undefined;
          const outside = last !== undefined && bid !== undefined && ask !== undefined && (last < bid || last > ask);
          const want = last !== undefined && !outside ? [last, "TRADE"] : mid !== undefined ? [mid, "MID"] : [undefined, "NONE"];
          expect([pp.markU, pp.markSource], `mark of ${s} after batch ${batch}`).toEqual(want);
          marks.set(s, pp.markU);
        }
        const fw = (await i.MarketForward.getAll()).find((f) => f.factory_id === DEMO.factory && f.gpuId === H100)!;
        const m = monthOf(Number((BigInt(now) - (BigInt(oct1) - BigInt(firstDayOf(OCT)) * 600n)) / 600n));
        expect(fw.currentMonth, `forward month after batch ${batch}`).toBe(m);
        expect([fw.nearSeries_id, fw.nextSeries_id], `near and next after batch ${batch}`).toEqual([seriesOfMonth.get(m), seriesOfMonth.get(m + 1)]);
        expect([fw.nearMarkU, fw.nextMarkU], `forward marks after batch ${batch}`).toEqual([marks.get(seriesOfMonth.get(m) ?? ""), marks.get(seriesOfMonth.get(m + 1) ?? "")]);
      }
      expect(replaced && turned).toBe(true);
      expect(lateFills).toBeGreaterThan(0); // the replaced book did trade after it was replaced
    }, 120_000);
  }
});
