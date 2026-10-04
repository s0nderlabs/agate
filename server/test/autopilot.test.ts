import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { rollDue, runAutopilot } from "../src/autopilot.ts";
import { config } from "../src/config.ts";
import { lockCount, serial } from "../src/serial.ts";
import { type GrantRow, Store } from "../src/store.ts";

const POCKET = "0x2222222222222222222222222222222222222222" as Address;
const NOW = Date.parse("2026-10-04T15:00:00Z");
const min = (n: number) => new Date(NOW + n * 60_000).toISOString();

/** a market reader with two months: Nov closes in `novIn` minutes, Dec in 300; the pocket holds `held` Nov GPU-hours */
function market(o: { novIn: number; held: number; bid?: number; dec?: boolean }) {
  const series = [
    { month: "2026-11", phase: "paying", closesAt: min(o.novIn), quote: { bid: o.bid ?? 4.72, ask: 4.82 } },
    ...(o.dec === false ? [] : [{ month: "2026-12", phase: "trading", closesAt: min(300), quote: { bid: 4.77, ask: 4.87 } }]),
  ];
  return {
    getMarket: async () => ({ series }),
    seriesAt: async (_g: string, m: string) => ({ terms: { token: m === "2026-11" ? "0x1100000000000000000000000000000000000011" : "0x1200000000000000000000000000000000000012" } }),
    pub: { readContract: async (a: { address: string }) => (a.address.startsWith("0x11") ? BigInt(Math.round(o.held * 1e6)) : 0n) },
  } as never;
}

describe("rollDue: when keep-my-hedge-going acts", () => {
  test("nothing while the held month closes later than the lead", async () => {
    expect(await rollDue(market({ novIn: 120, held: 1 }), POCKET, "H200", 60, 20, NOW)).toEqual({ skip: "nothing due" });
  });
  test("inside the lead it rolls all of a small hedge into the next month", async () => {
    expect(await rollDue(market({ novIn: 30, held: 1.0366 }), POCKET, "H200", 60, 20, NOW)).toEqual({ from: "2026-11", to: "2026-12", gpuHours: 1.0366, held: 1.0366 });
  });
  test("a hedge bigger than the cap rolls in parts under the cap", async () => {
    const r = await rollDue(market({ novIn: 30, held: 10 }), POCKET, "H200", 60, 20, NOW);
    expect("gpuHours" in r && r.gpuHours * 4.72).toBeLessThanOrEqual(20 * 0.95);
    expect("gpuHours" in r && r.gpuHours).toBeGreaterThan(3.9);
  });
  test("dust is left alone; no later month or no bid is a named skip", async () => {
    expect(await rollDue(market({ novIn: 30, held: 0.01 }), POCKET, "H200", 60, 20, NOW)).toEqual({ skip: "nothing due" });
    expect(await rollDue(market({ novIn: 30, held: 1, dec: false }), POCKET, "H200", 60, 20, NOW)).toMatchObject({ skip: expect.stringContaining("no later month") });
    expect(await rollDue(market({ novIn: 30, held: 1, bid: 0 }), POCKET, "H200", 60, 20, NOW)).toMatchObject({ skip: expect.stringContaining("no bid") });
  });
});

function grantRow(over: Partial<GrantRow> = {}): GrantRow {
  return {
    id: "g-1",
    userId: "u-1",
    label: "Claude",
    mainAccount: "0x1111111111111111111111111111111111111111",
    pocket: POCKET,
    assistantWalletId: "w-a",
    assistantAddress: "0x4444444444444444444444444444444444444444",
    budget: 100_000_000n,
    perTradeCap: 20_000_000n,
    shortTokensCap: 1_000_000n,
    routers: [config.router],
    pocketIndex: 1,
    tradesPerDay: 3,
    expiresAt: NOW + 86_400_000,
    permission: "x",
    status: "active",
    createdAt: NOW,
    ...over,
  };
}

describe("runAutopilot", () => {
  const never = (async () => {
    throw new Error("must not trade");
  }) as never;

  test("an order of a disconnected connection stops itself", async () => {
    const store = new Store(":memory:");
    store.putGrant(grantRow({ status: "revoked" }));
    const o = store.putStandingOrder({ grantId: "g-1", userId: "u-1", kind: "roll_long", gpu: "H200", leadMinutes: 60 });
    const r = await runAutopilot({ store, client: () => market({ novIn: 30, held: 1 }), trade: never, now: () => NOW });
    expect(r[0]?.result).toMatchObject({ stopped: expect.any(String) });
    expect(store.standingOrder(o.id)?.status).toBe("stopped");
    expect(store.events({ grantId: "g-1" }).map((e) => e.name)).toContain("autopilot.stopped");
  });

  test("a due roll waits when the day's trades are used, and says so once", async () => {
    const store = new Store(":memory:");
    store.putGrant(grantRow({ tradesPerDay: 1 }));
    store.event({ source: "agate", name: "pocket.trade", grantId: "g-1", detail: {} });
    store.putStandingOrder({ grantId: "g-1", userId: "u-1", kind: "roll_long", gpu: "H200", leadMinutes: 60 });
    const deps = { store, client: () => market({ novIn: 30, held: 1 }), trade: never, now: () => NOW + 1 };
    expect((await runAutopilot(deps))[0]?.result).toMatchObject({ skip: expect.stringContaining("daily_limit") });
    expect(store.tradesSince("g-1", 0)).toBe(1);
  });

  test("nothing due is recorded on the order without an activity entry", async () => {
    const store = new Store(":memory:");
    store.putGrant(grantRow());
    const o = store.putStandingOrder({ grantId: "g-1", userId: "u-1", kind: "roll_long", gpu: "H200", leadMinutes: 60 });
    await runAutopilot({ store, client: () => market({ novIn: 600, held: 1 }), trade: never, now: () => NOW });
    expect(store.standingOrder(o.id)?.lastResult).toEqual({ skip: "nothing due" });
    expect(store.events({ grantId: "g-1" })).toHaveLength(0);
  });
});

describe("serial", () => {
  test("runs one at a time per key and leaves no entry behind", async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => serial("k", async () => (order.push(`${tag}+`), await Bun.sleep(ms), order.push(`${tag}-`)));
    await Promise.all([slow("a", 20), slow("b", 1), slow("c", 1)]);
    expect(order).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
    expect(lockCount()).toBe(0);
  });
});
