// Writes the cross-language vector contracts/test/vectors/report_example.json (checked by
// contracts/test/ReportVector.t.sol and packages/report/test/encode.test.ts). Synthetic values only.
import { join } from "node:path";
import { digestOf, encodeReport, gpuIdOf, makeReport } from "../src/encode.ts";
import type { Address, Kind, SlotState } from "../src/types.ts";

export function example() {
  const H100 = gpuIdOf("H100-SXM/on-demand-list/neocloud/v1");
  const H200 = gpuIdOf("H200-SXM/on-demand-list/neocloud/v1");
  const chainSelector = 2183018362218727504n; // Monad testnet (CRE)
  const index: Address = "0x5FbDB2315678afecb367f032d93F642f64180aa3"; // first anvil deployment
  const day = 20758; // 2026-11-01 on the production clock
  const slice = 14;
  const readAt = BigInt(day * 86_400 + slice * 3_600 + 1_337);
  const report = makeReport(chainSelector, index, [
    { gpuId: H100, dayId: day, slice, readAt, values: [3_990_000, 0, 4_500_000, 3_600_000, 2_990_000] },
    { gpuId: H200, dayId: day, slice, readAt, values: [4_500_000, 5_400_000, 0, 3_490_000] },
  ]);
  const source: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil account 1
  const p = [3_990_000, 0, 4_500_000, 3_600_000, 2_990_000];
  const kinds: Kind[] = [1, 2, 1, 1, 1];
  const counts = [24, 0, 24, 23, 24];
  const post: SlotState[] = [
    { e: 3_990_000, miss: 0, inMedian: true, wasIn: true },
    { e: 3_850_000, miss: 1, inMedian: true, wasIn: true },
    { e: 4_500_000, miss: 0, inMedian: true, wasIn: true },
    { e: 3_600_000, miss: 0, inMedian: true, wasIn: true },
    { e: 2_990_000, miss: 0, inMedian: true, wasIn: true },
  ];
  const value = 3_850_000; // median of the five single-slot families
  const digest = digestOf({ gpuId: H100, day, source, p, kinds, counts, post, value });
  return { H100, H200, chainSelector, index, day, slice, readAt, report, source, p, kinds, counts, post, value, digest };
}

if (import.meta.main) {
  const x = example();
  const json = {
    reportHex: encodeReport(x.report),
    chainSelector: x.chainSelector.toString(),
    index: x.index,
    gpuIdH100: x.H100,
    gpuIdH200: x.H200,
    day: x.day,
    slice: x.slice,
    readAt: Number(x.readAt),
    valuesH100: x.report.entries[0]!.values,
    valuesH200: x.report.entries[1]!.values,
    source: x.source,
    p: x.p,
    kinds: x.kinds,
    counts: x.counts,
    postE: x.post.map((s) => s.e),
    postMiss: x.post.map((s) => s.miss),
    postIn: x.post.map((s) => s.inMedian),
    postWas: x.post.map((s) => s.wasIn),
    value: x.value,
    digest: x.digest,
  };
  const out = join(import.meta.dir, "../../../../contracts/test/vectors/report_example.json");
  await Bun.write(out, JSON.stringify(json, null, 2) + "\n");
  console.log(JSON.stringify(json, null, 2));
}
