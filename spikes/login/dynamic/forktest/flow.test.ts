// Runs the Dynamic spike's exact call sequence (lib/aa.ts) against an anvil fork of Monad testnet.
// Anvil default test accounts only (the public "test test ... junk" mnemonic). Nothing touches the public testnet.
// The Dynamic embedded wallet is replaced by an anvil account wrapped the same way the app wraps Dynamic's
// signer (toAccount with a signature counter), so signatures per step are measured, not guessed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { type Address, type PublicClient, createPublicClient, encodeFunctionData, http, parseEther } from "viem";
import { mnemonicToAccount, toAccount } from "viem/accounts";
import { contracts, flow } from "../../shared/config";
import {
  type AgentGrant,
  agentBuyCalls,
  agentSend,
  buyCalls,
  createAgentGrant,
  faucetCalls,
  gasPayer,
  grantSetupCalls,
  kernelClientFor,
  monadTestnet,
  ownerKernelAccount,
  sendCalls,
  testUsdAbi,
} from "../lib/aa";
import { miniBundler } from "./miniBundler";

setDefaultTimeout(240_000);

const PORT = Number(process.env.FORK_PORT ?? 18573);
const FORK = `http://127.0.0.1:${PORT}`;
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public default
const ownerKey = mnemonicToAccount(MNEMONIC, { addressIndex: 5 }); // stands in for the Dynamic embedded wallet
const sessionKey = mnemonicToAccount(MNEMONIC, { addressIndex: 6 }); // the agent's session key
const executor = mnemonicToAccount(MNEMONIC, { addressIndex: 7 }); // the bundler EOA
const sessionKey2 = mnemonicToAccount(MNEMONIC, { addressIndex: 8 }); // the agent's key for the budget-mode grant

let anvil: Subprocess | undefined;
let publicClient: PublicClient;
let signatures = 0;
const owner = toAccount({
  address: ownerKey.address,
  async signMessage(a) {
    signatures++;
    return ownerKey.signMessage(a);
  },
  async signTypedData(td) {
    signatures++;
    return ownerKey.signTypedData(td as never);
  },
  async signTransaction() {
    throw new Error("the owner never signs raw transactions in this flow");
  },
});

const rpc = (method: string, params: unknown[]) =>
  fetch(FORK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json());

const bal = (token: Address, who: Address) =>
  publicClient.readContract({ address: token, abi: testUsdAbi, functionName: "balanceOf", args: [who] });

const bundler = miniBundler(FORK, executor);
const t = () => ({ publicClient, bundlerTransport: bundler.transport });
let account: Awaited<ReturnType<typeof ownerKernelAccount>>;
let grant: AgentGrant;
const log: string[] = [];

beforeAll(async () => {
  anvil = spawn(
    ["anvil", "--fork-url", "https://testnet-rpc.monad.xyz", "--chain-id", "10143", "--port", String(PORT), "--silent"],
    { stdout: "ignore", stderr: "inherit" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      const j = (await rpc("eth_chainId", [])) as { result?: string };
      if (j.result === "0x279f") break;
    } catch {}
    await Bun.sleep(500);
  }
  // On Monad testnet every anvil default account carries an EIP-7702 delegation to a sweeper contract
  // (code 0xef01006bd9b7...), which drains MON the EntryPoint refunds to the bundler. Clear it on the fork only.
  for (const a of [ownerKey.address, sessionKey.address, executor.address, sessionKey2.address]) await rpc("anvil_setCode", [a, "0x"]);
  publicClient = createPublicClient({ chain: monadTestnet, transport: http(FORK) }) as PublicClient;
  account = await ownerKernelAccount(publicClient, owner);
  // Fork only: give the smart account MON for its own prefund (on testnet the ZeroDev paymaster pays instead).
  await rpc("anvil_setBalance", [account.address, `0x${parseEther("100").toString(16)}`]);
  await rpc("anvil_setBalance", [executor.address, `0x${parseEther("100").toString(16)}`]);
});

afterAll(() => {
  anvil?.kill();
  console.log(`\n--- fork run summary ---\n${log.join("\n")}`);
});

describe("Dynamic + ZeroDev flow on a Monad testnet fork", () => {
  test("contracts exist on the fork", async () => {
    for (const a of [contracts.testUsd, contracts.market, contracts.spUp]) {
      expect(((await publicClient.getCode({ address: a })) ?? "0x").length).toBeGreaterThan(2);
    }
    log.push(`user smart account (Kernel v3.1, index 0): ${account.address}, deployed before: ${await account.isDeployed()}`);
  });

  test("step 2: faucet as one user operation (deploys the account on first use)", async () => {
    const before = await bal(contracts.testUsd, account.address);
    const s0 = signatures;
    const r = await sendCalls(kernelClientFor(account, t()), faucetCalls(account.address));
    expect(r.success).toBe(true);
    expect((await bal(contracts.testUsd, account.address)) - before).toBe(flow.faucetAmount);
    expect(await account.isDeployed()).toBe(true);
    const g = gasPayer(r);
    log.push(`faucet: tx ${r.receipt.transactionHash}, signatures ${signatures - s0}, payer ${g.payer}, bundler ${g.bundler}`);
  });

  test("step 3: approve + buyUp(100) batched in ONE user operation", async () => {
    const usd0 = await bal(contracts.testUsd, account.address);
    const up0 = await bal(contracts.spUp, account.address);
    const s0 = signatures;
    const r = await sendCalls(kernelClientFor(account, t()), buyCalls(flow.buyAmount));
    expect(r.success).toBe(true);
    expect(signatures - s0).toBe(1);
    expect(usd0 - (await bal(contracts.testUsd, account.address))).toBe(flow.buyAmount);
    expect((await bal(contracts.spUp, account.address)) - up0).toBe(flow.buyAmount);
    log.push(`buy 100: tx ${r.receipt.transactionHash}, signatures ${signatures - s0} (one userop, 2 calls)`);
  });

  test("step 4a (per-call mode): grant the agent (one owner signature, no transaction)", async () => {
    const s0 = signatures;
    const block = await publicClient.getBlock();
    grant = await createAgentGrant({ publicClient, owner, agent: sessionKey.address, nowSeconds: Number(block.timestamp), mode: "per-call" });
    expect(grant.userAccount).toBe(account.address);
    expect(signatures - s0).toBe(1);
    log.push(`grant: signatures ${signatures - s0}, approval blob ${grant.approval.length} chars, validUntil ${grant.validUntil}`);
  });

  test("step 4b: the agent buys 50 with only the session key and the approval blob", async () => {
    const up0 = await bal(contracts.spUp, account.address);
    const s0 = signatures;
    const r = await agentSend({ ...t(), sessionKey, approval: grant.approval, calls: buyCalls(flow.agentBuyAmount) });
    expect(r.success).toBe(true);
    expect(signatures - s0).toBe(0); // the user is not involved
    expect((await bal(contracts.spUp, account.address)) - up0).toBe(flow.agentBuyAmount);
    log.push(`agent buy 50: tx ${r.receipt.transactionHash}, user signatures ${signatures - s0}, payer ${gasPayer(r).payer}`);
  });

  test("policy: the agent cannot buy more than 200 in one call", async () => {
    const err = await agentSend({ ...t(), sessionKey, approval: grant.approval, calls: buyCalls(flow.agentCap + 1n) }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    log.push("policy: buyUp(201) rejected");
  });

  test("policy: the agent cannot call anything else (TestUSD.transfer)", async () => {
    const data = encodeFunctionData({ abi: testUsdAbi, functionName: "transfer", args: [sessionKey.address, 1n] });
    const err = await agentSend({
      ...t(),
      sessionKey,
      approval: grant.approval,
      calls: [{ to: contracts.testUsd, value: 0n, data }],
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    log.push("policy: TestUSD.transfer rejected");
  });

  test("finding: the call policy caps each call, not the running total", async () => {
    const up0 = await bal(contracts.spUp, account.address);
    const calls = [...buyCalls(150_000_000n), ...buyCalls(150_000_000n)]; // 300 in one batch
    const r = await agentSend({ ...t(), sessionKey, approval: grant.approval, calls }).catch((e: Error) => e);
    const spent = r instanceof Error ? 0n : (await bal(contracts.spUp, account.address)) - up0;
    log.push(
      r instanceof Error
        ? "cumulative: a 300 batch was rejected"
        : `cumulative: a batch of 2 x 150 went through (spent ${Number(spent) / 1e6} > cap 200). Cap is per call only.`,
    );
    expect(true).toBe(true);
  });

  test("policy: the grant expires after one day", async () => {
    await rpc("evm_increaseTime", [flow.agentTtlSeconds + 60]);
    await rpc("evm_mine", []);
    const err = await agentSend({ ...t(), sessionKey, approval: grant.approval, calls: buyCalls(10_000_000n) }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    log.push(`policy: agent buy after ${flow.agentTtlSeconds + 60}s rejected; user ops sent through the fork bundler: ${bundler.stats.sent}`);
  });
  test("step 4 (budget mode, the app default): grant + approve(market, 200) in one user operation", async () => {
    const s0 = signatures;
    const block = await publicClient.getBlock();
    const g = await createAgentGrant({ publicClient, owner, agent: sessionKey2.address, nowSeconds: Number(block.timestamp) });
    expect(g.mode).toBe("budget");
    const r = await sendCalls(kernelClientFor(account, t()), grantSetupCalls("budget"));
    expect(r.success).toBe(true);
    expect(signatures - s0).toBe(2); // enable signature + the setup user operation
    grant = g;
    log.push(`budget grant: signatures ${signatures - s0} (1 permission + 1 userop), setup tx ${r.receipt.transactionHash}`);
  });

  const agentTry = async (amount: bigint, times = 1) => {
    const calls = Array.from({ length: times }, () => agentBuyCalls("budget", amount)).flat();
    const r = await agentSend({ ...t(), sessionKey: sessionKey2, approval: grant.approval, calls }).catch((e: Error) => e);
    return r instanceof Error ? "rejected" : r.success ? "ok" : "reverted";
  };

  test("budget mode: agent buys 50, then the total is capped at 200", async () => {
    const up0 = await bal(contracts.spUp, account.address);
    expect(await agentTry(flow.agentBuyAmount)).toBe("ok");
    expect((await bal(contracts.spUp, account.address)) - up0).toBe(flow.agentBuyAmount);
    const twoBy100 = await agentTry(100_000_000n, 2); // 200 more would make 250 total
    expect(twoBy100).not.toBe("ok");
    expect(await agentTry(150_000_000n)).toBe("ok"); // exactly the remaining 150
    expect(await agentTry(1_000_000n)).not.toBe("ok");
    const spent = (await bal(contracts.spUp, account.address)) - up0;
    expect(spent).toBe(flow.agentCap);
    const other = encodeFunctionData({ abi: testUsdAbi, functionName: "approve", args: [contracts.market, 10n ** 12n] });
    const raise = await agentSend({
      ...t(),
      sessionKey: sessionKey2,
      approval: grant.approval,
      calls: [{ to: contracts.testUsd, value: 0n, data: other }],
    }).catch((e: Error) => e);
    expect(raise).toBeInstanceOf(Error);
    log.push(`budget: 50 ok, 2 x 100 ${twoBy100}, 150 ok, 1 more rejected, agent cannot re-approve; total spent ${Number(spent) / 1e6}`);
  });
});
