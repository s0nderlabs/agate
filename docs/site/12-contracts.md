---
slug: contracts
title: Contracts and addresses
description: Every agate contract on Monad testnet, what it does, and where its source is.
group: Reference
order: 12
source: 'contracts/src, contracts/deployments/10143.json'
---

# Every contract, on Monad testnet (chain 10143).

Solidity 0.8.30 with Foundry, in `contracts/`. Addresses are in `contracts/deployments/10143.json` (the market),
`10143-indexes.json` (the index) and `10143-feeds.json` (the example feeds). Explorer:
[testnet.monadexplorer.com](https://testnet.monadexplorer.com).

## The price

| Contract | Address | What it does |
|---|---|---|
| `AgateIndex` | [`0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36`](https://testnet.monadexplorer.com/address/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36) | stores each writer's hourly readings, computes each day's price, final after 6 h or a countersign; the guardian's veto; the 48 h queue for changes |
| `AgatePriceFeed` (example) | H100 [`0xC686...3D98`](https://testnet.monadexplorer.com/address/0xC68687dd7d7b40281FB07E9006538aa45fAF3D98), others in [Onchain](09-onchain.md) | a Chainlink-style feed per GPU over the index |

`AgateIndex` keeps its storage and cheap views; its logic runs in four linked libraries (`IndexReports`, `IndexDays`,
`IndexViews`, `IndexAdmin`). The CRE writer reports through Chainlink's forwarder (in simulation, the CRE simulation
forwarder).

## The market

| Contract | Address | What it does |
|---|---|---|
| `AgateFactory` | [`0xEdBE3e696944443bBCe7eb3CD04E626e9396a0b5`](https://testnet.monadexplorer.com/address/0xEdBE3e696944443bBCe7eb3CD04E626e9396a0b5) | lists a series per GPU and month and records its Kuru market |
| `AgateRouter` | [`0x4F4C14E7421dA83C398e04e4b5CeA2543f903c9c`](https://testnet.monadexplorer.com/address/0x4F4C14E7421dA83C398e04e4b5CeA2543f903c9c) | one-call flows: Long, Short, pay me daily, close, roll, with the bound inside the call |
| `AgateDollar` (tUSD) | [`0x3A0513b2A19EE92eb3f73Dd06EefEe4D477CbF38`](https://testnet.monadexplorer.com/address/0x3A0513b2A19EE92eb3f73Dd06EefEe4D477CbF38) | the test dollar, 6 decimals, 10,000 a day from its faucet |

Each month is an `AgateSeries` (mint, redeem, pay me daily positions, daily sync, claim, settle) with its
`AgateToken`:

| Month | Series | Token | Kuru market | Range |
|---|---|---|---|---|
| H100 Nov 2026 | [`0xbc28...c577`](https://testnet.monadexplorer.com/address/0xbc28e45ede13d0bd61d78f6f3d9f6341b78fc577) | `0x0fbf...ce28` | [`0xf245...3a9c`](https://testnet.monadexplorer.com/address/0xf2455ab8bbb5f8fa82d2a626a56bd5df7ef43a9c) | $1.95 to $8.00 |
| H200 Nov 2026 | [`0x7b97...c9d4`](https://testnet.monadexplorer.com/address/0x7b97b60f8993de841ebf95cc0ed4d20e0abbc9d4) | `0x082a...1277` | [`0x3704...b70b`](https://testnet.monadexplorer.com/address/0x37049b0dbc6a623beb50d545799d138ac91bb70b) | $2.40 to $9.70 |
| B200 Nov 2026 | [`0x5bf2...7a52`](https://testnet.monadexplorer.com/address/0x5bf2839ce16c6f0d106df46e637fe09187f97a52) | `0xfe7c...2c7c` | [`0x30df...fcd1`](https://testnet.monadexplorer.com/address/0x30df9a641d1936cefe6e93f9dbd4cb6a0659fcd1) | $3.50 to $14.15 |

The live list, including months opened later: `GET https://agate.elpabl0.xyz/api/v1/markets`.

## Kuru (the order book)

agate trades on Kuru V1 on Monad testnet: Router `0x7EFbE105Ca7415dE98F96622173458ac1c054630`, MarginAccount
`0xd029C2D98ff85D8F64799017fE00a59B1159CE02`. Books use a price precision of 10^6 with a $0.01 tick, and sizes in
lots of 0.0001 GPU-hour (10^4 per token) with a 1 GPU-hour minimum order (`contracts/src/market/MarketTypes.sol`).
agate calls Kuru through interfaces that declare only the functions it uses.

## Build and test

```sh
cd contracts
forge install --no-git foundry-rs/forge-std@v1.17.0
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0
forge test                     # fork tests skip without MONAD_FORK_URL
```

Monad allows 128 KB of runtime code; local chains and tests match it (`code_size_limit = 131072`).
