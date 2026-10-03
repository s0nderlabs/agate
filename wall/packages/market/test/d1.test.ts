// MS 6.6 D1 as fixed by the phase 3 audit (P-H1, M-H2): forcedDay over every day a sync-bearing call would apply, and
// (recheck R1-L1) every later day within the margin of its last resort, which the call's own sync forces if it crosses
// before the call lands.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { RpcDown } from "@agate/watcher";
import { forcedDay } from "../src/d1.ts";
import type { IndexRecordView } from "../src/types.ts";

const DAY = 600;
const LR = 259_200n; // 3 days: the demo last resort floor
const T0 = 1_900_000_000n;
const terms = { index: "0x0000000000000000000000000000000000000001" as Address, gpuId: `0x${"01".repeat(32)}` as Hex, startDay: 100, startTs: T0, day: DAY, lastResort: LR };
const endOf = (j: number) => T0 + BigInt((j + 1) * DAY);

function reads(head: number | null | "throw" | "down", recs: Record<number, Partial<IndexRecordView>> = {}) {
  const asked = { head: 0, records: [] as number[] };
  return {
    asked,
    indexHead: async () => {
      asked.head++;
      if (head === "throw") throw new Error("reverted");
      if (head === "down") throw new RpcDown("every RPC URL failed");
      return head;
    },
    indexRecord: async (_i: Address, _g: Hex, d: number): Promise<IndexRecordView> => {
      asked.records.push(d);
      return { exists: false, isFinal: false, value: 0n, status: 0, ...recs[d] };
    },
  };
}

describe("forcedDay", () => {
  test("no day near its last resort: nothing held and nothing read", async () => {
    const r = reads(100);
    expect(await forcedDay(r, terms, 0, 5, endOf(4) + 10n)).toBe(null);
    expect(r.asked).toEqual({ head: 0, records: [] });
  });

  test("a day the wall has not closed (head <= day) is held; the oldest closed one is not", async () => {
    const t = endOf(2) + LR + 1n; // days 0 to 2 past their last resort; days 3 to 8 cross theirs within the hour
    expect(await forcedDay(reads(101), terms, 0, 3, t)).toEqual({ day: 101, head: 101, why: "not closed" });
    // R1-L1: day 103 (kPrev) crosses its last resort in 599 s and the wall has not closed it: held
    expect(await forcedDay(reads(103), terms, 0, 3, t)).toEqual({ day: 103, head: 103, why: "not closed" });
    expect(await forcedDay(reads(109), terms, 0, 3, t)).toBe(null); // all closed, no record: skipped days may be forced
  });

  test("a closed day whose record is not final yet is held; a final one is not", async () => {
    const t = endOf(2) + LR + 1n;
    expect(await forcedDay(reads(103, { 102: { exists: true, isFinal: false } }), terms, 0, 3, t)).toEqual({ day: 102, head: 103, why: "closed, not final yet" });
    expect(await forcedDay(reads(109, { 100: { exists: true, isFinal: true }, 101: { exists: true, isFinal: true }, 102: { exists: true, isFinal: true } }), terms, 0, 3, t)).toBe(null);
    // R1-L1: past kPrev too, a closed day still pending within the margin is held
    expect(await forcedDay(reads(109, { 105: { exists: true, isFinal: false } }), terms, 0, 3, t)).toEqual({ day: 105, head: 109, why: "closed, not final yet" });
  });

  test("the margin: a day an hour short of its last resort already counts (it may cross before the send)", async () => {
    const t = endOf(0) + LR - 3_000n;
    expect(await forcedDay(reads(100), terms, 0, 1, t)).toEqual({ day: 100, head: 100, why: "not closed" });
    expect(await forcedDay(reads(100), terms, 0, 1, endOf(0) + LR - 3_700n)).toBe(null);
  });

  test("head that reverts (a MockIndex) holds; no answer at all (RpcDown) propagates", async () => {
    const t = endOf(0) + LR + 1n;
    expect(await forcedDay(reads("throw"), terms, 0, 1, t)).toEqual({ day: 100, head: null, why: "index head unreadable" });
    expect(await forcedDay(reads(null), terms, 0, 1, t)).toEqual({ day: 100, head: null, why: "index head unreadable" });
    await expect(forcedDay(reads("down"), terms, 0, 1, t)).rejects.toThrow(RpcDown);
  });

  test("from kState on, past kPrev while days are within the margin (R1-L1), never at or past N", async () => {
    const t = endOf(4) + LR + 1n; // days 0 to 4 past their last resort, 5 to 10 within the hour
    const r = reads(111);
    expect(await forcedDay(r, terms, 3, 5, t)).toBe(null); // days 103 to 110: closed, no record
    expect(r.asked.records).toEqual([103, 104, 105, 106, 107, 108, 109, 110]);
    expect(await forcedDay(reads(105), terms, 3, 7, t)).toEqual({ day: 105, head: 105, why: "not closed" });
    // R1-C2's case: day kPrev ended, the wall has not closed it, 60 s before its last resort, nothing to apply now
    // (kState == kPrev): held, since a call landing a minute later would force it
    expect(await forcedDay(reads(105), terms, 5, 5, endOf(5) + LR - 60n)).toEqual({ day: 105, head: 105, why: "not closed" });
    // a month of N = 7 days: days 107 and later are not the series' and are never read
    const r7 = reads(107);
    expect(await forcedDay(r7, { ...terms, n: 7 }, 3, 5, t)).toBe(null);
    expect(r7.asked.records).toEqual([103, 104, 105, 106]);
    // the sweep: kState == kPrev == N, nothing left to apply or force
    const rN = reads(100);
    expect(await forcedDay(rN, { ...terms, n: 7 }, 7, 7, t)).toBe(null);
    expect(rN.asked).toEqual({ head: 0, records: [] });
  });
});
