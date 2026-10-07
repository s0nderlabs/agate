import { describe, expect, test } from "bun:test";
import { getMarket } from "@/lib/mock/data";
import type { IndexDay, Market } from "@/lib/mock/types";
import { changeWords, checkLine, cloudsCell, dayItems, dayMove, howSteps, ladder, periodCell, periodCells, railLine, recordStart, tradeLabel } from "./marketView";

const day = (date: string, price: number, extra: Partial<IndexDay> = {}): IndexDay => ({ date, price, status: "final", example: false, ...extra });
const NOW = Date.parse("2026-10-03T06:00:00Z");

describe("dayMove: the line under the big price", () => {
  test("a move up or down, in its tone, and the day the price is for", () => {
    const m = getMarket("H100");
    const up = dayMove({ ...m, price: 4.04, prevPrice: 3.99 });
    expect(up).toEqual({ text: "+$0.05 since yesterday", tone: "up", quiet: "The price for Oct 2" });
    expect(dayMove({ ...m, price: 3.94, prevPrice: 3.99 }).tone).toBe("down");
    expect(dayMove({ ...m, prevPrice: m.price }).text).toBe("Same as yesterday");
  });
  test("a carried day says so instead of a move", () => {
    const m = getMarket("H100", "carried");
    expect(dayMove(m)).toEqual({ text: "Carried from the day before, unverified", tone: null, quiet: "The price for Oct 2" });
  });
  test("the first day of the record, and before the first price", () => {
    const m = getMarket("H100");
    expect(dayMove({ ...m, history: [day("2026-10-04", 3.99)] }).text).toBe("First day of our record");
    const b = getMarket("B300");
    expect(dayMove(b)).toEqual({ text: "First price about 07:00 UTC", tone: null, quiet: "" });
  });
});

describe("periodCell: 7 and 30 days", () => {
  const h = [day("2026-09-01", 3.85), day("2026-09-25", 4.08), day("2026-10-01", 3.95), day("2026-10-02", 3.99)];
  test("percent in tone, dollars quiet, the base day in the note", () => {
    const c = periodCell(h, 7);
    expect(c.value).toBe("−2.2%");
    expect(c.quiet).toBe("−$0.09");
    expect(c.tone).toBe("down");
    expect(c.note).toBe("Today's price against the price for Sep 25, $4.08.");
    expect(periodCell(h, 30).tone).toBe("up");
  });
  test("no change says so; a stretch the record does not reach is Not yet with where it starts", () => {
    expect(periodCell([day("2026-09-20", 3.99), day("2026-10-02", 3.99)], 7)).toMatchObject({ value: "0.0%", quiet: "No change", tone: null });
    expect(periodCell([day("2026-09-30", 3.9), day("2026-10-02", 3.99)], 7)).toEqual({ value: "Not yet", quiet: "Record starts Sep 30", tone: null, note: null });
  });
  test("where the record starts is said once when neither stretch is reached", () => {
    const short = [day("2026-10-04", 3.99), day("2026-10-05", 3.99)];
    expect(periodCells(short).map((c) => [c.label, c.value, c.quiet])).toEqual([
      ["7 days", "Not yet", "Record starts Oct 4"],
      ["30 days", "Not yet", ""],
    ]);
    expect(periodCells(h).map((c) => c.value)).toEqual(["−2.2%", "+3.6%"]);
  });
  test("the record starts after the example history and the logger's days", () => {
    expect(recordStart([day("2026-09-28", 3.9, { example: true }), day("2026-10-01", 3.9, { onchain: false }), day("2026-10-04", 3.9)])).toBe("2026-10-04");
  });
});

describe("cloudsCell", () => {
  test("counted of the panel, with the reserve only when there is one", () => {
    expect(cloudsCell(getMarket("H100"))).toEqual({ label: "Clouds counted", value: "5 of 5", quiet: "plus 1 reserve" });
    expect(cloudsCell(getMarket("H200")).quiet).toBe("");
    expect(cloudsCell(getMarket("H100", "degraded")).value).toBe("4 of 5");
    expect(cloudsCell(getMarket("L40S"))).toEqual({ label: "Clouds read", value: "3 of 3", quiet: "" });
  });
});

describe("ladder: the clouds as a book", () => {
  test("counted clouds highest on top, the middle one is the index, the reserve apart", () => {
    const l = ladder(getMarket("H100"));
    const names = l.rungs.map((r) => (r.kind === "cloud" ? r.row.family : "mid"));
    expect(names).toEqual(["CoreWeave", "Nebius", "Lambda", "Verda", "Civo"]);
    const mid = l.rungs.find((r) => r.kind === "cloud" && r.row.middle);
    expect(mid?.kind === "cloud" && mid.row.family).toBe("Lambda");
    expect(l.halfway).toBe(false);
    expect(l.rest.map((r) => [r.family, r.reserve])).toEqual([["Hyperstack", true]]);
    // every counted row links to the page its price is read from
    expect(l.rungs.every((r) => r.kind === "cloud" && r.row.url?.startsWith("https://"))).toBe(true);
  });
  test("an even count puts the index halfway between the middle two, and a cloud left out sits with the reserve", () => {
    const l = ladder(getMarket("H100", "degraded"));
    const names = l.rungs.map((r) => (r.kind === "cloud" ? r.row.family : `mid ${r.price}`));
    expect(names).toEqual(["Nebius", "Lambda", "mid 3.83", "Verda", "Civo"]);
    expect(l.halfway).toBe(true);
    expect(l.rest.map((r) => r.family)).toEqual(["CoreWeave", "Hyperstack"]);
  });
  test("before the first price: the clouds being read, no prices, no index", () => {
    const l = ladder(getMarket("B300"));
    expect(l.rungs.map((r) => r.kind === "cloud" && r.row.price)).toEqual([null, null, null]);
    expect(l.rungs.some((r) => r.kind === "mid")).toBe(false);
    expect(l.rest.map((r) => r.family)).toEqual(["Hyperstack"]);
  });
});

describe("railLine and checkLine", () => {
  test("the rail's sentence follows the data", () => {
    const m = getMarket("H100");
    expect(railLine(m.gpu)).toBe("Each cloud's own on-demand H100 price, read every hour. The middle one sets the day's price.");
    expect(railLine(m.gpu, { halfway: true })).toContain("halfway between the middle two");
    expect(railLine("B300", { before: true })).toBe("Each cloud's own on-demand B300 price, read every hour. From the first day, the middle one sets the day's price.");
  });
  test("the check: the middle against the contract, both numbers either way", () => {
    expect(checkLine(getMarket("H100"))).toEqual({ text: "The middle of these five is $3.99, and the index contract reads $3.99.", same: true });
    const off: Market = { ...getMarket("H100"), price: 4.05 };
    expect(checkLine(off)).toEqual({ text: "The middle of these five is $3.99, but the index contract reads $4.05. The contract's price is the one that pays.", same: false });
    const carried: Market = { ...getMarket("H100", "carried"), price: 4.05 };
    expect(checkLine(carried)?.text).toBe("The middle of these five is $3.99. The index contract reads $4.05, carried from the day before.");
    expect(checkLine(getMarket("B300"))).toBeNull();
  });
});

describe("dayItems: the day-by-day list", () => {
  const days = [
    day("2026-09-28", 3.9, { example: true }),
    day("2026-09-29", 3.95, { example: true }),
    day("2026-09-30", 3.95),
    day("2026-10-01", 3.95, { status: "carried" }),
    day("2026-10-02", 3.99),
  ];
  test("newest first, each against the day before, one divider before the example days", () => {
    const items = dayItems(days, "ALL");
    expect(items.map((i) => (i.type === "day" ? i.date : i.text))).toEqual(["2026-10-02", "2026-10-01", "2026-09-30", "Example history before Sep 30", "2026-09-29", "2026-09-28"]);
    const first = items[0];
    expect(first.type === "day" && first.change).toBe(0.04);
    const carried = items[1];
    expect(carried.type === "day" && carried.carried).toBe(true);
    const oldest = items[items.length - 1];
    expect(oldest.type === "day" && oldest.change).toBeNull();
  });
  test("a range keeps the chart's span; the oldest day shown keeps its change from the day before it", () => {
    const items = dayItems(days, "1W");
    expect(items.filter((i) => i.type === "day")).toHaveLength(5);
    const many = Array.from({ length: 12 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`, 3.9 + i / 100));
    const w = dayItems(many, "1W");
    expect(w).toHaveLength(7);
    const last = w[6];
    expect(last.type === "day" && last.date).toBe("2026-10-06");
    expect(last.type === "day" && last.change).toBe(0.01);
  });
  test("the logger's days have their own divider", () => {
    const live = [day("2026-10-01", 3.9, { onchain: false }), day("2026-10-02", 3.92, { onchain: false }), day("2026-10-04", 3.95)];
    const items = dayItems(live, "ALL");
    expect(items[1]).toEqual({ type: "divider", kind: "logger", text: "Recorded by our logger before Oct 4, not onchain" });
    expect(items.filter((i) => i.type === "divider")).toHaveLength(1);
  });
  test("change words", () => {
    expect(changeWords(0.05)).toEqual({ text: "+$0.05", tone: "up" });
    expect(changeWords(-0.05)).toEqual({ text: "−$0.05", tone: "down" });
    expect(changeWords(0)).toEqual({ text: "No change", tone: null });
    expect(changeWords(null)).toEqual({ text: "", tone: null });
  });
});

describe("tradeLabel and howSteps", () => {
  test("the month the market page trades; none for an index-only GPU", () => {
    expect(tradeLabel(getMarket("H100"), NOW)).toBe("Trade H100 November");
    expect(tradeLabel(getMarket("B300"), NOW)).toBeNull();
  });
  test("four steps, the GPU named in the first", () => {
    const st = howSteps("H200");
    expect(st).toHaveLength(4);
    expect(st[0].text).toContain("on-demand H200 GPU-hour");
    expect(st.map((x) => x.title)).toEqual(["Read every hour", "The middle counts", "Written onchain", "Final at 07:00 UTC"]);
  });
});
