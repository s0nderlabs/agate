// BOTS-SPEC 4.2: listing windows (NotReady, MonthNotOpen, IndexStartsAfterMonth, other reverts), LISTER_STUCK past
// expectedAt, createMarket after list, idempotence (a second lister sends nothing), the pilot (no Kuru router), the
// hourly retries, and a list race (AlreadyListed in the simulation).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink, RpcDown } from "@agate/watcher";
import { Lister, monthLabel } from "../src/lister.ts";
import { Budget, type FactoryEntry, type ListingCheck, type SendSpec, type SpendGuard } from "@agate/market";
import { StateStore } from "../src/state.ts";
import { addr, type FakeFactory, FakeReads, FakeSender, FakeWorld, ZERO } from "./fake/world.ts";

function rig(o: Partial<FakeFactory> = {}) {
  const w = new FakeWorld();
  const f = w.addFactory("demo", o);
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const dir = mkdtempSync(join(tmpdir(), "agate-payer-lister-"));
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
  const reads = new FakeReads(w);
  const asks = { n: 0 };
  const preview = reads.previewListing.bind(reads);
  reads.previewListing = (...a) => {
    asks.n++;
    return preview(...a);
  };
  const make = (d = dir) => new Lister({ reads, sender: new FakeSender(w), factories: [entry], state: new StateStore(d), alerts, log: () => {} });
  return { w, f, entry, dir, alerts, reads, make, asks };
}

const ready: ListingCheck = { ok: true, floor: 1_800_000n, cap: 7_200_000n };
const codes = (a: AlertSink) => a.open().map((x) => x.code as string);

describe("listing windows (4.2)", () => {
  test("NotReady: nothing sent; LISTER_STUCK only past expectedAt; once ready both months list and their markets are created", async () => {
    const r = rig();
    r.f.firstRecord.set(r.f.gpus[0]!, r.w.epochDay);
    r.f.firstRecord.set(r.f.gpus[1]!, r.w.epochDay);
    const l = r.make();
    r.w.t = r.w.epochTs + 1_000n; // the first record final at + 960, plus 600 s of slack
    let rep = await l.tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    expect(rep.waiting.length).toBe(4);
    expect(codes(r.alerts)).not.toContain("LISTER_STUCK");
    r.w.t = r.w.epochTs + 1_561n;
    await l.tick(r.w.t);
    expect(codes(r.alerts).filter((c) => (c as string) === "LISTER_STUCK").length).toBe(4);
    r.f.listing = () => ready;
    rep = await l.tick(r.w.t + 5n);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["list", "createMarket", "list", "createMarket", "list", "createMarket", "list", "createMarket"]);
    expect(rep.listed).toEqual(["demo H100 2026-10", "demo H100 2026-11", "demo H200 2026-10", "demo H200 2026-11"]);
    expect(rep.created.length).toBe(4);
    for (const s of r.f.series.values()) expect(r.f.markets.get(s.toLowerCase())!.venue).toBe(1);
    expect(codes(r.alerts)).not.toContain("LISTER_STUCK");
  });

  test("alerts of a month that left the window are cleared; LISTER_STUCK's message is stable from tick to tick", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`] });
    r.f.firstRecord.set(r.f.gpus[0]!, r.w.epochDay);
    r.w.t = r.w.epochTs + 5_000n;
    const l = r.make();
    await l.tick(r.w.t);
    await l.tick(r.w.t + 30n);
    const stuck = r.alerts.all().filter((a) => (a.code as string) === "LISTER_STUCK");
    expect(stuck.length).toBe(2);
    expect(stuck.every((a) => a.updated === undefined)).toBe(true); // no rewrite each tick
    r.f.month += 2; // both months left the window
    await l.tick(r.w.t + 60n);
    expect(r.alerts.open().filter((a) => (a.code as string) === "LISTER_STUCK" && !a.id.endsWith(`-${r.f.month}`) && !a.id.endsWith(`-${r.f.month + 1}`))).toEqual([]);
  });

  test("no record at all for a GPU yet: NotReady never raises LISTER_STUCK (the index has not started)", async () => {
    const r = rig();
    r.w.t = r.w.epochTs + 1_000_000n;
    await r.make().tick(r.w.t);
    expect(codes(r.alerts)).toEqual([]);
  });

  test("idempotent: a restarted lister and a second lister (fresh state) send nothing", async () => {
    const r = rig({ listing: () => ready });
    await r.make().tick(r.w.t);
    const n = r.w.sends.length;
    expect(n).toBe(8);
    await r.make().tick(r.w.t + 10n);
    await r.make(mkdtempSync(join(tmpdir(), "agate-payer-lister2-"))).tick(r.w.t + 20n);
    expect(r.w.sends.length).toBe(n);
  });

  test("MonthNotOpen (a month boundary between two reads): wait, no alert", async () => {
    const r = rig({ listing: (_g, m) => ({ ok: false, error: `MonthNotOpen(${m}, ${m + 1})` }) });
    await r.make().tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    expect(codes(r.alerts)).toEqual([]);
  });

  test("IndexStartsAfterMonth: never asked again for that (factory, GPU, month), LISTER_INDEX_STARTS_AFTER once", async () => {
    const r = rig();
    r.f.listing = (_g, m) => (m === r.f.month ? { ok: false, error: `IndexStartsAfterMonth(20800, 20727)` } : ready);
    const l = r.make();
    await l.tick(r.w.t);
    expect(r.asks.n).toBe(4); // two GPUs x two months
    expect(r.w.sends.filter((s) => s.fn === "list").map((s) => monthLabel(s.args[1] as number))).toEqual(["2026-11", "2026-11"]);
    await l.tick(r.w.t + 10n);
    await r.make().tick(r.w.t + 20n); // a restart reads the never-list from state.json
    expect(r.asks.n).toBe(4);
    expect(r.alerts.all().filter((a) => (a.code as string) === "LISTER_INDEX_STARTS_AFTER").length).toBe(2);
    expect(r.alerts.all().find((a) => (a.code as string) === "LISTER_INDEX_STARTS_AFTER")!.severity).toBe("info");
  });

  test("any other revert: LISTER_REFUSED (action), retried after an hour of chain time", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`] });
    r.f.listing = () => ({ ok: false, error: "BadBand(0)" });
    const l = r.make();
    await l.tick(r.w.t);
    expect(r.asks.n).toBe(2);
    expect(r.alerts.open().filter((a) => (a.code as string) === "LISTER_REFUSED").map((a) => a.severity)).toEqual(["action", "action"]);
    await l.tick(r.w.t + 3_599n);
    expect(r.asks.n).toBe(2);
    r.f.listing = () => ready;
    await l.tick(r.w.t + 3_601n);
    expect(r.asks.n).toBe(4);
    expect(r.w.sends.filter((s) => s.fn === "list").length).toBe(2);
    expect(codes(r.alerts)).not.toContain("LISTER_REFUSED");
  });

  test("a list race: AlreadyListed in the simulation is skipped and its market still created", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`] });
    r.f.listing = (g, m) => {
      // previewListing answers ok, then a stranger lists before our send
      if (!r.f.series.has(`${g}:${m}`)) r.w.addSeries(r.f, g, m);
      return ready;
    };
    const l = r.make();
    await l.tick(r.w.t);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["createMarket", "createMarket"]);
    expect(codes(r.alerts)).toEqual([]);
  });

  test("createMarket refused: LISTER_MARKET_REFUSED with the decoded error, retried hourly; MarketAlreadySet is skipped", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`], listing: () => ready, createMarketError: "MarketParamsMismatch()" });
    const l = r.make();
    await l.tick(r.w.t);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["list", "list"]);
    const a = r.alerts.open().filter((x) => (x.code as string) === "LISTER_MARKET_REFUSED");
    expect(a.length).toBe(2);
    expect(a[0]!.message).toContain("MarketParamsMismatch");
    delete r.f.createMarketError;
    await l.tick(r.w.t + 100n);
    expect(r.w.sends.length).toBe(2);
    await l.tick(r.w.t + 3_601n);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["list", "list", "createMarket", "createMarket"]);
    expect(codes(r.alerts)).not.toContain("LISTER_MARKET_REFUSED");
    // someone else set a market meanwhile on a new month: MarketAlreadySet in a simulation is not an alert
    const s = r.w.addSeries(r.f, r.f.gpus[0]!, r.f.month + 5);
    r.f.markets.set(s.address.toLowerCase(), { market: addr(9), venue: 1 });
    await l.tick(r.w.t + 3_700n);
    expect(codes(r.alerts)).toEqual([]);
  });

  test("recheck R1-H1: a ready month the guard refused is owed; LISTER_STUCK past expectedAt, cleared once listed", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`], listing: () => ready });
    r.f.firstRecord.set(r.f.gpus[0]!, r.w.epochDay);
    // the guard refuses every send while the key sits at its floor (since Oct 5 a first listing is a safety send, so the
    // floor is the refusal it can meet)
    let budget = true;
    const guard: SpendGuard = { canSpend: () => (budget ? { ok: false, why: "FLOOR" } : { ok: true }), record: () => {} };
    const l = new Lister({ reads: r.reads, sender: new FakeSender(r.w, { guard }), factories: [r.entry], state: new StateStore(r.dir), alerts: r.alerts, log: () => {} });
    r.w.t = r.w.epochTs + 1_000n; // before expectedAt
    let rep = await l.tick(r.w.t);
    expect(r.w.sends).toEqual([]);
    expect(rep.waiting).toEqual([]); // ready, not NotReady
    expect(rep.owed).toEqual(["demo H100 2026-10", "demo H100 2026-11"]);
    expect(codes(r.alerts)).toEqual([]); // not late yet: the refusal alone is no alert
    r.w.t = r.w.epochTs + 1_561n; // past expectedAt
    rep = await l.tick(r.w.t);
    const stuck = r.alerts.open().filter((a) => (a.code as string) === "LISTER_STUCK");
    expect(stuck.length).toBe(2);
    expect(stuck[0]!.severity).toBe("action");
    expect(stuck[0]!.message).toContain("floor");
    budget = false;
    rep = await l.tick(r.w.t + 30n);
    expect(rep.listed.length).toBe(2);
    expect(rep.created.length).toBe(2);
    expect(rep.owed).toEqual([]);
    expect(codes(r.alerts)).not.toContain("LISTER_STUCK");
  });

  test("Oct 5: a listing is a safety send, so the real budget's day (paced, below one listing) never holds it; the floor does", async () => {
    const MON = 10n ** 18n;
    const budgetOf = (r: ReturnType<typeof rig>, balance: bigint) => {
      const b = new Budget({ dir: r.dir, role: "payer", keepWei: 15n * MON, lowBalanceWei: 0n, runUntil: Number(r.w.t) + 1_000 * 86_400, alerts: r.alerts, lowCode: "PAYER_KEY_LOW", spentCode: "PAYER_BUDGET_SPENT", address: addr(0xbee) });
      b.tick(r.w.t, balance);
      return b;
    };
    // 5 MON above the floor over 1,000 days: B = 0.005 MON, far below one listing, yet both months and markets go out
    const r = rig({ gpus: [addr(0x100) as `0x${string}`], listing: () => ready });
    r.f.firstRecord.set(r.f.gpus[0]!, r.w.epochDay);
    r.w.t = r.w.epochTs + 1_561n; // past expectedAt
    const b = budgetOf(r, 20n * MON);
    expect(b.canSpend(10n ** 17n, false)).toEqual({ ok: false, why: "BUDGET" }); // what a claim would meet
    const l = new Lister({ reads: r.reads, sender: new FakeSender(r.w, { guard: b }), factories: [r.entry], state: new StateStore(r.dir), alerts: r.alerts, log: () => {} });
    const rep = await l.tick(r.w.t);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["list", "createMarket", "list", "createMarket"]);
    expect(rep.owed).toEqual([]);
    expect(b.today!.safetyWei).toBeGreaterThan(0n);
    expect(b.today!.safetyWei).toBe(b.today!.spentWei); // it still counts in the day's spend
    expect(codes(r.alerts)).not.toContain("LISTER_STUCK");

    // 0.1 MON above the floor: the floor refuses the list; past expectedAt LISTER_STUCK names the floor
    const q = rig({ gpus: [addr(0x100) as `0x${string}`], listing: () => ready });
    q.f.firstRecord.set(q.f.gpus[0]!, q.w.epochDay);
    q.w.t = q.w.epochTs + 1_561n;
    const low = budgetOf(q, 15n * MON + 10n ** 17n);
    const ql = new Lister({ reads: q.reads, sender: new FakeSender(q.w, { guard: low }), factories: [q.entry], state: new StateStore(q.dir), alerts: q.alerts, log: () => {} });
    const qrep = await ql.tick(q.w.t);
    expect(q.w.sends).toEqual([]);
    expect(qrep.owed).toEqual(["demo H100 2026-10", "demo H100 2026-11"]);
    const stuck = q.alerts.open().filter((a) => (a.code as string) === "LISTER_STUCK");
    expect(stuck.length).toBe(2);
    expect(stuck[0]!.message).toContain("floor");
  });

  test("Oct 5: a list or createMarket that reverted onchain is retried under the day's budget until its slot fills", async () => {
    const r = rig({ gpus: [addr(0x100) as `0x${string}`], listing: () => ready });
    const seen: { fn: string; safety: boolean }[] = [];
    const revert = new Set(["list", "createMarket"]); // the first try of each reverts onchain (Monad bills its gas)
    class Reverts extends FakeSender {
      override async send(s: SendSpec) {
        seen.push({ fn: s.functionName, safety: s.safety === true });
        if (revert.has(s.functionName)) {
          revert.delete(s.functionName);
          return { ok: false, sent: true, txHash: `0x${"cd".repeat(32)}` as `0x${string}`, gasLimit: 1n, error: "reverted onchain" };
        }
        return super.send(s);
      }
    }
    const state = new StateStore(r.dir);
    const l = new Lister({ reads: r.reads, sender: new Reverts(r.w), factories: [r.entry], state, alerts: r.alerts, log: () => {} });
    await l.tick(r.w.t);
    // the current month's list reverted; the next month's list went through as a safety send, then its createMarket reverted
    expect(seen).toEqual([
      { fn: "list", safety: true },
      { fn: "list", safety: true },
      { fn: "createMarket", safety: true },
    ]);
    expect(state.data.budgetBound.length).toBe(2);
    seen.length = 0;
    await l.tick(r.w.t + 3_601n); // past the retry hour: both retries are the budget's
    expect(seen).toEqual([
      { fn: "list", safety: false },
      { fn: "createMarket", safety: true }, // a first try for the series just listed
      { fn: "createMarket", safety: false },
    ]);
    expect(state.data.budgetBound).toEqual([]); // every slot filled: nothing stays bound
    expect(new StateStore(r.dir).data.budgetBound).toEqual([]); // and that was saved
  });

  test("the pilot factory (no Kuru router) lists and never creates a market", async () => {
    const r = rig({ kuruRouter: ZERO, listing: () => ready });
    await r.make().tick(r.w.t);
    expect(r.w.sends.map((s) => s.fn)).toEqual(["list", "list", "list", "list"]);
  });

  test("no answer from the RPC: the tick fails with RpcDown and nothing is sent (the next tick asks again)", async () => {
    const r = rig({ listing: () => ready });
    r.reads.failNext = new RpcDown("every RPC URL failed: down");
    await expect(r.make().tick(r.w.t)).rejects.toBeInstanceOf(RpcDown);
    expect(r.w.sends).toEqual([]);
  });
});
