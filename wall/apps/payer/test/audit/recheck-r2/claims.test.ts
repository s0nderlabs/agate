// Recheck round 2 (cold, independent), claiming lens.
//   R2-C1  (finding R2-L1, fixed: whole batches per series) the whole-batch rule of recheck R1-L2 under the budget
//          the operator plans (450 MON over 11 days) with six series whose candidates interleave by size (largest
//          claimable first alternates between series, as it does when several GPUs and months carry daily positions):
//          how long the LARGEST daily position waits for a payment once the day's paced line is spent, against the
//          wiring before R1-L2, and whether every candidate is still paid within the UTC day.
//   R2-C2  a crash between a landed claimMany and its receipt, the restarted payer's scan behind the landing (a
//          finalized tip lags), and a new final day before the restart: the restart pays each payee exactly the new
//          day's increment (PAYER_DRIFT, then the re-read), never the stale offchain amount, never twice.
// Fakes only: no chain, no key, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, CENT, type FactoryEntry, LimitTable, monToWei, paced, type ScanEvent, type SendSpec, type SpendGuard } from "@agate/market";
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
  const d = mkdtempSync(join(tmpdir(), "agate-payer-r2-"));
  dirs.push(d);
  return d;
};

interface Run {
  firstPaidAfterS: number | null; // when the largest position was first paid, seconds after the start
  paidIds: number;
  claimTxs: number;
  spentWei: bigint;
  unpaidAt2300: number; // candidates with claimable >= $0.01 at 23:00 UTC, the hour pacing frees the whole day
}

async function day(wholeBatches: boolean, hours: number): Promise<Run> {
  const w = new FakeWorld();
  const t0 = (w.t / 86_400n) * 86_400n + 10n * 3_600n; // 10:00 UTC
  w.t = t0;
  w.maxFeePerGas = 200_000_000_000n;
  const f = w.addFactory("demo", { gpus: [gpu(0x100), gpu(0x200), gpu(0x300)] });
  const series: FakeSeries[] = [];
  for (let s = 0; s < 6; s++) {
    const x = w.addSeries(f, gpu(0x100 * (1 + (s % 3))), f.month + Math.floor(s / 3), { n: 31, floor: F, cap: C, startTs: t0 - 600n, day: 600 });
    x.values = Array.from({ length: 31 }, () => 3_600_000n);
    series.push(x);
  }
  // 45 daily positions a series, sizes strictly decreasing in the interleaved order (series varies fastest), so the
  // largest-first order alternates between the six series
  let largest: { s: FakeSeries; id: bigint } | null = null;
  for (let i = 0; i < 45; i++) {
    for (let s = 0; s < 6; s++) {
      const id = series[s]!.open({ owner: addr(0x1000 + i * 6 + s), payee: addr(0x9000 + i * 6 + s), side: 0, q: BigInt(3_000 - (i * 6 + s) * 10) * U, daily: true });
      if (largest === null) largest = { s: series[s]!, id };
    }
  }
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const dir = tmp();
  const budget = new Budget({ dir, role: "payer", keepWei: monToWei(15), lowBalanceWei: monToWei(60), runUntil: Number(t0) + 11 * 86_400, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: w.payer });
  let balance = monToWei(465);
  budget.tick(t0, balance);
  // since midnight the claims have kept the day's spend at its paced line
  budget.record(paced(budget.today!.budgetWei, t0) - 10_000_000_000_000_000n, false);
  const spent0 = budget.today!.spentWei;
  const guard: SpendGuard = { canSpend: (c, safety) => budget.canSpend(c, safety), record: (c, safety) => { const paid = (c * 102n) / 200n; balance -= paid; budget.record(paid, safety); } };
  const sender = new FakeSender(w, { guard });
  const view: BudgetView = wholeBatches ? budget : { allowance: () => budget.allowance(), headroom: () => budget.headroom(), spent: (x) => budget.spent(x) };
  const payer = new Payer({ reads: new FakeReads(w), sender, scanner: new FakeScanner(w), positions: new Positions([entry]), state: new StateStore(dir), limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget: view, log: () => {} });
  let firstPaidAfterS: number | null = null;
  const ticks = Math.floor((hours * 3_600) / 30);
  let unpaidAt2300 = -1;
  for (let i = 0; i < ticks; i++) {
    w.t = t0 + BigInt(i) * 30n;
    for (const s of series) s.finalDays = Math.min(31, 1 + Number((w.t - t0) / 600n));
    budget.tick(w.t, balance);
    const before = w.sends.length;
    await payer.tick(w.t);
    if (firstPaidAfterS === null && w.sends.slice(before).some((x) => x.fn === "claimMany" && x.to.toLowerCase() === largest!.s.address.toLowerCase() && (x.args[0] as bigint[]).includes(largest!.id))) firstPaidAfterS = Number(w.t - t0);
    if (w.t === t0 + 13n * 3_600n) {
      unpaidAt2300 = 0;
      for (const s of series) for (const [id] of s.pos) if ((s.claimableOf(id) ?? 0n) >= CENT) unpaidAt2300++;
    }
  }
  const claims = w.sends.filter((x) => x.fn === "claimMany");
  return { firstPaidAfterS, paidIds: claims.reduce((n, x) => n + (x.args[0] as bigint[]).length, 0), claimTxs: claims.length, spentWei: budget.today!.spentWei - spent0, unpaidAt2300 };
}

describe("R2-C1 (finding R2-L1, fixed): the whole-batch rule with six interleaved series under the planned budget", () => {
  test("the largest daily position is paid once one batch fits, not once every series' share does; more positions per MON", async () => {
    const v4 = await day(true, 3);
    const legacy = await day(false, 3);
    console.log(`R2-C1 measured over 3 h from 10:00 UTC: whole batches: largest first paid after ${v4.firstPaidAfterS} s, ${v4.claimTxs} claimMany, ${v4.paidIds} ids, ${Number(v4.spentWei) / 1e18} MON; before the fix: after ${legacy.firstPaidAfterS} s, ${legacy.claimTxs} claimMany, ${legacy.paidIds} ids, ${Number(legacy.spentWei) / 1e18} MON`);
    expect(legacy.firstPaidAfterS).not.toBeNull();
    expect(v4.firstPaidAfterS).not.toBeNull();
    // finding R2-L1, fixed: whole batches per series, not per prefix. Measured with the per-prefix rule: the largest
    // position first paid after 6,870 s (it waited for a prefix in which every series' share was whole, nearly every
    // candidate); now after the time pacing takes to free one series' batch (1,080 s measured: 45 ids and a sync) ...
    expect(v4.firstPaidAfterS!).toBeLessThan(1_800);
    // ... and the same MON still pays about three times the positions of the wiring before R1-L2 (one id a tick)
    const perMon = (x: Run) => (x.paidIds * 1e18) / Number(x.spentWei);
    expect(perMon(v4)).toBeGreaterThan(2.5 * perMon(legacy));
  }, 240_000);

  test("by 23:00 UTC (pacing has freed the whole day) the whole-batch rule has paid every candidate", async () => {
    const v4 = await day(true, 13.5);
    expect(v4.unpaidAt2300).toBe(0);
  }, 600_000);
});

describe("R2-C2: a crash after a landed claimMany, the scan behind it, a new day before the restart", () => {
  test("the restart pays exactly the new day's increment to each payee, once", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo");
    const s = w.addSeries(f, gpu(0x100), f.month, { n: 30, floor: F, cap: C, startTs: w.t, day: 600 });
    s.values = Array.from({ length: 30 }, (_, j) => 3_000_000n + BigInt(j) * 50_000n);
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const payees = Array.from({ length: 12 }, (_, i) => addr(0x7000 + i));
    for (let i = 0; i < 12; i++) s.open({ owner: addr(0x6000 + i), payee: payees[i]!, side: i % 2 === 0 ? 0 : 1, q: BigInt(100 + i * 37) * U, daily: true });
    s.finalDays = 3;
    w.t = s.t.startTs + 3n * 600n + 60n;
    const dir = tmp();
    // round 1: the claimMany lands, then the process dies before it reads the receipt
    const sender = new FakeSender(w);
    const crashing = Object.assign(Object.create(Object.getPrototypeOf(sender)), sender) as FakeSender;
    crashing.send = async (x: SendSpec) => {
      const r = await sender.send(x);
      if (x.functionName === "claimMany") throw new Error("killed after the claimMany landed");
      return r;
    };
    const p1 = new Payer({ reads: new FakeReads(w), sender: crashing, scanner: new FakeScanner(w), positions: new Positions([entry]), state: new StateStore(dir), limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, log: () => {} });
    const bal0 = payees.map((a) => w.balance(a));
    await expect(p1.tick(w.t)).rejects.toThrow("killed");
    const landedBlock = w.block;
    const bal1 = payees.map((a) => w.balance(a));
    expect(bal1.some((b, i) => b > bal0[i]!)).toBe(true); // it did pay
    // a new day turns final before the restart; the restarted scan stops before the landing block (finalized lag)
    s.finalDays = 4;
    w.t += 600n;
    const lagging = new FakeScanner(w);
    lagging.all = () => w.events.filter((e: ScanEvent) => e.block < landedBlock);
    const owedNow = new Map<string, bigint>();
    for (const [id, p] of s.pos) owedNow.set(p.payee.toLowerCase(), s.claimableOf(id)!);
    const alerts: string[] = [];
    const sends0 = w.sends.length;
    const p2 = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner: lagging, positions: new Positions([entry]), state: new StateStore(dir), limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, alerts: { raise: (a: { code: string }) => alerts.push(a.code), clearWhere: () => {} } as never, log: () => {} });
    await p2.tick(w.t);
    expect(alerts).toContain("PAYER_DRIFT"); // the stale offchain paid was caught by the simulation's total
    const claims = w.sends.slice(sends0).filter((x) => x.fn === "claimMany");
    expect(claims.length).toBe(1);
    payees.forEach((a, i) => {
      const got = w.balance(a) - bal1[i]!;
      const want = owedNow.get(a.toLowerCase())!;
      // exactly one day's increment (or nothing when it is under a cent), never round 1's amount again
      expect(got).toBe(want >= CENT ? want : 0n);
    });
    // a third tick in the same day sends nothing: the re-read raised paid in memory
    const n2 = w.sends.length;
    await p2.tick(w.t + 30n);
    expect(w.sends.length).toBe(n2);
  });
});
