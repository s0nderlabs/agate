// BUILD-SPEC 16 tests: the pure computation. Synthetic fixtures in the endpoints' field names only.
import { describe, expect, test } from "bun:test";
import { blockMsBetween, centString, classifyGroup, computeTraded, groupKey, type GroupIn, type LeaseIn, modelOfKey, interfaceOfKey, parseDec18, perGpuHourU, weightedStats } from "../src/akash.ts";

const gpuRes = (units: number, keys: string[], count = 1) => ({ gpuUnits: units, gpuKeys: keys, count });
const cpuOnly: GroupIn = { resources: [{ gpuUnits: 0, gpuKeys: [], count: 1 }] };
const H100 = "vendor/nvidia/model/h100";
const lease = (owner: string, dseq: string, provider: string, amount: string, denom = "uact", gseq = 1): LeaseIn => ({ owner, dseq, gseq, provider, price: { denom, amount } });

describe("conversion (16.5)", () => {
  test("4,263.344103 uact per block: 2,604,011 u at 5,894 ms and 2,603,569 u at 5,895 ms; cents 2.60 both", () => {
    expect(perGpuHourU("4263.344103000000000000", 5894, 1)).toBe(2_604_011n);
    expect(perGpuHourU("4263.344103000000000000", 5895, 1)).toBe(2_603_569n);
    expect(centString(2_604_011n)).toBe("2.60");
    expect(centString(2_603_569n)).toBe("2.60");
  });
  test("per GPU: the bundle price divided by the units", () => {
    expect(perGpuHourU("8526.688206000000000000", 5894, 2)).toBe(2_604_011n);
  });
  test("half-up ties, exactly", () => {
    // blockMs 3,600,000 makes u = amount / units
    expect(perGpuHourU("5", 3_600_000, 2)).toBe(3n); // 2.5 -> 3
    expect(perGpuHourU("3", 3_600_000, 2)).toBe(2n); // 1.5 -> 2
    expect(perGpuHourU("4.999999999999999999", 3_600_000, 2)).toBe(2n); // just under 2.5
    expect(centString(2_605_000n)).toBe("2.61");
    expect(centString(2_604_999n)).toBe("2.60");
  });
  test("refuses malformed amounts and bad inputs", () => {
    expect(() => parseDec18("1.0000000000000000001")).toThrow();
    expect(() => parseDec18("-1")).toThrow();
    expect(() => parseDec18("1e5")).toThrow();
    expect(() => perGpuHourU("1", 0, 1)).toThrow();
    expect(() => perGpuHourU("1", 5894, 0)).toThrow();
  });
});

describe("weighted median and percentiles (16.6)", () => {
  test("one lease", () => {
    const s = weightedStats([{ u: 5n, units: 1 }])!;
    expect([s.medianU, s.p25U, s.p75U, s.minU, s.maxU]).toEqual([5n, 5n, 5n, 5n, 5n]);
  });
  test("odd count: the middle of the multiset, each lease counted units times", () => {
    // multiset 1,1,1,9,9 -> median 1
    expect(weightedStats([{ u: 9n, units: 2 }, { u: 1n, units: 3 }])!.medianU).toBe(1n);
  });
  test("even count: the mean of the two middle, half up", () => {
    expect(weightedStats([{ u: 10n, units: 1 }, { u: 20n, units: 1 }])!.medianU).toBe(15n);
    expect(weightedStats([{ u: 10n, units: 1 }, { u: 21n, units: 1 }])!.medianU).toBe(16n); // 15.5 -> 16
    expect(weightedStats([{ u: 1n, units: 2 }, { u: 3n, units: 2 }])!.medianU).toBe(2n);
  });
  test("nearest-rank p25 and p75", () => {
    const s = weightedStats([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n].map((u) => ({ u, units: 1 })))!;
    expect(s.p25U).toBe(2n); // rank ceil(2) = 2
    expect(s.p75U).toBe(6n); // rank ceil(6) = 6
    expect(weightedStats([])).toBeNull();
  });
});

describe("models (16.4)", () => {
  test("model and interface from attribute keys", () => {
    expect(modelOfKey("vendor/nvidia/model/h100")).toBe("h100");
    expect(modelOfKey("vendor/nvidia/model/h100/ram/80Gi/interface/sxm")).toBe("h100");
    expect(modelOfKey("vendor/nvidia/model/h100nvl")).toBe("h100nvl");
    expect(modelOfKey("capabilities/storage/1/class")).toBeNull();
    expect(interfaceOfKey("vendor/nvidia/model/h100/ram/80Gi/interface/sxm")).toBe("sxm");
    expect(interfaceOfKey("vendor/nvidia/model/h100/interface/pcie")).toBe("pcie");
    expect(interfaceOfKey("vendor/nvidia/model/h100/ram/80Gi")).toBeNull();
  });
  test("a resource listing several models is ambiguous; one model with variants is exact", () => {
    expect(classifyGroup({ resources: [gpuRes(1, [H100, "vendor/nvidia/model/a100", "vendor/nvidia/model/rtx4090"])] }).kind).toBe("ambiguous");
    const c = classifyGroup({ resources: [gpuRes(2, [`${H100}/ram/80Gi`, `${H100}/ram/80Gi/interface/sxm`])] });
    expect(c).toEqual({ kind: "exact", model: "h100", units: 2, iface: "unstated" });
  });
  test("a group mixing models across resources is ambiguous; a resource naming no model is ambiguous", () => {
    expect(classifyGroup({ resources: [gpuRes(1, [H100]), gpuRes(1, ["vendor/nvidia/model/a100"])] }).kind).toBe("ambiguous");
    expect(classifyGroup({ resources: [gpuRes(1, [])] }).kind).toBe("ambiguous");
    expect(classifyGroup(cpuOnly).kind).toBe("none");
  });
  test("units = sum of gpu units times count across resources", () => {
    const c = classifyGroup({ resources: [gpuRes(2, [H100], 3), gpuRes(1, [H100], 2), { gpuUnits: 0, gpuKeys: [], count: 4 }] });
    expect(c).toEqual({ kind: "exact", model: "h100", units: 8, iface: "unstated" });
  });
  test("interface buckets: sxm only when every key says sxm", () => {
    expect(classifyGroup({ resources: [gpuRes(1, [`${H100}/ram/80Gi/interface/sxm`])] })).toMatchObject({ iface: "sxm" });
    expect(classifyGroup({ resources: [gpuRes(1, [`${H100}/interface/pcie`])] })).toMatchObject({ iface: "pcie" });
    expect(classifyGroup({ resources: [gpuRes(1, [`${H100}/interface/sxm`, `${H100}/ram/80Gi`])] })).toMatchObject({ iface: "unstated" });
  });
});

describe("computeTraded", () => {
  const groups: Record<string, GroupIn> = {
    [groupKey("buyerA", "1", 1)]: { resources: [gpuRes(1, [H100])] },
    [groupKey("buyerA", "2", 1)]: { resources: [gpuRes(1, [H100], 2)] }, // 2 GPUs
    [groupKey("buyerB", "3", 1)]: { resources: [gpuRes(1, [`${H100}/ram/80Gi/interface/sxm`])] },
    [groupKey("buyerC", "4", 1)]: { resources: [gpuRes(1, [H100, "vendor/nvidia/model/a100"])] }, // ambiguous
    [groupKey("buyerC", "5", 1)]: { resources: [gpuRes(1, [H100])] }, // other denom
    [groupKey("buyerC", "6", 1)]: cpuOnly,
    [groupKey("buyerD", "7", 1)]: { resources: [gpuRes(8, ["vendor/nvidia/model/b200"])] },
  };
  const leases = [
    lease("buyerA", "1", "sellerX", "4263.344103000000000000"), // 2,604,011 x1
    lease("buyerA", "2", "sellerX", "8526.688206000000000000"), // 2,604,011 x2
    lease("buyerB", "3", "sellerY", "5452.906600000000000000"), // x1 (sxm)
    lease("buyerC", "4", "sellerZ", "300.000000000000000000"), // ambiguous: excluded, counted
    lease("buyerC", "5", "sellerZ", "4000", "uakt"), // other denom: excluded, counted
    lease("buyerC", "6", "sellerZ", "50"), // CPU only: ignored
    lease("buyerD", "7", "sellerY", "88000"), // B200, 8 GPUs
    lease("buyerE", "9", "sellerQ", "1"), // group unknown
  ];
  const t = computeTraded(leases, groups, 5894);
  test("H100: exact leases only, weighted, with counts", () => {
    const h = t.gpus.H100!;
    expect(h.leases).toBe(3);
    expect(h.gpus).toBe(4);
    expect(h.sellers).toBe(2);
    expect(h.buyers).toBe(2);
    expect(h.medianU).toBe(2_604_011); // multiset 2,604,011 x3 and one higher
    expect(h.median).toBe("2.60");
    expect(h.minU).toBe(2_604_011);
    expect(h.maxU).toBe(Number(perGpuHourU("5452.906600000000000000", 5894, 1)));
    expect(h.topBuyerGpuShareBps).toBe(7500); // buyerA holds 3 of 4
    expect(h.topSellerGpuShareBps).toBe(7500);
    expect(h.interfaces).toEqual({ sxm: 1, pcie: 0, unstated: 3 });
    expect(h.excluded).toEqual({ ambiguousModel: 1, otherDenom: 1 });
  });
  test("B200 appears when exactly-modelled leases exist; H200 does not", () => {
    expect(t.gpus.B200!.gpus).toBe(8);
    expect(t.gpus.B200!.leases).toBe(1);
    expect(t.gpus.H200).toBeUndefined();
  });
  test("leases with an unknown group are counted, never priced", () => {
    expect(t.missingGroups).toBe(1);
    expect(t.leasesSeen).toBe(leases.length);
  });
  test("H100 is always present, with null prices when no lease is exactly H100", () => {
    const e = computeTraded([], {}, 5894).gpus.H100!;
    expect(e.median).toBeNull();
    expect(e.leases).toBe(0);
  });
});

describe("block time (16.1)", () => {
  test("whole milliseconds over the span, from nanosecond header times", () => {
    expect(blockMsBetween("2026-10-02T02:25:01.627302361Z", "2026-10-02T18:47:23.243203123Z", 10_000)).toBe(5894);
    expect(blockMsBetween("2026-10-02T01:48:54Z", "2026-10-02T18:11:27Z", 10_000)).toBe(5895);
    expect(() => blockMsBetween("2026-10-02T18:00:00Z", "2026-10-02T17:00:00Z", 10)).toThrow();
    expect(() => blockMsBetween("yesterday", "2026-10-02T17:00:00Z", 10)).toThrow();
  });
});
