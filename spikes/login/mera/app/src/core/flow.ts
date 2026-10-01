// The exact contract calls of the four steps, shared by the app, agent/run.ts and the fork test.
// Every write sets explicit gas (Monad bills the declared limit) and waits for its receipt.
import {
  type Account,
  type Address,
  type Chain,
  type Hash,
  parseSignature,
  type PublicClient,
  type Transport,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { abis, contracts, flow, testUsdPermitDomain } from "./chain";
import { GAS } from "./gas";

export type Signer = WalletClient<Transport, Chain, Account>;
export type Sent = { label: string; hash: Hash; receipt: TransactionReceipt; gasLimit: bigint };

const usd = contracts.testUsd as Address;
const market = contracts.market as Address;

async function send(
  label: string,
  wallet: Signer,
  client: PublicClient,
  req: { address: Address; abi: typeof abis.market; functionName: string; args: readonly unknown[]; gas: bigint },
): Promise<Sent> {
  const hash = await wallet.writeContract({ ...req, account: wallet.account, chain: wallet.chain } as Parameters<Signer["writeContract"]>[0]);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 400 });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return { label, hash, receipt, gasLimit: req.gas };
}

/** Step 2: mint 10,000 testUSD to the signer. One transaction, paid by the signer. */
export function claimTestUsd(wallet: Signer, client: PublicClient): Promise<Sent> {
  return send("faucet", wallet, client, {
    address: usd, abi: abis.testUsd, functionName: "faucet", args: [wallet.account.address], gas: GAS.faucet,
  });
}

/** Step 3: one EIP-2612 permit signature (no transaction) plus one buyUpWithPermit transaction. */
export async function goLong(wallet: Signer, client: PublicClient, amount: bigint = flow.buyAmount): Promise<Sent> {
  const owner = wallet.account.address;
  const nonce = (await client.readContract({ address: usd, abi: abis.testUsd, functionName: "nonces", args: [owner] })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await wallet.signTypedData({
    account: wallet.account,
    domain: testUsdPermitDomain,
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender: market, value: amount, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const vNum = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
  return send("buyUpWithPermit", wallet, client, {
    address: market, abi: abis.market, functionName: "buyUpWithPermit", args: [amount, deadline, vNum, r, s], gas: GAS.buyUpWithPermit,
  });
}

/**
 * Step 4: give the agent a cap and an expiry. Two transactions from one tap: the token allowance the market
 * needs to pull the agent's buys, then the agent grant itself.
 */
export async function grantAgent(
  wallet: Signer,
  client: PublicClient,
  agent: Address,
  cap: bigint = flow.agentCap,
  ttlSeconds: number = flow.agentTtlSeconds,
): Promise<{ approve: Sent; grant: Sent; expiry: bigint }> {
  const expiry = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
  const approve = await send("approve", wallet, client, {
    address: usd, abi: abis.testUsd, functionName: "approve", args: [market, cap], gas: GAS.approve,
  });
  const grant = await send("approveAgent", wallet, client, {
    address: market, abi: abis.market, functionName: "approveAgent", args: [agent, cap, expiry], gas: GAS.approveAgent,
  });
  return { approve, grant, expiry };
}

/** The agent's side: buy for the user within the grant. Paid by the agent's own key. */
export function agentBuy(agentWallet: Signer, client: PublicClient, user: Address, amount: bigint = flow.agentBuyAmount): Promise<Sent> {
  return send("buyUpFor", agentWallet, client, {
    address: market, abi: abis.market, functionName: "buyUpFor", args: [user, amount], gas: GAS.buyUpFor,
  });
}

export type Balances = { mon: bigint; usd: bigint; up: bigint; marketAllowance: bigint; agentRemaining?: bigint; agentExpiry?: bigint };

export async function readBalances(client: PublicClient, user: Address, agent?: Address): Promise<Balances> {
  const [mon, bal, up, allowance, grant] = await Promise.all([
    client.getBalance({ address: user }),
    client.readContract({ address: usd, abi: abis.testUsd, functionName: "balanceOf", args: [user] }),
    client.readContract({ address: contracts.spUp as Address, abi: abis.spUp, functionName: "balanceOf", args: [user] }),
    client.readContract({ address: usd, abi: abis.testUsd, functionName: "allowance", args: [user, market] }),
    agent
      ? client.readContract({ address: market, abi: abis.market, functionName: "agentAllowance", args: [user, agent] })
      : Promise.resolve(undefined),
  ]);
  const g = grant as readonly [bigint, bigint] | undefined;
  return {
    mon,
    usd: bal as bigint,
    up: up as bigint,
    marketAllowance: allowance as bigint,
    agentRemaining: g?.[0],
    agentExpiry: g?.[1],
  };
}

/** Upper bound of what a transaction can cost the payer on Monad: declared gas times the fee cap. */
export const feeOf = (r: TransactionReceipt, gasLimit: bigint) => gasLimit * r.effectiveGasPrice;
