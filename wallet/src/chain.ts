// Monad testnet and the account-abstraction constants every agate smart account uses. Kernel v3.1 on EntryPoint 0.7,
// ERC-4337 (not EIP-7702): the accounts proven on 10143 on Oct 1 and Oct 4 2026. Dynamic's ZeroDev provider defaults
// to Kernel v3.3 in 7702 mode; pin 4337 + v3.1 there too, or every user's account address changes.
import { constants } from "@zerodev/sdk";
import { type Address, defineChain } from "viem";
import { PUBLIC_RPC, TESTNET_DEPLOYMENTS } from "@agate/client";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } },
  testnet: true,
});

export const ENTRY_POINT = constants.getEntryPoint("0.7");
export const KERNEL_VERSION = constants.KERNEL_V3_1;
/** the user's main smart account */
export const MAIN_INDEX = 0n;
/** the first AI pocket; a second connected AI gets POCKET_INDEX + 1, and so on */
export const POCKET_INDEX = 1n;

const real = TESTNET_DEPLOYMENTS.factories.real!;
export const AGATE = {
  dollar: TESTNET_DEPLOYMENTS.dollar as Address,
  router: real.router as Address,
  factory: real.factory as Address,
};
