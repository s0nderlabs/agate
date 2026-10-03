// The Oct 3 code review's findings on the payer and the lister (phase 3 checkpoint), each fixed:
//   1. claimBatch reported "budget" whenever its id list shrank, also after a bisection or a drift re-read, which
//      stopped every later batch and series of the tick;
//   3. a scan that starts over while running (MarketScanner.reset: a chain reset under the cursor) left Positions
//      indexing into the old list and the old series in withOpen();
//   4. a list or createMarket that ended NONCE_STUCK was treated as refused ("reverted onchain", an hour of waiting);
//   6. a dry run ticked the MON budget (a frozen budget file, PAYER_KEY_LOW).
// Fakes only: no chain, no key, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink } from "@agate/watcher";
import { CENT, type FactoryEntry, LimitTable, type ListingCheck, type ScanEvent, type SendSpec } from "@agate/market";
import { Lister } from "../src/lister.ts";
import { type BudgetView, Payer } from "../src/payer.ts";
import { Positions } from "../src/positions.ts";
import { StateStore } from "../src/state.ts";
import { addr, FakeReads, FakeScanner, FakeSender, type FakeSeries, FakeWorld, gpu, U } from "./fake/world.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-payer-review-"));
  dirs.push(d);
  return d;
};
const open = { allowance: () => 10n ** 30n, headroom: () => 10n ** 30n, spent: () => {} } satisfies BudgetView;
const claimsTo = (w: FakeWorld, s: FakeSeries) => w.sends.filter((x) => x.fn === "claimMany" && x.to.toLowerCase() === s.address.toLowerCase());

function world(n = 30) {
  const w = new FakeWorld();
  const f = w.addFactory("demo");
  const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
  const mk = (g: number) => {
    const s = w.addSeries(f, gpu(g), 24_322, { n, floor: F, cap: C, startTs: w.t, day: 600 });
    s.values = Array.from({ length: n }, () => 3_600_000n);
    return s;
  };
  return { w, f, entry, mk };
}

describe("finding 1: only the budget's own cut stops the round", () => {
  test("a bad id in series A's batch: A's other ids and series B are paid in the same tick", async () => {
    const { w, entry, mk } = world();
    const a = mk(0x100);
    const b = mk(0x200);
    // A's positions are larger, so A's batch goes first
    const aIds = Array.from({ length: 10 }, (_, i) => a.open({ owner: addr(0x10 + i), payee: addr(0xa0 + i), side: 0, q: BigInt(500 - i) * U, daily: true }));
    const bIds = Array.from({ length: 10 }, (_, i) => b.open({ owner: addr(0x30 + i), payee: addr(0xc0 + i), side: 0, q: BigInt(100 - i) * U, daily: true }));
    a.revertPayees.add(addr(0xa3).toLowerCase());
    for (const s of [a, b]) s.finalDays = 1;
    w.t = a.t.startTs + 600n + 400n;
    const dir = tmp();
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    const state = new StateStore(dir);
    const p = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner: new FakeScanner(w), positions: new Positions([entry]), state, limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget: open, alerts, log: () => {} });
    await p.tick(w.t);
    expect(alerts.open().map((x) => x.code as string)).toContain("PAYER_BAD_ID");
    // before the fix: A's 9 ids landed, the shrink read as "budget", and B waited for the next tick
    expect(claimsTo(w, a).at(-1)!.args[0]).toEqual(aIds.filter((_, i) => i !== 3));
    expect(claimsTo(w, b).length).toBe(1);
    for (const id of bIds) expect(b.claimableOf(id)).toBe(0n);
    // both rounds are done: the day is claimed for A too (its bad id waits for a PayoutChanged)
    expect(state.data.series[a.address.toLowerCase()]!.lastClaimK).toBe(1);
    expect(state.data.series[b.address.toLowerCase()]!.lastClaimK).toBe(1);
  });

  test("in the final sweep a bad id found this round keeps the sweep open (it still qualifies)", async () => {
    const { w, entry, mk } = world(3);
    const a = mk(0x100);
    const ids = Array.from({ length: 4 }, (_, i) => a.open({ owner: addr(0x10 + i), payee: addr(0xa0 + i), side: 0, q: BigInt(50 + i) * U, daily: false }));
    a.revertPayees.add(addr(0xa1).toLowerCase());
    a.finalDays = 3;
    w.t = a.t.startTs + 3n * 600n + 400n;
    const dir = tmp();
    const state = new StateStore(dir);
    const p = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner: new FakeScanner(w), positions: new Positions([entry]), state, limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, budget: open, log: () => {} });
    await p.tick(w.t);
    expect([...(claimsTo(w, a).at(-1)!.args[0] as bigint[])].sort()).toEqual(ids.filter((_, i) => i !== 1).sort());
    expect(state.data.series[a.address.toLowerCase()]?.sweepDone ?? false).toBe(false);
    // the payee is fixed: its PayoutChanged clears the mark, and the sweep pays it and is done
    a.revertPayees.clear();
    w.mine();
    w.emit(a.address, "PayoutChanged", { id: ids[1]!, payee: addr(0xa1), daily: false });
    await p.tick(w.t + 30n);
    expect(a.pos.has(ids[1]!)).toBe(false); // a final claim deletes the position
    expect(state.data.series[a.address.toLowerCase()]!.sweepDone).toBe(true);
  });
});

describe("finding 3: a scan that starts over rebuilds the positions", () => {
  test("after a reset the old series are gone, the new list is applied from index 0, state.json is set aside", async () => {
    const { w, entry, mk } = world();
    const a = mk(0x100);
    for (let i = 0; i < 6; i++) a.open({ owner: addr(0x10 + i), payee: addr(0xa0 + i), side: 0, q: BigInt(100 + i) * U, daily: true });
    const cut = w.events.length; // everything up to here is "the old chain"
    const b = mk(0x200);
    const bIds = Array.from({ length: 2 }, (_, i) => b.open({ owner: addr(0x30 + i), payee: addr(0xc0 + i), side: 0, q: BigInt(200 + i) * U, daily: true }));
    const evs = [...w.events];
    const oldChain = evs.slice(0, cut);
    const newChain = evs.slice(cut);
    const scanner = Object.assign(new FakeScanner(w), { epoch: 0 });
    let list: readonly ScanEvent[] = oldChain;
    scanner.all = () => list;
    const dir = tmp();
    const state = new StateStore(dir);
    const positions = new Positions([entry]);
    const logs: string[] = [];
    const p = new Payer({ reads: new FakeReads(w), sender: new FakeSender(w), scanner, positions, state, limits: new LimitTable(), config: { claimThresholdU: CENT, maxIdsPerCall: 50, claimEveryDays: { demo: 1 } }, log: (e) => logs.push(e) });
    for (const s of [a, b]) s.finalDays = 1;
    w.t = a.t.startTs + 600n + 400n;
    await p.tick(w.t);
    expect(positions.withOpen().map((s) => s.series as string)).toEqual([a.address.toLowerCase()]);
    state.save();
    expect(state.data.series[a.address.toLowerCase()]).toBeDefined();
    // the chain is reset under the cursor: the scan starts over with a new (here shorter) event list. B's listing is in
    // the factory's own SeriesListed, which the new list must carry
    const listed = evs.find((e) => e.name === "SeriesListed" && e.series === b.address.toLowerCase())!;
    expect(newChain[0]).toBe(listed);
    scanner.epoch = 1;
    list = newChain;
    await p.tick(w.t + 30n);
    expect(logs).toContain("positions_reset");
    // before the fix: 6+ old events applied, so the new list's first entries (B's listing and positions) were skipped,
    // and A stayed in withOpen()
    expect(positions.withOpen().map((s) => s.series as string)).toEqual([b.address.toLowerCase()]);
    for (const id of bIds) expect(b.claimableOf(id)).toBe(0n);
    expect(state.data.series[a.address.toLowerCase()]).toBeUndefined();
    expect(readdirSync(dir).some((x) => x.startsWith("state.stale-"))).toBe(true);
  });
});

describe("finding 4: a NONCE_STUCK list or createMarket is not a refusal", () => {
  const ready: ListingCheck = { ok: true, floor: F, cap: C };
  test("no LISTER_REFUSED / LISTER_MARKET_REFUSED, no retry hour: the next tick looks again", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ready });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = tmp();
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    class Stuck extends FakeSender {
      stuck = new Set(["list"]);
      override async send(s: SendSpec) {
        if (this.stuck.has(s.functionName)) return { ok: false, sent: true, txHash: `0x${"ab".repeat(32)}` as `0x${string}`, gasLimit: 1n, error: "NONCE_STUCK" };
        return super.send(s);
      }
    }
    const sender = new Stuck(w);
    const state = new StateStore(dir);
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const lister = new Lister({ reads: new FakeReads(w), sender, factories: [entry], state, alerts, log: (event, data) => logs.push({ event, data }) });
    const r1 = await lister.tick(w.t);
    const codes = () => alerts.open().map((x) => x.code as string);
    expect(codes()).not.toContain("LISTER_REFUSED");
    expect(state.data.retryAt).toEqual({});
    expect(r1.owed.length).toBe(2); // still owed: it may land, or be sent again
    expect(logs.filter((l) => l.event === "list_skipped" && l.data.error === "NONCE_STUCK").length).toBe(2);
    // the list goes through next tick; then the createMarket sticks the same way
    sender.stuck = new Set(["createMarket"]);
    await lister.tick(w.t + 5n);
    expect(codes()).not.toContain("LISTER_MARKET_REFUSED");
    expect(state.data.marketRetryAt).toEqual({});
    sender.stuck = new Set();
    const r3 = await lister.tick(w.t + 10n);
    expect(r3.created.length).toBe(2);
    // a real revert (a receipt with a revert status) is still a refusal, with an honest text
    const w2 = new FakeWorld();
    const f2 = w2.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ready });
    const e2: FactoryEntry = { ...entry, index: f2.index, factory: f2.address };
    class Reverts extends FakeSender {
      override async send(s: SendSpec) {
        if (s.functionName === "list") return { ok: false, sent: true, txHash: `0x${"cd".repeat(32)}` as `0x${string}`, gasLimit: 1n, error: "reverted onchain" };
        return super.send(s);
      }
    }
    const a2 = new AlertSink(join(tmp(), "alerts.jsonl"), { now: () => Number(w2.t), print: false });
    await new Lister({ reads: new FakeReads(w2), sender: new Reverts(w2), factories: [e2], state: new StateStore(tmp()), alerts: a2, log: () => {} }).tick(w2.t);
    const refused = a2.open().filter((x) => (x.code as string) === "LISTER_REFUSED");
    expect(refused.length).toBe(2);
    expect(refused[0]!.message).toContain("reverted onchain (0xcdcd");
  });
});

describe("finding 6: a dry run never ticks the MON budget", () => {
  test("buildApp in a dry run writes no budget file and raises no PAYER_KEY_LOW", async () => {
    const { buildApp } = await import("../src/app.ts");
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [gpu(0x100)] });
    const dir = tmp();
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    const reads = Object.assign(new FakeReads(w), { blockTime: async () => w.t, monBalance: async () => 0n, indexClocks: async () => ({ day: 600, closeGrace: 60, tPend: 210 }) });
    const rt = {
      role: "payer",
      dryRun: true,
      keyVar: null,
      from: addr(0xfee),
      home: dir,
      dir,
      lockFd: null,
      alerts,
      pool: { chainId: 10143, tick: async () => {}, call: async () => { throw new Error("no RPC in this test"); }, redactedUrls: () => [] },
      endpoints: { http: [], ws: [] },
      deployments: { chainId: 10143, dollar: addr(0xd011a7), kuru: { router: addr(0x4b55), marginAccount: addr(0x3a) }, factories: { demo: { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n } } },
      reads,
      limits: new LimitTable(),
      maxFeeGwei: 200,
      sendLock: { acquire: async () => ({ otherHolder: false }), release: () => {} },
    };
    const { parseConfig } = await import("../src/config.ts");
    const app = await buildApp(rt as never, parseConfig({ payer: false, tickS: 30 }), { now: () => Number(w.t), log: () => {} });
    await app.tick({ lister: false });
    expect(readdirSync(dir).filter((x) => x.startsWith("budget-"))).toEqual([]);
    expect(alerts.open().map((x) => x.code as string)).not.toContain("PAYER_KEY_LOW");
    expect(existsSync(join(dir, "heartbeat.json"))).toBe(true);
  });
});
