// Pure viem helpers for the Privy spike. The app and the fork test both use these, so the fork test
// exercises the exact calldata and typed data the app sends through Privy.
import { encodeFunctionData, parseSignature, type Address, type Hex, type Abi } from "viem";
import { abis, chain, contracts, flow } from "../../../shared/config";

export const testUsdAbi = abis.testUsd as Abi;
export const marketAbi = abis.market as Abi;
export const spUpAbi = abis.spUp as Abi;

export type Call = { to: Address; data: Hex; label: string };

// Step 2: anyone may call faucet(to); the user's wallet sends it, Privy sponsors the gas.
export function faucetCall(user: Address): Call {
  return {
    to: contracts.testUsd,
    data: encodeFunctionData({ abi: testUsdAbi, functionName: "faucet", args: [user] }),
    label: "faucet",
  };
}

// Step 3: EIP-2612 permit typed data. Privy's signTypedData takes the eth-sig-util TypedMessage shape,
// so numbers are passed as decimal strings and EIP712Domain is listed explicitly.
export type PermitDomain = { name: string; version: string; chainId: number; verifyingContract: Address };

export function permitTypedData(args: {
  domain: PermitDomain;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    domain: args.domain,
    message: {
      owner: args.owner,
      spender: args.spender,
      value: args.value.toString(),
      nonce: args.nonce.toString(),
      deadline: args.deadline.toString(),
    },
  };
}

export function buyUpWithPermitCall(amount: bigint, deadline: bigint, signature: Hex): Call {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
  return {
    to: contracts.market,
    data: encodeFunctionData({
      abi: marketAbi,
      functionName: "buyUpWithPermit",
      args: [amount, deadline, v, sig.r, sig.s],
    }),
    label: "buyUpWithPermit",
  };
}

// Step 4 (user side): the onchain budget for the agent. The Privy signer may only call buyUp, never approve,
// so this allowance is a hard cumulative cap of 200 testUSD on what the agent can spend.
export function agentBudgetCall(): Call {
  return {
    to: contracts.testUsd,
    data: encodeFunctionData({ abi: testUsdAbi, functionName: "approve", args: [contracts.market, flow.agentCap] }),
    label: "approve(market, 200)",
  };
}

// Step 4 (agent side): what agent/run.ts sends from the user's wallet through the Privy signer.
export function agentBuyCall(amount: bigint = flow.agentBuyAmount): Call {
  return {
    to: contracts.market,
    data: encodeFunctionData({ abi: marketAbi, functionName: "buyUp", args: [amount] }),
    label: "buyUp (agent)",
  };
}

// The only function the agent policy allows. Kept as its own ABI fragment because Privy policies need
// the ABI to decode calldata.
export const buyUpAbiFragment = [
  {
    type: "function",
    name: "buyUp",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

export const caip2 = `eip155:${chain.id}` as const;
export const explorerTx = (hash: string) => `${chain.explorer}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${chain.explorer}/address/${addr}`;
