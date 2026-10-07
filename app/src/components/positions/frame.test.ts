import { describe, expect, test } from "bun:test";
import { holderPositions, momentCandles, momentMarket, momentNow } from "@/lib/mock/timeline";
import type { Moment } from "@/lib/mock/config";
import type { Candle } from "@/lib/mock/types";
import { monthStage } from "@/lib/data/derive";
import { dailyShares, holdingView, sharesByDay } from "./view";
import { barText, clipRange, closesStat, closeWhy, countText, dayBars, frontHeld, inText, moneyScale, nextShareStat, paidLine, payOutStat, paysCell, spanHours, steps, valueLine, type ValueInput } from "./frame";

const HOUR = 3_600_000;

const at = (m: Moment) => {
  const market = momentMarket("H100", m);
  const series = market.series.find((s) => s.month === "2026-11")!;
  const held = holderPositions(m);
  const by = (id: string) => held.find((p) => p.id === id)!;
  return { market, series, now: momentNow(m), held, daily: by("example-nov-daily"), long: by("example-nov-long"), short: by("example-nov-short") };
};

const candle = (t: string, c: number, v = 240): Candle => ({ t, o: c, h: c, l: c, c, v });

describe("valueLine: the scope's value, only from real candles and the holdings' own numbers", () => {
  const h = (o: Partial<ValueInput> = {}): ValueInput => ({ start: Date.parse("2026-10-03T05:10:00Z"), q: 100, long: true, cap: 8, entry: 4, key: "H100 2026-11", now: null, ...o });

  test("it starts at what was paid, then follows the month's closes hour by hour", () => {
    const cs = [candle("2026-10-03T05:00:00Z", 4.1), candle("2026-10-03T06:00:00Z", 4.2), candle("2026-10-03T07:00:00Z", 4.3)];
    const { points, quiet } = valueLine([h()], { "H100 2026-11": cs }, Date.parse("2026-10-03T08:00:00Z"));
    expect(quiet).toBe(false);
    expect(points.map((p) => Math.round(p.value * 1e6) / 1e6)).toEqual([400, 410, 420, 430]);
    expect(points[0].t).toBe(Date.parse("2026-10-03T05:10:00Z"));
    expect(points.every((p) => p.cost === 400)).toBe(true);
  });

  test("a Short is the ceiling less the price; the end uses the header's own price", () => {
    const cs = [candle("2026-10-03T05:00:00Z", 4.5)];
    const { points } = valueLine([h({ long: false, now: 5 })], { "H100 2026-11": cs }, Date.parse("2026-10-03T07:30:00Z"));
    expect(points[0].value).toBeCloseTo((8 - 4) * 100, 9);
    expect(points[1].value).toBeCloseTo((8 - 4.5) * 100, 9);
    expect(points[points.length - 1].value).toBeCloseTo((8 - 5) * 100, 9);
  });

  test("no trade since it was bought: flat at its price, said quiet, and now at the header's price", () => {
    const before = [candle("2026-10-02T05:00:00Z", 3.9)];
    const { points, quiet } = valueLine([h({ now: 4.4 })], { "H100 2026-11": before }, Date.parse("2026-10-04T05:00:00Z"));
    expect(quiet).toBe(true);
    expect(new Set(points.slice(0, -1).map((p) => p.value))).toEqual(new Set([400]));
    expect(points[points.length - 1].value).toBeCloseTo(440, 9);
    expect(valueLine([h()], {}, Date.parse("2026-10-04T05:00:00Z")).quiet).toBe(true);
  });

  test("a second holding adds to both lines from when it was bought; the cost line steps", () => {
    const cs = Array.from({ length: 6 }, (_, i) => candle(new Date(Date.parse("2026-10-03T05:00:00Z") + i * HOUR).toISOString(), 4));
    const later = h({ start: Date.parse("2026-10-03T08:30:00Z"), q: 50, entry: 4.2 });
    const { points } = valueLine([h(), later], { "H100 2026-11": cs }, Date.parse("2026-10-03T10:00:00Z"));
    const costs = [...new Set(points.map((p) => p.cost))];
    expect(costs).toEqual([400, 400 + 210]);
    const atBuy = points.find((p) => p.t === Date.parse("2026-10-03T08:30:00Z"))!;
    expect(atBuy.value).toBeCloseTo(400 + 210, 9);
  });

  test("a cost that is not known draws no cost line", () => {
    const { points } = valueLine([h({ entry: 0, now: 4 })], { "H100 2026-11": [candle("2026-10-03T05:00:00Z", 4)] }, Date.parse("2026-10-03T07:00:00Z"));
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.cost === null)).toBe(true);
  });

  test("the example: worth plus paid at the end is what the holdings are valued at now", () => {
    const { series, now, daily, long, short } = at("nov13");
    const last = series.quote!.last;
    const cs = momentCandles("H100", "2026-11", "nov13");
    const input = [daily, long, short].map((p) => ({ start: Date.parse(p.openedAt), q: p.q, long: p.side === "long", cap: series.cap, entry: p.entry, key: "k", now: last }));
    const { points } = valueLine(input, { k: cs }, now);
    const end = points[points.length - 1];
    const views = [daily, long, short].map((p) => ({ p, v: holdingView(p, series, last, now) }));
    const worthPlusPaid = views.reduce((a, x) => a + x.v.worth! + x.p.paid, 0);
    expect(end.value).toBeCloseTo(worthPlusPaid, 4);
    expect(end.cost).toBeCloseTo(views.reduce((a, x) => a + x.v.cost!, 0), 6);
    expect(end.value - end.cost!).toBeCloseTo(views.reduce((a, x) => a + x.v.change!, 0), 4);
    // hourly from Oct 3 to Nov 13
    expect(spanHours(points)).toBeGreaterThan(40 * 24);
  });

  test("clipRange keeps the last hours and enters where the line stood", () => {
    const pts = [0, 1, 2, 3, 4].map((i) => ({ t: i * HOUR * 10, value: i, cost: 0 }));
    const r = clipRange(pts, 15);
    expect(r[0]).toEqual({ t: 25 * HOUR, value: 2, cost: 0 });
    expect(r.slice(1).map((p) => p.value)).toEqual([3, 4]);
    expect(clipRange(pts, null)).toBe(pts);
    expect(clipRange(pts, 1000)).toBe(pts);
  });

  test("moneyScale: whole-dollar round steps around the values", () => {
    const { lo, hi, ticks } = moneyScale([6000, 6150]);
    expect(lo).toBeLessThanOrEqual(6000);
    expect(hi).toBeGreaterThanOrEqual(6150);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks.every((v) => Number.isInteger(v))).toBe(true);
    expect(moneyScale([100, 100]).ticks.length).toBeGreaterThan(1);
  });
});

describe("Paid to you: the month's days as bars", () => {
  test("the example mid-month: a bar per day, the priced days paid, the rest still to come", () => {
    const { market, series, daily } = at("nov13");
    const sh = dailyShares(daily, series, market.history)!;
    const bars = dayBars(series, sharesByDay([sh.days]));
    expect(bars.length).toBe(series.n);
    expect(bars.filter((b) => b.kind === "paid").length).toBe(series.k);
    expect(bars.filter((b) => b.kind === "ahead").length).toBe(series.n - series.k);
    expect(paidLine(sh.atOnce, sharesByDay([sh.days]))).toMatch(/^Paid when bought \$[\d,]+\.\d\d, then 12 daily shares \$[\d,]+\.\d\d\.$/);
  });

  test("bar and line words", () => {
    expect(barText({ date: "2026-11-12", kind: "paid", amount: 114.24, price: 4.33 })).toBe("Nov 12, priced at $4.33, +$114.24");
    expect(barText({ date: "2026-11-01", kind: "atOnce", amount: 0, price: null })).toBe("Nov 1, paid when bought");
    expect(barText({ date: "2026-11-20", kind: "ahead", amount: 0, price: null })).toBe("Nov 20, still to come");
    expect(paidLine(1440, [])).toBe("Paid when bought $1,440.00.");
    expect(paidLine(0, [{ date: "2026-11-02", price: 4, amount: 10 }])).toBe("Paid in 1 daily share, $10.00.");
    expect(paidLine(0, [])).toBe("Nothing paid yet.");
  });
});

describe("the header's figures", () => {
  test("next share: before the month its first day, during it the next, then all paid", () => {
    const oct = at("oct");
    expect(nextShareStat(oct.series, monthStage(oct.series, oct.now), oct.now)).toEqual({ value: "Nov 2", small: "07:00 UTC, in 30 days" });
    const mid = at("nov13");
    expect(nextShareStat(mid.series, monthStage(mid.series, mid.now), mid.now)).toEqual({ value: "Nov 14", small: "07:00 UTC, in 22h" });
    const fin = at("dec1final");
    expect(nextShareStat(fin.series, monthStage(fin.series, fin.now), fin.now).value).toBe("All paid");
  });

  test("pays out and trading closes", () => {
    const oct = at("oct");
    const st = monthStage(oct.series, oct.now);
    expect(payOutStat(oct.series, st)).toEqual({ value: "Dec 1", small: "about 07:00 UTC" });
    expect(closesStat(oct.series, st, oct.now)).toEqual({ value: "Nov 30", small: "in 58 days" });
    const last = at("nov30");
    expect(closesStat(last.series, monthStage(last.series, last.now), last.now)).toEqual({ value: "Today", small: "until 23:00 UTC" });
    const fin = at("dec1final");
    expect(closesStat(fin.series, "final", fin.now)).toEqual({ value: "Nov 30", small: "closed" });
  });

  test("the front held month is the first still trading", () => {
    const a = { month: "2026-10" };
    const b = { month: "2026-11" };
    expect(frontHeld([{ series: b, stage: "paying" }, { series: a, stage: "final" }])).toBe(b);
    expect(frontHeld([{ series: b, stage: "final" }, { series: a, stage: "final" }])).toBe(a);
    expect(frontHeld([])).toBeUndefined();
  });

  test("short words", () => {
    expect(countText(1)).toBe("1 holding");
    expect(countText(3)).toBe("3 holdings");
    expect(countText(2, true)).toBe("2 holdings, own pocket");
    const now = Date.parse("2026-11-13T09:00:00Z");
    expect(inText("2026-11-13T09:20:00Z", now)).toBe("in 20m");
    expect(inText("2026-11-14T07:00:00Z", now)).toBe("in 22h");
    expect(inText("2026-11-20T09:00:00Z", now)).toBe("in 7 days");
    expect(inText("2026-11-13T08:00:00Z", now)).toBeNull();
  });
});

describe("the list and the rail", () => {
  test("pays: paid so far, at month end, ready, collected", () => {
    const base = { done: false, ready: 0, final: false, stage: "paying" as const };
    expect(paysCell(true, 2808.4, base)).toBe("Paid $2,808");
    expect(paysCell(false, 0, base)).toBe("At month end");
    expect(paysCell(false, 0, { ...base, final: true, stage: "final", ready: 114 })).toBe("Ready to collect");
    expect(paysCell(false, 0, { ...base, final: true, stage: "final", done: true })).toBe("Collected");
    expect(paysCell(false, 0, { ...base, stage: "closed" })).toBe("Once final");
  });

  test("the timeline: bought, the daily shares, trading closes; a plain holding pays after trading closes", () => {
    const { series, now, daily, long } = at("nov13");
    const stage = monthStage(series, now);
    const d = steps({ openedAt: daily.openedAt, daily: true, series, stage, now });
    expect(d.map((x) => x.label)).toEqual(["Bought", "Pays a share each day", "Trading closes"]);
    expect(d[1]).toMatchObject({ when: "Nov 2 to Dec 1", sub: `${series.k} of ${series.n} paid`, done: true });
    expect(d[2]).toMatchObject({ when: "Nov 30, 23:00 UTC", done: false });
    const p = steps({ openedAt: long.openedAt, daily: false, series, stage, now });
    expect(p.map((x) => x.label)).toEqual(["Bought", "Trading closes", "Pays at month end"]);
    expect(p[2].when).toBe("Dec 1, about 07:00 UTC");
    // an unknown purchase time leaves the first row out
    expect(steps({ openedAt: "", daily: false, series, stage, now }).length).toBe(2);
  });

  test("final: the plain holding's last row is its final price", () => {
    const { series, now } = at("dec1final");
    const p = steps({ openedAt: "2026-10-03T05:10:00Z", daily: false, series, stage: "final", now });
    expect(p[p.length - 1].label).toMatch(/^Final at \$\d\.\d\d$/);
    expect(p.every((x) => x.done)).toBe(true);
    expect(p[1].label).toBe("Trading closed");
  });

  test("why there is no close form", () => {
    expect(closeWhy("paying", "November", true, "position")).toBeNull();
    expect(closeWhy("final", "November", false, "position")).toBeNull();
    expect(closeWhy("closed", "November", true, "tokens")).toBe("November has stopped trading, so this one settles at the final price.");
    expect(closeWhy("paying", "November", false, "tokens")).toContain("Kuru");
  });
});
