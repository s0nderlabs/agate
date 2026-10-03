// Recheck round 2, listing lens.
//   R2-LS1 (finding R2-L2, fixed) what the lister "owes" (recheck R1-H1) included a month whose list is refused for
//          good (UnknownGpu, or any revert but the waits: LISTER_REFUSED, retried hourly) and a series whose
//          createMarket is refused for good (LISTER_MARKET_REFUSED): no spend can ever list them, yet the claims kept a
//          listing's cost back for them every tick, for ever (measured: about 1.18 MON at the 200 gwei cap, 2.9 % of
//          the planned daily budget). Now a month or market inside its retry hour after a refusal is not owed.
//   R2-LS2 (finding R2-L4, fixed) a LISTER_MARKET_REFUSED (action) raised for a month that then leaves the lister's
//          window was never cleared (its key is the series); it now carries its factory and month and clears with the
//          window sweep.
// Fakes only: no chain, no key, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSink } from "@agate/watcher";
import { type FactoryEntry, LimitTable, monToWei } from "@agate/market";
import { listerOwes, listingCostWei } from "../../../src/app.ts";
import { Lister } from "../../../src/lister.ts";
import { StateStore } from "../../../src/state.ts";
import { addr, FakeReads, FakeSender, FakeWorld, gpu } from "../../fake/world.ts";

const F = 1_800_000n;
const C = 7_200_000n;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "agate-lister-r2-"));
  dirs.push(d);
  return d;
};

describe("R2-LS1 (finding R2-L2, fixed): a listing no spend can make keeps no reserve", () => {
  test("a GPU whose list reverts UnknownGpu: not owed at any hourly tick of a day (refused at each retry)", async () => {
    const w = new FakeWorld();
    const good = gpu(0x100);
    const bad = gpu(0x200);
    const f = w.addFactory("demo", { gpus: [good, bad], listing: (g) => (g === bad ? { ok: false, error: `UnknownGpu(${bad})` } : { ok: true, floor: F, cap: C }) });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = tmp();
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    const lister = new Lister({ reads: new FakeReads(w), sender: new FakeSender(w), factories: [entry], state: new StateStore(dir), alerts, log: () => {} });
    const owedAt: number[] = [];
    for (let h = 0; h <= 24; h++) {
      const rep = await lister.tick(w.t + BigInt(h) * 3_600n);
      if (h === 0) {
        // the good GPU's two months listed and their markets created at once; the bad one refused
        expect(rep.listed.length).toBe(2);
        expect(rep.created.length).toBe(2);
      }
      owedAt.push(rep.owed.length);
      // nothing a spend can land is owed: the claims keep no reserve back for the refused GPU
      expect(listerOwes(rep)).toBe(false);
    }
    // before the fix: owed (2 months) every hour of the day
    expect(owedAt.every((n) => n === 0)).toBe(true);
    // the person is still asked to look
    expect(alerts.open().some((a) => (a.code as string) === "LISTER_REFUSED")).toBe(true);
    // what the claims left unspent for it before the fix: one listing at the fee cap, against the planned daily budget
    const reserve = listingCostWei(new LimitTable(), 200_000_000_000n);
    const B = (monToWei(465) - monToWei(15)) / 11n;
    const share = Number((reserve * 10_000n) / B) / 100;
    expect(share).toBeGreaterThan(2.5);
    expect(share).toBeLessThan(3.5);
  });
});

describe("R2-LS2 (finding R2-L4, fixed): a market refusal of a month that left the window clears", () => {
  test("LISTER_MARKET_REFUSED raised in months m and m + 1 is cleared in month m + 2", async () => {
    const w = new FakeWorld();
    const f = w.addFactory("demo", { gpus: [gpu(0x100)], listing: () => ({ ok: true, floor: F, cap: C }), createMarketError: "KuruRouterPaused()" });
    const entry: FactoryEntry = { name: "demo", index: f.index, dollar: addr(0xd011a7), tag: "demo", factory: f.address, router: addr(0x7007), tPend: 210, startBlock: 0n };
    const dir = tmp();
    const alerts = new AlertSink(join(dir, "alerts.jsonl"), { now: () => Number(w.t), print: false });
    const lister = new Lister({ reads: new FakeReads(w), sender: new FakeSender(w), factories: [entry], state: new StateStore(dir), alerts, log: () => {} });
    const r0 = await lister.tick(w.t);
    expect(alerts.open().filter((a) => (a.code as string) === "LISTER_MARKET_REFUSED").length).toBe(2); // months m and m + 1
    expect(r0.owed).toEqual([]); // inside the retry hour no spend can create them (R2-L2)
    // Kuru unpauses, two months pass: months m + 2 and m + 3 list and get their markets
    f.createMarketError = undefined;
    f.month += 2;
    const rep = await lister.tick(w.t + 2n * 31n * 86_400n);
    expect(rep.created.length).toBe(2);
    expect(rep.owed).toEqual([]);
    // before the fix the two old months' action alerts stayed open (nobody will ever create those markets now)
    expect(alerts.open().filter((a) => (a.code as string) === "LISTER_MARKET_REFUSED").length).toBe(0);
  });
});
