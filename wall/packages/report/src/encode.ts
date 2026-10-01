import { decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, toHex } from "viem";
import type { Address, Entry, Hex, Kind, Report, SlotState } from "./types.ts";
import { REPORT_VERSION } from "./types.ts";

export const ENTRY_COMPONENTS = [
  { name: "gpuId", type: "bytes32" },
  { name: "dayId", type: "uint32" },
  { name: "slice", type: "uint8" },
  { name: "readAt", type: "uint64" },
  { name: "values", type: "uint32[]" },
] as const;

/** abi.encode(uint8 version, uint64 chainSelector, address index, Entry[] entries) */
export const REPORT_PARAMS = [
  { name: "version", type: "uint8" },
  { name: "chainSelector", type: "uint64" },
  { name: "index", type: "address" },
  { name: "entries", type: "tuple[]", components: ENTRY_COMPONENTS },
] as const;

/** keccak256(abi.encode(gpuId, day, source, p, kinds, counts, inMedian, miss, wasIn, value)) */
export const DIGEST_PARAMS = [
  { name: "gpuId", type: "bytes32" },
  { name: "day", type: "uint32" },
  { name: "source", type: "address" },
  { name: "p", type: "uint32[]" },
  { name: "kinds", type: "uint8[]" },
  { name: "counts", type: "uint8[]" },
  { name: "inMedian", type: "bool[]" },
  { name: "miss", type: "uint8[]" },
  { name: "wasIn", type: "bool[]" },
  { name: "value", type: "uint32" },
] as const;

export function encodeReport(r: Report): Hex {
  return encodeAbiParameters(REPORT_PARAMS, [
    r.version,
    r.chainSelector,
    r.index,
    r.entries.map((e) => ({ ...e, values: [...e.values] })),
  ]);
}

export function decodeReport(data: Hex): Report {
  const [version, chainSelector, index, entries] = decodeAbiParameters(REPORT_PARAMS, data);
  return {
    version,
    chainSelector,
    index: index as Address,
    entries: entries.map((e): Entry => ({ ...e, gpuId: e.gpuId as Hex, values: [...e.values] })),
  };
}

export function makeReport(chainSelector: bigint, index: Address, entries: readonly Entry[]): Report {
  return { version: REPORT_VERSION, chainSelector, index, entries };
}

export function digestOf(a: {
  gpuId: Hex;
  day: number;
  source: Address;
  p: readonly number[];
  kinds: readonly Kind[];
  counts: readonly number[];
  post: readonly SlotState[];
  value: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(DIGEST_PARAMS, [
      a.gpuId,
      a.day,
      a.source,
      [...a.p],
      [...a.kinds],
      [...a.counts],
      a.post.map((s) => s.inMedian),
      a.post.map((s) => s.miss),
      a.post.map((s) => s.wasIn),
      a.value,
    ]),
  );
}

/** CRE metadata as the forwarder packs it: workflowId (32) | workflowName (10) | workflowOwner (20). */
export function encodeMetadata(workflowId: Hex, workflowName: Hex, workflowOwner: Address): Hex {
  return encodePacked(["bytes32", "bytes10", "address"], [workflowId, workflowName, workflowOwner]);
}

/** gpuId = keccak256 of the market's spec string, e.g. "H100-SXM/on-demand-list/neocloud/v1". */
export function gpuIdOf(spec: string): Hex {
  return keccak256(toHex(spec));
}
