// Recheck round 1 (cold, independent), indexer reconciliation lens.
//   R1-I1  random Kuru V1 sessions (post-only adds on both sides, takers walking the book with partial and whole fills,
//          batch cancels that name live, partly filled and already filled ids, the deployed implementation's
//          OrderCanceled per live id plus OrdersCanceled with 0 for a filled one), fed through Envio's simulate in
//          several batches, reconciled against an independent reference model of the book after every batch: each
//          BookOrder's status and remaining, each BookLevel's size and order count (and no level left behind), the
//          PricePoint's best bid, best ask and mark (audit M-1's rule), the trade rows and the day's candle volume.
//   R1-I2  the series ledger identity over an interleaved month on two series in shared blocks (mints, redeems, daily
//          positions, claims of 0, the FINAL close after its Claimed, closes with token, unstreams, settles), against
//          an independent replay of MS 4.4's dollar moves.
// Every event is a real ABI encoding (test/ev.ts); no chain, no Docker, no network.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { listed, recorded, demoTs, SEP20 } from "../../build.ts";
import { ev } from "../../ev.ts";
import { market, series, token, user } from "../../world.ts";

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

interface ROrder {
  id: bigint;
  owner: string;
  isBuy: boolean;
  price: bigint;
  remaining: bigint;
  status: "ACTIVE" | "FILLED" | "CANCELED";
  /** a filled id already named in a cancel: its slot is deleted, so it is never named again */
  gone?: boolean;
}

/** An independent model of one Kuru V1 book: FIFO per price, post-only adds, takers walk the best price first. */
class RefBook {
  orders = new Map<bigint, ROrder>();
  next = 1n;
  lastTrade: bigint | undefined;
  volume = 0n;
  trades = 0;
  private active(isBuy: boolean) {
    return [...this.orders.values()].filter((o) => o.status === "ACTIVE" && o.isBuy === isBuy);
  }
  best(isBuy: boolean): bigint | undefined {
    const xs = this.active(isBuy).map((o) => o.price);
    if (xs.length === 0) return undefined;
    return xs.reduce((m, x) => (isBuy ? (x > m ? x : m) : x < m ? x : m));
  }
  /** FIFO queue of the opposite side, best price first, oldest id first. */
  queue(takerIsBuy: boolean): ROrder[] {
    return this.active(!takerIsBuy).sort((a, b) => (a.price !== b.price ? ((takerIsBuy ? a.price < b.price : a.price > b.price) ? -1 : 1) : a.id < b.id ? -1 : 1));
  }
}

describe("R1-I1: the indexed book equals an independent model after every batch", () => {
  for (const seed of [7, 19, 23, 42]) {
    it(`seed ${seed}: 240 random book events in 8 batches`, async () => {
      const rnd = prng(seed);
      const i = createTestIndexer();
      const S = series(40 + seed);
      const M = market(40 + seed);
      let blk = 300;
      let ts = demoTs(SEP20) + 1_000;
      await run(i, [listed({ series: S, token: token(40 + seed), block: 100 }), recorded({ series: S, market: M, block: 101 })]);
      const ref = new RefBook();
      const k = (name: string, args: Record<string, unknown>) => ev("KuruOrderBook", name, args, { src: M, block: blk, ts });
      for (let batch = 0; batch < 8; batch++) {
        const items: unknown[] = [];
        for (let n = 0; n < 30; n++) {
          blk++;
          ts += 1;
          const a = rnd();
          if (a < 0.5) {
            // a post-only add: a bid strictly under the best ask, an ask strictly over the best bid
            const isBuy = rnd() < 0.5;
            const owner = user(1 + Math.floor(rnd() * 4));
            const size = BigInt(1 + Math.floor(rnd() * 50)) * 10_000n;
            let price = BigInt(180 + Math.floor(rnd() * 41)) * TICK; // 1.80 .. 2.20
            const opp = ref.best(!isBuy);
            if (opp !== undefined && (isBuy ? price >= opp : price <= opp)) price = isBuy ? opp - TICK : opp + TICK;
            if (price <= 0n) continue;
            const id = ref.next++;
            ref.orders.set(id, { id, owner, isBuy, price, remaining: size, status: "ACTIVE" });
            items.push(k("OrderCreated", { orderId: Number(id), owner, size, price: Number(price), isBuy }));
          } else if (a < 0.8) {
            // a taker walks the opposite side: one Trade per maker order touched; a whole fill reports updatedSize 0
            const takerIsBuy = rnd() < 0.5;
            let left = BigInt(1 + Math.floor(rnd() * 120)) * 10_000n;
            for (const o of ref.queue(takerIsBuy)) {
              if (left === 0n) break;
              const filled = left < o.remaining ? left : o.remaining;
              o.remaining -= filled;
              if (o.remaining === 0n) o.status = "FILLED";
              left -= filled;
              ref.lastTrade = o.price;
              ref.volume += filled * 100n;
              ref.trades++;
              items.push(k("Trade", { orderId: Number(o.id), makerAddress: o.owner, isBuy: takerIsBuy, price: o.price * V, updatedSize: o.remaining, takerAddress: user(9), txOrigin: user(9), filledSize: filled }));
            }
          } else {
            // one owner's batch cancel: live ids (some partly filled) and ids already filled (Kuru skips those and
            // reports 0 in OrdersCanceled); never an id already cancelled (Kuru reverts on that)
            const owner = user(1 + Math.floor(rnd() * 4));
            const mine = [...ref.orders.values()].filter((o) => o.owner === owner && o.status !== "CANCELED" && !o.gone && rnd() < 0.6);
            if (mine.length === 0) continue;
            const reported: bigint[] = [];
            for (const o of mine) {
              if (o.status === "ACTIVE") {
                items.push(k("OrderCanceled", { orderId: Number(o.id), owner, price: Number(o.price), size: o.remaining, isBuy: o.isBuy }));
                o.status = "CANCELED";
                o.remaining = 0n;
                reported.push(o.id);
              } else reported.push(0n); // FILLED: its slot is deleted, no OrderCanceled
            }
            items.push(k("OrdersCanceled", { orderId: reported, owner }));
            // a filled order named once is gone for good (its slot was deleted); never name it again
            for (const o of mine) if (o.status === "FILLED") o.gone = true;
          }
        }
        await run(i, items);
        // ---- reconcile
        for (const o of ref.orders.values()) {
          const got = await i.BookOrder.getOrThrow(`${M}-${o.id}`);
          // a filled id named in a later cancel stays FILLED (Kuru reports it as 0 in OrdersCanceled)
          expect([got.status, got.remaining], `order ${o.id} after batch ${batch}`).toEqual([o.status, o.status === "ACTIVE" ? o.remaining : 0n]);
        }
        const levels = new Map<string, { size: bigint; orders: number }>();
        for (const o of ref.orders.values()) {
          if (o.status !== "ACTIVE") continue;
          const id = `${M}-${o.isBuy ? "bid" : "ask"}-${o.price}`;
          const l = levels.get(id) ?? { size: 0n, orders: 0 };
          levels.set(id, { size: l.size + o.remaining, orders: l.orders + 1 });
        }
        const got = new Map((await i.BookLevel.getAll()).filter((l) => l.market_id === M).map((l) => [l.id, { size: l.size, orders: l.orders }]));
        expect(got, `levels after batch ${batch}`).toEqual(levels);
        const pp = await i.PricePoint.getOrThrow(S);
        const bid = ref.best(true);
        const ask = ref.best(false);
        expect([pp.bestBidU, pp.bestAskU], `best bid and ask after batch ${batch}`).toEqual([bid, ask]);
        const last = ref.lastTrade;
        const inside = last !== undefined && !(bid !== undefined && ask !== undefined && (last < bid || last > ask));
        const mid = bid !== undefined && ask !== undefined ? ((bid + ask) / 2n / TICK) * TICK : undefined;
        expect([pp.markU, pp.markSource], `mark after batch ${batch}`).toEqual(inside ? [last, "TRADE"] : mid !== undefined ? [mid, "MID"] : [undefined, "NONE"]);
      }
      const trades = (await i.Trade.getAll()).filter((t) => t.market_id === M);
      expect(trades.length).toBe(ref.trades);
      const candles = (await i.DailyCandle.getAll()).filter((c) => c.series_id === S);
      expect(candles.reduce((s, c) => s + c.volumeTokens, 0n)).toBe(ref.volume);
      expect(candles.reduce((s, c) => s + c.trades, 0)).toBe(ref.trades);
      expect(ref.trades).toBeGreaterThan(20); // not a degenerate session
      expect([...ref.orders.values()].some((o) => o.gone)).toBe(true); // a filled id was named in a cancel
      expect([...ref.orders.values()].some((o) => o.status === "CANCELED" && o.remaining === 0n)).toBe(true);
    }, 120_000);
  }
});

describe("R1-I2: Series.ledger equals an independent replay of MS 4.4's dollar moves", () => {
  it("two series, interleaved in shared blocks, every kind of dollar move", async () => {
    const rnd = prng(99);
    const i = createTestIndexer();
    const A = series(80);
    const B = series(81);
    await run(i, [listed({ series: A, token: token(80), block: 100 }), listed({ series: B, token: token(81), block: 101, gpu: "0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d", label: "H200" })]);
    const ledger = new Map<string, bigint>([[A, 0n], [B, 0n]]);
    const openIds = new Map<string, Map<bigint, { paid: bigint; side: number; q: bigint }>>([[A, new Map()], [B, new Map()]]);
    const nextId = new Map<string, bigint>([[A, 1n], [B, 1n]]);
    let blk = 200;
    let ts = demoTs(SEP20) + 2_000;
    const items: unknown[] = [];
    const s = (src: string, name: string, args: Record<string, unknown>) => items.push(ev("AgateSeries", name, args, { src, block: blk, ts }));
    for (let n = 0; n < 400; n++) {
      if (rnd() < 0.3) {
        blk++;
        ts += 3;
      }
      const src = rnd() < 0.5 ? A : B;
      const who = user(1 + Math.floor(rnd() * 5));
      const q = BigInt(1 + Math.floor(rnd() * 900)) * 100n;
      const amt = BigInt(Math.floor(rnd() * 5_000_000));
      const L = ledger.get(src)!;
      const pos = openIds.get(src)!;
      const a = rnd();
      if (a < 0.2) {
        s(src, "Minted", { payer: who, to: who, q, cost: amt });
        ledger.set(src, L + amt);
      } else if (a < 0.3 && L >= amt) {
        s(src, "Redeemed", { holder: who, to: who, q, paid: amt });
        ledger.set(src, L - amt);
      } else if (a < 0.45 && L >= amt) {
        const id = nextId.get(src)!;
        nextId.set(src, id + 1n);
        const side = rnd() < 0.5 ? 0 : 1;
        s(src, "PositionOpened", { id, owner: who, payee: who, side, q, paidNow: amt, operator: "0x0000000000000000000000000000000000000000", daily: rnd() < 0.5, k: 0, to: who });
        pos.set(id, { paid: amt, side, q });
        ledger.set(src, L - amt);
      } else if (a < 0.6 && pos.size > 0) {
        const [id, p] = [...pos][Math.floor(rnd() * pos.size)]!;
        const pay = rnd() < 0.2 ? 0n : amt > L ? L : amt; // a claim of 0 is still a row
        s(src, "Claimed", { id, payee: who, amount: pay, paidTotal: p.paid + pay, k: 1 });
        p.paid += pay;
        ledger.set(src, L - pay);
        if (rnd() < 0.3) {
          // the FINAL close right after its Claimed in the same claim: no second ledger move
          s(src, "PositionClosed", { id, owner: who, kind: 0, amount: pay, to: who, by: who });
          pos.delete(id);
        }
      } else if (a < 0.7 && pos.size > 0) {
        const [id] = [...pos][Math.floor(rnd() * pos.size)]!;
        const pay = amt > L ? L : amt;
        s(src, "PositionClosed", { id, owner: who, kind: 1, amount: pay, to: who, by: who }); // WITH_TOKEN pays out
        pos.delete(id);
        ledger.set(src, L - pay);
      } else if (a < 0.8 && pos.size > 0) {
        const [id, p] = [...pos][Math.floor(rnd() * pos.size)]!;
        s(src, "PositionClosed", { id, owner: who, kind: 2, amount: p.paid, to: who, by: who }); // UNSTREAMED takes paid back
        pos.delete(id);
        ledger.set(src, L + p.paid);
      } else if (a < 0.9 && L >= amt) {
        s(src, "Settled", { holder: who, side: rnd() < 0.5 ? 0 : 1, q, paid: amt, to: who });
        ledger.set(src, L - amt);
      } else {
        s(src, "ShortCredited", { account: who, q, balance: q });
      }
    }
    // three batches, so the store carries the ledger across process calls; a batch never splits a block (a block
    // already processed is not processed again)
    const blockOf = (x: unknown) => (x as { block: { number: number } }).block.number;
    let from = 0;
    for (let b = 1; b <= 3; b++) {
      let to = b === 3 ? items.length : Math.ceil((items.length * b) / 3);
      while (to < items.length && to > 0 && blockOf(items[to]) === blockOf(items[to - 1])) to++;
      if (to > from) await run(i, items.slice(from, to));
      from = to;
    }
    for (const src of [A, B]) {
      const got = await i.Series.getOrThrow(src);
      expect(got.ledger, `ledger of ${src}`).toBe(ledger.get(src));
      expect(got.openPositions, `open positions of ${src}`).toBe(openIds.get(src)!.size);
    }
  });
});
