// Audit fixes that have no audit test of their own: one dollar for every configured factory
// (M-L1), recovery and orphan books beyond the quotable months (M-L4), a state file of another chain set aside (P-M3,
// for the maker too), and a settle refused GAS_CAP preceded by sync chunks (P-M1).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SendResult, SendSpec } from "@agate/market";
import { MakerConfigError, MarketMaker } from "../src/mm.ts";
import { DAY, H100, makerBook, MONTH, REF, type Rig, rig, START_DAY } from "./helpers.ts";

let r: Rig;
afterEach(() => r?.cleanup());
const lc = (a: string) => a.toLowerCase();

describe("M-L1: the maker refuses a configured factory that settles in another dollar", () => {
  test("a factory whose dollar is not the deployments file's is refused at start; one left out of factories is fine", () => {
    r = rig();
    const other = { ...r.deployments, factories: { ...r.deployments.factories, pilot: { ...r.deployments.factories.demo!, name: "pilot", dollar: "0x00000000000000000000000000000000000005dc" as const } } };
    expect(() => new MarketMaker({ ...r.mm.d, deployments: other, config: { ...r.mm.d.config, factories: ["demo", "pilot"] } })).toThrow(MakerConfigError);
    expect(() => new MarketMaker({ ...r.mm.d, deployments: other, config: { ...r.mm.d.config, factories: ["demo"] } })).not.toThrow();
  });
});

describe("M-L4: recovery and orphan books beyond the quotable months", () => {
  test("no state file and the series' month already past the quotable window: its book is scanned and cancelled", async () => {
    r = rig();
    await r.tick();
    expect(makerBook(r).bids.length).toBe(3);
    r.f.data.month = MONTH + 1; // the series is now last month's (m - 1): not quotable
    rmSync(join(r.dir, "state.json"));
    r.restart();
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    expect(Object.keys(r.mm.state.series)).toContain(lc(r.s.address)); // held: it is wound down and settled later
  });

  test("an orphan book (its series not held any more) is cancelled, not only logged", async () => {
    r = rig();
    await r.tick();
    delete r.mm.state.series[lc(r.s.address)];
    r.f.data.month = MONTH + 1;
    await r.tick();
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
  });
});

describe("P-M3 for the maker: a state file of another chain or deployment is set aside", () => {
  test("another chain id: state.json is kept aside, the full scan recovers the same active orders, nothing is double quoted", async () => {
    r = rig();
    await r.tick();
    const before = makerBook(r);
    const mm = new MarketMaker({ ...r.mm.d, deployments: { ...r.deployments, chainId: 31_337 } });
    expect(readdirSync(r.dir).some((f) => /^state\.stale-\d+\.json$/.test(f))).toBe(true);
    expect(mm.state.baseline).toBe(null);
    r.mm = mm;
    const n = r.sender.nonce;
    await r.tick();
    expect(makerBook(r)).toEqual(before);
    expect(r.sender.nonce).toBe(n + 1); // the one requote of a rebuilt book (condition 6), cancelling first
    expect(Object.values(r.mm.state.orders).flat().length).toBe(6);
  });

  test("an older state file without identity is adopted (and stamped)", async () => {
    r = rig();
    await r.tick();
    delete r.mm.state.identity;
    (r.mm as unknown as { save(): void }).save();
    const mm = new MarketMaker(r.mm.d);
    expect(mm.state.baseline).not.toBe(null);
    expect(mm.state.identity?.chainId).toBe(10_143);
    expect(existsSync(join(r.dir, "state.json"))).toBe(true);
  });
});

describe("P-M1 for the maker: a settle refused GAS_CAP is preceded by sync chunks", () => {
  test("sync(30) and sync(15) refused by the cap: sync(8) x 3 and sync(6), then both settles with nothing left to sync", async () => {
    r = rig();
    await r.tick();
    const endTs = BigInt((START_DAY + 30) * DAY);
    r.w.t = endTs + 30_000n;
    r.s.setPreview(30, 30n * REF);
    for (let d = START_DAY; d < START_DAY + 30; d++) r.ix.put(H100, d, REF, true);
    const orig = r.sender.send.bind(r.sender);
    r.sender.send = async (s: SendSpec): Promise<SendResult> => {
      if ((s.functionName === "settle" && (s.c ?? 0) > 0) || (s.functionName === "sync" && (s.c ?? 0) > 8)) return { ok: false, sent: false, error: "GAS_CAP" };
      return orig(s);
    };
    await r.tick();
    const fns = r.sender.log.filter((x) => x.result.ok && (x.spec.functionName === "sync" || x.spec.functionName === "settle")).map((x) => `${x.spec.functionName}:${x.spec.c}`);
    expect(fns).toEqual(["sync:8", "sync:8", "sync:8", "sync:6", "settle:0", "settle:0"]);
    expect(r.s.shortOf(r.maker)).toBe(0n);
    expect(Object.keys(r.mm.state.series)).toEqual([]);
  });
});
