// The writers' pure core: clock math and one reading run. Imported by the CRE workflow (WASM) and the bun writers.
import { encodeReport, makeReport } from "@agate/report";
import type { Address, Entry, Hex } from "@agate/report/types";

export * from "./clock.ts";
export * from "./reading.ts";

export function reportHex(chainSelector: bigint, index: Address, entries: readonly Entry[]): Hex {
  return encodeReport(makeReport(chainSelector, index, entries));
}

/** JSON-safe form of an entry (readAt as a number) for logs and the workflow's return value. */
export interface EntryJson {
  gpuId: Hex;
  dayId: number;
  slice: number;
  readAt: number;
  values: number[];
}

export function entryToJson(e: Entry): EntryJson {
  return { gpuId: e.gpuId, dayId: e.dayId, slice: e.slice, readAt: Number(e.readAt), values: [...e.values] };
}

export function entryFromJson(e: EntryJson): Entry {
  return { gpuId: e.gpuId, dayId: e.dayId, slice: e.slice, readAt: BigInt(e.readAt), values: [...e.values] };
}
