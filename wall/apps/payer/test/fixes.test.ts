// Audit fixes of the payer and lister that have no audit test of their own: a front-run list
// or createMarket clears its alerts (P-L1), the lister's reserve in the claims' budget (P-L2).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink } from "@agate/watcher";
import { BROADCAST_UNCONFIRMED, CENT, type FactoryEntry, LimitTable, type ListingCheck, type SendSpec } from "@agate/market";
import { listingCostWei } from "../src/app.ts";
import { Lister } from "../src/lister.ts";
import { type BudgetView, Payer } from "../src/payer.ts";
import { Positions } from "../src/positions.ts";
import { StateStore } from "../src/state.ts";
import { addr, type FakeFactory, FakeReads, FakeScanner, FakeSender, FakeWorld, gpu, U } from "./fake/world.ts";

const ready: ListingCheck = { ok: true, floor: 1_800_000n, cap: 7_200_000n };
const codes = (a: AlertSink) => a.open().map((x) => x.code as string);

function listerRig(o: Partial<FakeFactory> = {}) {
  const w = new FakeWorld();
  const f = w.addFactory("demo", { gpus: [addr(0x100) as `0x${string}`], ...o });
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const dir = mkdtempSync(join(tmpdir(), "agate-payer-fixes-"));
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
  const lister = new Lister({ reads: new FakeReads(w), sender: new FakeSender(w), factories: [entry], state: new StateStore(dir), alerts, log: () => {} });
  return { w, f, alerts, lister };
}

describe("P-L1: a filled slot clears the lister's refusals", () => {
  test("LISTER_REFUSED clears as soon as a stranger lists the month (not two months later)", async () => {
    const r = listerRig();
    r.f.listing = () => ({ ok: false, error: "BadBand(0)" });
    await r.lister.tick(r.w.t);
    expect(codes(r.alerts).filter((c) => c === "LISTER_REFUSED").length).toBe(2);
    r.w.addSeries(r.f, r.f.gpus[0]!, r.f.month); // a stranger listed the current month
    await r.lister.tick(r.w.t + 10n); // within the hour of retry
    expect(codes(r.alerts).filter((c) => c === "LISTER_REFUSED").length).toBe(1); // only next month's is left
  });

  test("LISTER_MARKET_REFUSED clears once the market exists, whoever made it", async () => {
    const r = listerRig({ listing: () => ready, createMarketError: "MarketParamsMismatch()" });
    await r.lister.tick(r.w.t);
    expect(codes(r.alerts).filter((c) => c === "LISTER_MARKET_REFUSED").length).toBe(2);
    for (const s of r.f.series.values()) r.f.markets.set(s.toLowerCase(), { market: addr(0x99), venue: 1 }); // the admin attached
    await r.lister.tick(r.w.t + 10n);
    expect(codes(r.alerts)).not.toContain("LISTER_MARKET_REFUSED");
  });
});

describe("M-M3 in the lister: a broadcast whose outcome is unknown is not a refusal", () => {
  test("no LISTER_REFUSED and no hour of waiting: the next tick's view shows whether it landed", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [addr(0x100) as `0x${string}`], listing: () => ready });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = mkdtempSync(join(tmpdir(), "agate-payer-fixes-"));
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    class Lost extends FakeSender {
      lost = true;
      override async send(s: SendSpec) {
        if (this.lost && s.functionName === "list") return { ok: false, sent: true, error: `${BROADCAST_UNCONFIRMED}: every RPC URL failed` };
        return super.send(s);
      }
    }
    const sender = new Lost(w);
    const state = new StateStore(dir);
    const lister = new Lister({ reads: new FakeReads(w), sender, factories: [entry], state, alerts, log: () => {} });
    await lister.tick(w.t);
    expect(codes(alerts)).not.toContain("LISTER_REFUSED");
    expect(state.data.retryAt).toEqual({});
    sender.lost = false;
    await lister.tick(w.t + 5n);
    expect(w.sends.filter((x) => x.fn === "list").length).toBe(2);
  });
});

describe("P-L2: while a month waits to be listed, the claims leave one listing's cost to the lister", () => {
  test("listingCostWei is list plus createMarket at 1.2 x (LIMIT + 21,000 + calldata), times the fee", () => {
    const lim = new LimitTable();
    const fee = 200_000_000_000n;
    const one = (l: number, cd: number) => (BigInt(l + 21_000 + cd) * 6n + 4n) / 5n;
    expect(listingCostWei(lim, fee)).toBe((one(3_609_379, 1_200) + one(1_247_597, 700)) * fee);
    expect(listingCostWei(lim, fee) / 10n ** 18n).toBe(1n); // about 1.17 MON at the 200 gwei cap
  });

  test("a budget that fits the claims only without the reserve: nothing is selected while the reserve applies", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo");
    const s = w.addSeries(f, gpu(0x100), 24_322, { n: 30, floor: 1_800_000n, cap: 7_200_000n, startTs: w.t, day: 600 });
    s.values = Array.from({ length: 30 }, () => 3_600_000n);
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = mkdtempSync(join(tmpdir(), "agate-payer-fixes-"));
    s.open({ owner: addr(1), payee: addr(0xa1), side: 0, q: 720n * U, daily: true });
    s.finalDays = 1;
    w.t = s.t.startTs + 600n + 400n;
    const allowance = 10n ** 18n; // 1 MON: plenty for one sync and one claim
    const budget: BudgetView = { allowance: () => allowance, headroom: () => 10n ** 30n, spent: () => {} };
    let reserve = allowance; // a listing waits and needs it all
    const p = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner: new FakeScanner(w), positions: new Positions([entry]), state: new StateStore(dir), limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget, reserveWei: () => reserve, log: () => {} });
    const a = await p.tick(w.t);
    expect(a.selected).toBe(0);
    expect(w.sends).toEqual([]);
    reserve = 0n; // listed: the reserve is released
    const b = await p.tick(w.t + 1n);
    expect(b.selected).toBe(1);
    expect(w.sends.map((x) => x.fn)).toEqual(["sync", "claimMany"]);
  });
});
