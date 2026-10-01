// The agent's Privy policy. Deny by default: the only thing the server signer may do with the user's
// wallet is call SpikeMarket.buyUp(amount <= 200 testUSD) on Monad testnet, until the expiry.
// TestUSD is deliberately NOT allowed: if the signer could call approve, it could raise its own budget.
// The cumulative 200 cap is the user's own onchain approve(market, 200) from step 4.
import type { AbiSchema } from "@privy-io/node/resources";
import { buyUpAbiFragment } from "../app/src/calls";
import { chain, contracts, flow } from "../../shared/config";

export function agentPolicy(expiryUnixSeconds: number) {
  return {
    version: "1.0" as const,
    chain_type: "ethereum" as const,
    name: "agate spike agent: buyUp only, 200 cap, 1 day",
    rules: [
      {
        name: "SpikeMarket.buyUp up to 200 before expiry",
        method: "eth_sendTransaction" as const,
        action: "ALLOW" as const,
        conditions: [
          { field_source: "ethereum_transaction" as const, field: "to" as const, operator: "eq" as const, value: contracts.market.toLowerCase() },
          { field_source: "ethereum_transaction" as const, field: "chain_id" as const, operator: "eq" as const, value: String(chain.id) },
          {
            field_source: "ethereum_calldata" as const,
            field: "buyUp.amount",
            abi: buyUpAbiFragment as unknown as AbiSchema,
            operator: "lte" as const,
            value: flow.agentCap.toString(),
          },
          { field_source: "system" as const, field: "current_unix_timestamp" as const, operator: "lte" as const, value: String(expiryUnixSeconds) },
        ],
      },
    ],
  };
}
