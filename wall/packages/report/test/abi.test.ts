// abi.ts must be the current forge build of IAgateIndex, and types.ts must name its structs' fields in the same order:
// a stale ABI decodes clocks() or record() shifted by a field (v4.3 added signAll and needsSign mid-struct).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import { agateIndexAbi } from "../src/abi.ts";
import { ACTION_WINDOW_DAYS, AlertCode, READER_SWAP_TAG } from "../src/types.ts";
import type { Clocks, IndexRecord, InitParams, Reader, Readings, ReaderVersion } from "../src/types.ts";

// AGATE_FORGE_OUT: a forge out folder other than contracts/out (a separate FOUNDRY_OUT)
const OUT = process.env.AGATE_FORGE_OUT ?? join(import.meta.dir, "../../../../contracts/out");
const INDEX_ARTIFACT = join(OUT, "AgateIndex.sol/AgateIndex.json");
const ARTIFACT = join(OUT, "IAgateIndex.sol/IAgateIndex.json");

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

  test("Oct 3 (4.11, 4.15): the reader swap and the execute window are in the ABI, and types.ts follows them", () => {
    for (const f of ["queueReaderSwap", "executeReaderSwap", "cancelReaderSwap", "readerSwapId", "readerHistory", "readerAt", "queuedEta"]) {
      expect(fn(f), f).toBeDefined();
    }
    for (const e of ["ReaderSwapQueued", "ReaderSwapped", "ReaderSwapCancelled", "ActionExecuted", "ActionCancelled"]) expect(ev(e), e).toBeDefined();
    const errs = items.filter((x) => x.type === "error").map((x) => x.name);
    for (const e of ["ActionExpired", "BadReader", "ReaderSwapPending"]) expect(errs).toContain(e);
    const rd: Record<keyof Reader, 0> = { url: 0, parserVersion: 0 };
    expect(fn("queueReaderSwap").inputs![2]!.components!.map((c) => c.name)).toEqual(Object.keys(rd));
    const rv: Record<keyof ReaderVersion, 0> = { fromDay: 0, executedAt: 0, readerHash: 0, url: 0, parserVersion: 0, reason: 0 };
    expect(fn("readerHistory").outputs![0]!.components!.map((c) => c.name)).toEqual(Object.keys(rv));
    expect(fn("readerAt").outputs![1]!.components!.map((c) => c.name)).toEqual(Object.keys(rv));
    expect(ev("ReaderSwapQueued").inputs!.map((i) => i.name)).toEqual(["id", "gpuId", "slot", "url", "parserVersion", "reason", "eta"]);
    expect(ev("ReaderSwapped").inputs!.map((i) => i.name)).toEqual(["id", "gpuId", "slot", "fromDay", "readerHash", "url", "parserVersion", "reason"]);
  });

  test("ACTION_WINDOW_DAYS and READER_SWAP_TAG mirror IAgateIndex.sol", async () => {
    const sol = await Bun.file(join(import.meta.dir, "../../../../contracts/src/interfaces/IAgateIndex.sol")).text();
    expect(Number(/uint8 constant ACTION_WINDOW_DAYS = (\d+);/.exec(sol)![1])).toBe(ACTION_WINDOW_DAYS);
    const tag = /bytes32 constant READER_SWAP_TAG = keccak256\("([^"]+)"\);/.exec(sol)![1]!;
    expect(keccak256(toBytes(tag))).toBe(READER_SWAP_TAG);
  });

  test("the Oct 3 alert codes (9.4) are in AlertCode, each named as its value", () => {
    const codes = ["PAGECHECK_REVIEW", "PAGECHECK_FAULT", "PAGECHECK_TRACKERS_DOWN", "KEY_MISMATCH", "KEY_UNVERIFIED", "READER_MISSING", "READER_REFUSED", "REPAIR_INCIDENT", "REPAIR_NOTE", "REPAIR_REFUSED", "REPAIR_WINDOW", "RPC_WS_DOWN", "TRACKER_GAP"];
    for (const c of codes) expect((AlertCode as Record<string, string>)[c]).toBe(c);
    for (const [k, v] of Object.entries(AlertCode)) expect(v as string).toBe(k);
  });
});
