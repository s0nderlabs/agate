// BOTS-SPEC 4.3 to 4.6 on the in-memory market: daily rounds (one sync, then claimMany batches of at most 50), the
// threshold, daily = false, the final sweep, the D1 hold, drift, bisection, the budget's largest-first prefix, and a
// restart (from state.json, and from nothing) that pays nobody twice.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink } from "@agate/watcher";
import { CENT, type FactoryEntry, LimitTable, LOT } from "@agate/market";
import { CLAIM_CALLDATA, Payer, SYNC_CALLDATA, type BudgetView } from "../src/payer.ts";
import { Positions } from "../src/positions.ts";
import { StateStore } from "../src/state.ts";
import { addr, FakeReads, FakeScanner, FakeSender, type FakeSeries, FakeWorld, gpu, U } from "./fake/world.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const VALUES = Array.from({ length: 30 }, (_, i) => (i < 10 ? 3_600_000n : 4_200_000n));

interface Rig {
  w: FakeWorld;
  s: FakeSeries;
  entry: FactoryEntry;
  dir: string;
  alerts: AlertSink;
  sender: FakeSender;
  make(o?: { budget?: BudgetView; every?: number }): Payer;
  logs: { event: string; data: Record<string, unknown> }[];
}

function rig(): Rig {
  const w = new FakeWorld();
  const f = w.addFactory("demo");
  const s = w.addSeries(f, gpu(0x100), 24_322, { n: 30, floor: F, cap: C, startTs: w.t, day: 600 });
  s.values = [...VALUES];
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const dir = mkdtempSync(join(tmpdir(), "agate-payer-round-"));
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
  const logs: Rig["logs"] = [];
  const r: Rig = {
    w,
    s,
    entry,
    dir,
    alerts,
    sender: new FakeSender(w),
    logs,
    make(o = {}) {
      return new Payer({
        reads: new FakeReads(w),
        sender: r.sender,
        scanner: new FakeScanner(w),
        positions: new Positions([entry]),
        state: new StateStore(dir),
        limits: new LimitTable(),
        config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: o.every ?? 1 } },
        ...(o.budget ? { budget: o.budget } : {}),
        alerts,
        log: (event, data) => logs.push({ event, data }),
      });
    },
  };
  return r;
}

/** Day k of the series is final (its value applied by previewSync). */
function finalize(r: Rig, k: number): void {
  r.s.finalDays = k;
  r.w.t = r.s.t.startTs + BigInt(k) * 600n + 400n; // inside day k + 1, after day k's finality
}

const claimsOf = (w: FakeWorld) => w.sends.filter((x) => x.fn === "claimMany");

describe("daily claims (4.3)", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  test("after each final day: one sync, then claimMany paying exactly claimable() to each payee; daily = false and sub-cent untouched", async () => {
    const payees = [addr(0xa1), addr(0xa2), addr(0xa3), addr(0xa4), addr(0xa5)];
    const long = r.s.open({ owner: addr(1), payee: payees[0]!, side: 0, q: 720n * U, daily: true });
    const short = r.s.open({ owner: addr(2), payee: payees[1]!, side: 1, q: 720n * U, daily: true });
    const lazy = r.s.open({ owner: addr(3), payee: payees[2]!, side: 0, q: 100n * U, daily: false });
    const dust = r.s.open({ owner: addr(4), payee: payees[3]!, side: 0, q: LOT, daily: true });
    const shortDust = r.s.open({ owner: addr(5), payee: payees[4]!, side: 1, q: LOT, daily: true });
    const p = r.make();
    // nothing final yet: nothing due
    await p.tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    for (let k = 1; k <= 3; k++) {
      finalize(r, k);
      const before = payees.map((a) => r.w.balance(a));
      const want = [long, short, lazy, dust, shortDust].map((id) => r.s.claimableOf(id)!);
      const rep = await p.tick(r.w.t);
      const sends = r.w.sends.slice(-2);
      expect(sends.map((x) => x.fn)).toEqual(["sync", "claimMany"]);
      expect(sends[0]!.c).toBe(1); // sync(kPrev - kState) = sync(1)
      expect(sends[0]!.args[0]).toBe(1n);
      expect(sends[1]!.c).toBe(0); // the batch after the sync makes no index call
      expect(want[1]!).toBeGreaterThan(want[0]!); // at 3.60 a short earns 0.12 a day per token, a long 0.06
      expect(sends[1]!.args[0]).toEqual([short, long]); // largest claimable first
      expect(r.w.balance(payees[0]!) - before[0]!).toBe(want[0]!);
      expect(r.w.balance(payees[1]!) - before[1]!).toBe(want[1]!);
      expect(r.w.balance(payees[2]!)).toBe(before[2]!); // daily = false
      expect(r.w.balance(payees[3]!)).toBe(before[3]!); // under a cent a day
      expect(r.w.balance(payees[4]!)).toBe(before[4]!);
      expect(want[3]!).toBeLessThan(CENT);
      expect(rep.paidIds).toBe(2);
      // the same day again: nothing more
      const n = r.w.sends.length;
      await p.tick(r.w.t + 10n);
      expect(r.w.sends.length).toBe(n);
    }
  });

  test("120 daily positions: one sync and 3 batches of 50, 50 and 20", async () => {
    for (let i = 0; i < 120; i++) r.s.open({ owner: addr(100 + i), payee: addr(1_000 + i), side: 0, q: BigInt(10 + i) * U, daily: true });
    finalize(r, 2);
    const p = r.make();
    await p.tick(r.w.t);
    expect(r.w.sends.map((x) => x.fn)).toEqual(["sync", "claimMany", "claimMany", "claimMany"]);
    expect(r.w.sends[0]!.c).toBe(2);
    expect(claimsOf(r.w).map((x) => x.n)).toEqual([50, 50, 20]);
    for (let i = 0; i < 120; i++) expect(r.s.claimableOf(BigInt(i + 1))).toBe(0n);
  });

  test("a batch over the gas cap is split in two until it fits", async () => {
    for (let i = 0; i < 50; i++) r.s.open({ owner: addr(100 + i), payee: addr(1_000 + i), side: 0, q: BigInt(10 + i) * U, daily: true });
    finalize(r, 1);
    r.sender = new FakeSender(r.w, { capIdsAbove: 20 });
    await r.make().tick(r.w.t);
    expect(claimsOf(r.w).map((x) => x.n)).toEqual([13, 12, 13, 12]);
    for (let i = 0; i < 50; i++) expect(r.s.claimableOf(BigInt(i + 1))).toBe(0n);
  });

  test("a dry run plans the sync and every claimMany batch (their simulation runs the sync), and sends nothing", async () => {
    for (let i = 0; i < 60; i++) r.s.open({ owner: addr(100 + i), payee: addr(1_000 + i), side: 0, q: BigInt(10 + i) * U, daily: true });
    finalize(r, 2);
    const planned: { fn: string; n?: number; c?: number }[] = [];
    const dry = new FakeSender(r.w, { dryRun: true });
    const plan = dry.plan.bind(dry);
    dry.plan = async (s) => {
      planned.push({ fn: s.functionName, ...(s.n !== undefined ? { n: s.n } : {}), ...(s.c !== undefined ? { c: s.c } : {}) });
      return plan(s);
    };
    r.sender = dry;
    const before = Array.from({ length: 60 }, (_, i) => r.s.claimableOf(BigInt(i + 1)));
    await r.make().tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    expect(planned.filter((x) => x.fn === "sync").length).toBe(1);
    const claims = planned.filter((x) => x.fn === "claimMany"); // each batch is planned, then planned again by send
    expect([...new Set(claims.map((x) => x.n))]).toEqual([50, 10]);
    expect(claims.every((x) => x.c === 2)).toBe(true);
    expect(Array.from({ length: 60 }, (_, i) => r.s.claimableOf(BigInt(i + 1)))).toEqual(before);
  });

  test("no sync when someone else already applied the day (c 0 everywhere); claimEveryDays waits that many days", async () => {
    const id = r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    finalize(r, 1);
    r.s.syncN(1); // a stranger's sync
    const p = r.make({ every: 3 });
    await p.tick(r.w.t);
    expect(r.w.sends).toEqual([]); // kPrev 1 < lastClaimK 0 + 3
    finalize(r, 3);
    await p.tick(r.w.t);
    expect(r.w.sends.map((x) => x.fn)).toEqual(["sync", "claimMany"]);
    expect(r.w.sends[0]!.c).toBe(2);
    expect(r.s.claimableOf(id)).toBe(0n);
  });
});

describe("the final sweep (4.4)", () => {
  test("every position with claimable >= $0.01, or q >= 1 token and claimable > 0, is claimed and deleted; dust stays", async () => {
    const r = rig();
    const lazy = r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 100n * U, daily: false });
    const daily = r.s.open({ owner: addr(2), payee: addr(0xa2), side: 1, q: 50n * U, daily: true });
    const oneToken = r.s.open({ owner: addr(3), payee: addr(0xa3), side: 1, q: U, daily: false });
    const dust = r.s.open({ owner: addr(4), payee: addr(0xa4), side: 0, q: LOT, daily: false });
    const p = r.make();
    finalize(r, 30);
    const want = r.s.claimableOf(oneToken)!;
    expect(want).toBeGreaterThan(0n);
    await p.tick(r.w.t);
    expect(r.w.sends.map((x) => x.fn)).toEqual(["sync", "claimMany"]);
    expect(r.w.sends[0]!.c).toBe(30);
    for (const id of [lazy, daily, oneToken]) expect(r.s.pos.has(id)).toBe(false);
    expect(r.w.balance(addr(0xa3))).toBe(want);
    expect(r.s.pos.has(dust)).toBe(true);
    expect(r.s.claimableOf(dust)!).toBeGreaterThan(0n);
    expect(new StateStore(r.dir).data.series[r.s.address.toLowerCase()]!.sweepDone).toBe(true);
    const n = r.w.sends.length;
    await p.tick(r.w.t + 600n);
    expect(r.w.sends.length).toBe(n);
  });
});

describe("the D1 hold (MS 6.6, v2 finding D1)", () => {
  test("past the last resort with head <= d (or no head): nothing sent, PAYER_FORCE_HELD; head past d: paid", async () => {
    const r = rig();
    const id = r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    finalize(r, 1);
    r.w.t = r.s.t.startTs + 600n + r.s.t.lastResort + 1n; // day 1 is past its last resort
    const p = r.make();
    await p.tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    expect(r.alerts.open().map((a) => a.code as string)).toContain("PAYER_FORCE_HELD");
    r.w.heads.set(`${r.entry.index.toLowerCase()}:${r.s.t.gpuId}`, r.s.t.startDay); // head == d: the wall has not closed d
    await p.tick(r.w.t + 1n);
    expect(r.w.sends).toEqual([]);
    r.w.heads.set(`${r.entry.index.toLowerCase()}:${r.s.t.gpuId}`, r.s.t.startDay + 1); // closed: d is final
    // recheck R1-L1: day d + 1 crosses its last resort in 599 s and the wall has not closed it: a claim landing then
    // would force it, so still held
    await p.tick(r.w.t + 2n);
    expect(r.w.sends).toEqual([]);
    // the wall closes every day whose last resort comes within the hour (d + 1 to d + 6; skipped in this fake)
    r.w.heads.set(`${r.entry.index.toLowerCase()}:${r.s.t.gpuId}`, r.s.t.startDay + 7);
    await p.tick(r.w.t + 3n);
    expect(r.w.sends.map((x) => x.fn)).toEqual(["sync", "claimMany"]);
    expect(r.s.claimableOf(id)).toBe(0n);
    expect(r.alerts.open().map((a) => a.code as string)).not.toContain("PAYER_FORCE_HELD");
  });
});

describe("drift and bisection (4.3)", () => {
  test("a claim the scan has not seen yet: PAYER_DRIFT, the ids are re-read, and nobody is paid twice", async () => {
    const r = rig();
    const a = r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    const b = r.s.open({ owner: addr(2), payee: addr(0xa2), side: 0, q: 500n * U, daily: true });
    finalize(r, 1);
    r.s.claim(a); // a stranger's claim...
    const evs = r.w.events.splice(r.w.events.length - 1); // ...that the scanner has not reached
    expect(evs.map((e) => e.name)).toEqual(["Claimed"]);
    const balA = r.w.balance(addr(0xa1));
    const p = r.make();
    await p.tick(r.w.t);
    expect(r.alerts.all().map((x) => x.code as string)).toContain("PAYER_DRIFT");
    expect(r.w.balance(addr(0xa1))).toBe(balA); // a was paid once, by the stranger
    expect(r.s.claimableOf(b)).toBe(0n);
    const last = claimsOf(r.w).at(-1)!;
    expect(last.args[0]).toEqual([b]);
  });

  test("a payee whose transfer reverts: the batch is bisected by simulation, that id skipped (PAYER_BAD_ID) until its payout changes", async () => {
    const r = rig();
    const ids = Array.from({ length: 9 }, (_, i) => r.s.open({ owner: addr(10 + i), payee: addr(0xb0 + i), side: 0, q: BigInt(100 - i) * U, daily: true }));
    r.s.revertPayees.add(addr(0xb0 + 6).toLowerCase());
    finalize(r, 1);
    const p = r.make();
    await p.tick(r.w.t);
    expect(r.alerts.all().map((x) => x.code as string)).toContain("PAYER_BAD_ID");
    expect(claimsOf(r.w).at(-1)!.args[0]).toEqual(ids.filter((_, i) => i !== 6));
    expect(r.s.claimableOf(ids[6]!)!).toBeGreaterThan(0n);
    // next day: still skipped
    finalize(r, 2);
    await p.tick(r.w.t);
    expect((claimsOf(r.w).at(-1)!.args[0] as bigint[]).includes(ids[6]!)).toBe(false);
    // the owner fixes the payee: PayoutChanged clears the mark and the position is paid on its next day
    r.s.revertPayees.clear();
    r.w.mine();
    r.w.emit(r.s.address, "PayoutChanged", { id: ids[6]!, payee: addr(0xb6), daily: true });
    finalize(r, 3);
    await p.tick(r.w.t);
    expect((claimsOf(r.w).at(-1)!.args[0] as bigint[]).includes(ids[6]!)).toBe(true);
    expect(r.s.claimableOf(ids[6]!)).toBe(0n);
  });
});

describe("the budget (4.5)", () => {
  test("a budget that fits 10 ids pays the 10 largest claimables (ties by id); the rest wait; PAYER_BUDGET_SPENT", async () => {
    const r = rig();
    // 30 positions; 25 to 29 tie on q (ties by the lower id)
    const ids = Array.from({ length: 30 }, (_, i) => r.s.open({ owner: addr(10 + i), payee: addr(0xc0 + i), side: 0, q: BigInt(i < 25 ? 10 + i : 40) * U, daily: true }));
    finalize(r, 1);
    const lim = new LimitTable();
    const gas = (limit: number, cd: number) => (BigInt(limit + 21_000 + cd) * 6n + 4n) / 5n;
    const fee = r.w.maxFeePerGas;
    const cost10 = gas(lim.limitFor("series.sync", 1), SYNC_CALLDATA) * fee + gas(lim.limitFor("series.claimMany", 0, 10), CLAIM_CALLDATA(10)) * fee;
    let spent = 0n;
    let alerted = 0;
    const budget: BudgetView = { allowance: () => cost10 - spent, headroom: () => 10n ** 30n, spent: () => alerted++ };
    r.sender = new FakeSender(r.w, { guard: { canSpend: (c) => (c <= cost10 - spent ? { ok: true } : { ok: false, why: "BUDGET" }), record: (c) => (spent += c) } });
    const p = r.make({ budget });
    await p.tick(r.w.t);
    const paid = claimsOf(r.w).flatMap((x) => x.args[0] as bigint[]);
    const want = [...ids.slice(25), ...ids.slice(15, 25).reverse()].slice(0, 10); // the five 40-token ties by id, then 34, 33, ...
    expect(paid).toEqual(want);
    expect(alerted).toBeGreaterThan(0);
    for (const id of ids) if (!want.includes(id)) expect(r.s.claimableOf(id)!).toBeGreaterThan(0n);
  });

  // recheck R1-L2: under pacing, only whole batches (a series' share all its candidates or a multiple of 50), while the
  // day can still pay the first one
  type Costs = { c10: bigint; c30: bigint; claim: (n: number) => bigint; sync: bigint };
  function paced30(o: { allowance: (c: Costs) => bigint; dayLeft: (c: Costs) => bigint; headroom?: (c: Costs) => bigint; n?: number }) {
    const r = rig();
    const ids = Array.from({ length: o.n ?? 30 }, (_, i) => r.s.open({ owner: addr(10 + i), payee: addr(0x1000 + i), side: 0, q: BigInt(10 + i) * U, daily: true }));
    finalize(r, 1);
    const lim = new LimitTable();
    const gas = (limit: number, cd: number) => (BigInt(limit + 21_000 + cd) * 6n + 4n) / 5n;
    const fee = r.w.maxFeePerGas;
    const sync = gas(lim.limitFor("series.sync", 1), SYNC_CALLDATA) * fee;
    const claim = (n: number) => gas(lim.limitFor("series.claimMany", 0, n), CLAIM_CALLDATA(n)) * fee;
    const c: Costs = { c10: sync + claim(10), c30: sync + claim(30), claim, sync };
    const st = { spent: 0n, allowance: o.allowance(c), dayLeft: o.dayLeft(c), headroom: o.headroom?.(c) ?? 10n ** 30n };
    const left = (x: bigint) => (x > st.spent ? x - st.spent : 0n);
    const budget: BudgetView = { allowance: () => left(st.allowance), headroom: () => left(st.headroom), dayLeft: () => left(st.dayLeft), spent: () => {} };
    r.sender = new FakeSender(r.w, { guard: { canSpend: (x) => (x <= left(st.allowance) && x <= left(st.headroom) ? { ok: true } : { ok: false, why: "BUDGET" }), record: (x) => (st.spent += x) } });
    return { r, ids, c, st, p: r.make({ budget }) };
  }

  test("recheck R1-L2: pacing allows 10 of 30 and the day can pay all 30: nothing now, one batch of 30 once it fits", async () => {
    const x = paced30({ allowance: (c) => c.c10, dayLeft: (c) => 2n * c.c30 });
    await x.p.tick(x.r.w.t);
    expect(x.r.w.sends).toEqual([]);
    expect(x.r.logs.some((l) => l.event === "claims_whole_batches" && l.data.fits === 10 && l.data.sent === 0 && l.data.firstWhole === 30)).toBe(true);
    x.st.allowance = x.c.c30; // pacing freed enough for the whole batch
    await x.p.tick(x.r.w.t + 30n);
    expect(x.r.w.sends.map((s) => `${s.fn}:${s.fn === "claimMany" ? (s.args[0] as bigint[]).length : s.c}`)).toEqual(["sync:1", "claimMany:30"]);
    for (const id of x.ids) expect(x.r.s.claimableOf(id)).toBe(0n);
  });

  test("recheck R1-L2: 120 candidates, pacing pays 60: one whole batch of 50 (the 10 more wait for the next whole one)", async () => {
    const x = paced30({ n: 120, allowance: (c) => c.sync + c.claim(50) + c.claim(10) + 1n, dayLeft: (c) => 10n * (c.sync + c.claim(50) * 3n) });
    await x.p.tick(x.r.w.t);
    const batches = claimsOf(x.r.w).map((s) => s.args[0] as bigint[]);
    expect(batches.map((b) => b.length)).toEqual([50]);
    // the largest claimables first: positions opened with q rising by id, so the 50 highest ids
    expect(batches[0]!.map(Number).sort((a, b) => a - b)).toEqual(x.ids.slice(70).map(Number));
    expect(x.r.logs.some((l) => l.event === "claims_whole_batches" && l.data.sent === 50 && l.data.firstWhole === 50)).toBe(true);
  });

  test("recheck R1-L2: what fits goes out when the day cannot pay a full batch, or the floor is what cuts", async () => {
    // the day's budget left pays only the 10: waiting would not help
    const a = paced30({ allowance: (c) => c.c10, dayLeft: (c) => c.c10 + 1n });
    await a.p.tick(a.r.w.t);
    expect(claimsOf(a.r.w).flatMap((s) => s.args[0] as bigint[]).length).toBe(10);
    // the floor's headroom is what cuts (pacing would allow all 30): no wait either
    const b = paced30({ allowance: (c) => 2n * c.c30, dayLeft: (c) => 2n * c.c30, headroom: (c) => c.c10 });
    await b.p.tick(b.r.w.t);
    expect(claimsOf(b.r.w).flatMap((s) => s.args[0] as bigint[]).length).toBe(10);
    // a budget view that cannot say what the day has left (no dayLeft): unchanged, what fits goes out
    const c = paced30({ allowance: (k) => k.c10, dayLeft: (k) => 2n * k.c30 });
    delete (c.p.d.budget as BudgetView).dayLeft;
    await c.p.tick(c.r.w.t);
    expect(claimsOf(c.r.w).flatMap((s) => s.args[0] as bigint[]).length).toBe(10);
  });
});

describe("restart safety (4.6)", () => {
  test("a restart from state.json, and one from nothing, pay nobody twice", async () => {
    const r = rig();
    const ids = Array.from({ length: 5 }, (_, i) => r.s.open({ owner: addr(10 + i), payee: addr(0xd0 + i), side: 0, q: 100n * U, daily: true }));
    finalize(r, 1);
    await r.make().tick(r.w.t);
    const n = r.w.sends.length;
    const bal = ids.map((_, i) => r.w.balance(addr(0xd0 + i)));
    await r.make().tick(r.w.t + 5n); // a fresh process, the same state.json
    expect(r.w.sends.length).toBe(n);
    rmSync(join(r.dir, "state.json"));
    await r.make().tick(r.w.t + 6n); // a fresh process without state.json: claimable is 0 for every id
    expect(r.w.sends.length).toBe(n);
    expect(ids.map((_, i) => r.w.balance(addr(0xd0 + i)))).toEqual(bal);
  });

  test("a landed claimMany the scan has not seen (a crash before the receipt was recorded): the simulation's total is 0, nothing is sent", async () => {
    const r = rig();
    const id = r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    finalize(r, 1);
    r.s.claimMany([id]); // our own claim landed...
    expect(r.w.events.splice(r.w.events.length - 1).map((e) => e.name)).toEqual(["Claimed"]); // ...but neither its receipt nor the scan was recorded
    const bal = r.w.balance(addr(0xa1));
    const p = r.make();
    await p.tick(r.w.t);
    expect(claimsOf(r.w)).toEqual([]);
    expect(r.w.balance(addr(0xa1))).toBe(bal);
  });

  test("the scan still catching up: no round at all", async () => {
    const r = rig();
    r.s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    finalize(r, 1);
    const p = r.make();
    (p.d.scanner as FakeScanner).caughtUp = false;
    await p.tick(r.w.t);
    expect(r.w.sends).toEqual([]);
  });
});
