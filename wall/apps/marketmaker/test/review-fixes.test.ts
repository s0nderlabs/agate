// The Oct 3 code review's findings on the maker, each fixed:
//   2. with no maker process running, a CLI request (unkill, rebase, cancel-all) booted one and ran a full tick that
//      minted, deposited and placed a ladder, then exited: a ladder nobody requotes (Kuru orders never expire). The
//      one-shot tick now places, mints and deposits nothing; cancels and the crossed orders' cancel still go;
//   6. a dry run raised MM_KEY_LOW (and main.ts froze the day's budget file from it).
// Fakes only: no chain, no key, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { MarketMaker } from "../src/mm.ts";
import { DAY, H100, makerBook, type Rig, rig } from "./helpers.ts";

let r: Rig;
afterEach(() => r?.cleanup());

const placing = (x: Rig, from: number) => x.sender.log.slice(from).filter((l) => l.result.ok && (["mint", "deposit"].includes(l.spec.functionName) || (l.spec.functionName === "batchUpdate" && (l.spec.adds ?? 0) > 0)));

describe("finding 2: a one-shot CLI tick places nothing", () => {
  test("unkill with no maker running: the kill is lifted, nothing is minted, deposited or placed; `run` quotes", async () => {
    r = rig();
    await r.tick();
    writeFileSync(r.mm.killPath(), "test");
    await r.tick(); // the kill tick cancels every order and forgets the quotes
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    // the process stops; the operator runs `unkill` (main.ts request(): the UNKILL file, KILL removed, one tick)
    const mm = r.restart();
    writeFileSync(join(r.dir, "UNKILL"), "");
    rmSync(mm.killPath(), { force: true });
    const n = r.sender.log.length;
    const rep = await mm.tick({ oneShot: true });
    expect(rep.killed).toBe(null);
    expect(mm.state.killed).toBe(null);
    // before the fix: decide() said "first quote" and the tick minted pairs, deposited and placed the full ladder
    expect(placing(r, n)).toEqual([]);
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    // the next `run` quotes
    await r.restart().tick();
    expect(makerBook(r).asks.length).toBe(3);
    expect(makerBook(r).bids.length).toBe(3);
  });

  test("rebase with no maker running: the baseline moves, the resting ladder is left as it is", async () => {
    r = rig();
    await r.tick();
    const before = makerBook(r);
    const mm = r.restart();
    writeFileSync(join(r.dir, "REBASE"), "");
    const n = r.sender.log.length;
    await mm.tick({ oneShot: true });
    expect(placing(r, n)).toEqual([]);
    expect(r.sender.log.length).toBe(n); // nothing sent at all: a state-only request
    expect(makerBook(r)).toEqual(before);
    expect(mm.state.baseline).not.toBe(null);
  });

  test("cancel-all with no maker running cancels; a fair move through the quotes cancels only the crossed orders", async () => {
    r = rig();
    await r.tick();
    let mm = r.restart();
    writeFileSync(join(r.dir, "CANCEL_ALL"), "");
    await mm.tick({ oneShot: true });
    expect(makerBook(r)).toEqual({ bids: [], asks: [] });
    // quotes again (a `run` tick), then fair jumps to 4.00 through the asks while no maker runs: a one-shot request
    // cancels the crossed asks (a safety send) and places nothing
    await r.restart().tick();
    const bids = makerBook(r).bids;
    r.w.t += BigInt(DAY);
    r.ix.put(H100, r.today() - 1, 4_000_000n, true);
    mm = r.restart();
    writeFileSync(join(r.dir, "REBASE"), "");
    const n = r.sender.log.length;
    await mm.tick({ oneShot: true });
    expect(placing(r, n)).toEqual([]);
    expect(makerBook(r).asks).toEqual([]);
    expect(makerBook(r).bids).toEqual(bids);
  });
});

describe("finding 6: a dry run moves no MON alert", () => {
  test("a dry-run maker with an unfunded key raises no MM_KEY_LOW and, built without a budget, writes no budget file", async () => {
    r = rig({ mon: 1n, budget: false });
    const config = parseConfig(JSON.stringify({ factories: ["demo"], runUntil: "2026-12-31T00:00:00Z" }));
    const dry = new MarketMaker({ reads: r.reads, sender: r.sender, deployments: r.deployments, config, dir: r.dir, alerts: r.alerts, dryRun: true, nowMs: () => r.clock.ms });
    await dry.tick();
    expect(r.alerts.open().map((a) => a.code as string)).not.toContain("MM_KEY_LOW");
    expect(readdirSync(r.dir).filter((x) => x.startsWith("budget-"))).toEqual([]);
    // the same key outside a dry run is low
    const live = new MarketMaker({ reads: r.reads, sender: r.sender, deployments: r.deployments, config, dir: r.dir, alerts: r.alerts, nowMs: () => r.clock.ms });
    await live.tick();
    expect(r.alerts.open().map((a) => a.code as string)).toContain("MM_KEY_LOW");
  });
});
