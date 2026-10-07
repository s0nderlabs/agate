import { describe, expect, test } from "bun:test";
import { TESTNET_INDEXES } from "@agate/client";
import { getMarket } from "@/lib/mock/data";
import type { IndexDay, Market } from "@/lib/mock/types";
import { INDEX_CONTRACT, pageLabel, pricePage } from "./pages";
import { changeOver, cloudRows, countdownLong, lineScale, middleCheck, middleOf, nextPriceText, pctText, placeLabels, readText, recentDays, sparkPath } from "./view";

const day = (date: string, price: number, extra: Partial<IndexDay> = {}): IndexDay => ({ date, price, status: "final", example: false, ...extra });

describe("the index contract", () => {
  test("is the production index the client knows (a copy, so the page does not load viem up front)", () => {
    expect(INDEX_CONTRACT.toLowerCase()).toBe(TESTNET_INDEXES.production.index.toLowerCase());
  });
});

describe("changeOver: the index against a day some days back", () => {
  const h = [day("2026-09-01", 4.0), day("2026-09-25", 3.9), day("2026-10-01", 3.95), day("2026-10-02", 3.99)];
  test("1 day: the day before", () => {
    const c = changeOver(h, 1)!;
    expect(c.base.date).toBe("2026-10-01");
    expect(c.delta).toBe(0.04);
    expect(c.pct).toBeCloseTo(0.04 / 3.95, 6);
  });
  test("7 days: the last day on or before a week back", () => {
    expect(changeOver(h, 7)!.base.date).toBe("2026-09-25");
  });
  test("a stretch the record does not reach is null, never a shorter one passed off as it", () => {
    expect(changeOver([day("2026-10-04", 3.9), day("2026-10-05", 3.95)], 7)).toBeNull();
    expect(changeOver([day("2026-10-05", 3.95)], 1)).toBeNull();
    expect(changeOver([], 1)).toBeNull();
  });
  test("percent text uses the true minus sign and says no change plainly", () => {
    expect(pctText(0.0101)).toBe("+1.0%");
    expect(pctText(-0.004)).toBe("−0.4%");
    expect(pctText(0.0001)).toBe("0.0%");
  });
});

describe("recentDays: the last days, newest first", () => {
  test("each against the day before it; the first has no change; kinds follow the day's flags", () => {
    const rows = recentDays([day("2026-10-01", 3.9, { onchain: false }), day("2026-10-02", 3.9, { example: true }), day("2026-10-03", 3.95, { status: "carried" })], 14);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-03", "2026-10-02", "2026-10-01"]);
    expect(rows[0].change).toBe(0.05);
    expect(rows[0].status).toBe("carried");
    expect(rows.map((r) => r.kind)).toEqual(["onchain", "example", "logger"]);
    expect(rows[2].change).toBeNull();
  });
  test("keeps to n rows", () => {
    const many = Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`, 4 + i / 100));
    expect(recentDays(many, 14)).toHaveLength(14);
  });
});

describe("cloudRows and middleCheck on the example H100", () => {
  const m = getMarket("H100");
  test("low to high, the middle counted cloud marked, the reserve not counted, every row with its page", () => {
    const rows = cloudRows(m);
    expect(rows.map((r) => r.family)).toEqual(["Civo", "Hyperstack", "Verda", "Lambda", "Nebius", "CoreWeave"]);
    expect(rows.filter((r) => r.middle).map((r) => r.family)).toEqual(["Lambda"]);
    const hs = rows.find((r) => r.family === "Hyperstack")!;
    expect(hs.counted).toBe(false);
    expect(hs.reserve).toBe(true);
    expect(rows.every((r) => r.url !== null)).toBe(true);
  });
  test("the middle of the counted clouds equals the onchain price", () => {
    const c = middleCheck(m)!;
    expect(c.count).toBe(5);
    expect(c.mid).toBe(3.99);
    expect(c.onchain).toBe(3.99);
    expect(c.same).toBe(true);
  });
  test("live data never lists the reserve in sources: the panel adds it, unread", () => {
    const live: Market = { ...m, sources: m.sources.filter((x) => x.family !== "Hyperstack") };
    const hs = cloudRows(live).find((r) => r.family === "Hyperstack")!;
    expect(hs.price).toBeNull();
    expect(readText(hs, live)).toBe("Not read while it waits as the reserve");
    expect(readText(cloudRows(live)[0], live)).toBe("Read every hour on Oct 2");
  });
  test("the middle is worked in whole cents as the contract does: an even count's half cent rounds up", () => {
    const four: Market = { ...m, sources: [1.01, 1.02, 0.9, 1.4].map((price, i) => ({ family: `C${i}`, price, live: true })) };
    expect(middleOf(four)).toBe(1.02);
    expect(middleOf({ ...m, sources: [] })).toBeNull();
  });
  test("two counted clouds at the middle price: only one is marked the index", () => {
    const tie: Market = { ...m, sources: [2.99, 3.99, 3.99, 4.5, 6.16].map((price, i) => ({ family: `C${i}`, price, live: true })), panel: [] };
    expect(cloudRows(tie).filter((r) => r.middle)).toHaveLength(1);
  });
  test("before the first final day there is nothing to check", () => {
    expect(middleCheck(getMarket("B300"))).toBeNull();
    expect(cloudRows(getMarket("B300")).every((r) => r.price === null && !r.middle)).toBe(true);
  });
});

describe("placeLabels: names under the price line never overlap", () => {
  test("far apart: all on the first row", () => {
    expect(placeLabels([50, 300, 600], [60, 60, 60], 800, 3)).toEqual([0, 0, 0]);
  });
  test("crowded: the next row, then dropped when every row is taken", () => {
    expect(placeLabels([100, 110, 120, 130], [80, 80, 80, 80], 800, 3)).toEqual([0, 1, 2, -1]);
  });
  test("labels at the edges are pulled inside the line", () => {
    expect(placeLabels([0, 800], [100, 100], 800, 1)).toEqual([0, 0]);
  });
  test("by rank: on a crowded phone line the index keeps its name and a cloud not counted drops first", () => {
    // Civo, Hyperstack (not counted), Verda, Lambda (the index), Nebius, CoreWeave at 327 px, two rows
    const x = [23, 41, 82, 111, 157, 305];
    const w = [46, 142, 46, 54, 54, 78];
    const rows = placeLabels(x, w, 327, 2, 12, [1, 2, 1, 0, 1, 1]);
    expect(rows[3]).toBe(0);
    expect(rows[1]).toBe(-1);
    expect(rows.filter((r) => r >= 0)).toHaveLength(5);
  });
});

describe("scales stay honest", () => {
  test("two close prices are not stretched across the whole line", () => {
    const { lo, hi } = lineScale([3.99, 4.0]);
    expect(hi - lo).toBeGreaterThan(0.39);
  });
  test("a sparkline needs two days and keeps a cent of noise small", () => {
    expect(sparkPath([day("2026-10-02", 3.99)], 100, 20)).toBe("");
    const p = sparkPath([day("2026-10-01", 3.99), day("2026-10-02", 4.0)], 100, 20);
    const ys = [...p.matchAll(/V([\d.]+)/g)].map((x) => Number(x[1]));
    const y0 = Number(p.match(/^M0,([\d.]+)/)![1]);
    expect(Math.abs(y0 - ys[0])).toBeLessThan(2);
  });
});

describe("the next price", () => {
  test("a countdown to the second, in days past 48 hours, null once due", () => {
    const now = Date.parse("2026-10-06T12:27:53Z");
    expect(countdownLong("2026-10-07T07:00:00Z", now)).toBe("18h 32m 07s");
    expect(countdownLong("2026-10-10T07:00:00Z", now)).toBe("3 days");
    expect(countdownLong("2026-10-06T07:00:00Z", now)).toBeNull();
  });
  test("published, then final, in that order; in its checks between the two", () => {
    expect(nextPriceText({ nextCloseAt: "2026-10-07T01:00:00Z", nextUpdateAt: "2026-10-07T07:00:00Z" })).toBe("Published about 01:00 UTC, final about 07:00 UTC on Oct 7");
    expect(nextPriceText({ nextCloseAt: "2026-10-08T01:00:00Z", nextUpdateAt: "2026-10-07T07:00:00Z" })).toBe("Published and in its six hours of checks, final about 07:00 UTC on Oct 7");
  });
});

describe("pages", () => {
  test("a known cloud links to the page it is read from; an unknown one has no link", () => {
    expect(pricePage("Civo")).toBe("https://www.civo.com/pricing");
    expect(pricePage("Nowhere")).toBeNull();
    expect(pageLabel("https://www.civo.com/pricing")).toBe("civo.com/pricing");
  });
});
