// Fork test of the exact call sequence the Privy spike sends, against an anvil fork of Monad testnet
// where the shared contracts already exist. Uses anvil's default test account #1 as the "user".
// On the fork the user pays its own gas (no Privy sponsor); everything else is byte-for-byte the
// calldata and typed data the app hands to Privy.
//   bun test fork.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, contracts, flow } from "../../shared/config";
import {
  agentBudgetCall,
  agentBuyCall,
  buyUpAbiFragment,
  buyUpWithPermitCall,
  faucetCall,
  permitTypedData,
  spUpAbi,
  testUsdAbi,
  type Call,
} from "../app/src/calls";
import { agentPolicy } from "./policy-def";

const PORT = 18572;
const RPC = `http://127.0.0.1:${PORT}`;
// anvil default account #1 (public test key, never used on a real network by us)
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const user = privateKeyToAccount(USER_KEY);
const forkChain = {
  id: chain.id,
  name: "monad-testnet-fork",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

let anvil: Subprocess | undefined;
const pub = createPublicClient({ chain: forkChain, transport: http(RPC) });
const wallet = createWalletClient({ account: user, chain: forkChain, transport: http(RPC) });

async function send(call: Call) {
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r;
}
const usd = (a: Address) =>
  pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const up = (a: Address) =>
  pub.readContract({ address: contracts.spUp, abi: spUpAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const allowance = (a: Address) =>
  pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "allowance", args: [a, contracts.market] }) as Promise<bigint>;

beforeAll(async () => {
  anvil = Bun.spawn(
    ["anvil", "--fork-url", chain.rpcUrl, "--chain-id", String(chain.id), "--port", String(PORT), "--silent"],
    { stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await pub.getChainId()) === chain.id) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error("anvil fork did not come up");
}, 90_000);

afterAll(() => {
  anvil?.kill();
});

describe("Privy spike call sequence on a Monad testnet fork", () => {
  test("shared contracts exist on the fork", async () => {
    for (const a of [contracts.testUsd, contracts.market, contracts.spUp]) {
      const code = await pub.getCode({ address: a });
      expect(code && code.length > 2).toBe(true);
    }
  });

  test("step 2: faucet(user) mints 10,000 testUSD", async () => {
    const before = await usd(user.address);
    const r = await send(faucetCall(user.address));
    expect(r.status).toBe("success");
    expect((await usd(user.address)) - before).toBe(flow.faucetAmount);
  });

  test("step 3: permit signature + buyUpWithPermit(100) in one transaction", async () => {
    const [nonce, domain] = await Promise.all([
      pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "nonces", args: [user.address] }),
      pub.readContract({ address: contracts.testUsd, abi: testUsdAbi, functionName: "eip712Domain" }),
    ]);
    const [, name, version] = domain as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    // Exactly the object the app passes to Privy's signTypedData...
    const typed = permitTypedData({
      domain: { name, version, chainId: chain.id, verifyingContract: contracts.testUsd },
      owner: user.address,
      spender: contracts.market,
      value: flow.buyAmount,
      nonce: nonce as bigint,
      deadline,
    });
    // ...signed here by viem (which wants bigints and derives EIP712Domain itself).
    const { EIP712Domain: _omit, ...types } = typed.types;
    const signature = await user.signTypedData({
      domain: typed.domain,
      types,
      primaryType: typed.primaryType,
      message: {
        owner: typed.message.owner,
        spender: typed.message.spender,
        value: BigInt(typed.message.value),
        nonce: BigInt(typed.message.nonce),
        deadline: BigInt(typed.message.deadline),
      },
    });
    const upBefore = await up(user.address);
    const usdBefore = await usd(user.address);
    const r = await send(buyUpWithPermitCall(flow.buyAmount, deadline, signature));
    expect(r.status).toBe("success");
    expect((await up(user.address)) - upBefore).toBe(flow.buyAmount);
    expect(usdBefore - (await usd(user.address))).toBe(flow.buyAmount);
    // the permit was consumed by the buy (no leftover allowance), so the permit really did the approving
    expect(await allowance(user.address)).toBe(0n);
  });

  test("step 4 (user): approve(market, 200) sets the agent's onchain budget", async () => {
    const r = await send(agentBudgetCall());
    expect(r.status).toBe("success");
    expect(await allowance(user.address)).toBe(flow.agentCap);
  });

  test("step 4 (agent): buyUp(50) from the user's wallet, as the Privy signer sends it", async () => {
    const upBefore = await up(user.address);
    const r = await send(agentBuyCall());
    expect(r.status).toBe("success");
    expect((await up(user.address)) - upBefore).toBe(flow.agentBuyAmount);
    expect(await allowance(user.address)).toBe(flow.agentCap - flow.agentBuyAmount);
  });

  test("cumulative cap: a buy above the remaining 150 reverts onchain", async () => {
    const remaining = await allowance(user.address);
    await expect(
      pub.call({ account: user.address, to: contracts.market, data: agentBuyCall(remaining + 1n).data }),
    ).rejects.toThrow();
    // and exactly the remainder would still go through
    await pub.call({ account: user.address, to: contracts.market, data: agentBuyCall(remaining).data });
  });

  test("policy shape: matches the agent's buyUp call and nothing else", () => {
    const expiry = Math.floor(Date.now() / 1000) + flow.agentTtlSeconds;
    const p = agentPolicy(expiry);
    expect(p.rules.length).toBe(1);
    const conds = p.rules[0].conditions;
    const to = conds.find((c) => c.field === "to")!;
    const amt = conds.find((c) => c.field === "buyUp.amount")!;
    const time = conds.find((c) => c.field === "current_unix_timestamp")!;
    // the agent's call: right contract, decodes with the policy ABI, amount within the cap
    const buy = agentBuyCall();
    expect(buy.to.toLowerCase()).toBe(to.value);
    const decoded = decodeFunctionData({ abi: buyUpAbiFragment, data: buy.data });
    expect(decoded.functionName).toBe("buyUp");
    expect(decoded.args[0] <= BigInt(amt.value as string)).toBe(true);
    expect(Number(time.value)).toBe(expiry);
    // approve on TestUSD is a different contract, so the deny-by-default policy rejects it
    expect(agentBudgetCall().to.toLowerCase()).not.toBe(to.value);
    // a 250 buy would decode above the per-call cap
    expect(decodeFunctionData({ abi: buyUpAbiFragment, data: agentBuyCall(250_000_000n).data }).args[0] > BigInt(amt.value as string)).toBe(true);
  });

  test("agent/run.ts --dry-run builds the Privy request and passes its pre-checks on the fork", async () => {
    const proc = Bun.spawn(["bun", "run", "run.ts", "--user", user.address, "--dry-run"], {
      cwd: import.meta.dir,
      env: { ...process.env, AGENT_RPC_URL: RPC, PRIVY_APP_SECRET: "", PRIVY_AUTHORIZATION_PRIVATE_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("agent budget left 150");
    expect(out).toContain(`"caip2": "eip155:${chain.id}"`);
    expect(out).toContain('"sponsor": true');
    expect(out).toContain(agentBuyCall().data);
  });
});
