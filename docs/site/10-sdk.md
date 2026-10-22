---
slug: sdk
title: SDK
description: The TypeScript library Agate's own app runs on. Every read in plain numbers, every trade as a write or a call batch.
group: Reference
order: 10
source: 'client/src'
---

# The library Agate's own app runs on.

`@s0nderlabs/agate` is Agate's data and trading layer: every screen
of the app reads through it, and Agate's server builds every AI trade with it. One dependency,
[viem](https://viem.sh). It works in Node 18+, browsers (any bundler) and Bun, and returns plain numbers: dollars per
GPU-hour and GPU-hours, never raw units.

## Install

```sh
npm install @s0nderlabs/agate viem   # or: bun add @s0nderlabs/agate viem
```

Then `import { createAgateClient } from "@s0nderlabs/agate"`. The package is published from `client/` in this
repository (`bun run pack:npm` builds it); inside the repository's own packages the same code is the workspace
package `@agate/client`.

## Create a client

```ts
import { createAgateClient } from "@s0nderlabs/agate";

const agate = createAgateClient({
  graphqlUrl: "https://agate-1.tailf06dd7.ts.net:8443/v1/graphql", // history, trades, candles; null = chain only
});
```

A first script, `read.mjs` (`node read.mjs` or `bun read.mjs`):

```js
import { createAgateClient } from "@s0nderlabs/agate";

const agate = createAgateClient({ graphqlUrl: null }); // chain only: no indexer needed for this read
const h100 = await agate.getMarket("H100");
console.log(`${h100.gpu} $${h100.price} per GPU-hour, final day ${h100.priceDate}`);
for (const s of h100.sources) console.log(`  ${s.family.padEnd(10)} $${s.price.toFixed(2)}`);
```

```text
H100 $3.99 per GPU-hour, final day 2026-10-09
  Verda      $3.92
  Nebius     $4.50
  Lambda     $3.99
  CoreWeave  $6.16
  Civo       $2.99
```

(Read on Oct 10 2026 over the public RPC, in a few seconds.)

| Option | Default | Meaning |
|---|---|---|
| `rpcUrl` | the public Monad testnet RPC | one URL, or a comma list tried in order (a URL that fails or is rate limited passes the call on) |
| `graphqlUrl` | `NEXT_PUBLIC_AGATE_GRAPHQL_URL` if set; else `http://localhost:8080/v1/graphql` outside a browser or on a page served from localhost; else `null` | Agate's indexer, one URL or a comma list (a URL that fails rests 60 s while the next answers); `null` reads the chain only (no candles, fills or listing times). The public one: `https://agate-1.tailf06dd7.ts.net:8443/v1/graphql` |
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
| `checkDay({ gpu, date })` | one day's index price recomputed from the chain alone, beside the stored one, with each source's inputs (below) |

All shapes are in `types.ts` (`Market`, `Series`, `IndexDay`, `Book`, `Fill`, `Candle`, `Position`, `Wallet`, ...).

### Check any day

```ts
const day = await agate.checkDay({ gpu: "H100", date: "2026-10-09" });
console.log(day.stored, day.recomputed, day.match); // 3.99 3.99 true
```

`checkDay` reads the day's stored readings and replays the index's rules on them, from the GPU's first day, then
compares the result with the stored record, digest included (`DayCheck` in `types.ts`; the method:
[Check any day yourself](04-the-price.md#check-any-day-yourself)). In `client/`, `bun run check-day H100 2026-10-09`
prints the same as a short report. It is not in the npm release yet: `@s0nderlabs/agate` gets it in its next version.

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
| close a daily Long | `closeLongDaily` | `planCloseLongDaily` (`upFront: "paid"` puts back only what it was paid) |
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
import { buyLong, planBuyLong, readResult } from "@s0nderlabs/agate";

await buyLong(agate, walletClient, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });

const plan = await planBuyLong(agate, account, { gpu: "H100", month: "2026-11", dollars: "100", maxPrice: "4.10" });
// send plan.calls as one user operation, then read what it did from the receipt's logs:
const done = readResult(agate, plan.summary.action, receipt.logs);
```

Amounts are decimal strings (`"100"`, `"4.10"`) and never floats; prices are on the $0.01 grid, sizes in whole lots of
0.0001 GPU-hour.

## Errors

Every failure is a `WriteError` with a `stage`, a `reason`, a sentence a person can read (`message`), and, once
sent, the transaction `hash`. Errors are matched by name, not by `instanceof`, so a second copy of viem in an app
does not break them.

A write can be several transactions (an approval, then the trade; a claim across months): the `stage` names the
step that failed, and `WriteError.txs` lists the ones already sent. Every stage and reason, what each means and what
to do: [Errors](17-errors.md#sdk-errors). A bad amount (a float, too many decimals, off the lot grid) throws
`AmountError` before any read.
