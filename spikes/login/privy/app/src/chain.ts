import { createPublicClient, defineChain, http } from "viem";
import { chain } from "../../../shared/config";

export const monadTestnet = defineChain({
  id: chain.id,
  name: chain.name,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
  blockExplorers: { default: { name: "Monad Explorer", url: chain.explorer } },
  testnet: true,
});

export const publicClient = createPublicClient({ chain: monadTestnet, transport: http(chain.rpcUrl) });
