// Chain, contract and amount settings for the Mera spike. Everything comes from the shared config so the
// three spikes send the same calls to the same contracts.
import { type Abi, type Address, defineChain } from "viem";
import { abis as sharedAbis, chain as sharedChain, contracts, flow } from "../../../../shared/config";

export { contracts, flow };

export const abis = {
  testUsd: sharedAbis.testUsd as Abi,
  market: sharedAbis.market as Abi,
  spUp: sharedAbis.spUp as Abi,
};

export const explorer = sharedChain.explorer;
export const defaultRpcUrl = sharedChain.rpcUrl;

export function monadTestnet(rpcUrl: string = sharedChain.rpcUrl) {
  return defineChain({
    id: sharedChain.id,
    name: sharedChain.name,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Monad Explorer", url: sharedChain.explorer } },
    testnet: true,
  });
}

export const txUrl = (hash: string) => `${sharedChain.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${sharedChain.explorer}/address/${address}`;

// EIP-712 domain of TestUSD (OpenZeppelin ERC20Permit("agate test dollar"), version "1").
// test/fork.test.ts checks this against the deployed contract's eip712Domain().
export const testUsdPermitDomain = {
  name: "agate test dollar",
  version: "1",
  chainId: sharedChain.id,
  verifyingContract: contracts.testUsd as Address,
} as const;

export const chainId = sharedChain.id;
