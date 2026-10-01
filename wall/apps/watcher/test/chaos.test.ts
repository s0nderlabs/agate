// BUILD-SPEC 12.6 chaos rows: the local machine asleep 3 hours (PRODUCTION and DEMO) and every RPC URL down for 10 minutes.
import { describe, expect, test } from "bun:test";
import { AlertCode } from "@agate/report/types";
import { Pages, World } from "../src/sim/world.ts";

const OCT1 = 20_727;
const BASE = [3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000];

describe("chaos: machine asleep 3 hours", () => {
  test("PRODUCTION: 3 slices of a step day slept; nothing posted for them; incomplete records countersigned; CLOCK_JUMP; L1", async () => {
    const DAY = 86_400;
    const S = 3_600;
    const D = OCT1 + 2;
    const sleepFrom = D * DAY + 10 * S;
    const sleepTo = sleepFrom + 3 * S;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: D * DAY + 12 * S, v: b + 600_000 })));
    const w = new World({ firstDay: OCT1, profile: { day: DAY, slices: 24 }, pages: pages.fn, writers: [{ net: "w1" }, { net: "w2" }], asleep: (t) => t >= sleepFrom && t < sleepTo, step: 120 });
    await w.run((D + 4) * DAY);
    const g = w.m.g(w.panel.gpuId);
    for (const wr of w.m.writers) {
      const a = w.m.accOf(g, D, wr)!;
      expect([...a.sliceBits.toString(2)].filter((b) => b === "1").length).toBe(21);
    }
    const posts = w.m.events.filter((e) => e.name === "ReadingsPosted" && e.day === D);
    expect(posts.every((e) => !(e.at >= sleepFrom && e.at < sleepTo))).toBe(true);
    expect(posts.every((e) => (e.args.slice as number) < 10 || (e.args.slice as number) > 12)).toBe(true);
    const r = g.records.get(D)!;
    expect(r.incomplete).toBe(true);
    expect(r.attestedBy).toBe(w.m.attester);
    expect(w.raised(AlertCode.CLOCK_JUMP)).toBe(true);
    const missed = [0, 1, 2, 3, 4].every((i) => [10, 11, 12].every((h) => w.log.get(`s${i}`, D * 24 + h)?.attempts === 0));
    expect(missed).toBe(true);
    expect(w.days(OCT1, D + 2).every((x) => x.final && x.lag <= w.c.lagMax)).toBe(true);
  }, 60_000);

  test("DEMO: 18 demo days slept; carried at GRACE once the keeper runs, no counter advanced, one carry per STEP, lag recovers", async () => {
    const P = { day: 600, slices: 4, qMin: 1 };
    const D = OCT1 + 3;
    const sleepFrom = D * 600 + 300;
    const sleepTo = sleepFrom + 3 * 3_600;
    const pages = new Pages(BASE);
    const w = new World({ firstDay: OCT1, profile: P, pages: pages.fn, writers: [{ net: "w1" }, { net: "w2" }], asleep: (t) => t >= sleepFrom && t < sleepTo, step: 5 });
    await w.run(sleepTo + 600 * 12);
    const carried = w.m.events.filter((e) => e.name === "DayCarried");
    expect(carried.length).toBeGreaterThanOrEqual(15);
    expect(carried.every((e) => e.args.missAdvanced === 0)).toBe(true);
    const ats = carried.map((e) => e.at).sort((a, b) => a - b);
    for (let j = 1; j < ats.length; j++) expect(ats[j]! - ats[j - 1]!).toBeGreaterThanOrEqual(w.c.step);
    expect(w.raised(AlertCode.R5_HEAD_LAG)).toBe(true);
    const lastDay = w.dayOf(w.now) - 2;
    const tail = w.days(lastDay - 3, lastDay);
    expect(tail.every((x) => x.final && x.lag <= w.c.lagMax)).toBe(true);
    expect(w.alerts.open().filter((a) => a.code === AlertCode.R5_HEAD_LAG)).toEqual([]);
  }, 60_000);
});

describe("chaos: every RPC URL down for 10 minutes", () => {
  test("PRODUCTION: posts held and sent after recovery inside their windows; no missed slice; nothing lost", async () => {
    const DAY = 86_400;
    const D = OCT1 + 2;
    const from = D * DAY + 5 * 3_600 + 600;
    const down = (t: number) => t >= from && t < from + 600;
    const pages = new Pages(BASE, BASE.map((b, i) => ({ slot: i, at: D * DAY, v: b + 300_000 })));
    const w = new World({ firstDay: OCT1, profile: { day: DAY, slices: 24 }, pages: pages.fn, writers: [{ net: "w1", rpcDown: down }, { net: "w2", rpcDown: down }], chainDown: down, step: 60 });
    await w.run((D + 3) * DAY);
    const g = w.m.g(w.panel.gpuId);
    for (const wr of w.m.writers) expect(w.m.accOf(g, D, wr)!.sliceBits).toBe(2 ** 24 - 1);
    const r = g.records.get(D)!;
    expect(w.m.isFinal(r, w.now) && r.attestedAt > 0).toBe(true);
    expect(w.days(OCT1, D + 1).every((x) => x.final && x.lag <= w.c.lagMax)).toBe(true);
  }, 60_000);

  test("DEMO: a whole demo day without RPC: held posts land inside the F1 window (or the day closes incomplete or is carried); L1 holds", async () => {
    const P = { day: 600, slices: 4, qMin: 1 };
    const D = OCT1 + 3;
    const from = D * 600;
    const down = (t: number) => t >= from && t < from + 600;
    const w = new World({ firstDay: OCT1, profile: P, pages: new Pages(BASE).fn, writers: [{ net: "w1", rpcDown: down }, { net: "w2", rpcDown: down }], chainDown: down, step: 5, guardian: { delay: 75, looks: true } });
    await w.run((D + 10) * 600);
    const r = w.m.g(w.panel.gpuId).records.get(D)!;
    expect(w.m.isFinal(r, w.now)).toBe(true);
    // no post after its window: every accepted entry of D landed by dayEnd + CLOSE_GRACE - margin
    const late = w.m.events.filter((e) => e.name === "ReadingsPosted" && e.day === D && e.at > (D + 1) * 600 + w.c.closeGrace - 30);
    expect(late).toEqual([]);
    const days = w.days(OCT1, D + 6);
    expect(days.every((x) => x.final)).toBe(true);
    expect(Math.max(...days.map((x) => x.lag))).toBeLessThanOrEqual(w.c.lagMax);
  }, 60_000);
});
