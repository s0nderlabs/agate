// Recheck round 1, claiming and listing lens.
//   R1-C1  a whole month of daily claims against a hostile crowd: random sides and sizes, duplicate payees, strangers
//          claiming between rounds, owners flipping daily on and off, positions opened mid-month, one payee whose
//          transfer reverts (bisected out, then paid once its payout changes). After every round: every position that
//          was daily pays down to under a cent, no claimMany names a position that was not daily, and the final sweep
//          leaves dust only. Pins MS 6.6's selection rules end to end.
//   R1-C2  (finding R1-L1, fixed) the D1 margin did not reach the boundary day: forcedDay checked the days the call
//          applies now (kState .. kPrev - 1), never day kPrev itself, which the claimMany's own sync would FORCE if it
//          crosses its last resort between the check and the landing. Now held.
//   R1-C3  (finding R1-H1, fixed) the lister's reserve (audit P-L2) was wired to the lister's NotReady months only: a
//          month that IS ready but whose list the day's budget refused was not "waiting", so the claims got the whole
//          room in the same tick and the listing starved while claims were due. Measured on a simulated demo morning
//          (R1-C3b) with the real Budget: never listed in five hours before the fix. Now the lister reports what it
//          still owes (`owed`) and the app keeps the reserve while anything is owed (`listerOwes`). R1-C3b also covers
//          finding R1-L2 (fixed): under pacing the claims went out in tiny batches nearly every tick, paying each
//          transaction's fixed gas again; now they wait for a full batch while the day can still pay one.
// The recheck round pinned the old behaviour; the fix round flipped each assertion (recheck R1).
// Fakes only: no chain, no key, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { Budget, CENT, type FactoryEntry, forcedDay, LimitTable, type ListingCheck, monToWei, paced, type SpendGuard } from "@agate/market";
import { listerOwes, listingCostWei } from "../../../src/app.ts";
import { Lister } from "../../../src/lister.ts";
import { type BudgetView, Payer } from "../../../src/payer.ts";
import { Positions } from "../../../src/positions.ts";
import { StateStore } from "../../../src/state.ts";
import { addr, FakeReads, FakeScanner, FakeSender, type FakeSeries, FakeWorld, gpu, U } from "../../fake/world.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-payer-r1-"));
  dirs.push(d);
  return d;
};

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

describe("R1-C1: a month of daily claims against a hostile crowd", () => {
  for (const seed of [3, 17, 101]) {
    test(`seed ${seed}: daily positions paid to under a cent each round, nothing else named, the sweep leaves dust only`, async () => {
      const rnd = prng(seed);
      const w = new FakeWorld();
      const f = w.addFactory("demo");
      const s: FakeSeries = w.addSeries(f, gpu(0x100), 24_322, { n: 30, floor: F, cap: C, startTs: w.t, day: 600 });
      s.values = Array.from({ length: 30 }, () => F + BigInt(Math.floor(rnd() * Number(C - F + 1n))));
      const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
      const st = new StateStore(tmp());
      const payer = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner: new FakeScanner(w), positions: new Positions([entry]), state: st, limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, log: () => {} });
      const payees = [addr(0xa1), addr(0xa2), addr(0xa3), addr(0xa4), addr(0xa5)];
      const randomQ = () => {
        const r = rnd();
        return r < 0.3 ? BigInt(1 + Math.floor(rnd() * 99)) * 100n : r < 0.6 ? BigInt(1 + Math.floor(rnd() * 5)) * U : BigInt(1 + Math.floor(rnd() * 3_000)) * U; // dust, small, large
      };
      const open = () => s.open({ owner: addr(0x100 + Math.floor(rnd() * 8)), payee: payees[Math.floor(rnd() * payees.length)]!, side: rnd() < 0.5 ? 0 : 1, q: randomQ(), daily: rnd() < 0.7 });
      for (let i = 0; i < 60; i++) open();
      // one payee whose dollar transfer reverts: its daily position is bisected out until its payout changes
      const bad = addr(0xbad);
      s.revertPayees.add(bad.toLowerCase());
      const badId = s.open({ owner: addr(0x1ff), payee: bad, side: 0, q: 500n * U, daily: true });
      let badFixed = false;
      let everBad = false;
      for (let day = 1; day <= 30; day++) {
        s.finalDays = day;
        w.t = s.t.startTs + BigInt(day) * 600n + 300n;
        // strangers claim, owners flip daily, new positions arrive (only while the month is open)
        for (const [id, p] of s.pos) {
          if (rnd() < 0.05) s.claim(id);
          if (rnd() < 0.08) {
            w.mine();
            p.daily = !p.daily;
            w.emit(s.address, "PayoutChanged", { id, payee: p.payee, daily: p.daily });
          }
        }
        if (day < 30 && rnd() < 0.5) open();
        if (day === 12) {
          // the bad payee's owner points the payout elsewhere: the bad mark clears, the position is paid again
          w.mine();
          const p = s.pos.get(badId)!;
          p.payee = addr(0x600d);
          p.daily = true;
          w.emit(s.address, "PayoutChanged", { id: badId, payee: p.payee, daily: true });
          badFixed = true;
        }
        const dailyNow = new Map([...s.pos].map(([id, p]) => [id, p.daily]));
        const before = w.sends.length;
        await payer.tick(w.t);
        if (st.isBad(s.address, badId)) everBad = true;
        const named = w.sends.slice(before).filter((x) => x.fn === "claimMany").flatMap((x) => x.args[0] as bigint[]);
        for (const id of named) {
          // during the month only daily positions are named; in the sweep (k == N) daily is ignored
          if (day < 30 && dailyNow.get(id) !== true) throw new Error(`day ${day}: claimMany named position ${id}, which is not daily`);
          if (id === badId && !badFixed) throw new Error(`day ${day}: the reverting payee's position was sent again before its payout changed`);
        }
        for (const [id, p] of s.pos) {
          const c = s.claimableOf(id)!;
          if (day < 30 && dailyNow.get(id) === true && c >= CENT && !(id === badId && !badFixed)) throw new Error(`day ${day}: daily position ${id} still has ${c} u claimable after the round`);
          if (day === 30 && (c >= CENT || (p.q >= U && c > 0n))) throw new Error(`sweep: position ${id} (q ${p.q}) still open with ${c} u claimable`);
        }
      }
      // the sweep closed every position worth closing; what is left is dust its owners may claim themselves
      for (const [id, p] of s.pos) {
        const c = s.claimableOf(id)!;
        expect(c < CENT && (p.q < U || c === 0n)).toBe(true);
        expect(id).not.toBe(badId);
      }
      expect(everBad).toBe(true); // the bisection path ran
      expect(w.sends.filter((x) => x.fn === "claimMany").every((x) => (x.args[0] as bigint[]).length <= 50)).toBe(true);
    }, 60_000);
  }
});

describe("R1-C2 (finding R1-L1, fixed): the D1 margin reaches the boundary day kPrev", () => {
  test("day kPrev ended, not closed by the wall, 60 s before its last resort: held (a claim landing 60 s later would force it)", async () => {
    const index = addr(0x1d);
    const g = gpu(0x100);
    const terms = { index, gpuId: g, startDay: 20_000, startTs: 1_000_000_000n, day: 600, lastResort: 259_200n };
    // day 0 final (closed: head > day 0); day 1 ended but the wall has not closed it (head = day 1)
    const reads = {
      indexHead: async () => terms.startDay + 1,
      indexRecord: async (_i: Address, _g: `0x${string}`, d: number) => (d === terms.startDay ? { exists: true, isFinal: true, value: 3_600_000n, status: 1 } : { exists: false, isFinal: false, value: 0n, status: 0 }),
    };
    const endDay1 = terms.startTs + 2n * 600n;
    const t = endDay1 + terms.lastResort - 60n;
    // what the payer checks: kState 0, kPrev 1 (previewSync applies day 0 only: day 1 is neither final nor overdue yet)
    const held = await forcedDay(reads, terms, 0, 1, t);
    // FIXED: held (was null, so sync(1) then claimMany went out, and a claimMany landing 60 s later ran _sync(all) and
    // forced day 1 at lastX while the wall had not closed it, MS 6.6 D1)
    expect(held).toMatchObject({ day: terms.startDay + 1, why: "not closed" });
    // with nothing to apply now (kState == kPrev == 1) it is held too: claimMany syncs whatever has crossed by then
    expect(await forcedDay(reads, terms, 1, 1, t)).toMatchObject({ day: terms.startDay + 1, why: "not closed" });
    // the same day one minute later is held: the margin was meant to catch it before it crossed
    expect(await forcedDay(reads, terms, 0, 2, t + 61n)).toMatchObject({ day: terms.startDay + 1, why: "not closed" });
  });
});

describe("R1-C3 (finding R1-H1, fixed): the lister's reserve covers a ready month the budget refused", () => {
  test("list refused BUDGET is owed: the app keeps the reserve and the claims leave the room to the listing", async () => {
    const w = new FakeWorld();
    const ready: ListingCheck = { ok: true, floor: F, cap: C };
    const f = w.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ready });
    // last month's series still pays daily positions
    const s = w.addSeries(f, gpu(0x100), f.month - 1, { n: 30, floor: F, cap: C, startTs: w.t, day: 600 });
    s.values = Array.from({ length: 30 }, () => 3_600_000n);
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    for (let i = 0; i < 5; i++) s.open({ owner: addr(0x300 + i), payee: addr(0x400 + i), side: 0, q: 2_000n * U, daily: true });
    s.finalDays = 1;
    w.t = s.t.startTs + 600n + 300n;
    // one budget for both, as in the app: the day's paced allowance is 0.3 MON; a list needs about 0.44 MON at 100 gwei
    let allowance = 300_000_000_000_000_000n;
    const guard: SpendGuard = {
      canSpend: (cost, safety) => (!safety && cost > allowance ? { ok: false, why: "BUDGET" } : { ok: true }),
      record: (cost) => {
        allowance = allowance > cost ? allowance - cost : 0n;
      },
    };
    const sender = new FakeSender(w, { guard });
    const state = new StateStore(tmp());
    const lister = new Lister({ reads: new FakeReads(w), sender, factories: [entry], state, log: () => {} });
    // the app's wiring (app.ts): the reserve applies while listerOwes(the lister's report)
    let owes = false;
    const limits = new LimitTable();
    const reserveWei = (fee: bigint) => (owes ? listingCostWei(limits, fee, lister.gasSeen) : 0n);
    const budget: BudgetView = { allowance: () => allowance, headroom: () => 10n ** 30n, spent: () => {} };
    const payer = new Payer({ reads: new FakeReads(w), sender, scanner: new FakeScanner(w), positions: new Positions([entry]), state, limits, config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget, reserveWei, log: () => {} });
    const rep = await lister.tick(w.t);
    owes = listerOwes(rep);
    expect(w.sends.filter((x) => x.fn === "list")).toEqual([]); // refused: over the day's allowance
    // FIXED: the refused months are owed (was: not "waiting", reserve 0); NotReady months stay what `waiting` counts
    expect(rep.waiting).toEqual([]);
    expect(rep.owed.length).toBe(2); // this month and the next, both ready, both refused BUDGET
    expect(owes).toBe(true);
    expect(lister.gasSeen.list).toBeGreaterThan(0n); // the refused plan's gas limit, for the reserve
    const before = allowance;
    await payer.tick(w.t);
    // FIXED: the claims leave the allowance to the listing (was: sync and claimMany took it)
    expect(w.sends).toEqual([]);
    expect(allowance).toBe(before);
    // a NotReady month is owed too (the case the P-L2 fix covered)
    f.listing = () => ({ ok: false, error: "NotReady()" });
    const nr = await lister.tick(w.t + 1n);
    expect(nr.waiting.length).toBeGreaterThan(0);
    expect(listerOwes(nr)).toBe(true);
  });

  test("a listed series whose createMarket the budget refused is owed; once the market exists nothing is", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ({ ok: true, floor: F, cap: C }) });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    // enough for one list, not for the createMarket after it
    const limits = new LimitTable();
    const fee = w.maxFeePerGas;
    const plan = (shape: "factory.list" | "factory.createMarket") => ((BigInt(limits.limitFor(shape) + 21_000) * 6n + 4n) / 5n) * fee;
    let allowance = plan("factory.list") + plan("factory.createMarket") / 2n;
    const guard: SpendGuard = {
      canSpend: (cost, safety) => (!safety && cost > allowance ? { ok: false, why: "BUDGET" } : { ok: true }),
      record: (cost) => {
        allowance = allowance > cost ? allowance - cost : 0n;
      },
    };
    const lister = new Lister({ reads: new FakeReads(w), sender: new FakeSender(w, { guard }), factories: [entry], state: new StateStore(tmp()), log: () => {} });
    const a = await lister.tick(w.t);
    expect(a.listed.length).toBe(1);
    expect(a.created).toEqual([]);
    // this month's market (refused BUDGET) and next month (its list refused BUDGET) are owed
    expect(a.owed.length).toBe(2);
    expect(a.owed.some((x) => x.startsWith("market "))).toBe(true);
    expect(listerOwes(a)).toBe(true);
    allowance = 10n ** 30n;
    const b = await lister.tick(w.t + 1n);
    expect(b.created.length).toBe(2);
    expect(b.owed).toEqual([]);
    expect(listerOwes(b)).toBe(false);
    // the pilot (no Kuru router) owes no market
    const p = new FakeWorld();
    const pf = p.addFactory("pilot", { gpus: [gpu(0x100)], listing: () => ({ ok: true, floor: F, cap: C }), kuruRouter: addr(0) });
    const pe: FactoryEntry = { name: "pilot", index: pf.index, dollar: addr(0xd011a7), tag: "pilot", factory: pf.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const pr = await new Lister({ reads: new FakeReads(p), sender: new FakeSender(p), factories: [pe], state: new StateStore(tmp()), log: () => {} }).tick(p.t);
    expect(pr.listed.length).toBe(2);
    expect(pr.owed).toEqual([]);
  });

  test("a factory whose pass fails keeps the reserve (what it owes is unknown); a month that can never list does not", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ({ ok: false, error: "IndexStartsAfterMonth(20000, 19990)" }) });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const reads = new FakeReads(w);
    const lister = new Lister({ reads, sender: new FakeSender(w), factories: [entry], state: new StateStore(tmp()), log: () => {} });
    const a = await lister.tick(w.t);
    expect(a.owed).toEqual([]);
    expect(listerOwes(a)).toBe(false);
    reads.gpuIds = async () => {
      throw new Error("a view reverted");
    };
    const b = await lister.tick(w.t + 1n);
    expect(b.errors).toBe(1);
    expect(listerOwes(b)).toBe(true);
  });

  test("the reserve covers at least the gas the sender last planned for each send (a LIMIT row below the chain's estimate)", () => {
    const limits = new LimitTable();
    const fee = 100_000_000_000n;
    const table = listingCostWei(limits, fee);
    expect(listingCostWei(limits, fee, { list: 1n, createMarket: 1n })).toBe(table); // a smaller plan: the table
    const bigList = 10n * BigInt(limits.limitFor("factory.list"));
    expect(listingCostWei(limits, fee, { list: bigList })).toBeGreaterThan(table);
    expect(listingCostWei(limits, fee, { list: bigList }) - table).toBe((bigList - (BigInt(limits.limitFor("factory.list") + 21_000 + 1_200) * 6n + 4n) / 5n) * fee);
  });
});

describe("R1-C3b (findings R1-H1, R1-L2, fixed): a simulated demo morning with daily claims due", () => {
  // The real Budget (B = (balance - keep) / days left, paced hourly), the operator's planned payer funding (450 MON over
  // 11 days, MS 10.4 step 4: B is about 40.9 MON a day), a 200 gwei fee cap, 102 gwei paid (Oct 3), one demo series
  // with 140 daily positions (E10's shape) claimed after every demo day (600 s), and the next month entering the
  // lister's window at 04:00 UTC (a demo month turns) NotReady for its first 6 minutes (MS 2: about 6 min on the demo
  // clock), then ready. Ticks of 30 s for five hours, the lister first in each tick as the app runs it.
  // `legacy` replays the wiring before the fix round (the reserve only while a month was NotReady, no batch wait) so
  // the measured difference stays in the suite.
  interface Morning {
    readyAt: bigint;
    listedAt: bigint | null;
    createdAt: bigint | null;
    claimTxs: number;
    idsPerClaim: number;
    paidIds: number;
    spentWei: bigint;
    unpaidDailyAtEnd: number;
  }
  async function morning(legacy: boolean): Promise<Morning> {
    const w = new FakeWorld();
    const t0 = (w.t / 86_400n) * 86_400n + 4n * 3_600n; // 04:00 UTC
    w.t = t0;
    w.maxFeePerGas = 200_000_000_000n;
    const f = w.addFactory("demo", { gpus: [gpu(0x100)] });
    const s = w.addSeries(f, gpu(0x100), f.month, { n: 31, floor: F, cap: C, startTs: t0, day: 600 });
    f.markets.set(s.address.toLowerCase(), { market: addr(0x777), venue: 1 });
    s.values = Array.from({ length: 31 }, () => 3_600_000n);
    for (let i = 0; i < 140; i++) s.open({ owner: addr(0x500 + i), payee: addr(0x900 + i), side: i % 2 === 0 ? 0 : 1, q: BigInt(20 + (i % 7) * 30) * U, daily: true });
    const readyAt = t0 + 360n;
    f.listing = (_g, month) => (month === f.month + 1 && w.t < readyAt ? { ok: false, error: "NotReady()" } : { ok: true, floor: F, cap: C });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = tmp();
    const budget = new Budget({ dir, role: "payer", keepWei: monToWei(15), lowBalanceWei: monToWei(60), runUntil: Number(t0) + 11 * 86_400, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: w.payer });
    let balance = monToWei(465);
    budget.tick(t0, balance);
    // since midnight the claims have kept the day's spend at its paced line (they spend whatever pacing frees)
    budget.record(paced(budget.today!.budgetWei, t0) - 50_000_000_000_000_000n, false);
    const spent0 = budget.today!.spentWei;
    // the fake sender plans at the 200 gwei cap; the chain bills about 102 gwei (Oct 3): record what it would bill
    const guard: SpendGuard = { canSpend: (c, safety) => budget.canSpend(c, safety), record: (c, safety) => { const paid = (c * 102n) / 200n; balance -= paid; budget.record(paid, safety); } };
    const sender = new FakeSender(w, { guard });
    const state = new StateStore(dir);
    const limits = new LimitTable();
    const lister = new Lister({ reads: new FakeReads(w), sender, factories: [entry], state, log: () => {} });
    let owes = false;
    // the app's wiring (app.ts), or the one before the fix round
    const reserveWei = (fee: bigint) => (owes ? listingCostWei(limits, fee, legacy ? {} : lister.gasSeen) : 0n);
    const view: BudgetView = legacy ? { allowance: () => budget.allowance(), headroom: () => budget.headroom(), spent: (x) => budget.spent(x) } : budget;
    const payer = new Payer({ reads: new FakeReads(w), sender, scanner: new FakeScanner(w), positions: new Positions([entry]), state, limits, config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget: view, reserveWei, log: () => {} });
    let listedAt: bigint | null = null;
    let createdAt: bigint | null = null;
    const next = `${gpu(0x100)}:${f.month + 1}`;
    for (let i = 0; i < 600; i++) {
      w.t = t0 + BigInt(i) * 30n;
      s.finalDays = Math.min(31, Number((w.t - t0) / 600n));
      budget.tick(w.t, balance);
      const rep = await lister.tick(w.t);
      owes = legacy ? rep.waiting.length > 0 : listerOwes(rep);
      if (listedAt === null && f.series.has(next)) listedAt = w.t;
      if (createdAt === null && f.series.has(next) && (f.markets.get(f.series.get(next)!.toLowerCase())?.venue ?? 0) !== 0) createdAt = w.t;
      await payer.tick(w.t);
    }
    const claims = w.sends.filter((x) => x.fn === "claimMany");
    const paidIds = claims.reduce((n, x) => n + (x.args[0] as bigint[]).length, 0);
    let unpaidDailyAtEnd = 0;
    for (const [id] of s.pos) if ((s.claimableOf(id) ?? 0n) >= CENT) unpaidDailyAtEnd++;
    return { readyAt, listedAt, createdAt, claimTxs: claims.length, idsPerClaim: paidIds / Math.max(1, claims.length), paidIds, spentWei: budget.today!.spentWei - spent0, unpaidDailyAtEnd };
  }

  test("before the fix round: the month that turned ready at 04:06 UTC is still unlisted at 09:00 UTC; claims two ids at a time", async () => {
    const r = await morning(true);
    // R1-L2 as measured: a claimMany in most ticks, a few ids each (a 50-id batch costs about half the gas per id)
    expect(r.claimTxs).toBeGreaterThan(400);
    expect(r.idsPerClaim).toBeLessThan(10);
    // R1-H1 as measured: not listed within the five hours after it turned ready (a demo month is about 5.2 hours)
    expect(r.listedAt).toBeNull();
  }, 120_000);

  test("fixed: listed and its market created within minutes of turning ready; claims in full batches, more ids per MON", async () => {
    const legacy = await morning(true);
    const r = await morning(false);
    expect(r.listedAt).not.toBeNull();
    expect(r.listedAt! - r.readyAt).toBeLessThan(3_600n);
    expect(r.createdAt).not.toBeNull();
    expect(r.createdAt! - r.readyAt).toBeLessThan(3_600n);
    // R1-L2: full batches (140 candidates: 50 ids a batch), a fraction of the transactions
    expect(r.idsPerClaim).toBeGreaterThanOrEqual(40);
    expect(r.claimTxs * 5).toBeLessThan(legacy.claimTxs);
    // the same budget pays more positions (both runs spend the day's paced line)
    const perMon = (x: Morning) => (x.paidIds * 1e18) / Number(x.spentWei);
    expect(perMon(r)).toBeGreaterThan(1.25 * perMon(legacy)); // measured 1.35 (1,350 ids for 8.28 MON against 1,031 for 8.54)
    expect(r.paidIds).toBeGreaterThan(legacy.paidIds);
  }, 240_000);
});
