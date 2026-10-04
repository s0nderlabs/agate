// The write path's policy, on fakes (no chain): simulate first and send nothing when it reverts; an explicit gas
// limit of ceil(1.2 x eth_estimateGas); a reverted receipt is an error; events are decoded.
import { describe, expect, test } from "bun:test";
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, encodeEventTopics, type Hex, keccak256, toHex } from "viem";
import { agateDollarAbi } from "../src/abi.ts";
import type { AgateClient } from "../src/client.ts";
import { decodeLogs, send, WriteError } from "../src/writes.ts";

const ME = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DOLLAR = "0x3A0513b2A19EE92eb3f73Dd06EefEe4D477CbF38";

function fakes(o: { revert?: boolean; estimate?: bigint; status?: "success" | "reverted" }) {
  const sent: unknown[] = [];
  const dripped = { address: DOLLAR, topics: encodeEventTopics({ abi: agateDollarAbi, eventName: "Dripped", args: { to: ME } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [10_000_000_000n, 1_791_244_800n]) };
  const pub = {
    async simulateContract() {
      if (o.revert) {
        const e = new ContractFunctionRevertedError({ abi: agateDollarAbi, functionName: "drip", data: (keccak256(toHex("DripTooSoon(uint64)")).slice(0, 10) + "00".repeat(31) + "05") as Hex });
        throw new BaseError("call reverted", { cause: e });
      }
      return { result: 1n };
    },
    async estimateContractGas() {
      return o.estimate ?? 100_001n;
    },
    async waitForTransactionReceipt() {
      return { status: o.status ?? "success", gasUsed: 90_000n, blockNumber: 7n, logs: [dripped] };
    },
  };
  const c = { pub, chain: { id: 10143 } } as unknown as AgateClient;
  const w = {
    account: { address: ME, type: "local" },
    chain: { id: 10143 },
    async writeContract(req: unknown) {
      sent.push(req);
      return "0xabc" as Hex;
    },
  };
  return { c, w: w as never, sent };
}

const call = { address: DOLLAR as Hex, abi: agateDollarAbi, functionName: "drip", args: [], label: "drip" };

describe("send", () => {
  test("a reverted simulation sends nothing and names the error", async () => {
    const f = fakes({ revert: true });
    const e = await send(f.c, f.w, call as never).catch((x) => x);
    expect(e).toBeInstanceOf(WriteError);
    expect((e as WriteError).stage).toBe("simulate");
    expect((e as WriteError).reason).toBe("DripTooSoon");
    expect(f.sent.length).toBe(0);
  });
  test("the gas limit is ceil(1.2 x the estimate), always set", async () => {
    const f = fakes({ estimate: 100_001n });
    const t = await send(f.c, f.w, call as never);
    expect(t.gasLimit).toBe(120_002n);
    expect((f.sent[0] as { gas: bigint }).gas).toBe(120_002n);
    expect(t.gasUsed).toBe(90_000n);
    expect(t.events[0]?.name).toBe("Dripped");
    expect((t.events[0]?.args as { amount: bigint }).amount).toBe(10_000_000_000n);
  });
  test("a reverted receipt is an error carrying the hash", async () => {
    const f = fakes({ status: "reverted" });
    const e = await send(f.c, f.w, call as never).catch((x) => x);
    expect((e as WriteError).stage).toBe("receipt");
    expect((e as WriteError).hash).toBe("0xabc");
  });
  test("decodeLogs skips logs of contracts it does not know", () => {
    expect(decodeLogs([{ address: DOLLAR, topics: [keccak256(toHex("Other()"))], data: "0x" } as never])).toEqual([]);
  });
});
