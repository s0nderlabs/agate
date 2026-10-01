// Dynamic headless JS SDK setup plus the bridge from Dynamic's embedded wallet to ZeroDev.
import {
  type DynamicClient,
  createDynamicClient,
  getOwnerWalletAccountForSmartWalletAccount,
  getWalletAccounts,
  initializeClient,
  switchActiveNetwork,
} from "@dynamic-labs-sdk/client";
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from "@dynamic-labs-sdk/client/waas";
import type { EvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import { addZerodevExtension, createKernelClientForWalletAccount, sendUserOperation } from "@dynamic-labs-sdk/zerodev";
import { type Address, type PublicClient, createPublicClient, http } from "viem";
import { toAccount } from "viem/accounts";
import type { UserOperationReceipt } from "viem/account-abstraction";
import { chain } from "../../../shared/config";
import { type Call, type Ids, kernelClientFor, monadTestnet, ownerKernelAccount, sendCalls, zerodevRpcs } from "../../lib/aa";
import { metrics } from "./metrics";

declare const __IDS_AT_BUILD__: Ids;

export async function loadIds(): Promise<Ids> {
  let ids: Ids = {};
  try {
    const r = await fetch("/ids.json", { cache: "no-store" });
    if (r.ok) ids = await r.json();
  } catch {}
  if (!ids.dynamicEnvironmentId) ids = { ...__IDS_AT_BUILD__, ...ids };
  if (!ids.dynamicEnvironmentId && import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID)
    ids.dynamicEnvironmentId = import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID;
  return ids;
}

const monadNetworkData = {
  blockExplorerUrls: [chain.explorer],
  chain: "EVM" as const,
  displayName: chain.name,
  iconUrl: "",
  name: chain.name,
  nativeCurrency: { decimals: 18, name: "Monad", symbol: "MON" },
  networkId: String(chain.id),
  rpcUrls: { http: [chain.rpcUrl] },
  testnet: true,
};

export async function createClient(environmentId: string): Promise<DynamicClient> {
  const client = createDynamicClient({
    environmentId,
    autoInitialize: false,
    metadata: { name: "agate login spike (Dynamic)" },
    // Monad testnet is appended when the dashboard does not already list it.
    transformers: {
      networksData: (list) =>
        list.some((n) => n.chain === "EVM" && n.networkId === String(chain.id)) ? list : [...list, monadNetworkData],
    },
  });
  addWaasEvmExtension(client);
  addZerodevExtension(client);
  await initializeClient(client);
  return client;
}

export async function ensureEmbeddedWallet(client: DynamicClient) {
  const missing = getChainsMissingWaasWalletAccounts(client);
  if (missing.length) await createWaasWalletAccounts({ chains: missing }, client);
}

const isEvm = (a: { chain: string }): a is EvmWalletAccount => a.chain === "EVM";
const isZerodev = (a: { walletProviderKey: string }) => a.walletProviderKey.toLowerCase().startsWith("zerodev");

export type Wallets = { eoa: EvmWalletAccount; smart?: EvmWalletAccount };

export function findWallets(client: DynamicClient): Wallets | undefined {
  const evm = getWalletAccounts(client).filter(isEvm);
  const smart = evm.find(isZerodev);
  const owner = smart ? getOwnerWalletAccountForSmartWalletAccount({ smartWalletAccount: smart }, client) : undefined;
  const eoa = (owner && isEvm(owner) ? owner : undefined) ?? evm.find((a) => !isZerodev(a));
  return eoa ? { eoa, smart } : undefined;
}

// Dynamic's embedded wallet as a viem account for ZeroDev's ECDSA validator, counting every signature.
export async function ownerSigner(client: DynamicClient, eoa: EvmWalletAccount) {
  try {
    await switchActiveNetwork({ networkId: String(chain.id), walletAccount: eoa }, client);
  } catch (e) {
    metrics.note(`switchActiveNetwork to ${chain.id} failed: ${(e as Error).message}`);
  }
  const wc = await createWalletClientForWalletAccount({ walletAccount: eoa }, client);
  return toAccount({
    address: eoa.address as Address,
    async signMessage({ message }) {
      metrics.signature();
      return wc.signMessage({ account: wc.account, message });
    },
    async signTypedData(td) {
      metrics.signature();
      return wc.signTypedData({ account: wc.account, ...(td as any) });
    },
    async signTransaction() {
      throw new Error("the embedded wallet never signs raw transactions in this spike (all gas is sponsored)");
    },
  });
}

export const publicClient = createPublicClient({ chain: monadTestnet, transport: http(chain.rpcUrl) }) as PublicClient;

export type AaPath = "direct" | "dynamic-extension";

// One object that sends batched, sponsored user operations from the user's Kernel account, through either
// Dynamic's zerodev extension (needs ZeroDev enabled in the Dynamic dashboard and a smart wallet on the user)
// or the ZeroDev SDK directly with Dynamic's embedded wallet as the owner.
export async function makeSender(p: {
  client: DynamicClient;
  ids: Ids;
  wallets: Wallets;
  owner: Awaited<ReturnType<typeof ownerSigner>>;
  prefer: "auto" | AaPath;
}) {
  const rpcs = zerodevRpcs(p.ids);
  if ("error" in rpcs) throw new Error(rpcs.error);
  const directAccount = await ownerKernelAccount(publicClient, p.owner);
  const direct = kernelClientFor(directAccount, {
    publicClient,
    bundlerTransport: http(rpcs.bundler),
    paymasterTransport: http(rpcs.paymaster),
  });
  const wantExt = p.prefer === "dynamic-extension" || (p.prefer === "auto" && Boolean(p.wallets.smart));
  if (wantExt) {
    try {
      if (!p.wallets.smart) throw new Error("this user has no ZeroDev smart wallet from Dynamic");
      const kc = await createKernelClientForWalletAccount(
        { smartWalletAccount: p.wallets.smart, networkId: String(chain.id), bundlerRpc: rpcs.bundler, paymasterRpc: rpcs.paymaster },
        p.client,
      );
      const address = kc.account.address as Address;
      if (address.toLowerCase() !== directAccount.address.toLowerCase())
        metrics.note(`Dynamic smart account ${address} differs from the direct Kernel v3.1 account ${directAccount.address}`);
      return {
        path: "dynamic-extension" as AaPath,
        address,
        directAddress: directAccount.address,
        send: (calls: Call[]): Promise<UserOperationReceipt> => sendUserOperation({ kernelClient: kc, calls }),
      };
    } catch (e) {
      metrics.note(`Dynamic zerodev extension unavailable, using the ZeroDev SDK directly: ${(e as Error).message}`);
    }
  }
  return {
    path: "direct" as AaPath,
    address: directAccount.address,
    directAddress: directAccount.address,
    send: (calls: Call[]) => sendCalls(direct, calls),
  };
}
