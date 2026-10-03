// Readers in force and the key check on the real AgateIndex (BUILD-SPEC 4.15, 8.5, 8.6): the owner queues a reader
// swap, executes it after the timelock, and the writer reads the new reader from fromDay on, never mid-day. A swap to a
// parser version this build lacks reads nothing (0) and raises READER_MISSING; nothing recorded before moves. Skipped
// until contracts/out holds a contract with the reader swap (or AGATE_CONTRACTS_OUT points at such a build).
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agateIndexAbi } from "@agate/report/abi";
import type { Hex } from "@agate/report/types";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { dayEnd, dayIdAt, dayStart, sliceStart } from "../src/core/index.ts";
import type { LogLine } from "../src/pipeline/log.ts";
import { haveAnvil, ROOT } from "./helpers/anvil.ts";
import { D, makeWorld, type World } from "./helpers/world.ts";

const OUT = process.env.AGATE_CONTRACTS_OUT || join(ROOT, "contracts/out");
const haveSwap = (() => {
  try {
    const abi = JSON.parse(readFileSync(join(OUT, "AgateIndex.sol/AgateIndex.json"), "utf8")).abi as { name?: string }[];
    return abi.some((x) => x.name === "queueReaderSwap");
  } catch {
    return false;
  }
})();
if (haveAnvil && !haveSwap) console.log("anvil-readers: skipped (the built AgateIndex has no reader swap yet; rebuild contracts/out)");

let world: World | undefined;
afterEach(() => {
  world?.stop();
  world = undefined;
});

function lines(dir: string): LogLine[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

describe.skipIf(!haveAnvil || !haveSwap)("reader swap on the real contract (8.6)", () => {
  test("a swap to a version this build lacks: READER_MISSING after the execute, the slot reads 0 from fromDay, earlier days untouched", async () => {
    const w = (world = await makeWorld());
    const c = w.clock;
    const h100 = w.dep.panels.find((p) => p.gpu === "H100")!;
    const slot = h100.slots.find((s) => s.sourceId === "p_lambda")!.slot;
    const g = h100.gpuId as Hex;
    const s = await w.writer("standby", { readers: true });
    await w.run([s], dayStart(c, D) + 1, sliceStart(c, D, 2));
    const owner = w.a.wallet(0);
    const reader = { url: "https://lambda.ai/pricing", parserVersion: "lambda/2" };
    const send = async (fn: "queueReaderSwap" | "executeReaderSwap", args: readonly unknown[]) => {
      const hash = await owner.writeContract({ address: w.dep.index, abi: agateIndexAbi, functionName: fn, args, account: owner.account!, chain: owner.chain } as never);
      const rc = await w.a.pub.waitForTransactionReceipt({ hash });
      expect(rc.status).toBe("success");
    };
    await send("queueReaderSwap", [g, slot, reader, "test: the pricing page moved to a new layout"]);
    // the contract's swap id is 4.15's formula, the one the watcher, the guardian and the repair agent compute offchain
    const tag = keccak256(toHex("agate.ReaderSwap.v1"));
    const offchainId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }], [tag, g, slot, keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], [reader.url, reader.parserVersion]))]));
    const read = (functionName: string, args: readonly unknown[]) => w.a.pub.readContract({ address: w.dep.index, abi: agateIndexAbi, functionName, args } as never) as Promise<unknown>;
    expect(await read("readerSwapId", [g, slot, reader])).toBe(offchainId);
    const eta = Number(await read("queuedEta", [offchainId]));
    expect(eta).toBeGreaterThanOrEqual(w.now + c.timelock);
    expect(eta).toBeLessThanOrEqual(w.now + c.timelock + 30);
    // the timelock (2 DAY on TEST): the writer keeps reading with the registered reader meanwhile
    const queuedAt = w.now;
    await w.run([s], queuedAt + 1, queuedAt + c.timelock + 30);
    const before = await w.record(g, D);
    expect(before.exists).toBe(true);
    await send("executeReaderSwap", [g, slot, reader]);
    const fromDay = dayIdAt(c, w.now + c.slice) + 1;
    expect(fromDay).toBe(D + 3);
    await w.run([s], w.now + 1, sliceStart(c, D + 3, 2));
    const miss = s.alerts.find((x) => x.code === "READER_MISSING")!;
    expect(miss).toMatchObject({ severity: "action", gpuId: g, slot, day: fromDay, deadline: dayStart(c, fromDay) });
    const history = (await w.a.pub.readContract({ address: w.dep.index, abi: agateIndexAbi, functionName: "readerHistory", args: [g, slot] } as never)) as { fromDay: number }[];
    expect(history.map((x) => Number(x.fromDay))).toEqual([fromDay]);
    const reads = lines(s.log.dir).filter((l) => l.kind === "reading") as Extract<LogLine, { kind: "reading" }>[];
    const valueOn = (d: number) => reads.filter((l) => l.dayId === d).map((l) => l.entries.find((e) => e.gpuId === g)!.values[slot]);
    expect(valueOn(D + 2).every((v) => v === 3_990_000)).toBe(true); // the day of the execute: still the old reader
    expect(valueOn(D + 3).length).toBeGreaterThan(0);
    expect(valueOn(D + 3).every((v) => v === 0)).toBe(true); // from fromDay: no reading, never another reader
    const lam = reads.find((l) => l.dayId === D + 3)!.sources.find((x) => x.sourceId === "p_lambda")!;
    expect(lam.rows.H100).toEqual({ state: "MISSED", valueU: 0 });
    expect(lam.rows.B200!.state).toBe("VALID"); // B200's Lambda slot was not swapped
    // a recorded day does not move (the first record waits for a countersign nobody gives here, so D + 1 stays open)
    const after = await w.record(g, D);
    expect(after.rec.digest).toBe(before.rec.digest);
    expect(after.rec.value).toBe(before.rec.value);
    expect(dayEnd(c, D + 2)).toBeLessThan(w.now);
    // the key check saw only this writer's own posts on the real chain (eth_getLogs over the anvil blocks)
    expect(s.alerts.filter((x) => x.code === "KEY_MISMATCH" || x.code === "KEY_UNVERIFIED")).toEqual([]);
    expect(s.alerts.filter((x) => x.code === "READER_MISSING").length).toBe(1);
  }, 240_000);
});
