// The pre-launch history (src/prelaunch.ts, the index's model driven by the archive): on the committed archive fixture
// (Sep 30 17 UTC to Oct 3 08 UTC, so Oct 1 and Oct 2 are whole days) it must equal a by-hand mean-then-median, keep the
// reserve out, hold a short slot at its last price, carry a day without readings and skip a first day without any. On
// the live archive the committed file must be what it gives.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archivePresent, type HourValues, listHours, valuesOfHour } from "@agate/sources/io";
import type { Panel } from "@agate/sources/types";
import { dayAndSlice, dayOfDate, prelaunchDays } from "../src/prelaunch.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const fixture = json("wall/packages/sources/test/fixtures/archive-values.json").hours as HourValues[];
const panels = json("wall/packages/sources/panels/launch.json").panels as Panel[];
const config = json("contracts/script/config/testnet-production.json");
const { day, slices, minReadings, qMin, signAll, demoLabel, epochDay } = config.profile;
const P = { day, slices, minReadings, qMin, signAll, demoLabel, epochDay, epochTs: 0 };
const OCT1 = 20727;
const OCT2 = 20728;
const panel = (g: string) => panels.find((p) => p.gpu === g)!;

// independent of computeRecord: per live slot the cent-rounded floor mean of its valid in-bounds hours (at least
// minReadings), then the cent-rounded median over the slots (one family per slot on the launch panel)
const centOf = (v: number) => Math.floor((v + 5_000) / 10_000) * 10_000;
function byHand(p: Panel, hours: readonly HourValues[], day: number): number {
  const vals: number[] = [];
  for (const s of p.slots) {
    if (!s.liveAtStart) continue;
    const xs = hours
      .filter((h) => dayAndSlice(h.hour)[0] === day)
      .map((h) => h.sources[s.sourceId]?.rows[p.gpu])
      .filter((r) => r !== undefined && r.s === "VALID" && r.v >= 100_000 && r.v <= 1_000_000_000)
      .map((r) => r!.v);
    if (xs.length >= P.minReadings) vals.push(centOf(Math.floor(xs.reduce((a, b) => a + b, 0) / xs.length)));
  }
  vals.sort((a, b) => a - b);
  const n = vals.length;
  return centOf(n % 2 === 1 ? vals[(n - 1) / 2]! : Math.floor((vals[n / 2 - 1]! + vals[n / 2]!) / 2));
}
/** The fixture with one source's row for one GPU rewritten per hour: a value, null (no row), undefined (as it was). */
function edit(src: string, gpu: string, v: (h: HourValues) => number | null | undefined): HourValues[] {
  return fixture.map((h) => {
    const s = h.sources[src];
    const x = v(h);
    if (x === undefined || !s) return h;
    const rows = { ...s.rows };
    if (x === null) delete rows[gpu as keyof typeof rows];
    else rows[gpu as keyof typeof rows] = { s: "VALID", v: x };
    return { ...h, sources: { ...h.sources, [src]: { ...s, rows } } };
  });
}
const run = (hours: readonly HourValues[], fromDay = OCT1, toDay = OCT2) => prelaunchDays({ hours, panels, profile: P, fromDay, toDay });

describe("pre-launch history", () => {
  test("Oct 1 and Oct 2 from the fixture equal the by-hand mean-then-median, every GPU, 24 hours each", () => {
    const out = run(fixture);
    for (const p of panels) {
      expect(out[p.gpu]!.map((d) => [d.date, d.valueU, d.hours])).toEqual([
        ["2026-10-01", byHand(p, fixture, OCT1), 24],
        ["2026-10-02", byHand(p, fixture, OCT2), 24],
      ]);
      expect(out[p.gpu]!.every((d) => d.valueU % 10_000 === 0 && d.valueU > 0)).toBe(true);
    }
  });

  test("the reserve slot never counts: H100's reserve at $99 changes nothing", () => {
    const h100 = panel("H100");
    const reserve = h100.slots.find((s) => !s.liveAtStart)!;
    const before = run(fixture).H100!.map((d) => d.valueU);
    expect(run(edit(reserve.sourceId, "H100", () => 99_000_000)).H100!.map((d) => d.valueU)).toEqual(before);
  });

  test("a slot short of minReadings on a day is held at its last price, as the chain would hold it", () => {
    const h100 = panel("H100");
    const src = h100.slots.find((s) => s.liveAtStart)!.sourceId;
    // the source's Oct 2: its first k hours quote $50 (far above every other cloud), the rest of the day nothing
    const oct2 = fixture.filter((h) => dayAndSlice(h.hour)[0] === OCT2).map((h) => h.hour);
    const at50 = (k: number) => edit(src, "H100", (h) => (dayAndSlice(h.hour)[0] !== OCT2 ? undefined : oct2.indexOf(h.hour) < k ? 50_000_000 : null));
    // the same as the source quoting exactly its Oct 1 price all of Oct 2
    const oct1 = run(fixture).H100![0]!;
    const xs = fixture.filter((h) => dayAndSlice(h.hour)[0] === OCT1).map((h) => h.sources[src]!.rows.H100!.v);
    const e1 = centOf(Math.floor(xs.reduce((a, b) => a + b, 0) / xs.length));
    const held = run(edit(src, "H100", (h) => (dayAndSlice(h.hour)[0] === OCT2 ? e1 : undefined))).H100![1]!.valueU;
    // minReadings - 1 hours at $50: not enough to count, the slot is held at its Oct 1 price
    expect(run(at50(P.minReadings - 1)).H100![1]!.valueU).toBe(held);
    expect(run(at50(P.minReadings - 1)).H100![0]).toEqual(oct1);
    // control: minReadings hours at $50 count, and the day moves
    expect(run(at50(P.minReadings)).H100![1]!.valueU).toBeGreaterThan(held);
  });

  test("hours of other days never count; a day without readings is carried, a first day without any is skipped", () => {
    const oct1Only = fixture.filter((h) => dayAndSlice(h.hour)[0] <= OCT1);
    const out = run(oct1Only);
    for (const p of panels) {
      const v = byHand(p, fixture, OCT1);
      expect(out[p.gpu]!.map((d) => [d.date, d.valueU, d.status, d.hours])).toEqual([
        ["2026-10-01", v, out[p.gpu]![0]!.status, 24],
        ["2026-10-02", v, "CARRIED", 0],
      ]);
      expect(out[p.gpu]![0]!.status).not.toBe("CARRIED");
    }
    expect(run(fixture, OCT2, OCT2).H100!.map((d) => d.valueU)).toEqual([byHand(panel("H100"), fixture, OCT2)]);
    // no reading at all on the first day: nothing to carry, the day is skipped and Oct 2 is the entry day
    const late = run(fixture.filter((h) => dayAndSlice(h.hour)[0] !== OCT1));
    expect(late.H100!.map((d) => [d.date, d.valueU])).toEqual([["2026-10-02", byHand(panel("H100"), fixture, OCT2)]]);
  });

  test("the archive's hour names only, and only a 24-slice profile", () => {
    expect(dayAndSlice("2026-10-01T05")).toEqual([OCT1, 5]);
    expect(dayAndSlice("2026-10-02T23")).toEqual([OCT2, 23]);
    expect(dayOfDate("2026-10-01")).toBe(OCT1);
    for (const bad of ["2026-10-01", "2026-10-01T5", "2026-10-01 05", "2026-02-30T00", "2026-10-01T24", ""]) expect(() => dayAndSlice(bad)).toThrow(/not an archive hour/);
    expect(() => dayOfDate("2026-02-30")).toThrow(/not an archive hour/);
    expect(() => prelaunchDays({ hours: fixture, panels, profile: { ...P, slices: 4, minReadings: 2 }, fromDay: OCT1, toDay: OCT1 })).toThrow(/archive is hourly/);
    expect(() => prelaunchDays({ hours: fixture, panels, profile: { ...P, epochTs: 3_600 }, fromDay: OCT1, toDay: OCT1 })).toThrow(/archive is hourly/);
  });

  test.skipIf(!archivePresent())("the committed 10143-prelaunch.json is what the archive gives (rerun scripts/prelaunch.ts)", () => {
    const doc = json("contracts/deployments/10143-prelaunch.json");
    const prod = json("contracts/deployments/10143-indexes.json").production;
    expect([doc.index, doc.firstDay]).toEqual([prod.index, prod.firstDay]);
    const hours = listHours()
      .filter((h) => dayOfDate(h.date) >= doc.fromDay && dayOfDate(h.date) <= prod.firstDay)
      .map((h) => valuesOfHour(h));
    const before = prelaunchDays({ hours, panels, profile: P, fromDay: doc.fromDay, toDay: prod.firstDay - 1 });
    const first = prelaunchDays({ hours, panels, profile: P, fromDay: prod.firstDay, toDay: prod.firstDay });
    for (const p of panels) {
      expect(before[p.gpu]).toEqual(doc.days[p.gpu]);
      expect(first[p.gpu]![0] ?? null).toEqual(doc.check.values[p.gpu]);
    }
  });
});
