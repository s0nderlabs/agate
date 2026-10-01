// abi.ts must be the current forge build of IAgateIndex, and types.ts must name its structs' fields in the same order:
// a stale ABI decodes clocks() or record() shifted by a field (v4.3 added signAll and needsSign mid-struct).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agateIndexAbi } from "../src/abi.ts";
import type { Clocks, IndexRecord, InitParams, Readings } from "../src/types.ts";

const INDEX_ARTIFACT = join(import.meta.dir, "../../../../contracts/out/AgateIndex.sol/AgateIndex.json");

const ARTIFACT = join(import.meta.dir, "../../../../contracts/out/IAgateIndex.sol/IAgateIndex.json");

type Item = { type: string; name?: string; inputs?: { name: string; components?: { name: string }[] }[]; outputs?: { name: string; components?: { name: string }[] }[] };
const items = agateIndexAbi as unknown as Item[];
const fn = (name: string) => items.find((x) => x.type === "function" && x.name === name)!;
const ev = (name: string) => items.find((x) => x.type === "event" && x.name === name)!;

describe("ABI and types", () => {
  test.skipIf(!existsSync(ARTIFACT))("abi.ts equals the forge artifact (run `bun run gen:abi` after `forge build`)", async () => {
    const { abi } = await Bun.file(ARTIFACT).json();
    expect(JSON.parse(JSON.stringify(agateIndexAbi))).toEqual(abi);
  });

  test.skipIf(!existsSync(INDEX_ARTIFACT))("InitParams in types.ts follows AgateIndex's constructor", async () => {
    const { abi } = await Bun.file(INDEX_ARTIFACT).json();
    const ctor = (abi as Item[]).find((x) => x.type === "constructor")!;
    const init: Record<keyof InitParams, 0> = { day: 0, slices: 0, minReadings: 0, qMin: 0, demoLabel: 0, signAll: 0, epochTs: 0, epochDay: 0, chainSelector: 0, owner: 0, writers: 0, attester: 0, guardians: 0, forwarder: 0, writerMode: 0 };
    expect(ctor.inputs![0]!.components!.map((c) => c.name)).toEqual(Object.keys(init));
  });

  test("struct fields in types.ts follow the ABI, in order (rule R v4.3: signAll, needsSign)", () => {
    const clocks: Record<keyof Clocks, 0> = { day: 0, slice: 0, tPend: 0, closeGrace: 0, grace: 0, holdMove: 0, holdMin: 0, step: 0, reopenWait: 0, timelock: 0, slices: 0, minReadings: 0, qMin: 0, demoLabel: 0, signAll: 0, epochTs: 0, epochDay: 0, chainSelector: 0 };
    expect(fn("clocks").outputs![0]!.components!.map((c) => c.name)).toEqual(Object.keys(clocks));
    const rec: Record<keyof IndexRecord, 0> = { value: 0, status: 0, fresh: 0, quorum: 0, held: 0, freshMedian: 0, late: 0, incomplete: 0, changed: 0, needsSign: 0, dropped: 0, source: 0, postedAt: 0, finalAt: 0, attestedAt: 0, attestedBy: 0, digest: 0 };
    expect(fn("record").outputs![2]!.components!.map((c) => c.name)).toEqual(Object.keys(rec));
    const rd: Record<keyof Readings, 0> = { sums: 0, counts: 0, sliceBits: 0, late: 0, anyValid: 0, lastPostAt: 0 };
    expect(fn("readings").outputs![0]!.components!.map((c) => c.name)).toEqual(Object.keys(rd));
    expect(ev("DayClosed").inputs!.map((i) => i.name)).toContain("needsSign");
    expect(ev("DayCarried").inputs!.map((i) => i.name).at(-1)).toBe("missAdvanced");
  });
});
