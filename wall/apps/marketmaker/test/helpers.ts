// A fake world with one demo factory, one GPU and a listed month on a FakeKuru book, and a maker over it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex, keccak256, parseEther, toBytes } from "viem";
import { AlertSink } from "@agate/watcher";
import { Budget, type Deployments, U } from "@agate/market";
import { parseConfig } from "../src/config.ts";
import { FakeReads, FakeSender, fakeAddress, FakeWorld, type FakeFactory, type FakeIndex, type FakeKuru, type FakeSeries } from "../src/fake/index.ts";
import { MarketMaker } from "../src/mm.ts";

export const H100 = keccak256(toBytes("H100-SXM/on-demand-list/neocloud/v1")) as Hex;
export const DAY = 86_400;
export const START_DAY = 20_758; // 2026-11-01
export const MONTH = 2026 * 12 + 10; // November 2026
export const F = 1_800_000n;
export const C = 7_200_000n;
export const REF = 3_600_000n;

export interface Rig {
  w: FakeWorld;
  ix: FakeIndex;
  f: FakeFactory;
  s: FakeSeries;
  k: FakeKuru;
  maker: Address;
  user: Address;
  reads: FakeReads;
  sender: FakeSender;
  mm: MarketMaker;
  dir: string;
  deployments: Deployments;
  alerts: AlertSink;
  budget: Budget;
  clock: { ms: number };
  /** a fresh maker over the same world and dir (a restart) */
  restart(): MarketMaker;
  tick(): ReturnType<MarketMaker["tick"]>;
  cleanup(): void;
  today(): number;
  putDays(value: bigint, upTo?: number): void;
}

export function rig(o: { config?: Record<string, unknown>; daysBefore?: number; budget?: boolean; mon?: bigint } = {}): Rig {
  const w = new FakeWorld();
  const ix = w.addIndex();
  const f = w.addFactory(ix);
  f.data.month = MONTH - 1;
  f.data.labels.set(H100.toLowerCase(), "H100");
  const startTs = BigInt(START_DAY * DAY);
  const { series: s, kuru: k } = w.list(f, H100, MONTH, { startDay: START_DAY, startTs, n: 30, floor: F, cap: C });
  w.t = startTs - BigInt((o.daysBefore ?? 10) * DAY) + 3_600n;
  const maker = fakeAddress(11);
  const user = fakeAddress(12);
  w.setMon(maker, o.mon ?? parseEther("200"));
  w.mintTo(w.dollar, maker, 10_000_000n * U);
  w.mintTo(w.dollar, user, 100_000n * U);
  const dir = mkdtempSync(join(tmpdir(), "agate-mm-test-"));
  const deployments: Deployments = {
    chainId: 10143,
    dollar: w.dollar,
    kuru: { router: w.kuruRouter, marginAccount: w.ma },
    factories: { demo: { name: "demo", index: ix.address, dollar: w.dollar, tag: "demo", factory: f.address, router: f.router, tPend: 21_600, startBlock: 0n } },
  };
  const config = parseConfig(JSON.stringify({ factories: ["demo"], runUntil: "2026-12-31T00:00:00Z", ...(o.config ?? {}) }));
  const clock = { ms: 1_000_000 };
  const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
  const budget = new Budget({ dir, role: "marketmaker", keepWei: config.keepWei, lowBalanceWei: config.lowBalanceWei, runUntil: config.runUntil, lowCode: "MM_KEY_LOW", spentCode: "MM_BUDGET_SPENT", address: maker, headStartS: config.headStartS });
  const reads = new FakeReads(w);
  let mm!: MarketMaker;
  const sender = new FakeSender(w, maker, { guard: { canSpend: (c, safety) => mm.canSpend(c, safety), record: (c, safety) => mm.record(c, safety) } });
  const make = () =>
    new MarketMaker({ reads, sender, deployments, config, dir, alerts, ...(o.budget === false ? {} : { budget }), nowMs: () => clock.ms });
  mm = make();
  const r: Rig = {
    w,
    ix,
    f,
    s,
    k,
    maker,
    user,
    reads,
    sender,
    mm,
    dir,
    deployments,
    alerts,
    budget,
    clock,
    restart() {
      mm = make();
      r.mm = mm;
      return mm;
    },
    tick() {
      clock.ms += 60_000;
      return r.mm.tick();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
    today() {
      return Math.floor(Number(w.t) / DAY);
    },
    putDays(value: bigint, upTo?: number) {
      const last = upTo ?? r.today() - 1;
      for (let d = last - 40; d <= last; d++) ix.put(H100, d, value, true);
    },
  };
  r.putDays(REF);
  return r;
}

/** The maker's resting orders on the fake book, by Kuru's own status rule. */
export function makerBook(r: Rig): { bids: [bigint, bigint][]; asks: [bigint, bigint][] } {
  const bids: [bigint, bigint][] = [];
  const asks: [bigint, bigint][] = [];
  for (const [id, o] of r.k.data.orders) {
    if (o.owner.toLowerCase() !== r.maker.toLowerCase() || r.k.status(id) !== "ACTIVE") continue;
    (o.isBuy ? bids : asks).push([o.price, o.size]);
  }
  bids.sort((a, b) => (a[0] > b[0] ? -1 : 1));
  asks.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { bids, asks };
}
