// ViemReads over plain calls (no Multicall3 on the endpoint): decoding, null on revert, previewListing's decoded
// error, batching in one turn of the event loop; getL2Book's layout and Kuru's status rule (BOTS-SPEC 1, 3.6); the
// generated ABI against the forge artifacts (AGATE_FORGE_OUT, default contracts/out) and against scripts/gen-abi.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, type Hex, padHex, toFunctionSelector } from "viem";
import { RpcPool } from "@agate/watcher";
import { forgeOut, render } from "../scripts/gen-abi.ts";
import * as ABI from "../src/abi.ts";
import { agateFactoryAbi, agateSeriesAbi } from "../src/abi.ts";
import { decodeL2Book, kuruStatus, ViemReads } from "../src/reads.ts";
import { FakeRpc } from "./fake/rpc-server.ts";

const S: Address = "0x00000000000000000000000000000000000005e1";
const F: Address = "0x0000000000000000000000000000000000000fac";
let rpc: FakeRpc;
let reads: ViemReads;

beforeAll(async () => {
  rpc = new FakeRpc().start();
  const pool = await RpcPool.create({ urls: [rpc.url, rpc.url2], expectChainId: 10143, timeoutMs: 5_000, staleS: 10 ** 9, role: "test", now: () => 0 });
  reads = new ViemReads({ pool });
  const sel = (sig: string) => toFunctionSelector(sig);
  rpc.call = (p) => {
    if (p.data.startsWith(sel("previewSync()"))) return { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "previewSync", result: [7, 25_200_000n] }) };
    if (p.data.startsWith(sel("state()"))) return { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "state", result: [6, 21_600_000n, 3_600_000, false, true, 99n, 12n, 5n] }) };
    if (p.data.startsWith(sel("claimable(uint256)"))) return { revert: encodeErrorResult({ abi: agateSeriesAbi, errorName: "NoPosition", args: [4n] }) };
    if (p.data.startsWith(sel("position(uint256)"))) return { result: encodeFunctionResult({ abi: agateSeriesAbi, functionName: "position", result: { owner: "0x0000000000000000000000000000000000000000", side: 0, daily: false, openedK: 0, payee: "0x0000000000000000000000000000000000000000", q: 0n, operator: "0x0000000000000000000000000000000000000000", paid: 0n } }) };
    if (p.data.startsWith(sel("previewListing(bytes32,uint32)"))) return { revert: encodeErrorResult({ abi: agateFactoryAbi, errorName: "NotReady" }) };
    if (p.data.startsWith(sel("currentMonth()"))) return { result: encodeFunctionResult({ abi: agateFactoryAbi, functionName: "currentMonth", result: 24_321 }) };
    return { revert: "0x" };
  };
});
afterAll(() => rpc.stop());

describe("ViemReads (plain calls)", () => {
  test("decodes the series views; a reverting view is null; previewListing carries the decoded error", async () => {
    const before = reads.batches;
    const [st, pv, cl, pos, chk, m] = await Promise.all([reads.state(S), reads.previewSync(S), reads.claimable(S, 4n), reads.position(S, 4n), reads.previewListing(F, padHex("0x01", { size: 32 }), 24_322), reads.currentMonth(F)]);
    expect(reads.batches - before).toBe(1); // one turn of the event loop, one batch
    expect(st).toMatchObject({ k: 6, sum: 21_600_000n, lastX: 3_600_000n, appliedReal: true, ledger: 99n, nextId: 12n, shortSupply: 5n });
    expect(pv).toEqual({ k: 7, sum: 25_200_000n });
    expect(cl).toBeNull();
    expect(pos).toBeNull();
    expect(chk).toEqual({ ok: false, error: "NotReady()" });
    expect(m).toBe(24_321);
  });
  test("a view that must answer throws on a revert (never a silent zero)", async () => {
    await expect(reads.gpuIds(F)).rejects.toThrow("gpuIds");
  });
});

describe("Kuru's order status rule (3.6)", () => {
  test("price 0 cancelled; head 0 or head > id filled; else active", () => {
    expect(kuruStatus(5n, 0n, 9n)).toBe("CANCELED");
    expect(kuruStatus(5n, 1n, 0n)).toBe("FILLED");
    expect(kuruStatus(5n, 1n, 6n)).toBe("FILLED");
    expect(kuruStatus(5n, 1n, 5n)).toBe("ACTIVE");
    expect(kuruStatus(5n, 1n, 3n)).toBe("ACTIVE");
  });
});

describe("getL2Book layout", () => {
  test("block, bids best first, a zero word, asks best first", () => {
    const words = [123n, 3_590_000n, 10_000_000n, 3_580_000n, 20_000_000n, 0n, 3_640_000n, 10_000_000n, 3_650_000n, 5n];
    const data = encodeAbiParameters(words.map(() => ({ type: "uint256" })), words) as Hex;
    expect(decodeL2Book(data)).toEqual({ block: 123n, bids: [[3_590_000n, 10_000_000n], [3_580_000n, 20_000_000n]], asks: [[3_640_000n, 10_000_000n], [3_650_000n, 5n]] });
    const empty = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [9n, 0n]) as Hex;
    expect(decodeL2Book(empty)).toEqual({ block: 9n, bids: [], asks: [] });
  });
});

const OUT = forgeOut();
const ABI_FILES = ["AgateFactory", "AgateSeries", "AgateToken", "AgateRouter", "AgateDollar", "IKuruRouter"];
describe("generated ABI", () => {
  const pairs: [keyof typeof ABI, string][] = [
    ["agateFactoryAbi", "AgateFactory"],
    ["agateSeriesAbi", "AgateSeries"],
    ["agateTokenAbi", "AgateToken"],
    ["agateRouterAbi", "AgateRouter"],
    ["agateDollarAbi", "AgateDollar"],
    ["iKuruRouterAbi", "IKuruRouter"],
  ];
  for (const [name, contract] of pairs) {
    const file = join(OUT, `${contract}.sol/${contract}.json`);
    test.skipIf(!existsSync(file))(`${name} equals the forge artifact (bun run gen:abi after forge build)`, async () => {
      const { abi } = await Bun.file(file).json();
      expect(JSON.parse(JSON.stringify(ABI[name]))).toEqual(abi);
    });
  }
});
describe("src/abi.ts is exactly what scripts/gen-abi.ts writes", () => {
  const have = ABI_FILES.every((c) => existsSync(join(OUT, `${c}.sol/${c}.json`)));
  test.skipIf(!have)("bun run gen:abi after a contracts change", async () => {
    expect(readFileSync(join(import.meta.dir, "../src/abi.ts"), "utf8")).toBe(await render(OUT));
  });
});
