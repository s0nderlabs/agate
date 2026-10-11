// Check any day yourself (check.ts and AgateClient.checkDay), on fixed inputs: no chain, no network. The real days are
// the production index's stored readings and records of H100 and H200 on Monad testnet for Oct 4 to 10 2026, as
// readings() and record() returned them on Oct 11 2026: the port must reproduce every stored digest byte for byte.
import { describe, expect, test } from "bun:test";
import type { Address, Hex, PublicClient } from "viem";
import { render } from "../scripts/check-day.ts";
import { carryState, checkDayFrom, type DayCheckInput, type DayReadings, type IndexShape, recomputeDay, type StoredRecord } from "../src/check.ts";
import { AgateClient } from "../src/client.ts";
import { PANELS } from "../src/static.ts";
import { AmountError, dateOfDay, dayOfDate } from "../src/units.ts";

const NEVER = 4294967295;
const CRE = "0xF0be5c7461c0743acDE590A22BcCb66Fc2112335" as Address;
const STANDBY = "0x7AB94Da3958d82dF236529c57e46B6D11FE90e92" as Address;

interface FixtureDay {
  day: number;
  rec: Omit<StoredRecord, "exists" | "isFinal">;
  sums: number[];
  counts: number[];
}
interface Fixture {
  gpu: "H100" | "H200";
  gpuId: Hex;
  firstDay: number;
  shape: IndexShape;
  days: FixtureDay[];
}
const rec = (value: number, status: number, fresh: number, held: number, freshMedian: number, changed: boolean, digest: Hex) => ({ value, status, fresh, quorum: 5, held, freshMedian, late: false, incomplete: false, changed, source: CRE, digest });

const H100: Fixture = {
  gpu: "H100",
  gpuId: "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955",
  firstDay: 20730,
  shape: { family: [0, 1, 2, 3, 4, 5], famQ: [1, 1, 1, 1, 1, 1], liveFrom: [20730, 20730, 20730, 20730, 20730, NEVER], liveUntil: Array(6).fill(NEVER) },
  days: [
    { day: 20730, rec: rec(3990000, 1, 5, 0, 3990000, true, "0x001149c65b88aac2167243c155aa3e0bb1a321c485aac675c249892ea76d28f5"), sums: [85540000, 103500000, 91770000, 141680000, 65780000, 0], counts: [23, 23, 23, 23, 22, 0] },
    { day: 20731, rec: rec(3990000, 1, 5, 0, 3990000, false, "0x36063c5c0cfb5b469960d1bbd6219f0f741202fa8ac6064415d74c0d1ee09e31"), sums: [86410000, 103500000, 91770000, 141680000, 68770000, 0], counts: [23, 23, 23, 23, 23, 0] },
    { day: 20732, rec: rec(3990000, 1, 5, 0, 3990000, false, "0x07df609fb7b91947ef2cc61a80cb734c48b547d80aa84dcc763674f7d6d6206e"), sums: [90960000, 108000000, 95760000, 147840000, 71760000, 0], counts: [24, 24, 24, 24, 24, 0] },
    { day: 20733, rec: rec(3990000, 1, 5, 0, 3990000, false, "0x7f5188e35e30ed5db78fbd44dd02a57e4459f830c1122590691813977999f696"), sums: [91960000, 108000000, 95760000, 147840000, 71760000, 0], counts: [24, 24, 24, 24, 24, 0] },
    { day: 20734, rec: rec(3990000, 2, 4, 1, 3930000, false, "0x85281db8a1aacf355d4dfb13b1ded7a2f2018424b13d4b0237e83740f9d66baf"), sums: [92880000, 49500000, 95760000, 147840000, 71760000, 0], counts: [24, 11, 24, 24, 24, 0] },
    { day: 20735, rec: rec(3990000, 2, 4, 1, 3960000, false, "0x1dc2c1ca92324b594b0337799befa04c7ba154a50b2309e1546318be675766da"), sums: [93960000, 0, 95760000, 141680000, 71760000, 0], counts: [24, 0, 24, 23, 24, 0] },
    { day: 20736, rec: rec(3990000, 2, 4, 1, 3960000, false, "0x07ea6fbcb5458012787d9b41f57e2e7f2c7522a7a2b714a7ff21b206951c8f19"), sums: [94320000, 0, 95760000, 147840000, 71760000, 0], counts: [24, 0, 24, 24, 24, 0] },
  ],
};
const H200: Fixture = {
  gpu: "H200",
  gpuId: "0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d",
  firstDay: 20730,
  shape: { family: [0, 1, 2, 3, 4], famQ: [1, 1, 1, 1, 1], liveFrom: Array(5).fill(20730), liveUntil: Array(5).fill(NEVER) },
  days: [
    { day: 20730, rec: rec(4850000, 1, 5, 0, 4850000, true, "0xe5d9fc49870200e5517982a89c1d447939246b7d1964aca3ceb2abfd1dd6876a"), sums: [111640000, 124200000, 145130000, 76780000, 91770000], counts: [23, 23, 23, 22, 23] },
    { day: 20731, rec: rec(4900000, 1, 5, 0, 4900000, true, "0xb20496013de1ebe26c81b0f054fefadfe9b2a464712b130bef260e093c264f09"), sums: [112760000, 124200000, 145130000, 80270000, 91770000], counts: [23, 23, 23, 23, 23] },
    { day: 20732, rec: rec(4950000, 1, 5, 0, 4950000, true, "0x55dc6ed2fc1cc95f16714a9b17896e3073937b3bc9dd5a4367d84ce872c1749a"), sums: [118680000, 129600000, 151440000, 83760000, 95760000], counts: [24, 24, 24, 24, 24] },
    { day: 20733, rec: rec(5000000, 1, 5, 0, 5000000, true, "0x1ab027e4f913f8ec36ae144cdcde46133876cc44e5d0735bcfc9bd2d4dead78f"), sums: [119930000, 129600000, 151440000, 83760000, 95760000], counts: [24, 24, 24, 24, 24] },
    // an even number of fresh companies: freshMedian is the floor mean of the middle two ($3.99 and $5.045 -> $4.52)
    { day: 20734, rec: rec(5050000, 2, 4, 1, 4520000, true, "0x5cd656402768ed01bf80683e035c35467de89dd552b59e1ad376e81264dd5e91"), sums: [121080000, 59400000, 151440000, 83760000, 95760000], counts: [24, 11, 24, 24, 24] },
    { day: 20735, rec: rec(5100000, 2, 4, 1, 4550000, true, "0x1929dd12d1c8bc07e1b42ec7c3ff872fd61a4b0dc53c5a879dcf6e68ba2def09"), sums: [122430000, 0, 145130000, 83760000, 95760000], counts: [24, 0, 23, 24, 24] },
    { day: 20736, rec: rec(5120000, 2, 4, 1, 4560000, true, "0xd256b9bcadb40c77a1ea6c450e6c792191249f55b16a9795d764f4e43d97117a"), sums: [122880000, 0, 151440000, 83760000, 95760000], counts: [24, 0, 24, 24, 24] },
  ],
};
const FULL = (1n << 24n) - 1n;

/** checkDayFrom's input for fixture f checked on `day` (edit: change the fixture's days before the call). */
function inputOf(f: Fixture, day: number, days: FixtureDay[] = f.days): DayCheckInput {
  const records = new Map<number, StoredRecord>();
  const readings = new Map<number, DayReadings>();
  for (const d of days) {
    if (d.day > day) continue;
    records.set(d.day, { exists: true, isFinal: true, ...d.rec });
    readings.set(d.day, { sums: d.sums, counts: d.counts, sliceBits: FULL, late: false });
  }
  const panel = PANELS.find((p) => p.gpu === f.gpu)!;
  return { gpu: f.gpu, gpuId: f.gpuId, day, firstDay: f.firstDay, firstRecordDay: f.firstDay, minReadings: 12, slices: 24, shape: f.shape, names: panel.slots.map((s) => s.family), records, readings, carried: new Map() };
}

describe("real days: the production index on Monad testnet, Oct 4 to 10 2026", () => {
  for (const f of [H100, H200]) {
    test(`${f.gpu}: every day recomputed from its stored readings equals its record, digest included`, () => {
      for (const d of f.days) {
        const r = checkDayFrom(inputOf(f, d.day));
        expect(r.differences).toEqual([]);
        expect(r.match).toBe(true);
        expect(r.recomputed).toBe(r.stored);
        expect(r.stored).toBe(d.rec.value / 1e6);
        expect(r.digest).toEqual({ stored: d.rec.digest.toLowerCase(), recomputed: d.rec.digest.toLowerCase() });
        expect(r.replay).toEqual({ from: "2026-10-04", days: d.day - f.firstDay + 1, mismatches: [] });
      }
    });
  }

  test("H100 Oct 9: Nebius dark (0 readings) is held at its last good day price, the reserve is out, the median is $3.99", () => {
    const r = checkDayFrom(inputOf(H100, 20735));
    expect(r.date).toBe("2026-10-09");
    expect(r.status).toBe("degraded");
    expect(r.source).toBe(CRE.toLowerCase());
    expect(r.sources).toEqual([
      { family: "Verda", slot: 0, readings: 24, dayPrice: 3.92, kind: "fresh", used: 3.92 },
      // Oct 8 had 11 readings (below 12): held from Oct 7's $4.50, and still held on Oct 9
      { family: "Nebius", slot: 1, readings: 0, dayPrice: null, kind: "held", used: 4.5 },
      { family: "Lambda", slot: 2, readings: 24, dayPrice: 3.99, kind: "fresh", used: 3.99 },
      { family: "CoreWeave", slot: 3, readings: 23, dayPrice: 6.16, kind: "fresh", used: 6.16 },
      { family: "Civo", slot: 4, readings: 24, dayPrice: 2.99, kind: "fresh", used: 2.99 },
      { family: "Hyperstack", slot: 5, readings: 0, dayPrice: null, kind: "out", used: null },
    ]);
  });

  test("a changed reading or a changed stored value never passes", () => {
    const tampered = H100.days.map((d) => (d.day === 20735 ? { ...d, sums: d.sums.map((s, i) => (i === 3 ? s + 23 * 100_000 : s)) } : d));
    const r = checkDayFrom(inputOf(H100, 20735, tampered));
    expect(r.match).toBe(false);
    expect(r.differences).toContain("digest"); // CoreWeave's day price moves $0.10: the digest covers every day price
    const value = H100.days.map((d) => (d.day === 20736 ? { ...d, rec: { ...d.rec, value: 4_000_000 } } : d));
    const v = checkDayFrom(inputOf(H100, 20736, value));
    expect(v.match).toBe(false);
    expect(v.differences).toEqual(["value"]);
    expect(v.recomputed).toBe(3.99);
    expect(v.stored).toBe(4);
  });

  test("an earlier day that disagrees is named in the replay; the checked day is still judged on its own record", () => {
    const bad = H100.days.map((d) => (d.day === 20732 ? { ...d, rec: { ...d.rec, digest: `0x${"11".repeat(32)}` as Hex } } : d));
    const r = checkDayFrom(inputOf(H100, 20736, bad));
    expect(r.match).toBe(true);
    expect(r.replay.mismatches).toEqual(["2026-10-06"]);
  });
});

describe("the formula on a small panel", () => {
  // three companies, each its own family, all live from day 20730 (Oct 4 2026)
  const shape: IndexShape = { family: [0, 1, 2], famQ: [1, 1, 1], liveFrom: [20730, 20730, 20730], liveUntil: [NEVER, NEVER, NEVER] };
  const gpuId = `0x${"ab".repeat(32)}` as Hex;
  const rd = (avg: number[], counts = [24, 24, 24]): DayReadings => ({ sums: avg.map((a, i) => a * counts[i]!), counts, sliceBits: FULL, late: false });
  const day = (d: number, pre: ReturnType<typeof recomputeDay>["post"] | null, readings: DayReadings, prevValue: number | null = 1) =>
    recomputeDay({ gpuId, day: d, source: CRE, shape, minReadings: 12, slices: 24, pre: pre ?? [0, 1, 2].map(() => ({ e: 0, miss: 6, inMedian: false, wasIn: false })), readings, prevValue, firstRecordDay: 20730 });

  test("a day price is the readings' average to the cent, halves up; the index is the median", () => {
    // 3.995 averages up to $4.00; 2.994999 down to $2.99
    const r = day(20730, null, { sums: [3_995_000 * 2, 2_994_999 * 2, 6_000_000 * 12], counts: [2, 2, 12], sliceBits: FULL, late: false });
    expect(r.counts).toEqual([2, 2, 12]);
    expect(r.p).toEqual([0, 0, 6_000_000]); // two readings are below the 12 a day price needs
    const s = day(20730, null, { sums: [3_995_000 * 24, 2_994_999 * 24, 6_000_000 * 24], counts: [24, 24, 24], sliceBits: FULL, late: false });
    expect(s.p).toEqual([4_000_000, 2_990_000, 6_000_000]);
    expect(s.value).toBe(4_000_000);
    expect(s.status).toBe(2); // three fresh companies: DEGRADED (FULL needs five)
  });

  test("a dark company is held for 5 computed days, then leaves the median, and comes back on its first good day", () => {
    let r = day(20730, null, rd([2_000_000, 3_000_000, 5_000_000]));
    expect(r.value).toBe(3_000_000);
    const values: number[] = [];
    const kinds: number[] = [];
    for (let d = 20731; d <= 20737; d++) {
      r = day(d, r.post, rd([2_000_000, 0, 5_000_000], [24, 0, 24]), r.value);
      values.push(r.value);
      kinds.push(r.kinds[1]!);
    }
    // held (kind 2) at $3.00 for five days: the median of 2, 3, 5 stays $3.00; day six it is out (kind 0): the median
    // of $2.00 and $5.00 is their mean, $3.50
    expect(kinds).toEqual([2, 2, 2, 2, 2, 0, 0]);
    expect(values).toEqual([3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_500_000, 3_500_000]);
    r = day(20738, r.post, rd([2_000_000, 3_100_000, 5_000_000]), r.value);
    expect(r.kinds).toEqual([1, 1, 1]); // it was in before (wasIn): back on its first good day, mid-month
    expect(r.value).toBe(3_100_000);
    expect(r.changed).toBe(true);
  });

  test("the reserve is never read; a company queued to join is read in its 5 shadow days but not counted", () => {
    const sh: IndexShape = { family: [0, 1, 2], famQ: [1, 1, 1], liveFrom: [20730, 20730, NEVER], liveUntil: [NEVER, NEVER, NEVER] };
    const reserve = recomputeDay({ gpuId, day: 20730, source: CRE, shape: sh, minReadings: 12, slices: 24, pre: [0, 1, 2].map(() => ({ e: 0, miss: 6, inMedian: false, wasIn: false })), readings: rd([2_000_000, 3_000_000, 9_000_000]), prevValue: null, firstRecordDay: null });
    expect(reserve.counts).toEqual([24, 24, 0]);
    expect(reserve.kinds).toEqual([1, 1, 0]);
    expect(reserve.value).toBe(2_500_000);
    const queued: IndexShape = { ...sh, liveFrom: [20730, 20730, 20758] }; // joins Nov 1 2026 (day 20758)
    const shadow = recomputeDay({ gpuId, day: 20755, source: CRE, shape: queued, minReadings: 12, slices: 24, pre: reserve.post, readings: rd([2_000_000, 3_000_000, 9_000_000]), prevValue: 2_500_000, firstRecordDay: 20730 });
    expect(shadow.p).toEqual([2_000_000, 3_000_000, 9_000_000]);
    expect(shadow.kinds).toEqual([1, 1, 0]);
    expect(shadow.value).toBe(2_500_000);
    const joined = recomputeDay({ gpuId, day: 20758, source: CRE, shape: queued, minReadings: 12, slices: 24, pre: shadow.post, readings: rd([2_000_000, 3_000_000, 9_000_000]), prevValue: 2_500_000, firstRecordDay: 20730 });
    expect(joined.kinds).toEqual([1, 1, 1]); // the 1st of a month is an entry day
    expect(joined.value).toBe(3_000_000);
  });

  test("a carried day repeats the day before's price; its dark-day counter moves only on every eligible writer's evidence", () => {
    const first = day(20730, null, rd([2_000_000, 3_000_000, 5_000_000]), null);
    expect(carryState(first.post, shape, 20731, 12, [[24, 3, 24], [24, 20, 24]]).map((s) => s.miss)).toEqual([0, 0, 0]);
    expect(carryState(first.post, shape, 20731, 12, [[24, 3, 24], [24, 5, 0]]).map((s) => s.miss)).toEqual([0, 1, 0]);
    expect(carryState(first.post, shape, 20731, 12, []).map((s) => s.miss)).toEqual([0, 0, 0]);
    const records = new Map<number, StoredRecord>([
      [20730, { exists: true, isFinal: true, value: first.value, status: first.status, fresh: first.fresh, quorum: first.quorum, held: first.held, freshMedian: first.freshMedian, late: false, incomplete: false, changed: true, source: CRE, digest: first.digest }],
      [20731, { exists: true, isFinal: true, value: first.value, status: 4, fresh: 0, quorum: 0, held: 0, freshMedian: 0, late: false, incomplete: false, changed: false, source: "0x0000000000000000000000000000000000000000", digest: `0x${"00".repeat(32)}` }],
    ]);
    const input: DayCheckInput = { gpu: "H100", gpuId, day: 20731, firstDay: 20730, firstRecordDay: 20730, minReadings: 12, slices: 24, shape, names: ["a", "b", "c"], records, readings: new Map([[20730, rd([2_000_000, 3_000_000, 5_000_000])]]), carried: new Map([[20731, [[0, 0, 0]]]]) };
    const r = checkDayFrom(input);
    expect(r).toMatchObject({ status: "carried", stored: 3, recomputed: 3, match: true, source: "", digest: null, sources: [] });
    records.set(20731, { ...records.get(20731)!, value: 3_010_000 });
    expect(checkDayFrom(input)).toMatchObject({ match: false, differences: ["value"], recomputed: 3 });
  });

  test("no record for the day: an error, never a guess", () => {
    expect(() => checkDayFrom(inputOf(H100, 20737))).toThrow("no record for H100 on 2026-10-11");
  });
});

describe("the check-day script's report", () => {
  test("H100 on Oct 9 2026, as the docs show it", () => {
    const r = checkDayFrom(inputOf(H100, 20735));
    expect(render(r, "Monad Testnet (chain 10143), index 0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36").split("\n")).toEqual([
      "H100 on 2026-10-09 (index day 20735), final, DEGRADED",
      "Recomputed from Monad Testnet (chain 10143), index 0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36, source writer 0xf0be5c7461c0743acde590a22bccb66fc2112335",
      "",
      "  company     readings  day price  counted",
      "  Verda             24      $3.92  yes, at its day price",
      "  Nebius             0          -  yes, at its last good day price $4.50 (under 12 readings)",
      "  Lambda            24      $3.99  yes, at its day price",
      "  CoreWeave         23      $6.16  yes, at its day price",
      "  Civo              24      $2.99  yes, at its day price",
      "  Hyperstack         0          -  no",
      "",
      "Median of the 5 counted: $3.99",
      "Stored $3.99, recomputed $3.99: MATCH (price, status, counts and the record's digest)",
      "Replayed the 5 earlier days from 2026-10-04 for the held prices: each matches its record",
    ]);
    const bad = checkDayFrom(inputOf(H100, 20735, H100.days.map((d) => (d.day === 20735 ? { ...d, rec: { ...d.rec, value: 4_000_000 } } : d))));
    expect(render(bad, "x")).toContain("Stored $4.00, recomputed $3.99: MISMATCH (value)");
  });
});

describe("dates", () => {
  test("dayOfDate is dateOfDay's inverse and refuses what is not a real YYYY-MM-DD", () => {
    expect(dayOfDate("2026-10-09")).toBe(20735);
    expect(dateOfDay(dayOfDate("2028-02-29"))).toBe("2028-02-29");
    for (const bad of ["2026-02-30", "2026-1-09", "20261009", "", "2026-10-09T00:00:00Z"]) expect(() => dayOfDate(bad)).toThrow(AmountError);
  });
});

describe("AgateClient.checkDay on a fake chain", () => {
  /** The production index as a fake chain: H100's fixture days, head 20737 (Oct 11 not closed); optionally Oct 11
   *  carried and computed days after it. Reads are answered call by call (no Multicall3). */
  function chain(o: { carryOct11?: boolean; extra?: FixtureDay[] } = {}): { pub: PublicClient; calls: string[] } {
    const calls: string[] = [];
    const days = new Map([...H100.days, ...(o.extra ?? [])].map((d) => [d.day, d]));
    const head = Math.max(o.carryOct11 ? 20737 : 0, ...days.keys()) + 1;
    const read = ({ functionName, args }: { functionName: string; args?: readonly unknown[] }): unknown => {
      calls.push(functionName);
      const d = Number(args?.[1]);
      switch (functionName) {
        case "clocks":
          return { day: 86_400, slice: 3_600, tPend: 21_600, closeGrace: 3_600, slices: 24, minReadings: 12, epochTs: 0n, epochDay: 0 };
        case "gpu":
          return { recipeHash: `0x${"00".repeat(32)}`, nSlots: 6, nFamilies: 6, firstDay: 20730, registeredAt: 0n, lastCarryAt: 0n, head };
        case "firstRecordDay":
          return [true, 20730];
        case "writers":
          return [CRE, STANDBY];
        case "slotWindow":
          return [H100.shape.liveFrom[Number(args?.[1])], NEVER];
        case "familyOf":
          return [Number(args?.[1]), 1];
        case "isSuspended":
          return false;
        case "isVoided":
          return d === 20737 && String(args?.[2]).toLowerCase() === CRE.toLowerCase();
        case "record": {
          const x = days.get(d);
          if (x) return [true, true, { ...x.rec, postedAt: 1n, finalAt: 2n, attestedAt: 0n, attestedBy: CRE, needsSign: false, dropped: false }];
          if (o.carryOct11 && d === 20737) return [true, true, { value: 3_990_000, status: 4, fresh: 0, quorum: 0, held: 0, freshMedian: 0, late: false, incomplete: false, changed: false, needsSign: false, dropped: false, source: "0x0000000000000000000000000000000000000000", postedAt: 1n, finalAt: 1n, attestedAt: 0n, attestedBy: "0x0000000000000000000000000000000000000000", digest: `0x${"00".repeat(32)}` }];
          return [false, false, { value: 0, status: 0, source: "0x0000000000000000000000000000000000000000", digest: `0x${"00".repeat(32)}` }];
        }
        case "readings": {
          const x = days.get(d);
          const w = String(args?.[2]).toLowerCase();
          if (x && w === CRE.toLowerCase()) return { sums: x.sums, counts: x.counts, sliceBits: FULL, late: false, anyValid: true, lastPostAt: 1n };
          // Oct 11 (carried): the CRE writer read Nebius 12 times but its readings of the day were voided; the standby
          // read only Lambda 12 times
          if (d === 20737 && w === CRE.toLowerCase()) return { sums: [0, 54_000_000, 0, 0, 0, 0], counts: [0, 12, 0, 0, 0, 0], sliceBits: 0xfffn, late: false, anyValid: true, lastPostAt: 1n };
          if (d === 20737 && w === STANDBY.toLowerCase()) return { sums: [0, 0, 47_880_000, 0, 0, 0], counts: [0, 0, 12, 0, 0, 0], sliceBits: 0xfffn, late: false, anyValid: true, lastPostAt: 1n };
          return { sums: Array(6).fill(0), counts: Array(6).fill(0), sliceBits: 0n, late: false, anyValid: false, lastPostAt: 0n };
        }
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    };
    const pub = { getCode: async () => undefined, readContract: async (r: { functionName: string; args?: readonly unknown[] }) => read(r), getBlock: async () => ({ timestamp: 1_791_763_200n }) } as unknown as PublicClient;
    return { pub, calls };
  }

  test("reads the chain only and answers the day: H100 on Oct 9 2026 matches its record", async () => {
    const { pub, calls } = chain();
    const agate = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const r = await agate.checkDay({ gpu: "H100", date: "2026-10-09" });
    expect(r).toMatchObject({ gpu: "H100", date: "2026-10-09", day: 20735, final: true, status: "degraded", stored: 3.99, recomputed: 3.99, match: true, differences: [], minReadings: 12, replay: { from: "2026-10-04", days: 6, mismatches: [] } });
    expect(r.sources.map((s) => `${s.family}:${s.kind}:${s.used}`)).toEqual(["Verda:fresh:3.92", "Nebius:held:4.5", "Lambda:fresh:3.99", "CoreWeave:fresh:6.16", "Civo:fresh:2.99", "Hyperstack:out:null"]);
    // the source's readings of each replayed day, never another writer's (no carried day here)
    expect(calls.filter((c) => c === "readings").length).toBe(6);
    expect(calls).not.toContain("isVoided");
  });

  test("a carried day: the day before's price, with every writer's readings and void flag of that day read", async () => {
    const { pub, calls } = chain({ carryOct11: true });
    const agate = new AgateClient({ publicClient: pub, graphqlUrl: null });
    const r = await agate.checkDay({ gpu: "H100", date: "2026-10-11" });
    expect(r).toMatchObject({ status: "carried", stored: 3.99, recomputed: 3.99, match: true, digest: null, sources: [], replay: { days: 8, mismatches: [] } });
    expect(calls.filter((c) => c === "readings").length).toBe(7 + 2);
    expect(calls.filter((c) => c === "isVoided").length).toBe(2);
  });

  test("the counter a carried day moves feeds the days after it; a voided writer's readings are no evidence", async () => {
    // the index's own steps: the fixture days, Oct 11 carried on the standby's evidence alone (Nebius dark: 3 -> 4),
    // then Oct 12 and 13 with Nebius still dark: held on the 12th (5), out on the 13th (6)
    let state = H100.days.reduce((pre, d, i) => recomputeDay({ gpuId: H100.gpuId, day: d.day, source: CRE, shape: H100.shape, minReadings: 12, slices: 24, pre, readings: { sums: d.sums, counts: d.counts, sliceBits: FULL, late: false }, prevValue: i === 0 ? null : 3_990_000, firstRecordDay: 20730 }).post, [0, 1, 2, 3, 4, 5].map(() => ({ e: 0, miss: 6, inMedian: false, wasIn: false })));
    state = carryState(state, H100.shape, 20737, 12, [[0, 0, 12, 0, 0, 0]]);
    const extra: FixtureDay[] = [];
    let prev = 3_990_000;
    for (const d of [20738, 20739]) {
      const sums = [94_320_000, 0, 95_760_000, 147_840_000, 71_760_000, 0];
      const counts = [24, 0, 24, 24, 24, 0];
      const c = recomputeDay({ gpuId: H100.gpuId, day: d, source: CRE, shape: H100.shape, minReadings: 12, slices: 24, pre: state, readings: { sums, counts, sliceBits: FULL, late: false }, prevValue: prev, firstRecordDay: 20730 });
      extra.push({ day: d, rec: { value: c.value, status: c.status, fresh: c.fresh, quorum: c.quorum, held: c.held, freshMedian: c.freshMedian, late: false, incomplete: false, changed: c.changed, source: CRE, digest: c.digest }, sums, counts });
      state = c.post;
      prev = c.value;
    }
    expect(extra.map((x) => x.rec.value)).toEqual([3_990_000, 3_960_000]); // the 13th: the median of four, (3.93 + 3.99) / 2
    const agate = new AgateClient({ publicClient: chain({ carryOct11: true, extra }).pub, graphqlUrl: null });
    const r = await agate.checkDay({ gpu: "H100", date: "2026-10-13" });
    expect(r).toMatchObject({ match: true, stored: 3.96, recomputed: 3.96, replay: { days: 10, mismatches: [] } });
    expect(r.sources[1]).toMatchObject({ family: "Nebius", readings: 0, kind: "out", used: null });
  });

  test("a day with no record is a ReadError that says why", async () => {
    const agate = new AgateClient({ publicClient: chain().pub, graphqlUrl: null });
    await expect(agate.checkDay({ gpu: "H100", date: "2026-10-11" })).rejects.toThrow("H100 has no record for 2026-10-11 yet: 2026-10-11 is the next day to close");
    await expect(agate.checkDay({ gpu: "H100", date: "2026-10-03" })).rejects.toThrow("H100 has no record for 2026-10-03: the index's first day for it is 2026-10-04");
    await expect(agate.checkDay({ gpu: "H100", date: "Oct 9" })).rejects.toThrow(AmountError);
  });
});
