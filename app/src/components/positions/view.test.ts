import { describe, expect, test } from "bun:test";
import { holderPositions, momentMarket, momentNow } from "@/lib/mock/timeline";
import type { Moment } from "@/lib/mock/config";
import type { Position } from "@/lib/mock/types";
import { monthStage } from "@/lib/data/derive";
import { dailyShares, holdingView, monthLine, nextShareAt, shareLine, sharesByDay, stageRank } from "./view";

const at = (m: Moment) => {
  const market = momentMarket("H100", m);
  const series = market.series.find((s) => s.month === "2026-11")!;
  const held = holderPositions(m);
  const by = (id: string) => held.find((p) => p.id === id)!;
  return { market, series, now: momentNow(m), daily: by("example-nov-daily"), long: by("example-nov-long"), short: by("example-nov-short") };
};

describe("holdingView: what a holding cost, is worth and pays", () => {
  test("mid-month: a pay me daily Long is worth its price less what it was paid; cost and worth add up to the change", () => {
    const { series, now, daily } = at("nov13");
    const last = series.quote!.last;
    const v = holdingView(daily, series, last, now);
    expect(v.stage).toBe("paying");
    expect(v.cost).toBeCloseTo(daily.entry * daily.q, 6);
    expect(v.worth).toBeCloseTo(last * daily.q - daily.paid, 6);
    expect(v.worth! + daily.paid - v.cost!).toBeCloseTo(v.change!, 6);
    expect(v.done).toBe(false);
  });

  test("a Short costs the ceiling less its price, and gains when the price falls", () => {
    const { series, now, short } = at("nov13");
    const v = holdingView(short, series, short.entry - 0.5, now);
    expect(v.cost).toBeCloseTo((series.cap - short.entry) * short.q, 6);
    expect(v.change).toBeCloseTo(0.5 * short.q, 6);
  });

  test("final: the month's average values it, the end payment is ready, and once collected it is done", () => {
    const { series, now, long } = at("dec1final");
    const v = holdingView(long, series, 999, now);
    expect(v.final).toBe(true);
    expect(v.price).toBeCloseTo(series.S / series.n, 9);
    expect(v.ready).toBeCloseTo(long.claimable, 6);
    const collected: Position = { ...long, paid: long.claimable, claimable: 0 };
    const after = holdingView(collected, series, 999, now);
    expect(after.done).toBe(true);
    expect(after.worth).toBe(0);
    expect(monthLine(series, "final", [after])).toContain("collected");
    expect(monthLine(series, "final", [v])).toContain("ready to collect");
  });

  test("no price: no worth and no change, never the entry passed off as one", () => {
    const { series, now, long } = at("nov13");
    const v = holdingView(long, series, null, now);
    expect(v.worth).toBeNull();
    expect(v.change).toBeNull();
  });
});

describe("dailyShares: each day's share, only when the chain's record backs it", () => {
  test("the example's daily Long: the floor paid at once, then one share per priced day, adding up to what it was paid", () => {
    const { market, series, daily } = at("nov13");
    const sh = dailyShares(daily, series, market.history)!;
    expect(sh).not.toBeNull();
    expect(sh.days.length).toBe(series.k);
    expect(sh.atOnce).toBeCloseTo(series.floor * daily.q, 2);
    expect(sh.atOnce + sh.days.reduce((a, d) => a + d.amount, 0)).toBeCloseTo(daily.paid, 2);
  });

  test("a paid amount the record does not explain lists no days", () => {
    const { market, series, daily } = at("nov13");
    expect(dailyShares({ ...daily, paid: daily.paid + 50 }, series, market.history)).toBeNull();
  });

  test("a history missing a priced day lists no days", () => {
    const { market, series, daily } = at("nov13");
    const gap = market.history.filter((d) => d.date !== "2026-11-05");
    expect(dailyShares(daily, series, gap)).toBeNull();
  });

  test("days add up per date across positions, newest first", () => {
    const rows = sharesByDay([
      [{ date: "2026-11-01", price: 2, amount: 1 }],
      [
        { date: "2026-11-01", price: 3, amount: 2 },
        { date: "2026-11-02", price: 3, amount: 4 },
      ],
    ]);
    expect(rows).toEqual([
      { date: "2026-11-02", price: 3, amount: 4 },
      { date: "2026-11-01", price: null, amount: 3 },
    ]);
  });

  test("the next share: the day after the last priced one, about 07:00 UTC; none once every day is priced", () => {
    expect(nextShareAt(at("nov13").series)).toBe("2026-11-14T07:00:00.000Z");
    expect(nextShareAt(at("dec1gap").series)).toBe("2026-12-01T07:00:00.000Z");
    expect(nextShareAt(at("dec1final").series)).toBeNull();
  });
});

describe("shareLine: when the daily shares pay, in words", () => {
  const line = (m: Moment) => {
    const { series, now } = at(m);
    return shareLine(series, monthStage(series, now), now);
  };

  test("before the month, from its first pay day; during it, the next share; the month's last day pays the last one", () => {
    expect(line("oct")).toBe("A share pays each day from Nov 2, about 07:00 UTC.");
    expect(line("nov13")).toBe("Next share about Nov 14, 07:00 UTC.");
    expect(line("nov30")).toBe("Last share about Dec 1, 07:00 UTC.");
    expect(line("dec1gap")).toBe("Last share about Dec 1, 07:00 UTC.");
    expect(line("dec1final")).toBe("Every day of November has paid its share.");
  });

  test("a share past its time is due, never a time in the past", () => {
    const { series } = at("nov13");
    expect(shareLine(series, "paying", Date.parse("2026-11-14T08:00:00Z"))).toBe("The next share is due any minute now.");
  });

  test("the card follows the month paying now before one about to start or one already final", () => {
    const ranked = (["final", "listed", "lastDay"] as const).slice().sort((a, b) => stageRank(a) - stageRank(b));
    expect(ranked).toEqual(["lastDay", "listed", "final"]);
  });
});
