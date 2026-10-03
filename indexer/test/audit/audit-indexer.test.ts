// Independent audit of the P3 indexer (phase 3). Each test pins an edge the builder's suite did not cover, named by its
// finding id in bots-indexer-20261003/audit-indexer.md. The fix round flipped every defect's expectation to the fixed
// behaviour (bots-indexer-20261003/fix-log.md); L-2 stays documented behaviour.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { dayLabel } from "../../src/lib/labels.ts";
import { listed, recorded, SEP20, demoTs } from "../build.ts";
import { ev } from "../ev.ts";
import { DEMO, H100, ZERO, market, series, token, user } from "../world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const D = 20_727;
const DIG = `0x${"d1".repeat(32)}`;
const DIG2 = `0x${"d2".repeat(32)}`;
const V = 10n ** 12n;
let blk = 1_000;
let t = 1_791_000_000;
const ix = (name: string, args: Record<string, unknown>, at?: number) => ev("AgateIndex", name, args, { src: DEMO.index, block: blk++, ts: at ?? (t += 10) });
const closed = (o: { status?: number; value?: number; needsSign?: boolean; source?: string; digest?: string } = {}) =>
  ix("DayClosed", {
    gpuId: H100,
    day: D,
    source: o.source ?? user(1),
    value: o.value ?? 2_010_000,
    status: o.status ?? 1,
    fresh: 5,
    held: 0,
    freshMedian: 2_000_000,
    changed: o.needsSign ?? false,
    needsSign: o.needsSign ?? false,
    late: false,
    incomplete: false,
    digest: o.digest ?? DIG,
  });
const fix = (i: TI) => i.DailyFix.getOrThrow(`${DEMO.index}-${H100}-${D}`);

describe("audit: daily fixes", () => {
  it("L-1 (fixed): a first day dropped then skipped clears the never-final record's value and status", async () => {
    // IndexDays.carry case 1 on a GPU's first day: FixDropped, then DaySkipped (no record before it)
    const i = createTestIndexer();
    await run(i, [
      closed({ needsSign: true, status: 3, value: 2_500_000 }),
      ix("FixDropped", { gpuId: H100, day: D, source: user(1), value: 2_500_000, digest: DIG }),
      ix("DaySkipped", { gpuId: H100, day: D, carryCase: 1 }),
    ]);
    const f = await fix(i);
    expect(dayLabel(f, 2_000_000_000n)).toBe("skipped"); // the label is right
    // FIXED: a skipped day shows no value and status NONE (as the README says); that a record was dropped stays
    expect(f).toMatchObject({ state: "SKIPPED", value: 0n, status: "NONE", needsSign: false, dropped: true, finalAt: undefined });
  });

  it("L-2: after the attester's select the record's status, fresh, needsSign stay the replaced record's (documented)", async () => {
    const i = createTestIndexer();
    await run(i, [
      closed({ needsSign: true, status: 3 }),
      ix("RecordReplaced", { gpuId: H100, day: D, by: user(8), oldSource: user(1), newSource: user(2), oldValue: 2_010_000, newValue: 2_020_000, oldDigest: DIG, newDigest: DIG2 }),
    ]);
    expect(await fix(i)).toMatchObject({ value: 2_020_000n, source: user(2), status: "DEMO", needsSign: true, replaced: true });
  });

  it("M-3 (fixed): an owner action whose day does not fit Int (LIVE_UNTIL with a far or NEVER day) is stored as INT32_MAX", async () => {
    // IndexAdmin._validate bounds LIVE_UNTIL's day only from below, so the owner can queue day = NEVER (2^32 - 1).
    // OwnerAction.day is Int (Postgres integer, int32): a larger value would fail the batch write and halt the indexer.
    const i = createTestIndexer();
    const id = `0x${"a9".repeat(32)}`;
    const action = { kind: 5, slot: 0, addr: ZERO, gpuId: H100, day: 4_294_967_295, mode: 0 };
    let err: unknown;
    try {
      await run(i, [ix("ActionQueued", { id, action, eta: 1_800_000_000n })]);
    } catch (e) {
      err = e;
    }
    const row = err === undefined ? await i.OwnerAction.get(`${DEMO.index}-${id}`) : undefined;
    // FIXED: no throw, and the day fits int32 (2^31 - 1 reads "beyond int32: see the action on chain")
    expect(err).toBeUndefined();
    expect(row).toMatchObject({ day: 2_147_483_647, kind: 5, status: "QUEUED" });
    // an ordinary day is stored as it is
    const i2 = createTestIndexer();
    await run(i2, [ix("ActionQueued", { id, action: { ...action, day: 20_800 }, eta: 1_800_000_000n })]);
    expect((await i2.OwnerAction.getOrThrow(`${DEMO.index}-${id}`)).day).toBe(20_800);
  });
});

describe("audit: Kuru marks and replaced markets", () => {
  const S = series(1);
  const M = market(1);
  let kb = 2_000;
  let kt = demoTs(SEP20) + 1_000;
  const k = (src: string, name: string, args: Record<string, unknown>) => ev("KuruOrderBook", name, args, { src, block: kb++, ts: (kt += 2) });

  it("M-1 (fixed): once the book has moved away from the last trade, the mark is the book's mid", async () => {
    const i = createTestIndexer();
    await run(i, [listed({ series: S, token: token(1), block: 100 }), recorded({ series: S, market: M, block: 101 })]);
    await run(i, [
      k(M, "OrderCreated", { orderId: 1, owner: user(1), size: 10_000n, price: 3_560_000, isBuy: true }),
      k(M, "OrderCreated", { orderId: 2, owner: user(1), size: 10_000n, price: 3_640_000, isBuy: false }),
      k(M, "Trade", { orderId: 2, makerAddress: user(1), isBuy: true, price: 3_640_000n * V, updatedSize: 9_000n, takerAddress: user(2), txOrigin: user(3), filledSize: 1_000n }),
      // the maker requotes 10 cents higher after a new final day (batchUpdate: cancels, then adds)
      k(M, "OrderCanceled", { orderId: 1, owner: user(1), price: 3_560_000, size: 10_000n, isBuy: true }),
      k(M, "OrderCanceled", { orderId: 2, owner: user(1), price: 3_640_000, size: 9_000n, isBuy: false }),
      k(M, "OrderCreated", { orderId: 3, owner: user(1), size: 10_000n, price: 3_660_000, isBuy: true }),
      k(M, "OrderCreated", { orderId: 4, owner: user(1), size: 10_000n, price: 3_740_000, isBuy: false }),
    ]);
    const pp = await i.PricePoint.getOrThrow(S);
    expect({ bid: pp.bestBidU, ask: pp.bestAskU, mid: pp.midU }).toEqual({ bid: 3_660_000n, ask: 3_740_000n, mid: 3_700_000n });
    // FIXED: 3.64 is below the best bid, so no one can trade there: the forward curve's point is the mid 3.70
    expect({ mark: pp.markU, src: pp.markSource }).toEqual({ mark: 3_700_000n, src: "MID" });
    expect(pp.lastTradePriceU).toBe(3_640_000n); // the trade itself is still there for the app
  });

  it("L-3 (fixed): a replaced market's later fills stay in Trade but enter neither the candles nor the price point", async () => {
    const i = createTestIndexer();
    const M2 = market(2);
    await run(i, [listed({ series: S, token: token(1), block: 100 }), recorded({ series: S, market: M, block: 101 })]);
    await run(i, [
      k(M, "OrderCreated", { orderId: 1, owner: user(1), size: 10_000n, price: 2_000_000, isBuy: true }),
      recorded({ series: S, market: M2, block: kb++, previous: M, created: false, ts: (kt += 2) }),
      k(M, "Trade", { orderId: 1, makerAddress: user(1), isBuy: false, price: 2_000_000n * V, updatedSize: 0n, takerAddress: user(2), txOrigin: user(2), filledSize: 10_000n }),
    ]);
    // FIXED: chart and mark agree: the old book's fill is in neither
    expect(await i.DailyCandle.getAll()).toEqual([]);
    expect((await i.PricePoint.getOrThrow(S)).lastTradePriceU).toBeUndefined();
    expect((await i.Trade.getAll()).length).toBe(1); // the fill itself is history
  });

  it("L-5 (fixed): a Kuru market state the table does not know is read as HARD_PAUSED, never a halt", async () => {
    const i = createTestIndexer();
    await run(i, [listed({ series: S, token: token(1), block: 100 }), recorded({ series: S, market: M, block: 101 })]);
    await run(i, [k(M, "MarketStateUpdated", { previousState: 0, newState: 7 })]);
    expect((await i.Market.getOrThrow(M)).state).toBe("HARD_PAUSED");
    await run(i, [k(M, "MarketStateUpdated", { previousState: 7, newState: 0 })]);
    expect((await i.Market.getOrThrow(M)).state).toBe("ACTIVE");
  });

  it("L-4 (documented): a market recorded with created = false may hold orders from before registration; the README says to read getL2Book", async () => {
    const i = createTestIndexer();
    await run(i, [listed({ series: S, token: token(1), block: 100 }), recorded({ series: S, market: M, block: 101, created: false })]);
    // orders placed before MarketRecorded are never seen (Envio registers the book from this block on); the entity
    // has `created` but nothing on PricePoint tells the app to trust getL2Book instead
    expect(await i.Market.getOrThrow(M)).toMatchObject({ created: false, current: true });
    expect(Object.keys(await i.PricePoint.getOrThrow(S))).not.toContain("bookComplete");
    // the fix is the README's guidance (no schema change): created = false means the book may predate MarketRecorded
    const readme = readFileSync(join(import.meta.dirname, "..", "..", "README.md"), "utf8");
    expect(readme).toContain("`Market.created` is false");
  });
});
