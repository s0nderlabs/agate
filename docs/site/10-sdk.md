---
slug: sdk
title: SDK
description: The TypeScript library Agate's own app runs on. Every read in plain numbers, every trade as a write or a call batch.
group: Reference
order: 10
source: 'client/src'
---

# The library Agate's own app runs on.

`@agate/client` (packaged for npm as `agate-sdk`, not yet published) is Agate's data and trading layer: every screen
of the app reads through it, and Agate's server builds every AI trade with it. One dependency,
[viem](https://viem.sh). It works in Node 18+, browsers (any bundler) and Bun, and returns plain numbers: dollars per
GPU-hour and GPU-hours, never raw units.

```sh
bun install                    # at the repo root: the workspace package @agate/client
# once on npm: npm install agate-sdk viem, and import from "agate-sdk" instead
```

## Create a client

```ts
import { createAgateClient } from "@agate/client";

const agate = createAgateClient({
  graphqlUrl: "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql", // history, trades, candles; null = chain only
});
```

| Option | Default | Meaning |
|---|---|---|
| `rpcUrl` | the public Monad testnet RPC | one URL, or a comma list tried in order (a URL that fails or is rate limited passes the call on) |
| `graphqlUrl` | `NEXT_PUBLIC_AGATE_GRAPHQL_URL` | Agate's indexer; `null` reads the chain only |
| `snapshotUrl` | none | Agate's server markets snapshot, one request for every market and book |
| `deployments`, `factory` | Monad testnet, `"real"` | which contracts (the `"demo"` factory runs a fast-clock month) |
| `publicClient` | made from `rpcUrl` | an existing viem client |

## Read

| Call | Returns |
|---|---|
| `getMarkets()` | every GPU: today's price, the day before's, each source, the daily history, the open months |
| `getMarket(gpu)` | one GPU, the same shape |
| `book(gpu, month)` | the month's Kuru order book: bids and asks in dollars per GPU-hour and GPU-hours |
| `recentFills(gpu, month, n)` | recent trades, newest first, with transaction hashes |
| `candles(gpu, month)` | hourly candles from the month's first trade |
| `ticker()` | each GPU's change and each month's change over 24 hours |
| `getWallet(address)` | test dollars, every position (Long, Short, pay me daily), what is claimable, what rests at Kuru |
| `openOrders(address)` | the account's resting limit orders |

All shapes are in `types.ts` (`Market`, `Series`, `IndexDay`, `Book`, `Fill`, `Candle`, `Position`, `Wallet`, ...).

## Trade, two ways

Every action exists as a **write**, which sends it with a viem `WalletClient`, and as a **plan**, which returns the
exact call batch for a smart account or a server to send as one user operation. Both run the same checks first (the
band, a thin book, a price that moved, the balance, slippage) and put the bound onchain inside the router call.

| Action | Write | Plan |
|---|---|---|
| test dollars | `drip` | `planDrip` |
| Long | `buyLong` | `planBuyLong` |
| close a Long | `sellLong` | `planSellLong` |
| Long, paid daily | `openLongDaily` | `planOpenLongDaily` |
| close a daily Long | `closeLongDaily` | `planCloseLongDaily` |
| Short (with or without pay me daily) | `openShort` | `planOpenShort` |
| close a Short | `closeShort` | `planCloseShort` |
| roll a Long into the next month | | `planRollLong` |
| claim daily payouts | `claim`, `claimDaily` | `planClaim`, `planClaimAll` |
| settle after the month | `settle` | `planSettle` |
| limit order | `placeLimit` | `planPlaceLimit` |
| cancel limit orders | `cancelLimit` | `planCancelLimit` |
| take funds back from Kuru | `withdrawMargin` | `planWithdrawMargin` |
| mint or redeem pairs | `mintPairs`, `redeem` | `planRedeem` |

```ts
import { buyLong, planBuyLong, readResult } from "@agate/client";

await buyLong(agate, walletClient, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });

const plan = await planBuyLong(agate, account, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });
// send plan.calls as one user operation, then read what it did from the receipt's logs:
const done = readResult(agate, plan.summary.action, receipt.logs);
```

Amounts are decimal strings (`"100"`, `"4.10"`) and never floats; prices are on the $0.01 grid, sizes in whole lots of
0.0001 GPU-hour.

## Errors

A refusal before anything is sent is a `WriteError` with a stage (`check`) and a reason (`InsufficientBalance`,
`ThinBook`, `PriceMoved`, `MonthNotFinal`, ...) and a sentence a person can read. Errors are matched by name, not by
`instanceof`, so a second copy of viem in an app does not break them.

## Packaging

`bun run pack:npm` in `client/` builds the npm package into `client/dist/pkg` (ES modules and type declarations) and
lists what it would ship. Publishing is a person's step.
