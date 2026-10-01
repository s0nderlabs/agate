// Shared by the three login spikes (Mera, Privy, Dynamic). Monad testnet only.
import testUsdAbi from "./TestUSD.abi.json";
import spikeMarketAbi from "./SpikeMarket.abi.json";
import spikeUpAbi from "./SpikeUp.abi.json";

export const chain = {
  id: 10143,
  name: "Monad Testnet",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadexplorer.com",
} as const;

export const contracts = {
  testUsd: "0xc9C22eE1a54DA8D38ffb1803919d32a31967df7a",
  market: "0xECA702514F4d02dE0f581490121b91c8BFBfaB01",
  spUp: "0x3C762CbBe96C922c1573FefDCb639D6D0BE807Cc",
} as const;

export const abis = { testUsd: testUsdAbi, market: spikeMarketAbi, spUp: spikeUpAbi };

// The same four steps in every spike, so the numbers compare.
export const flow = {
  faucetAmount: 10_000_000_000n, // 10,000 testUSD (6 decimals)
  buyAmount: 100_000_000n, // 100 testUSD
  agentCap: 200_000_000n, // the agent may spend up to 200 testUSD
  agentBuyAmount: 50_000_000n, // the agent buys 50 testUSD worth
  agentTtlSeconds: 86_400, // one day
} as const;

// Dashboard ids are written to ids.json beside this file once the operator's dashboards are set up.
// They are client-side identifiers, not secrets. Secrets (app secret, authorization keys) live only in
// each spike's gitignored .env.local, entered by the operator.
