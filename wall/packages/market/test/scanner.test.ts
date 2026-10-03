// BOTS-SPEC 2.5 and 4.1: the payer's log scan over a scriptable JSON-RPC endpoint: a stranger's look-alike events
// dropped, series registered from a known factory's SeriesListed, dedupe, a torn last line, restart from the cursor,
// the finalized tip, chunk halving on a range error, and the two-call fallback when a node refuses a filter without an
// address. (Positions rebuilt from the events: wall/apps/payer/test/positions.test.ts.)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type AbiEvent, type Address, encodeAbiParameters, encodeEventTopics, type Hex, padHex, toHex } from "viem";
import { RpcPool } from "@agate/watcher";
import { agateFactoryAbi, agateSeriesAbi } from "../src/abi.ts";
import { compactEvents, isRangeError, isRateLimit, MarketScanner, SCAN_TOPICS, type ScanEvent } from "../src/scanner.ts";
import { FakeRpc, type RawLogJson } from "./fake/rpc-server.ts";

const A = (n: number): Address => padHex(toHex(n), { size: 20 }) as Address;
const FACTORY = A(0xfac);
const STRANGER = A(0xbad);
const U = 1_000_000n;

function rawLog(address: Address, abi: Abi, name: string, args: Record<string, unknown>, block: number, logIndex: number): RawLogJson {
  const item = abi.find((x) => x.type === "event" && x.name === name) as AbiEvent;
  const topics = encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[];
  const nonIdx = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIdx, nonIdx.map((i) => args[i.name!]) as never);
  return { address, topics, data, blockNumber: toHex(block), logIndex: toHex(logIndex), transactionHash: padHex(toHex(block * 1000 + logIndex), { size: 32 }), blockHash: padHex(toHex(block), { size: 32 }), transactionIndex: "0x0", removed: false };
}

const listed = (series: Address, block: number, li: number, from: Address = FACTORY) =>
  rawLog(from, agateFactoryAbi as Abi, "SeriesListed", { series, gpuId: padHex("0x01", { size: 32 }), month: 24_322, token: A(0x70c), startDay: 20_758, n: 30, startTs: 1_900_000_000n, day: 600, lastResort: 259_200n, floor: 1_800_000, cap: 7_200_000, x0: 3_600_000, bandGrade: 0, anchorCarried: 0, anchorMinFresh: 5, anchorLate: false, name: "agate H100 Nov 2026", symbol: "dH100-NOV26" }, block, li);
const opened = (series: Address, id: bigint, block: number, li: number, q = 720n * U) =>
  rawLog(series, agateSeriesAbi as Abi, "PositionOpened", { id, owner: A(0xa), payee: A(0xb), side: 0, q, paidNow: 1_296n * U, operator: A(0), daily: true, k: 0, to: A(0xa) }, block, li);
const claimed = (series: Address, id: bigint, paidTotal: bigint, block: number, li: number) => rawLog(series, agateSeriesAbi as Abi, "Claimed", { id, payee: A(0xb), amount: paidTotal - 1_296n * U, paidTotal, k: 1 }, block, li);

let rpc: FakeRpc;
let pool: RpcPool;
let dir: string;
const logs: { event: string; data: Record<string, unknown> }[] = [];
const mk = (o: Partial<{ chunk: number }> = {}) => new MarketScanner({ pool, dir, fromBlock: 10n, factories: [FACTORY], chunk: o.chunk ?? 100, log: (event, data) => logs.push({ event, data }) });

beforeAll(async () => {
  rpc = new FakeRpc().start();
  pool = await RpcPool.create({ urls: [rpc.url, rpc.url2], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "test", now: () => 0 });
});
afterAll(() => rpc.stop());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agate-payer-scan-"));
  rpc.logs = [];
  rpc.latest = 1_000n;
  rpc.finalizedLag = 2;
  rpc.maxRange = 100_000;
  rpc.refuseNoAddress = false;
  logs.length = 0;
});

const S1 = A(0x5e1);
const S2 = A(0x5e2);

describe("MarketScanner", () => {
  test("topic0 filter is the six events (FixApplied is not scanned: audit S-L1); a stranger's look-alikes are dropped; a known factory's series are followed", async () => {
    expect(SCAN_TOPICS.length).toBe(6);
    rpc.logs = [
      listed(S1, 20, 0),
      listed(S2, 21, 0, STRANGER), // a stranger's factory look-alike: its series is never followed
      opened(S1, 1n, 22, 0),
      opened(S2, 1n, 22, 1), // emitted by the stranger's "series"
      opened(A(0x5e3), 9n, 23, 0), // an unknown emitter
      opened(S1, 2n, 24, 3),
    ];
    const s = mk();
    await s.sync();
    expect(s.all().map((e) => `${e.name}@${e.address}`)).toEqual([`SeriesListed@${FACTORY.toLowerCase()}`, `PositionOpened@${S1.toLowerCase()}`, `PositionOpened@${S1.toLowerCase()}`]);
    expect(s.knownSeries()).toEqual([S1.toLowerCase()]);
    // one call per chunk, no address filter
    const gl = rpc.seen.filter((x) => x.method === "eth_getLogs");
    expect(gl.every((x) => (x.params[0] as { address?: unknown }).address === undefined)).toBe(true);
  });

  test("a series event before its SeriesListed is dropped: registration is in (block, logIndex) order", async () => {
    rpc.logs = [opened(S1, 1n, 30, 0), listed(S1, 30, 1), opened(S1, 2n, 30, 2)];
    const s = mk();
    await s.sync();
    expect(s.all().map((e) => e.name)).toEqual(["SeriesListed", "PositionOpened"]);
  });

  test("the tip is the finalized block (latest - 3 when a node refuses the tag)", async () => {
    rpc.logs = [listed(S1, 20, 0), opened(S1, 1n, 999, 0)];
    const s = mk();
    await s.sync();
    expect(s.next).toBe(999n); // finalized = 998
    expect(s.all().length).toBe(1);
    expect(s.caughtUp).toBe(true);
    rpc.latest = 1_001n;
    await s.sync();
    expect(s.all().length).toBe(2);
    rpc.finalizedLag = null;
    rpc.latest = 1_010n;
    await s.sync();
    expect(s.next).toBe(1_008n); // 1,010 - 3 + 1
  });

  test("restart: events.jsonl and cursor.json resume the scan; a torn last line is skipped; nothing is duplicated", async () => {
    rpc.logs = [listed(S1, 20, 0), opened(S1, 1n, 50, 0), claimed(S1, 1n, 1_400n * U, 60, 0)];
    const s = mk();
    await s.sync();
    expect(s.all().length).toBe(3);
    const calls = rpc.count("eth_getLogs");
    appendFileSync(join(dir, "events.jsonl"), '{"key":"000000000070:000000","name":"Clai'); // a torn line
    const again = mk();
    expect(again.all().length).toBe(3);
    expect(again.next).toBe(s.next);
    await again.sync();
    expect(rpc.count("eth_getLogs")).toBe(calls); // nothing new to scan
    // a crash after the events were written but before the cursor: the chunk is rescanned and deduplicated
    rmSync(join(dir, "cursor.json"));
    const third = mk();
    await third.sync();
    expect(third.all().length).toBe(3);
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter((l) => l.startsWith("{") && l.endsWith("}"));
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.length).toBe(3);
  });

  test("a range error halves the chunk down to 10, logged without the URL; a grown chunk that fails again backs off", async () => {
    rpc.maxRange = 30;
    rpc.logs = [listed(S1, 15, 0), opened(S1, 1n, 400, 0)];
    const s = mk();
    await s.sync();
    expect(s.chunkSize).toBe(25);
    expect(s.all().length).toBe(2);
    const halved = logs.filter((l) => l.event === "scan_chunk_halved");
    expect(halved.slice(0, 2).map((l) => l.data.chunk)).toEqual([50, 25]);
    expect(JSON.stringify(halved)).not.toContain("127.0.0.1");
    // a node whose real limit is under the configured chunk: growing back is tried ever more rarely (10, 20, 40 ...
    // successes), so the failed calls stay a small share of the scan
    const failed = halved.length;
    const calls = rpc.count("eth_getLogs");
    expect(failed).toBeLessThanOrEqual(5);
    expect(failed * 5).toBeLessThan(calls);
    rpc.maxRange = 5;
    rpc.latest = 2_000n;
    await expect(mk({ chunk: 10 }).sync()).rejects.toThrow();
  });

  test("a halved chunk grows back once the node takes it again (audit P-M2: never stuck at the floor)", async () => {
    rpc.maxRange = 30;
    rpc.latest = 300n;
    rpc.logs = [listed(S1, 15, 0)];
    const s = mk();
    await s.sync();
    expect(s.chunkSize).toBe(25);
    rpc.maxRange = 100_000; // the limit was a moment's
    rpc.latest = 5_000n;
    const from = logs.length;
    await s.sync();
    expect(s.chunkSize).toBe(100);
    expect(logs.slice(from).filter((l) => l.event === "scan_chunk_grown").map((l) => l.data.chunk)).toEqual([50, 100]);
    expect(s.caughtUp).toBe(true);
  });

  test("a node that refuses a filter without an address: two calls per chunk (the factories, then the known series)", async () => {
    rpc.refuseNoAddress = true;
    rpc.logs = [listed(S1, 20, 0), listed(S2, 21, 0, STRANGER), opened(S1, 1n, 20, 1), opened(S2, 1n, 40, 0), opened(S1, 2n, 300, 0)];
    const s = mk();
    await s.sync();
    expect(s.all().map((e) => e.name)).toEqual(["SeriesListed", "PositionOpened", "PositionOpened"]);
    expect(logs.filter((l) => l.event === "scan_split").length).toBe(1);
  });
});

describe("the cursor's identity (audit P-M3)", () => {
  test("cursor.json carries the chain id, the start block and the factory set", async () => {
    rpc.logs = [listed(S1, 20, 0)];
    await mk().sync();
    const j = JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"));
    expect(j).toMatchObject({ next: "999", chainId: 10143, fromBlock: "10", factories: [FACTORY.toLowerCase()] });
  });

  test("a cursor of another deployment (other factories or start block) restarts from the start block into a fresh events file", async () => {
    rpc.logs = [listed(S1, 20, 0), opened(S1, 1n, 50, 0)];
    await mk().sync();
    const other = new MarketScanner({ pool, dir, fromBlock: 12n, factories: [A(0xfa2)], chunk: 100, log: (event, data) => logs.push({ event, data }) });
    expect(other.next).toBe(12n);
    expect(other.all()).toEqual([]);
    expect(logs.some((l) => l.event === "scan_reset" && String(l.data.why).includes("fromBlock, factories"))).toBe(true);
    expect(readdirSync(dir).some((f) => /^events\.stale-\d+\.jsonl$/.test(f))).toBe(true);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    await other.sync(); // A(0xfa2) listed nothing: S1's events are not its
    expect(other.all()).toEqual([]);
    expect(other.caughtUp).toBe(true);
  });

  test("an older cursor without identity is adopted, unless it is far past this chain's finalized block", async () => {
    rpc.logs = [listed(S1, 20, 0), opened(S1, 1n, 50, 0)];
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ next: "40" }));
    const s = mk();
    expect(s.next).toBe(40n);
    await s.sync();
    expect(s.all()).toEqual([]); // adopted as it is: S1 was listed before block 40, so its later event is not followed
    // far ahead (a fork's or another chain's height): rescanned from the start block
    rmSync(join(dir, "events.jsonl"), { force: true });
    writeFileSync(join(dir, "cursor.json"), JSON.stringify({ next: "67760000" }));
    const t = mk();
    await t.sync();
    expect(t.all().map((e) => e.name)).toEqual(["SeriesListed", "PositionOpened"]);
    expect(rpc.count("eth_getLogs")).toBeGreaterThan(0);
  });
});

describe("rate limits are not range errors (audit P-M2)", () => {
  test("Alchemy's 429 and its friends are rate limits; a real range refusal is not", () => {
    const alchemy = new Error("Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.");
    expect(isRateLimit(alchemy)).toBe(true);
    expect(isRangeError(alchemy)).toBe(false);
    expect(isRateLimit(new Error("HTTP request failed. Status: 429"))).toBe(true);
    expect(isRateLimit(new Error("Too Many Requests"))).toBe(true);
    const range = new Error("block range too large: max 100 blocks");
    expect(isRangeError(range)).toBe(true);
    expect(isRateLimit(range)).toBe(false);
    expect(isRangeError(new Error("query returned more than 10000 results"))).toBe(true);
  });
});

describe("events.jsonl compaction (audit S-L1)", () => {
  const base = (name: string, key: string, address: string, extra: Record<string, unknown>) => ({ key, block: Number(key.slice(0, 12)), logIndex: 0, address, tx: null, name, ...extra }) as unknown as ScanEvent;
  test("keeps factory events and each open position's PositionOpened, newest Claimed and newest PayoutChanged; drops closed positions and FixApplied", () => {
    const s = S1.toLowerCase();
    const evs = [
      base("SeriesListed", "000000000001:000000", FACTORY.toLowerCase(), { series: s }),
      base("PositionOpened", "000000000002:000000", s, { id: 1n }),
      base("PositionOpened", "000000000002:000001", s, { id: 2n }),
      base("Claimed", "000000000003:000000", s, { id: 1n, paidTotal: 5n }),
      base("FixApplied", "000000000003:000001", s, {}),
      base("Claimed", "000000000004:000000", s, { id: 1n, paidTotal: 9n }),
      base("PayoutChanged", "000000000004:000001", s, { id: 1n }),
      base("PayoutChanged", "000000000005:000000", s, { id: 1n }),
      base("Claimed", "000000000005:000001", s, { id: 2n, paidTotal: 3n }),
      base("PositionClosed", "000000000006:000000", s, { id: 2n }),
    ];
    expect(compactEvents(evs).map((e) => e.key)).toEqual(["000000000001:000000", "000000000002:000000", "000000000004:000000", "000000000005:000000"]);
  });

  test("a large events file is compacted at start, and the positions it describes are the same", async () => {
    const ev: ReturnType<typeof listed>[] = [listed(S1, 20, 0), opened(S1, 1n, 21, 0)];
    for (let i = 0; i < 30; i++) ev.push(claimed(S1, 1n, 1_300n * U + BigInt(i), 30 + i, 0));
    rpc.logs = ev;
    const s = mk();
    await s.sync();
    expect(s.all().length).toBe(32);
    const small = new MarketScanner({ pool, dir, fromBlock: 10n, factories: [FACTORY], chunk: 100, compactAbove: 10, log: (event, data) => logs.push({ event, data }) });
    expect(small.all().map((e) => e.name)).toEqual(["SeriesListed", "PositionOpened", "Claimed"]);
    expect((small.all()[2] as ScanEvent & { paidTotal: bigint }).paidTotal).toBe(1_300n * U + 29n);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").length).toBe(3);
    expect(logs.some((l) => l.event === "scan_compacted")).toBe(true);
    await small.sync();
    expect(small.all().length).toBe(3); // nothing rescanned
  });
});
