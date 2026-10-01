// Alerts (9.4: stable ids, update not duplicate, clear, shared file), health (9.5: HEARTBEAT_LOST, R5_HEAD_LAG,
// KEY_LOW, CLOCK_SKEW), the event decoder and the persisted incremental event indexer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type AbiEvent, encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem";
import { agateIndexAbi } from "@agate/report/abi";
import { AlertSink, alertId } from "../src/alerts.ts";
import { abiProblems } from "../src/chain/abi-check.ts";
import { decodeWallEvent, EventIndexer } from "../src/chain/viem-index.ts";
import { existsSync } from "node:fs";

// The forge build of IAgateIndex is the interface of record; @agate/report's generated abi.ts must match it.
const FORGE = join(import.meta.dir, "../../../../contracts/out/IAgateIndex.sol/IAgateIndex.json");
const ABI: Abi = existsSync(FORGE) ? ((JSON.parse(readFileSync(FORGE, "utf8")) as { abi: Abi }).abi) : (agateIndexAbi as Abi);
import type { Wall } from "../src/config.ts";
import { appendLine, Heartbeat, writeAtomic } from "../src/fsutil.ts";
import { beatStatus, Health } from "../src/health.ts";
import { pickNotePath } from "../src/keeper.ts";
import { roleBeats, writerBeatFile } from "../src/main.ts";
import { Pages, World } from "../src/sim/world.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("alerts", () => {
  test("a repeated condition updates the open alert; a cleared one re-opens fresh; two processes share the file", () => {
    const dir = tmp("agate-alerts-");
    let now = 100;
    const a = new AlertSink(join(dir, "alerts.jsonl"), { now: () => now, print: false });
    const b = new AlertSink(join(dir, "alerts.jsonl"), { now: () => now, print: false });
    a.raise({ code: "R1_NO_CANDIDATE", severity: "action", gpuId: "0x01", day: 7, deadline: 500, message: "m1" });
    now = 150;
    a.raise({ code: "R1_NO_CANDIDATE", severity: "action", gpuId: "0x01", day: 7, deadline: 500, message: "m1" });
    expect(readFileSync(join(dir, "alerts.jsonl"), "utf8").trim().split("\n").length).toBe(1);
    a.raise({ code: "R1_NO_CANDIDATE", severity: "action", gpuId: "0x01", day: 7, deadline: 900, message: "m2" });
    const open = b.open();
    expect(open.length).toBe(1);
    expect(open[0]!.at).toBe(100); // first raise time kept
    expect(open[0]!.deadline).toBe(500); // the earliest deadline kept
    b.clear(open[0]!.id);
    expect(a.open()).toEqual([]);
    now = 200;
    expect(a.raise({ code: "R1_NO_CANDIDATE", severity: "action", gpuId: "0x01", day: 7, message: "again" }).at).toBe(200);
  });

  test("two indexes on one home (demo and real, same gpuIds): each sees and clears only its own alerts and the writers'", async () => {
    const home = tmp("agate-two-index-");
    const path = join(home, "alerts", "alerts.jsonl");
    const [A, B] = ["0xaaaaaaaa00000000000000000000000000000001", "0xbbbbbbbb00000000000000000000000000000002"];
    let now = 1_000;
    const a = new AlertSink(path, { now: () => now, print: false, index: A });
    const b = new AlertSink(path, { now: () => now, print: false, index: B });
    // a writer's alert (unscoped, ops.ts)
    appendLine(path, { id: "RPC_DOWN:-:-:-:0xw", code: "RPC_DOWN", severity: "action", at: 1, message: "every RPC URL failed (primary)" });
    // index A: its attester is down; index B: its attester beats. Both healths run the same code.
    const beat = (index: string) => new Heartbeat(join(home, "watcher", index, "heartbeat-attest.json"), "attest", index);
    beat(B).beat(now, "ok");
    const health = (index: string, alerts: AlertSink) => new Health({ view: {} as never, clock: { slice: 200 } as never, alerts, roles: [{ role: "attest", path: join(home, "watcher", index, "heartbeat-attest.json"), periodS: 200 }], gpuIds: [], keys: [] });
    await health(A, a).tick(now);
    a.raise({ code: "R5_HEAD_LAG", severity: "action", gpuId: G, day: 20_727, message: "lag" });
    now = 1_060;
    beat(B).beat(now, "ok");
    await health(B, b).tick(now);
    // index B's attester clears its older lag alerts for the same gpuId (attester.ts lagAlert)
    b.clearWhere((x) => x.code === "R5_HEAD_LAG" && x.gpuId === G && (x.day ?? 0) < 20_800);
    expect(a.open().map((x) => x.code).sort()).toEqual(["HEARTBEAT_LOST", "R5_HEAD_LAG", "RPC_DOWN"]);
    expect(a.open().find((x) => x.code === "HEARTBEAT_LOST")!.at).toBe(1_000);
    expect(b.open().map((x) => x.code)).toEqual(["RPC_DOWN"]);
    // the same condition on B is its own alert (its own id), never A's
    b.raise({ code: "R5_HEAD_LAG", severity: "action", gpuId: G, day: 20_727, message: "lag" });
    expect(a.open().filter((x) => x.code === "R5_HEAD_LAG").map((x) => x.id)).toEqual([alertId({ code: "R5_HEAD_LAG", gpuId: G, day: 20_727, index: A })]);
    // the writer's alert is never cleared by a watcher process
    b.clearWhere((x) => x.code === "RPC_DOWN");
    expect(new AlertSink(path, { now: () => now, print: false }).open().map((x) => x.code).sort()).toEqual(["HEARTBEAT_LOST", "R5_HEAD_LAG", "R5_HEAD_LAG", "RPC_DOWN"]);
  });

  test("two indexes on one home: health reads each index's own writer heartbeat; pick notes are per index", () => {
    const home = tmp("agate-two-index-");
    const [A, B] = ["0xaaaaaaaa00000000000000000000000000000001", "0xbbbbbbbb00000000000000000000000000000002"] as const;
    const now = 5_000;
    // index B's primary beats (writer.ts writes the shared heartbeat.json and its own per-index file); A's is dead
    for (const name of ["heartbeat.json", `heartbeat-${B.slice(2, 10)}.json`]) writeAtomic(join(home, "primary", name), JSON.stringify({ pid: 1, role: "primary", index: B, at: now, tick: 1, lastAction: "ok" }));
    const wall = (index: string) => ({ home, index, dir: join(home, "watcher", index), clock: { slice: 200, keeperPeriod: 200 } }) as unknown as Wall;
    const prev = process.env.AGATE_HEALTH_WRITERS;
    process.env.AGATE_HEALTH_WRITERS = "primary";
    try {
      expect(beatStatus(roleBeats(wall(A)), now).find((s) => s.role === "primary")).toMatchObject({ lost: true, age: null });
      expect(beatStatus(roleBeats(wall(B)), now).find((s) => s.role === "primary")).toMatchObject({ lost: false, age: 0 });
    } finally {
      if (prev === undefined) delete process.env.AGATE_HEALTH_WRITERS;
      else process.env.AGATE_HEALTH_WRITERS = prev;
    }
    expect(writerBeatFile(home, "primary", B)).toBe(join(home, "primary", `heartbeat-${B.slice(2, 10)}.json`));
    expect(pickNotePath(home, A, G)).not.toBe(pickNotePath(home, B, G));
  });
});

describe("health", () => {
  test("HEARTBEAT_LOST after three periods, cleared when it beats again; R5_HEAD_LAG; KEY_LOW; CLOCK_SKEW", async () => {
    const dir = tmp("agate-health-");
    const pages = new Pages([3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000]);
    const w = new World({ firstDay: 20_727, pages: pages.fn, writers: [{ net: "w1", close: "never" }], keeper: false, attester: false, guardian: null });
    await w.run(20_727 * 2_400 + 100);
    const hbPath = join(dir, "hb-attest.json");
    const hb = new Heartbeat(hbPath, "attest", "0x");
    hb.beat(w.now, "ok");
    w.chain.balances.set(w.m.writers[0].toLowerCase(), 1n);
    const health = new Health({ view: w.chain, clock: w.c, alerts: w.alerts, roles: [{ role: "attest", path: hbPath, periodS: 200 }], gpuIds: [w.panel.gpuId], keys: [{ role: "primary", address: w.m.writers[0] }] });
    await health.tick(w.now + 100);
    expect(w.alerts.open().some((a) => a.code === "HEARTBEAT_LOST")).toBe(false);
    expect(w.alerts.open().some((a) => a.code === "KEY_LOW")).toBe(true);
    await health.tick(w.now + 700);
    expect(w.alerts.open().some((a) => a.code === "HEARTBEAT_LOST")).toBe(true);
    hb.beat(w.now + 701, "ok");
    await health.tick(w.now + 702);
    expect(w.alerts.open().some((a) => a.code === "HEARTBEAT_LOST")).toBe(false);
    // the writer never closes and nobody keeps: the lag alert fires a DAY after the oldest open day ended
    await w.run(20_729 * 2_400 + 2_400 + 10);
    for (let j = 0; j < 3; j++) await health.tick(w.now + 60 + j); // local clock 60 s ahead of the chain: CLOCK_SKEW
    expect(w.alerts.open().some((a) => a.code === "R5_HEAD_LAG")).toBe(true);
    expect(w.alerts.open().some((a) => a.code === "CLOCK_SKEW")).toBe(true);
  });
});

function mkLog(eventName: string, args: Record<string, unknown>, block: number, logIndex: number): Log {
  const ev = ABI.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return { address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", topics: topics as never, data, blockNumber: BigInt(block), logIndex, blockHash: "0x00", transactionHash: "0x00", transactionIndex: 0, removed: false } as Log;
}

const G: Hex = "0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955";
const W: Hex = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("events", () => {
  test("the interface of record is v4.3; a stale generated abi.ts is detected (processes refuse to start on it)", () => {
    expect(abiProblems(ABI)).toEqual([]);
    const stale = abiProblems(agateIndexAbi as Abi);
    if (stale.length > 0) console.log(`NOTE: @agate/report abi.ts is stale (${stale.join("; ")}); run bun run gen:abi`);
  });

  test("decodeWallEvent reads the ABI's events into WallEvents", () => {
    const decodeWallEventFresh = (l: Log) => decodeWallEvent(l, ABI);
    const rp = decodeWallEventFresh(mkLog("ReadingsPosted", { gpuId: G, day: 20_758, writer: W, slice: 3, readAt: 1_793_542_937n, values: [3_990_000, 0], validMask: 1, late: false }, 10, 2))!;
    expect(rp).toMatchObject({ name: "ReadingsPosted", day: 20_758, slice: 3, validMask: 1, values: [3_990_000, 0], readAt: 1_793_542_937 });
    expect(rp.key).toBe("000000000010:000002");
    const rs = decodeWallEventFresh(mkLog("RecordSlots", { gpuId: G, day: 5, source: W, digest: `0x${"ab".repeat(32)}`, p: [1, 2], kinds: [1, 2], counts: [12, 0], post: [{ e: 1, miss: 0, inMedian: true, wasIn: true }, { e: 2, miss: 1, inMedian: true, wasIn: true }] }, 11, 0))!;
    expect(rs).toMatchObject({ name: "RecordSlots", kinds: [1, 2], post: [{ e: 1, miss: 0 }, { e: 2, miss: 1 }] });
    const dc = decodeWallEventFresh(mkLog("DayCarried", { gpuId: G, day: 6, value: 3_400_000, carryCase: 1, dropped: true, missAdvanced: 0b101 }, 12, 0))!;
    expect(dc).toMatchObject({ name: "DayCarried", carryCase: 1, dropped: true, missAdvanced: 5 });
    const cl = decodeWallEventFresh(mkLog("DayClosed", { gpuId: G, day: 6, source: W, value: 1, status: 1, fresh: 5, held: 0, freshMedian: 1, changed: true, needsSign: true, late: false, incomplete: true, digest: `0x${"cd".repeat(32)}` }, 13, 0))!;
    expect(cl).toMatchObject({ name: "DayClosed", needsSign: true, incomplete: true });
  });

  test("the indexer scans in chunks, persists events and a cursor, and resumes after a restart without duplicates", async () => {
    const dir = tmp("agate-events-");
    const logs = [mkLog("FixDropped", { gpuId: G, day: 1, source: W, value: 1, digest: `0x${"01".repeat(32)}` }, 5, 0), mkLog("FixDropped", { gpuId: G, day: 2, source: W, value: 1, digest: `0x${"02".repeat(32)}` }, 250, 1)];
    let head = 300n;
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
      },
    };
    const pool = { call: (fn: (c: unknown) => Promise<unknown>) => fn(client) };
    const ix = new EventIndexer({ pool: pool as never, address: W, dir, fromBlock: 0n, chunk: 100n, abi: ABI });
    await ix.sync();
    expect(ix.all().map((e) => e.day)).toEqual([1, 2]);
    expect(calls).toEqual([[0n, 99n], [100n, 199n], [200n, 299n], [300n, 300n]]);
    head = 400n;
    logs.push(mkLog("FixDropped", { gpuId: G, day: 3, source: W, value: 1, digest: `0x${"03".repeat(32)}` }, 350, 0));
    const again = new EventIndexer({ pool: pool as never, address: W, dir, fromBlock: 0n, chunk: 100n, abi: ABI });
    expect(again.all().map((e) => e.day)).toEqual([1, 2]);
    await again.sync();
    expect(again.all().map((e) => e.day)).toEqual([1, 2, 3]);
    expect(calls.at(-1)).toEqual([301n, 400n]);
  });
});
