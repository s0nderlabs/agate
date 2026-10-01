// ZeroDev Kernel helpers shared by the app, agent/run.ts and the fork test, so the fork test runs the exact calls.
// Kernel v3.1 on EntryPoint 0.7 with the plain ECDSA validator at index 0: this is what Dynamic's zerodev
// extension picks by default (EntryPoint 0.7 maps to KERNEL_V3_1), and every contract it needs exists on Monad
// testnet 10143 (checked with eth_getCode on Oct 1 2026). CallPolicy v0.0.5 is NOT deployed there, so v0.0.4.
import {
  constants,
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getUserOperationGasPrice,
} from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  deserializePermissionAccount,
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import {
  CallPolicyVersion,
  ParamCondition,
  toCallPolicy,
  toTimestampPolicy,
} from "@zerodev/permissions/policies";
import { toECDSASigner, toEmptyECDSASigner } from "@zerodev/permissions/signers";
import {
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  defineChain,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
} from "viem";
import type { UserOperationReceipt } from "viem/account-abstraction";
import { chain, contracts, flow } from "../../shared/config";

export const monadTestnet = defineChain({
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
  blockExplorers: { default: { name: "Monad Explorer", url: chain.explorer } },
  testnet: true,
});

export const ENTRY_POINT = constants.getEntryPoint("0.7");
export const KERNEL_VERSION = constants.KERNEL_V3_1;

// Typed fragments of the shared contracts (same signatures as shared/*.abi.json).
export const testUsdAbi = parseAbi([
  "function faucet(address to)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
export const marketAbi = parseAbi(["function buyUp(uint256 amount)"]);
// One ABI for the call policy so both permissions share a type (the policy matches by target + selector).
const policyAbi = [...testUsdAbi, ...marketAbi] as const;

export type Call = { to: Address; value: bigint; data: Hex };

export const faucetCalls = (to: Address): Call[] => [
  { to: contracts.testUsd, value: 0n, data: encodeFunctionData({ abi: testUsdAbi, functionName: "faucet", args: [to] }) },
];

// approve + buyUp batched into ONE user operation (one signature, executed atomically by Kernel executeBatch).
export const buyCalls = (amount: bigint): Call[] => [
  {
    to: contracts.testUsd,
    value: 0n,
    data: encodeFunctionData({ abi: testUsdAbi, functionName: "approve", args: [contracts.market, amount] }),
  },
  { to: contracts.market, value: 0n, data: encodeFunctionData({ abi: marketAbi, functionName: "buyUp", args: [amount] }) },
];

// A viem-compatible signer: a LocalAccount (agent, fork test) or the Dynamic embedded wallet wrapped by toAccount.
export type OwnerSigner = LocalAccount;

export async function ownerKernelAccount(publicClient: PublicClient, owner: OwnerSigner) {
  const sudo = await signerToEcdsaValidator(publicClient, {
    signer: owner,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  return createKernelAccount(publicClient, { entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, plugins: { sudo } });
}

type KernelAccount = Awaited<ReturnType<typeof ownerKernelAccount>>;

export type AaTransports = {
  publicClient: PublicClient;
  bundlerTransport: Transport;
  // Omit to pay gas from the smart account's own MON (used on the anvil fork, where ZeroDev's paymaster cannot sign).
  paymasterTransport?: Transport;
};

export function kernelClientFor(account: KernelAccount, t: AaTransports) {
  return createKernelAccountClient({
    account,
    chain: monadTestnet,
    bundlerTransport: t.bundlerTransport,
    client: t.publicClient,
    // Same fee source Dynamic's extension uses (zd_getUserOperationGasPrice on the ZeroDev bundler).
    userOperation: { estimateFeesPerGas: async ({ bundlerClient }) => getUserOperationGasPrice(bundlerClient) },
    ...(t.paymasterTransport
      ? {
          paymaster: {
            getPaymasterData: (userOperation) =>
              createZeroDevPaymasterClient({ chain: monadTestnet, transport: t.paymasterTransport! }).sponsorUserOperation({
                userOperation,
              }),
          },
        }
      : {}),
  });
}

export async function sendCalls(client: ReturnType<typeof kernelClientFor>, calls: Call[]): Promise<UserOperationReceipt> {
  const hash = await client.sendUserOperation({ calls });
  return client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
}

// Who paid gas for a user operation: the paymaster when one is set, otherwise the smart account itself.
// The bundler EOA (receipt.receipt.from) fronts the gas and is repaid from that deposit.
export function gasPayer(r: UserOperationReceipt) {
  const viaPaymaster = r.paymaster && r.paymaster !== zeroAddress;
  return {
    payer: viaPaymaster ? `paymaster ${r.paymaster}` : `user smart account ${r.sender}`,
    bundler: r.receipt.from as Address,
    sponsored: Boolean(viaPaymaster),
  };
}

// ---- agent grant (ZeroDev permissions on the user's Kernel account) ----

// Two grant modes, both verified on the fork:
// - "per-call" (the brief's literal policy): the session key may call TestUSD.approve(market, <=200) and
//   SpikeMarket.buyUp(<=200). ZeroDev's call policy checks EACH call, so a batch of 2 x 150 passes (300 total).
// - "budget" (default): the session key may only call SpikeMarket.buyUp(<=200). The grant also sets
//   TestUSD.approve(market, 200) from the user's account, so the ERC-20 allowance is a true 200 total cap.
//   Caveat: a later user trade that re-approves the market overwrites the agent's remaining budget.
export type GrantMode = "budget" | "per-call";

export function sessionPolicies(nowSeconds: number, mode: GrantMode = "budget") {
  const buyUp = {
    target: contracts.market,
    abi: policyAbi,
    functionName: "buyUp",
    args: [{ condition: ParamCondition.LESS_THAN_OR_EQUAL, value: flow.agentCap }],
  } as const;
  const approve = {
    target: contracts.testUsd,
    abi: policyAbi,
    functionName: "approve",
    args: [
      { condition: ParamCondition.EQUAL, value: contracts.market },
      { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: flow.agentCap },
    ],
  } as const;
  return [
    mode === "budget"
      ? toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [buyUp] })
      : toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [approve, buyUp] }),
    toTimestampPolicy({ validUntil: nowSeconds + flow.agentTtlSeconds }),
  ];
}

// What the agent sends for one buy under each mode.
export const agentBuyCalls = (mode: GrantMode, amount: bigint): Call[] =>
  mode === "budget" ? buyCalls(amount).slice(1) : buyCalls(amount);

// Budget mode only: the user's one-time on-chain setup that makes the 200 cap real.
export const grantSetupCalls = (mode: GrantMode): Call[] => (mode === "budget" ? buyCalls(flow.agentCap).slice(0, 1) : []);

export type AgentGrant = {
  mode: GrantMode;
  approval: string; // serialized permission account: contains the owner's enable signature, never a private key
  userAccount: Address;
  agent: Address;
  capPerCall: string;
  validUntil: number;
  kernelVersion: string;
  entryPoint: Address;
  chainId: number;
};

// The user signs once (enable typed data). Nothing is sent on chain here: the permission is installed by the
// agent's first user operation (Kernel "enable mode").
export async function createAgentGrant(p: {
  publicClient: PublicClient;
  owner: OwnerSigner;
  agent: Address;
  nowSeconds: number;
  mode?: GrantMode;
}): Promise<AgentGrant> {
  const mode = p.mode ?? "budget";
  const sudo = await signerToEcdsaValidator(p.publicClient, {
    signer: p.owner,
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
  });
  const regular = await toPermissionValidator(p.publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    signer: toEmptyECDSASigner(p.agent),
    policies: sessionPolicies(p.nowSeconds, mode),
  });
  const account = await createKernelAccount(p.publicClient, {
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_VERSION,
    plugins: { sudo, regular },
  });
  const approval = await serializePermissionAccount(account);
  return {
    mode,
    approval,
    userAccount: account.address,
    agent: p.agent,
    capPerCall: flow.agentCap.toString(),
    validUntil: p.nowSeconds + flow.agentTtlSeconds,
    kernelVersion: KERNEL_VERSION,
    entryPoint: ENTRY_POINT.address,
    chainId: chain.id,
  };
}

export async function agentAccount(publicClient: PublicClient, sessionKey: LocalAccount, approval: string) {
  const signer = await toECDSASigner({ signer: sessionKey });
  return deserializePermissionAccount(publicClient, ENTRY_POINT, KERNEL_VERSION, approval, signer);
}

export async function agentSend(p: AaTransports & { sessionKey: LocalAccount; approval: string; calls: Call[] }) {
  const account = await agentAccount(p.publicClient, p.sessionKey, p.approval);
  const client = createKernelAccountClient({
    account,
    chain: monadTestnet,
    bundlerTransport: p.bundlerTransport,
    client: p.publicClient,
    userOperation: { estimateFeesPerGas: async ({ bundlerClient }) => getUserOperationGasPrice(bundlerClient) },
    ...(p.paymasterTransport
      ? {
          paymaster: {
            getPaymasterData: (userOperation) =>
              createZeroDevPaymasterClient({ chain: monadTestnet, transport: p.paymasterTransport! }).sponsorUserOperation({
                userOperation,
              }),
          },
        }
      : {}),
  });
  const hash = await client.sendUserOperation({ calls: p.calls });
  return client.waitForUserOperationReceipt({ hash, timeout: 120_000 });
}

// ZeroDev RPC from ids.json. Explicit URLs win; a bare project id falls back to ZeroDev's v3 URL shape
// (one URL for bundler and paymaster). Returns a clear error instead of throwing deep inside viem.
export type Ids = {
  dynamicEnvironmentId?: string;
  zerodevProjectId?: string;
  zerodevBundlerRpc?: string;
  zerodevPaymasterRpc?: string;
  [k: string]: unknown;
};

export function zerodevRpcs(ids: Ids): { bundler: string; paymaster: string } | { error: string } {
  const fromId = ids.zerodevProjectId ? `https://rpc.zerodev.app/api/v3/${ids.zerodevProjectId}/chain/${chain.id}` : undefined;
  const bundler = ids.zerodevBundlerRpc || fromId;
  const paymaster = ids.zerodevPaymasterRpc || fromId;
  if (!bundler || !paymaster)
    return { error: "ZeroDev RPC missing: set zerodevBundlerRpc and zerodevPaymasterRpc (or zerodevProjectId) in shared/ids.json" };
  return { bundler, paymaster };
}
