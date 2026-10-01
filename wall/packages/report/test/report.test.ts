import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, size, slice } from "viem";
import { agateIndexAbi } from "../src/abi.ts";
import { decodeReport, digestOf, encodeMetadata, encodeReport, gpuIdOf, makeReport } from "../src/encode.ts";
import type { Address, Entry, Hex } from "../src/types.ts";
import { MAX_SLOTS, P_MAX, REPORT_VERSION } from "../src/types.ts";

const INDEX: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const SEL = 2183018362218727504n;

describe("report encoding (BUILD-SPEC 5)", () => {
  test("gpuIds of the three launch specs", () => {
    expect(gpuIdOf("H100-SXM/on-demand-list/neocloud/v1")).toBe("0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955");
    expect(gpuIdOf("H200-SXM/on-demand-list/neocloud/v1")).toBe("0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d");
    expect(gpuIdOf("B200-SXM/on-demand-list/neocloud/v1")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(gpuIdOf("H100-SXM/on-demand-list/neocloud/v2")).not.toBe(gpuIdOf("H100-SXM/on-demand-list/neocloud/v1"));
  });

  test("the largest report shape round-trips: 3 GPUs x 15 slots, extreme values", () => {
    const entries: Entry[] = ["H100", "H200", "B200"].map((g, k) => ({
      gpuId: gpuIdOf(`${g}-SXM/on-demand-list/neocloud/v1`),
      dayId: 20_758,
      slice: 23,
      readAt: 1_793_627_999n,
      values: Array.from({ length: MAX_SLOTS }, (_, i) => (i === k ? 0 : i === 14 ? P_MAX : 0xffffffff - i)),
    }));
    const r = makeReport(SEL, INDEX, entries);
    expect(r.version).toBe(REPORT_VERSION);
    const hex = encodeReport(r);
    expect(decodeReport(hex)).toEqual(r);
    expect(size(hex)).toBeLessThan(50_000); // CRE's evm_report limit
  });

  test("no entries and empty values still encode", () => {
    const r = makeReport(SEL, INDEX, [{ gpuId: gpuIdOf("x"), dayId: 0, slice: 0, readAt: 0n, values: [] }]);
    expect(decodeReport(encodeReport(r))).toEqual(r);
    expect(decodeReport(encodeReport(makeReport(SEL, INDEX, [])))).toEqual(makeReport(SEL, INDEX, []));
  });

  test("malformed bytes do not decode", () => {
    const hex = encodeReport(makeReport(SEL, INDEX, []));
    expect(() => decodeReport(slice(hex, 0, 64))).toThrow();
    expect(() => decodeReport("0x")).toThrow();
  });

  test("the report travels inside postReport(bytes) unchanged", () => {
    const hex = encodeReport(makeReport(SEL, INDEX, [{ gpuId: gpuIdOf("x"), dayId: 1, slice: 2, readAt: 3n, values: [4, 5] }]));
    const data = encodeFunctionData({ abi: agateIndexAbi, functionName: "postReport", args: [hex] });
    const back = decodeFunctionData({ abi: agateIndexAbi, data });
    expect(back.functionName).toBe("postReport");
    expect((back.args as readonly Hex[])[0]).toBe(hex);
  });

  test("CRE metadata: 62 bytes, workflow owner at [42:62] (check A2, WORKFLOW_OWNER mode)", () => {
    const owner: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const m = encodeMetadata(`0x${"11".repeat(32)}`, `0x${"22".repeat(10)}`, owner);
    expect(size(m)).toBe(62);
    expect(slice(m, 42, 62).toLowerCase()).toBe(owner.toLowerCase());
  });

  test("digest moves with every field", () => {
    const base = {
      gpuId: gpuIdOf("x"),
      day: 1,
      source: INDEX,
      p: [3_000_000],
      kinds: [1 as const],
      counts: [24],
      post: [{ e: 3_000_000, miss: 0, inMedian: true, wasIn: true }],
      value: 3_000_000,
    };
    const d0 = digestOf(base);
    expect(digestOf({ ...base, value: 3_010_000 })).not.toBe(d0);
    expect(digestOf({ ...base, post: [{ ...base.post[0]!, wasIn: false }] })).not.toBe(d0);
    expect(digestOf({ ...base, counts: [23] })).not.toBe(d0);
    expect(digestOf({ ...base })).toBe(d0);
  });
});
