// Recheck r1: the keeper's M3 hold against a chain that keeps dropping out after the day ended (a flaky
// network, or repeated machine wakes). The fix log said writers and the keeper do not close a day before
// min(recovery + CLOSE_GRACE, REPOST_END); the writers capped the hold at REPOST_END, the keeper did not, so each
// recovery pushed its close (and its carry fallback) another CLOSE_GRACE out. Fixed (fix round 2): the keeper holds
// only while now < min(holdCloseUntil, dayEnd + GRACE - slice). TEST clock: DAY 2,400 s, CLOSE_GRACE 200 s,
// REPOST_END = dayEnd + 2,200 s.
import { describe, expect, test } from "bun:test";
import { Keeper } from "../../../src/keeper.ts";
import { KEEPER, Pages, World } from "../../../src/sim/world.ts";

const OCT1 = 20_727;
const T = 2_400;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

/** The writer never closes; from dayEnd + 60 s the keeper's chain fails for 20 s in every 150 s until `flapUntil`. */
async function flapping(flapUntil: number): Promise<{ w: World; k: Keeper; closedAt: number | null }> {
  const pages = new Pages(BASE);
  const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", close: "never" }], keeper: false, guardian: null });
  await w.run((OCT1 + 1) * T + 10);
  const k = new Keeper({ view: w.chain, sender: w.chain.sender(KEEPER), clock: w.c, gpuIds: [w.panel.gpuId], tickS: 10 });
  await k.tick(w.now);
  const dayEnd = (OCT1 + 1) * T;
  let closedAt: number | null = null;
  for (let t = w.now + 10; t <= dayEnd + 3 * T && closedAt === null; t += 10) {
    await w.run(t);
    const off = t - dayEnd - 60;
    w.chain.down = off >= 0 && t < flapUntil && off % 150 < 20;
    await k.tick(t);
    w.chain.down = false;
    if (w.m.g(w.panel.gpuId).head === OCT1 + 1) closedAt = t;
  }
  return { w, k, closedAt };
}

describe("keeper hold under a flapping chain (recheck r1)", () => {
  // the fix log's bound (min(recovery + CLOSE_GRACE, REPOST_END)), as the writers apply it
  test("the keeper closes by REPOST_END (plus one keeper backoff) however often the chain recovers", async () => {
    const dayEnd = (OCT1 + 1) * T;
    const { closedAt, w } = await flapping(dayEnd + 2 * T);
    const repostEnd = dayEnd + w.c.grace - w.c.slice;
    expect(closedAt).not.toBeNull();
    expect(closedAt!).toBeGreaterThanOrEqual(repostEnd); // held until then: every recovery kept the writers first
    expect(closedAt!).toBeLessThanOrEqual(repostEnd + 60);
  }, 120_000);

  test("without a flap the hold is unchanged: the keeper closes once CLOSE_GRACE has passed", async () => {
    const dayEnd = (OCT1 + 1) * T;
    const { closedAt, w } = await flapping(0);
    expect(closedAt).not.toBeNull();
    expect(closedAt!).toBeGreaterThanOrEqual(dayEnd + w.c.closeGrace);
    expect(closedAt!).toBeLessThan(dayEnd + w.c.closeGrace + 60);
  }, 120_000);

  test("a recovery after REPOST_END holds nothing", async () => {
    const dayEnd = (OCT1 + 1) * T;
    const pages = new Pages(BASE);
    const w = new World({ firstDay: OCT1, pages: pages.fn, writers: [{ net: "w1", close: "never" }], keeper: false, guardian: null });
    await w.run((OCT1 + 1) * T + 10);
    const k = new Keeper({ view: w.chain, sender: w.chain.sender(KEEPER), clock: w.c, gpuIds: [w.panel.gpuId], tickS: 10 });
    await k.tick(w.now);
    const repostEnd = dayEnd + w.c.grace - w.c.slice;
    // the keeper's machine sleeps through the day's end and wakes after REPOST_END: no CLOSE_GRACE hold then
    await w.run(repostEnd + 30);
    await k.tick(repostEnd + 30);
    expect(w.m.g(w.panel.gpuId).head).toBe(OCT1 + 1);
  }, 120_000);
});
