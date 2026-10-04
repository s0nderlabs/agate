// Kernel smart accounts owned by an ECDSA signer (a Dynamic embedded wallet in the app, a delegated or agent wallet on
// the server, a local key in tests), and a ZeroDev client that sponsors their user operations.
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, getUserOperationGasPrice } from "@zerodev/sdk";
import { type Address, type Hex, http, type LocalAccount, type PublicClient, type Transport, zeroAddress } from "viem";
import { toAccount } from "viem/accounts";
import type { UserOperationReceipt } from "viem/account-abstraction";
import { ENTRY_POINT, KERNEL_VERSION, MAIN_INDEX, monadTestnet } from "./chain.ts";

export type Call = { to: Address; value: bigint; data: Hex };

/** A signer that can only say its address: enough to compute an account address without anyone signing. */
export function addressOnly(address: Address): LocalAccount {
  const no = async (): Promise<never> => {
    throw new Error(`${address} is an address-only signer`);
  };
  return toAccount({ address, signMessage: no, signTypedData: no, signTransaction: no });
}

export async function sudoValidator(pc: PublicClient, signer: LocalAccount) {
  return signerToEcdsaValidator(pc, { signer, entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION });
}

/** The Kernel account `signer` owns at `index` (0: the user's main account; 1, 2, ...: AI pockets). */
export async function kernelAccount(pc: PublicClient, signer: LocalAccount, index: bigint = MAIN_INDEX) {
  const sudo = await sudoValidator(pc, signer);
  return createKernelAccount(pc, { entryPoint: ENTRY_POINT, kernelVersion: KERNEL_VERSION, index, plugins: { sudo } });
}

export async function kernelAddress(pc: PublicClient, owner: Address, index: bigint = MAIN_INDEX): Promise<Address> {
  return (await kernelAccount(pc, addressOnly(owner), index)).address;
}

export type KernelAccount = Awaited<ReturnType<typeof createKernelAccount>>;

export type Sponsor = {
  /** ZeroDev v3 RPC (bundler and paymaster share it); omit the paymaster on a fork */
  bundler: Transport;
  paymaster?: Transport;
};

export function zerodev(rpcUrl: string): Sponsor {
  return { bundler: http(rpcUrl), paymaster: http(rpcUrl) };
}

/** A client that sends the account's user operations through the bundler, gas paid by the paymaster when given. */
export function accountClient(account: KernelAccount, pc: PublicClient, s: Sponsor) {
  return createKernelAccountClient({
    account,
    chain: monadTestnet,
    bundlerTransport: s.bundler,
    client: pc,
    userOperation: { estimateFeesPerGas: async ({ bundlerClient }) => getUserOperationGasPrice(bundlerClient) },
    ...(s.paymaster
      ? {
          paymaster: {
            getPaymasterData: (userOperation) => createZeroDevPaymasterClient({ chain: monadTestnet, transport: s.paymaster! }).sponsorUserOperation({ userOperation }),
          },
        }
      : {}),
  });
}

export type AccountClient = ReturnType<typeof accountClient>;

export async function sendCalls(client: AccountClient, calls: Call[], timeoutMs = 120_000): Promise<UserOperationReceipt> {
  const hash = await client.sendUserOperation({ calls });
  return client.waitForUserOperationReceipt({ hash, timeout: timeoutMs });
}

export function describeReceipt(r: UserOperationReceipt) {
  return {
    userOpHash: r.userOpHash,
    txHash: r.receipt.transactionHash,
    success: r.success,
    block: Number(r.receipt.blockNumber),
    sender: r.sender,
    sponsored: Boolean(r.paymaster && r.paymaster !== zeroAddress),
    reason: r.reason ?? null,
  };
}
