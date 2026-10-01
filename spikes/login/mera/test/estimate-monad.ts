// Read-only gas measurement: eth_estimateGas for every call the spike sends, against Monad testnet itself and
// against an anvil fork, so the explicit limits in app/src/core/gas.ts cover Monad's own gas schedule.
// Sends nothing. The "user" and "agent" are anvil's public dev accounts; state they lack on the real chain
// (testUSD balance, allowance, agent grant) is supplied with eth_estimateGas state overrides.
// Run: bun test/estimate-monad.ts [forkRpcUrl]
import {
  type Address,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  pad,
  parseSignature,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { abis, contracts, defaultRpcUrl, flow, monadTestnet, testUsdPermitDomain } from "../app/src/core/chain";

// anvil default accounts #1 (user) and #2 (agent); public test keys, never funded on a real network by us.
const user = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const agent = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const mapSlot = (key: Address, slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (k1: Address, k2: Address, slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [k2, mapSlot(k1, slot)]));

async function estimates(rpcUrl: string) {
  const client = createPublicClient({ chain: monadTestnet(rpcUrl), transport: http(rpcUrl) });
  const usd = contracts.testUsd as Address;
  const market = contracts.market as Address;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = (await client.readContract({ address: usd, abi: abis.testUsd, functionName: "nonces", args: [user.address] })) as bigint;
  const sig = parseSignature(
    await user.signTypedData({
      domain: testUsdPermitDomain,
      types: { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] },
      primaryType: "Permit",
      message: { owner: user.address, spender: market, value: flow.buyAmount, nonce, deadline },
    }),
  );
  // OpenZeppelin v5 ERC20 layout: _balances slot 0, _allowances slot 1. SpikeMarket.agentAllowance slot 0.
  const balanceOverride = { slot: mapSlot(user.address, 0n), value: pad(toHex(flow.faucetAmount), { size: 32 }) };
  const allowanceOverride = { slot: nestedSlot(user.address, market, 1n), value: pad(toHex(flow.agentCap), { size: 32 }) };
  const expiry = BigInt(Math.floor(Date.now() / 1000) + flow.agentTtlSeconds);
  const grantOverride = { slot: nestedSlot(user.address, agent.address, 0n), value: pad(toHex((expiry << 128n) | flow.agentCap), { size: 32 }) };

  const calls: Record<string, { from: Address; to: Address; data: Hex; stateOverride?: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] }> = {
    faucet: { from: user.address, to: usd, data: encodeFunctionData({ abi: abis.testUsd, functionName: "faucet", args: [user.address] }) },
    approve: { from: user.address, to: usd, data: encodeFunctionData({ abi: abis.testUsd, functionName: "approve", args: [market, flow.agentCap] }) },
    approveAgent: { from: user.address, to: market, data: encodeFunctionData({ abi: abis.market, functionName: "approveAgent", args: [agent.address, flow.agentCap, expiry] }) },
    buyUpWithPermit: {
      from: user.address, to: market,
      data: encodeFunctionData({ abi: abis.market, functionName: "buyUpWithPermit", args: [flow.buyAmount, deadline, Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0))), sig.r, sig.s] }),
      stateOverride: [{ address: usd, stateDiff: [balanceOverride] }],
    },
    buyUpFor: {
      from: agent.address, to: market,
      data: encodeFunctionData({ abi: abis.market, functionName: "buyUpFor", args: [user.address, flow.agentBuyAmount] }),
      stateOverride: [
        { address: usd, stateDiff: [balanceOverride, allowanceOverride] },
        { address: market, stateDiff: [grantOverride] },
      ],
    },
  };
  const out: Record<string, string> = {};
  for (const [name, c] of Object.entries(calls)) {
    try {
      out[name] = (await client.estimateGas({ account: c.from, to: c.to, data: c.data, stateOverride: c.stateOverride })).toString();
    } catch (e) {
      out[name] = `error: ${(e as Error).message.split("\n")[0]}`;
    }
  }
  return out;
}

const fork = process.argv[2] ?? "http://127.0.0.1:8547";
console.log(JSON.stringify({ monadTestnet: await estimates(defaultRpcUrl), anvilFork: await estimates(fork) }, null, 2));
