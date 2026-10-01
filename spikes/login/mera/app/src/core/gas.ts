// Explicit gas limits. Monad bills the DECLARED gas limit, not the gas used, so every limit is set by hand.
// Measured Oct 1 2026 with eth_estimateGas against Monad testnet itself (test/estimate-monad.ts), because Monad
// prices cold state access higher than Ethereum and an anvil estimate alone comes out 15 to 45% too low:
//   faucet 80,924 (anvil 68,237) | approve 52,930 (46,353) | approveAgent 53,403 (46,731)
//   buyUpWithPermit 216,760 (160,591) | buyUpFor 171,401 (118,247)
// Limits below are those Monad numbers plus about 20% headroom.
export const GAS = {
  dripTransfer: 21_000n,
  faucet: 100_000n,
  approve: 65_000n,
  buyUpWithPermit: 260_000n,
  approveAgent: 65_000n,
  buyUpFor: 210_000n,
} as const;
