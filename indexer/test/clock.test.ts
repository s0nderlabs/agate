// The clock (BOTS-SPEC 5.6): its two steps as pure functions, then through Envio's block handler in simulate.
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { CLOCK_EVERY, dueFinal } from "../src/lib/clock.ts";
import { forwardView } from "../src/lib/market.ts";
import { NOV, OCT, SEP20, demoTs, listed } from "./build.ts";
import { ev } from "./ev.ts";
import { DEMO, DOLLAR, H100, START, U, series, token, user } from "./world.ts";

type TI = ReturnType<typeof createTestIndexer>;
const run = (indexer: TI, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });
const tick = (block: number, ts: number) => ev("AgateDollar", "Dripped", { to: user(1), amount: 1n * U, nextAt: BigInt(ts + 86_400) }, { src: DOLLAR, block, ts });

describe("pure steps", () => {
  it("dueFinal: only PENDING days whose finalAt has passed", () => {
    const fixes = [
      { id: "a", state: "PENDING", finalAt: 100n },
      { id: "b", state: "PENDING", finalAt: 101n },
      { id: "c", state: "PENDING", finalAt: undefined },
      { id: "d", state: "NEEDS_SIGN", finalAt: undefined },
      { id: "e", state: "FINAL", finalAt: 10n },
      { id: "f", state: "CARRIED", finalAt: 10n },
    ];
    expect(dueFinal(fixes, 100n).map((f) => f.id)).toEqual(["a"]);
    expect(dueFinal(fixes, 101n).map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("forwardView: near is the current month, next the one after; missing months are empty", () => {
    const pts = [
      { series_id: "s10", month: OCT, markU: 2_000_000n },
      { series_id: "s11", month: NOV, markU: undefined },
      { series_id: "s9", month: OCT - 1, markU: 1_900_000n },
    ];
    expect(forwardView(pts, OCT)).toEqual({ currentMonth: OCT, nearSeries_id: "s10", nextSeries_id: "s11", nearMarkU: 2_000_000n, nextMarkU: undefined });
    expect(forwardView(pts, NOV)).toEqual({ currentMonth: NOV, nearSeries_id: "s11", nextSeries_id: undefined, nearMarkU: undefined, nextMarkU: undefined });
  });
});

describe("the block handler", () => {
  const D = 20_727;
  const closed = (block: number, ts: number) =>
    ev(
      "AgateIndex",
      "DayClosed",
      { gpuId: H100, day: D, source: user(1), value: 2_000_000, status: 1, fresh: 5, held: 0, freshMedian: 2_000_000, changed: false, needsSign: false, late: false, incomplete: false, digest: `0x${"d1".repeat(32)}` },
      { src: DEMO.index, block, ts },
    );

  it("marks a day FINAL at the first clock run whose newest event time reaches finalAt, never earlier", async () => {
    const i = createTestIndexer();
    const t0 = 1_791_000_000;
    const runs = [START + CLOCK_EVERY, START + 2 * CLOCK_EVERY, START + 3 * CLOCK_EVERY];
    const r = await run(i, [
      closed(START + 50, t0), // final at t0 + 210
      tick(runs[0]! + 10, t0 + 100), // the second run sees t0 + 100: not yet
      tick(runs[1]! + 10, t0 + 300), // the third run sees t0 + 300: final
      tick(runs[2]! + 10, t0 + 400),
    ]);
    const finalAt = r.changes.find((c) => c.DailyFix?.sets?.some((f) => f.state === "FINAL"));
    expect(finalAt?.block).toBe(runs[2]);
    expect((await i.DailyFix.getOrThrow(`${DEMO.index}-${H100}-${D}`)).state).toBe("FINAL");
  });

  it("moves a forward curve to the next month when the clock's time crosses the 1st", async () => {
    const i = createTestIndexer();
    const before = demoTs(SEP20 + 11) - 30; // Sep 30 on the demo clock, 30 s before October
    await run(i, [
      listed({ series: series(1), token: token(1), block: START + 10, month: OCT, ts: before - 10 }),
      listed({ series: series(2), token: token(2), block: START + 11, month: NOV, ts: before - 9 }),
      tick(START + CLOCK_EVERY + 5, before + 100), // past October 1st
      tick(START + 2 * CLOCK_EVERY + 5, before + 200),
    ]);
    const fw = (await i.MarketForward.getAll())[0]!;
    expect(fw).toMatchObject({ factory_id: DEMO.factory, currentMonth: OCT, nearSeries_id: series(1), nextSeries_id: series(2) });
  });
});
