// The Oct 3 code review's findings on the shared layer (phase 3 checkpoint), each fixed:
//   3. MarketScanner.reset while running gave consumers no sign: it now bumps `epoch` (the payer rebuilds on it);
//   5. GAS_CAP was one alert per target for every bot and shape, raised by a call its caller then split and cleared by
//      the smaller call in the same breath (and notified again every tick), and cleared by the other bot's sends;
//   7. a replacement transaction (fees x1.25 up to three times) was signed without asking the MON floor again;
//   8. an AGATE_MARKET_GAS_LIMITS entry of {} passed validation and made every plan of its shape throw.
// A scriptable local JSON-RPC endpoint and fakes only: no chain, no key of value, no network.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Abi, type AbiEvent, type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Hex, padHex, parseTransaction, toFunctionSelector, toHex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { AlertSink, RpcPool } from "@agate/watcher";
import { agateFactoryAbi, agateSeriesAbi } from "../src/abi.ts";
import { capFor, LimitsError, LimitTable } from "../src/limits.ts";
import { MarketScanner } from "../src/scanner.ts";
import { gasCapKey, MarketSender, type SpendGuard } from "../src/sender.ts";
import type { SendSpec } from "../src/types.ts";
import { FakeRpc, type RawLogJson } from "./fake/rpc-server.ts";

const KEY_ENV = "AGATE_TEST_REVIEW_SENDER_KEY";
process.env[KEY_ENV] = generatePrivateKey();
const SERIES: Address = "0x00000000000000000000000000000000000005e1";
const T = new LimitTable();

let rpc: FakeRpc;
let pool: RpcPool;
let alerts: AlertSink;
const events: { event: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  rpc = new FakeRpc().start();
  pool = await RpcPool.create({ urls: [rpc.url, rpc.url2], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "test", now: () => 0 });
});
afterAll(() => rpc.stop());
beforeEach(() => {
  alerts = new AlertSink(join(mkdtempSync(join(tmpdir(), "agate-market-review-")), "alerts.jsonl"), { now: () => 0, print: false });
  rpc.raws = [];
  rpc.seen.length = 0;
  rpc.noReceipt = false;
  rpc.call = (p) => (p.data.startsWith(toFunctionSelector("claimMany(uint256[])")) ? { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "claimMany", result: 1n }) } : { result: "0x" });
  rpc.estimate = () => 100_000n;
  events.length = 0;
});

const sender = (role: string, o: Partial<{ guard: SpendGuard; now: () => number; sleep: (ms: number) => Promise<void> }> = {}) =>
  new MarketSender({ pool, role, keyEnv: KEY_ENV, limits: T, alerts, ...(o.guard ? { guard: o.guard } : {}), now: o.now ?? (() => 0), ...(o.sleep ? { sleep: o.sleep } : {}), pollMs: 1, rebroadcastS: 1_000_000, replaceS: 30, maxReplacements: 3, giveUpS: 30, log: (event, data) => events.push({ event, data }) });
const claim = (n: number, splits = false): SendSpec => ({ to: SERIES, abi: agateSeriesAbi, functionName: "claimMany", args: [Array.from({ length: n }, (_, i) => BigInt(i + 1))], shape: "series.claimMany", c: 0, n, ...(splits ? { splitsOnCap: true } : {}) });
const sync = (c: number): SendSpec => ({ to: SERIES, abi: agateSeriesAbi, functionName: "sync", args: [BigInt(c)], shape: "series.sync", c });
const gasCaps = () => alerts.open().filter((a) => (a.code as string) === "GAS_CAP");
const over = (s: SendSpec) => () => BigInt(Math.ceil(Number(capFor(T, s.shape, "0x", { c: s.c ?? 0, n: s.n ?? 1 })) / 1.2) + 10_000);

describe("finding 5: GAS_CAP is per role, shape and target; a split call only logs", () => {
  test("a capped call its caller splits raises nothing; the smallest call over the cap raises once", async () => {
    rpc.estimate = over(claim(50));
    const p = await sender("payer").plan(claim(50, true));
    expect(p.error).toBe("GAS_CAP");
    expect(gasCaps()).toEqual([]);
    expect(events.some((e) => e.event === "gas_cap_split")).toBe(true);
    // the smaller half fits: nothing to clear, nothing raised (before the fix: raised, then cleared in the same tick)
    rpc.estimate = () => 100_000n;
    expect((await sender("payer").plan(claim(25, true))).ok).toBe(true);
    expect(gasCaps()).toEqual([]);
    // one id over the cap (not split further): the action alert, keyed by role, shape and target
    rpc.estimate = over(claim(1));
    expect((await sender("payer").plan(claim(1))).error).toBe("GAS_CAP");
    expect(gasCaps().map((a) => a.id)).toEqual([`GAS_CAP:-:-:-:-:${gasCapKey("payer", "series.claimMany", SERIES)}`]);
  });

  test("another bot's send, or another shape, never clears it", async () => {
    rpc.estimate = over(claim(1));
    await sender("payer").plan(claim(1));
    expect(gasCaps().length).toBe(1);
    rpc.estimate = () => 100_000n;
    // the maker's sync on the same series plans fine; so does the payer's own sync: the claim alert stays
    expect((await sender("marketmaker").plan(sync(1))).ok).toBe(true);
    expect((await sender("payer").plan(sync(1))).ok).toBe(true);
    expect(gasCaps().length).toBe(1);
    // the payer's claimMany on that series fits again: cleared
    expect((await sender("payer").plan(claim(1))).ok).toBe(true);
    expect(gasCaps()).toEqual([]);
  });
});

describe("finding 7: a replacement asks the floor again", () => {
  test("a replacement whose higher fee the floor refuses is not signed; the one in flight keeps waiting", async () => {
    rpc.noReceipt = true;
    let clock = 0;
    const asked: { c: bigint; safety: boolean }[] = [];
    // the floor allows the first send and one replacement (x1.25), not a second (x1.5625)
    const guard: SpendGuard = {
      canSpend: (c, safety) => {
        asked.push({ c, safety });
        return c * 100n <= asked[0]!.c * 130n ? { ok: true } : { ok: false, why: "FLOOR" };
      },
      record: () => {},
    };
    const s = sender("payer", { guard, now: () => clock, sleep: async () => void (clock += 10) });
    const r = await s.send(claim(1));
    expect(r).toMatchObject({ ok: false, sent: true, error: "NONCE_STUCK" });
    // the first send, then three replacement rounds, each asked as a safety send (the floor only, never pacing)
    expect(asked.length).toBe(4);
    expect(asked.slice(1).every((x) => x.safety)).toBe(true);
    // before the fix: four raws (the first and three replacements at x1.25, x1.5625, x1.95); now two
    expect(rpc.raws.length).toBe(2);
    const fees = rpc.raws.map((x) => parseTransaction(x).maxFeePerGas!);
    expect(fees[1]!).toBe((fees[0]! * 125n + 99n) / 100n); // raised once, x1.25 (under the 200 gwei cap)
    expect(events.filter((e) => e.event === "replacement_held").length).toBe(2);
  });
});

describe("finding 8: an empty override", () => {
  test("AGATE_MARKET_GAS_LIMITS with {} for a shape is refused at start; a direct {} counts as no override", () => {
    for (const shape of ["factory.list", "kuru.batchUpdate", "series.mint", "series.sync"]) {
      expect(() => LimitTable.fromEnv({ AGATE_MARKET_GAS_LIMITS: JSON.stringify({ [shape]: {} }) })).toThrow(LimitsError);
    }
    const t = new LimitTable({ "factory.list": {}, "series.mint": {} });
    expect(t.limitFor("factory.list")).toBe(new LimitTable().limitFor("factory.list"));
    expect(t.measured("kuru.batchUpdate")).toBe(false);
    expect(new LimitTable({ "kuru.batchUpdate": {} }).measured("kuru.batchUpdate")).toBe(false);
  });
});

describe("finding 3: a scan that starts over says so", () => {
  const A = (n: number): Address => padHex(toHex(n), { size: 20 }) as Address;
  const FACTORY = A(0xfac);
  const listed = (series: Address, block: number): RawLogJson => {
    const item = (agateFactoryAbi as Abi).find((x) => x.type === "event" && x.name === "SeriesListed") as AbiEvent;
    const args: Record<string, unknown> = { series, gpuId: padHex("0x01", { size: 32 }), month: 24_322, token: A(0x70c), startDay: 20_758, n: 30, startTs: 1_900_000_000n, day: 600, lastResort: 259_200n, floor: 1_800_000, cap: 7_200_000, x0: 3_600_000, bandGrade: 0, anchorCarried: 0, anchorMinFresh: 5, anchorLate: false, name: "agate H100 Nov 2026", symbol: "dH100-NOV26" };
    const topics = encodeEventTopics({ abi: [item], eventName: "SeriesListed", args: Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as Hex[];
    const nonIdx = item.inputs.filter((i) => !i.indexed);
    return { address: FACTORY, topics, data: encodeAbiParameters(nonIdx, nonIdx.map((i) => args[i.name!]) as never), blockNumber: toHex(block), logIndex: "0x0", transactionHash: padHex(toHex(block), { size: 32 }), blockHash: padHex(toHex(block), { size: 32 }), transactionIndex: "0x0", removed: false };
  };
  test("the finalized tip far below the cursor: reset, epoch + 1, a fresh list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agate-market-review-scan-"));
    rpc.logs = [listed(A(0x5e1), 20)];
    rpc.latest = 60_000n;
    rpc.finalizedLag = 2;
    const s = new MarketScanner({ pool, dir, fromBlock: 10n, factories: [FACTORY], chunk: 100_000 });
    await s.sync();
    expect(s.epoch).toBe(0);
    const before = s.all();
    expect(before.length).toBe(1);
    // a testnet reset: the chain is back at block 1,000, far under the cursor
    rpc.latest = 1_000n;
    rpc.logs = [listed(A(0x5e2), 30)];
    await s.sync();
    expect(s.epoch).toBe(1);
    expect(s.all()).not.toBe(before);
    expect(s.all().map((e) => (e as { series: string }).series)).toEqual([A(0x5e2).toLowerCase()]);
    rpc.latest = 1_000n;
    rpc.logs = [];
  });
});
