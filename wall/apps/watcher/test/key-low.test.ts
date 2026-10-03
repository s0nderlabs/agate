// KEY_LOW (9.5, wall spec 18.4): under the 10 MON floor, or under AGATE_KEY_LOW_HOURS (24) of the key's own spend at
// the rate health saw over the last max(1 h, DAY). With six GPUs the DEMO primary spends about 178 MON a real day at
// 102 gwei, so 10 MON is about 80 minutes of its sends: the floor alone would warn far too late.
import { describe, expect, test } from "bun:test";
import type { Address } from "@agate/report/types";
import { AlertSink } from "../src/alerts.ts";
import type { IndexView } from "../src/chain/types.ts";
import { Health, SpendWindow } from "../src/health.ts";

const MON = 10n ** 18n;
const PRIMARY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const KEEPER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as Address;

/** A chain of balances only (no GPUs, no heartbeats): each key loses `burn` wei a second, plus top-ups. */
function rig(o: { day: number; balances: Record<string, bigint>; burn: Record<string, bigint>; hours?: number; spent?: (dt: number) => bigint }) {
  let t = 1_793_491_200;
  const start = t;
  const extra: Record<string, bigint> = {};
  // spent: wei gone after dt seconds when the spend lands in batches (reports, closes) instead of evenly
  const bal = (a: Address) => o.balances[a]! - (o.spent ? o.spent(t - start) : o.burn[a]! * BigInt(t - start)) + (extra[a] ?? 0n);
  const view = { blockTime: async () => t, balance: async (a: Address) => bal(a) } as unknown as IndexView;
  const alerts = new AlertSink(null, { now: () => t, print: false });
  const clock = { slice: o.day / 4, day: o.day } as never;
  const keys = Object.keys(o.balances).map((address) => ({ role: address === KEEPER ? "keeper" : "primary", address: address as Address }));
  const health = new Health({ view, clock, alerts, roles: [], gpuIds: [], keys, ...(o.hours ? { keyLowHours: o.hours } : {}) });
  return {
    alerts,
    bal,
    topUp: (a: Address, w: bigint) => void (extra[a] = (extra[a] ?? 0n) + w),
    /** health ticks every 60 s for `s` seconds */
    run: async (s: number) => {
      for (const end = t + s; t < end; ) {
        t += 60;
        await health.tick(t);
      }
    },
    /** time passes with no tick and no spend (a machine sleep: the writers sleep too) */
    sleep: async (s: number) => {
      for (const a of Object.keys(o.balances)) extra[a] = (extra[a] ?? 0n) + o.burn[a]! * BigInt(s);
      t += s;
    },
    low: (a: Address) => alerts.open().filter((x) => x.code === "KEY_LOW" && x.writer?.toLowerCase() === a.toLowerCase()),
  };
}

// 178 MON a real day: the DEMO primary at 102 gwei (README, "Gas with six GPUs")
const DEMO_BURN = (178n * MON) / 86_400n;

describe("KEY_LOW on the recent spend rate", () => {
  test("DEMO: a primary funded with 100 MON is flagged once half an hour of spend is seen, long before the floor", async () => {
    const r = rig({ day: 600, balances: { [PRIMARY]: 100n * MON }, burn: { [PRIMARY]: DEMO_BURN } });
    await r.run(25 * 60);
    expect(r.low(PRIMARY)).toEqual([]); // under half the 1 h window: no rate yet, and 100 MON is over the floor
    await r.run(10 * 60);
    const [a] = r.low(PRIMARY);
    expect(a?.severity).toBe("action");
    expect(a?.message).toMatch(/primary key 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 holds 9\d MON, under 24 h of its sends at the recent rate \(17\d MON\): fund it/);
    expect(r.bal(PRIMARY) > 10n * MON).toBe(true);
  });

  test("a key holding more than a day of its spend is quiet; it is flagged as it falls under, and cleared by a top-up", async () => {
    const r = rig({ day: 600, balances: { [PRIMARY]: 200n * MON }, burn: { [PRIMARY]: DEMO_BURN } });
    await r.run(60 * 60);
    expect(r.low(PRIMARY)).toEqual([]); // about 192 MON left, a day needs about 178
    await r.run(3 * 60 * 60);
    expect(r.low(PRIMARY).length).toBe(1); // about 170 MON left
    r.topUp(PRIMARY, 500n * MON);
    await r.run(60);
    expect(r.low(PRIMARY)).toEqual([]); // the top-up is not counted as spend, and the rate stays the same
    await r.run(60 * 60);
    expect(r.low(PRIMARY)).toEqual([]);
  });

  test("a key that spends nothing (the keeper on a normal day) only has the 10 MON floor", async () => {
    const r = rig({ day: 600, balances: { [KEEPER]: 11n * MON }, burn: { [KEEPER]: 0n } });
    await r.run(3 * 60 * 60);
    expect(r.low(KEEPER)).toEqual([]);
    const r2 = rig({ day: 600, balances: { [KEEPER]: 9n * MON }, burn: { [KEEPER]: 0n } });
    await r2.run(60);
    expect(r2.low(KEEPER)[0]?.message).toBe(`keeper key ${KEEPER} holds 9.0 MON, below the 10 MON floor`);
  });

  test("PRODUCTION: the rate window is a whole day; 30 MON is many days of the real calendar's 4.5 MON", async () => {
    const r = rig({ day: 86_400, balances: { [PRIMARY]: 30n * MON }, burn: { [PRIMARY]: (45n * MON) / 10n / 86_400n } });
    await r.run(36 * 60 * 60);
    expect(r.low(PRIMARY)).toEqual([]);
  });

  test("lumpy spend near the need does not flap the alert: one raise while the balance falls, cleared only by a top-up", async () => {
    // the DEMO primary: a 0.155 MON report each 150 s slice and six closes (0.57 MON) each 600 s day, each at an
    // uneven second (read offsets are random), about 171 MON a real day
    const sends: [number, bigint][] = [];
    for (let k = 0; k < 6 * 24; k++) sends.push([k * 150 + ((k * 53) % 120), (155n * MON) / 1_000n]);
    for (let k = 0; k < 6 * 6; k++) sends.push([k * 600 + 150 + ((k * 97) % 300), (570n * MON) / 1_000n]);
    const spent = (dt: number) => sends.reduce((s, [at, w]) => (at <= dt ? s + w : s), 0n);
    const r = rig({ day: 600, balances: { [PRIMARY]: 190n * MON }, burn: { [PRIMARY]: 0n }, spent });
    let raises = 0;
    let open = false;
    for (let i = 0; i < 6 * 60; i++) {
      await r.run(60);
      const now = r.low(PRIMARY).length > 0;
      if (now && !open) raises++;
      open = now;
    }
    expect(raises).toBe(1);
    expect(open).toBe(true);
    r.topUp(PRIMARY, 500n * MON);
    await r.run(60);
    expect(r.low(PRIMARY)).toEqual([]);
  });

  test("a machine sleep does not clear an open KEY_LOW: it stays until a rate is measured again or the key is topped up", async () => {
    const r = rig({ day: 600, balances: { [PRIMARY]: 100n * MON }, burn: { [PRIMARY]: DEMO_BURN } });
    await r.run(60 * 60);
    expect(r.low(PRIMARY).length).toBe(1);
    const before = r.low(PRIMARY)[0]!.id;
    await r.sleep(3 * 60 * 60); // nothing ticks and nothing is spent
    await r.run(60);
    expect(r.low(PRIMARY).map((a) => a.id)).toEqual([before]); // no rate yet after the gap: kept, not cleared
    await r.run(40 * 60);
    expect(r.low(PRIMARY).length).toBe(1); // the rate is measured again and still says fund it
    r.topUp(PRIMARY, 500n * MON);
    await r.sleep(3 * 60 * 60);
    await r.run(60);
    expect(r.low(PRIMARY)).toEqual([]); // a top-up across a gap clears it
  });

  test("AGATE_KEY_LOW_HOURS sets the horizon", async () => {
    const r = rig({ day: 600, balances: { [PRIMARY]: 100n * MON }, burn: { [PRIMARY]: DEMO_BURN }, hours: 6 });
    await r.run(2 * 60 * 60);
    expect(r.low(PRIMARY)).toEqual([]); // about 85 MON left, 6 h need about 45
    await r.run(8 * 60 * 60);
    expect(r.low(PRIMARY)[0]?.message).toMatch(/under 6 h of its sends/);
  });
});

describe("SpendWindow", () => {
  test("spend is the sum of the drops over the window; a top-up is not spending; no rate before half a window", () => {
    const w = new SpendWindow(3_600);
    w.add(0, 100n);
    w.add(1_000, 90n);
    expect(w.need(1)).toBe(null); // 1,000 s of samples, under half the window: no rate yet
    w.add(2_000, 80n);
    w.add(2_100, 180n); // a top-up
    w.add(3_000, 170n);
    expect(w.spent()).toEqual({ wei: 30n, spanS: 3_000 });
    expect(w.need(1)).toBe(36n); // 30 wei over 3,000 s is 36 an hour
    w.add(7_000, 130n);
    // the oldest kept sample is the last one at or before 7,000 - 3,600: t = 3,000
    expect(w.spent()).toEqual({ wei: 40n, spanS: 4_000 });
  });
  test("a gap over maxGapS starts the window over; add reports a top-up", () => {
    const w = new SpendWindow(3_600);
    w.add(0, 100n, 180);
    w.add(2_000, 80n, Infinity);
    expect(w.need(1)).toBe(36n); // 20 wei over 2,000 s
    expect(w.add(12_000, 79n, 180)).toBe(false); // a 10,000 s sleep: not a time of zero spend
    expect(w.need(1)).toBe(null);
    expect(w.add(12_060, 500n, 180)).toBe(true);
  });
});
