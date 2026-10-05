# @agate/client

agate's live data layer for the app: typed reads that return the app's own shapes (the mock layer's `Market`,
`Series`, `IndexDay`, `SourceReading`, `Quote`, `Position`, `Wallet`, `BookLevel`, `Fill`, `TickerItem`, `Candle`,
`OpenOrder`) in plain dollars and GPU-hours, and every user write as a plain async function taking a viem
`WalletClient`. TypeScript, viem as its only dependency, browser-safe (no `node:*`, no React, no Next.js).

```ts
import { createAgateClient, buyLong } from "@agate/client";

const agate = createAgateClient({ graphqlUrl: process.env.NEXT_PUBLIC_AGATE_GRAPHQL_URL });
const markets = await agate.getMarkets();               // six GPUs, the app's Market shape
const quote = (await agate.getMarket("H100")).series[0]!.quote!; // what the screen shows
const res = await buyLong(agate, walletClient, { gpu: "H100", month: "2026-11", dollars: "250", maxPrice: String(quote.ask) });
```

## Wiring it into the app

- `app/package.json`: `"@agate/client": "workspace:*"` (the repo root is a bun workspace), then `bun install` at the
  repo root.
- The package ships TypeScript source (`exports` point at `src/`): add it to `transpilePackages` in `next.config`
  (`transpilePackages: ["@agate/client"]`).
- `app/tsconfig.json` type-checks that source too (`next build` runs the check), so it needs two options the app does
  not set today: `"target": "ES2020"` (or later: the source uses bigint literals such as `10n`) and
  `"allowImportingTsExtensions": true` (its imports name `./abi.ts`; allowed because the app has `"noEmit": true`).
  Without them the check fails with TS2737 and TS5097 (checked with the app's TypeScript 5.9.3 and its options).
- Errors are matched by name, not by `instanceof`, so a public or wallet client from the app's own copy of viem (two
  copies once the app adds its own viem or wagmi) reads reverts as reverts.
- Swap the mock layer: each mock function has a live call (table below). The shapes are the mock's, field for field;
  extra fields are marked "added" in `src/types.ts` and are optional to read.
- Use the client in client components or route handlers; it holds no secret.

## Configuration

`createAgateClient(config)`, every field optional:

| Field | Default | Meaning |
|---|---|---|
| `deployments` | `TESTNET_DEPLOYMENTS` (a copy of `contracts/deployments/10143.json`) | the deployments file's JSON; pass another one for a fork or a new deploy |
| `factory` | `"real"` | which factory entry (`"real"`, or `"demo"` during a demo session) |
| `rpcUrl` | `https://testnet-rpc.monad.xyz` | a key-free RPC; never put a URL that carries a key into a browser bundle or a `NEXT_PUBLIC_` variable |
| `chainId` | the deployments' `chainId` | must equal it |
| `graphqlUrl` | `NEXT_PUBLIC_AGATE_GRAPHQL_URL`, else `http://localhost:8080/v1/graphql` where that is this machine's own indexer (outside a browser, or on a page served from localhost); a page hosted elsewhere with no URL set reads the chain only | the Envio indexer's GraphQL; `null` reads the chain only |
| `publicClient` | a viem public client over `rpcUrl` | bring your own |
| `panels` | `PANELS` (from `wall/packages/sources/panels/launch.json`) | slot order, cloud names and the reserve per GPU |

**The env var.** `NEXT_PUBLIC_AGATE_GRAPHQL_URL` is a public, build-time variable: Next.js inlines it when the app is
built, so a hosted build must set it to the hosted indexer's URL before `next build`. The client reads it itself
(behind a `typeof process` guard), but the reliable way is to pass it from app code as above, where Next.js always
inlines it. A hosted page built without it does not ask each visitor's own `localhost:8080`: it reads the chain only
(`listedAt` "", no fills, candles or history beyond the chain's). Anything at the URL that is not GraphQL's JSON (a dev
server's HTML page, a proxy's error page, even with status 200) counts as no indexer.

## Units

Onchain, every dollar amount and price is an integer number of u (1 u = $0.000001: tUSD's 6 decimals; prices are u per
GPU-hour on the $0.01 tick), a token amount is base units (10^6 per token, one token = one GPU-hour), and a Kuru size is
size units (10^4 per GPU-hour). Reads convert through the exact decimal string (`formatUnits`) into plain numbers:
dollars, dollars per GPU-hour, GPU-hours. Writes take **decimal strings** (`"250"`, `"3.90"`, `"48"`) or bigint base
units, parsed exactly (`parseDollars`, `parseHours`, `parsePrice`); a JS number is refused, so no float ever reaches a
transaction. GPU-hours must be whole multiples of 0.0001 (the series' LOT); limit prices whole cents.

## Reads

The chain is the source of truth (viem over the RPC, batched through Multicall3); the indexer adds what only events
hold. A transport failure is retried, then thrown (`ReadError`); a revert is never mistaken for one. When the indexer is
unreachable every read still answers, as the last column says.

| Read | Returns | From | Without the indexer |
|---|---|---|---|
| `getMarkets()` / `getMarket(gpu)` | `Market` for the six GPUs | index records (`head`, `record`, `slotState`, `slotWindow`, `readings`), the factory, the series, Kuru books | history from chain records; `listedAt` "", `quote.last` the mid, and `openInterest` the token supply only (the tokens inside open pay-me-daily long positions need the indexer) |
| `getSeries(gpu?)` | every month from the index's first to next month, listed or upcoming | factory and series views, Kuru books | as above |
| `book(gpu, month)` | `{asks, bids, spread}`: Kuru's real levels (`getL2Book`), sizes in GPU-hours | chain | same |
| `recentFills(gpu, month, limit)` | `Fill[]`, newest first by block and log index (taker side, HH:MM UTC) | indexer `Trade` (a limit that falls inside a block reads that block whole, since the indexer orders a block's trades by their text ids) | `[]` |
| `candles(gpu, month)` | hourly OHLCV from the first trade's hour to now; an hour without trades repeats the close with volume 0 | indexer `Trade` | `[]` |
| `ticker()` | each GPU's index price against the final day before, then each month's last price against its price 24 h earlier: the last trade before then (the first trade since, for a month younger than that; 0 % before any trade) | as above | changes 0 for months |
| `getWallet(address)` | tUSD, `lastDrip` / `nextDrip` / `canDrip` (the dollar's `nextDripAt`), Kuru margin tUSD, MON, positions: held tokens, short balances, pay-me-daily and short positions with `paid` and `claimable` | chain balances and `position()` / `claimable()`; indexer for position ids, open times and entry prices | every position id scanned on chain; `entry` 0, `openedAt` "" |
| `openOrders(address)` | the user's resting Kuru orders as `OpenOrder`, newest first | indexer `BookOrder` candidates (every page, up to 50,000) plus every order id above the newest the indexer has seen (an order placed a moment ago is never missed; the newest ids are read first, so an order indexed in between is in one of the two), each checked on chain by Kuru's own status rule | the newest 500 order ids of each book, from the chain |
| `openOrdersResult(address)` | `{orders, complete, source}`: the same orders, where they came from (`"indexer"` or `"chain"`) and whether every id was reached | as above; `complete` false when the indexer holds more of the user's orders than 50,000 | `complete` false when a book holds older ids than the scan reached (the maker's requotes create ids all day): show "may be incomplete" |

A month that is not listed (an upcoming month, or a price-only GPU) has an empty book, no fills and no candles: `book`,
`recentFills` and `candles` return empty, never an error; the writes, which need a listed month, throw `ReadError`
before the wallet is asked for anything: "B300 is price only" for B300, A100 and L40S (they never list), "not listed"
for a market GPU's month not listed yet. An unknown GPU is a `ReadError`, a month not written `YYYY-MM` an
`AmountError`.

What the fields mean, where the chain gives a choice:

- **Market.price** is the newest final day's fix; `priceDate` is that day, `updatedAt` its `finalAt`. Before the first
  final day: `price` and `prevPrice` 0, `updatedAt` "", `priceDate` null, no sources, no history.
- **sources** are the panel's clouds on the newest final day: the price each slot gave the index (the cent-rounded mean
  of the source writer's readings once the slot has `minReadings` of them, else its held value), `live` = in the median.
  A slot with no price that day is left out; `panelSize` still counts it. The writers post no reading for a reserve
  (checked on the live index's first day: H100's Hyperstack slot reads 0), so a reserve never appears in `sources`;
  `panel` (added) lists every registered slot with its cloud, `live`, `reserve` and `price` (null when not read), for
  "n of N clouds" with names. `liveCount` is the clouds in the median (before the first final day: the slots open
  today).
- **history** is real days only (`example` is always false), final or carried, oldest first, never before the GPU's
  first day. A day counts as final by its `finalAt` against chain time, so the indexer's slower FINAL label never hides it.
- **prelaunch** (added, optional in the type) is the days before the GPU's first day, oldest first, each `onchain: false`:
  on the Monad testnet production index only (Oct 1 to 3 2026; empty on any other index). They are the prices the
  index's own formula records from our index logger's archived hours (`contracts/deployments/10143-prelaunch.json`, made
  by `wall/apps/watcher/scripts/prelaunch.ts`), never onchain and never part of `history`, `price` or anything that
  settles. Draw them apart (greyed, "recorded by our logger, not onchain"). The logger read each page at its own minute,
  so on a day a cloud changes price one can differ by a cent from what the writers would have posted (checked on Oct 4,
  the first onchain day, computed the same way: H100 and B300 equal, H200 and B200 one cent above).
- **nextUpdateAt** is when the next index price is expected to be final, from the index's own rule
  (`contracts/src/lib/IndexDays.sol`): a day closes from its end plus CLOSE_GRACE (01:00 UTC on the production clock),
  which publishes the record, and the record is final at **postedAt + T_PEND** (about **07:00 UTC**). A countersign
  does not make it final earlier: a record that needs one is final at max(postedAt + T_PEND, the countersign). Bounds:
  never before the day's end + CLOSE_GRACE + T_PEND (07:00 UTC); later when the close is late (a writer that missed
  slices may wait until the end + T_PEND, 06:00 UTC, to be closed, then final at 12:00 UTC) or the countersign comes
  after T_PEND. `nextCloseAt` (added) is when the price is published, about 01:00 UTC.
- **Series.phase**: `trading` before the month starts, `paying` inside it, `settled` once every day is applied
  (`previewSync().k == N`), `upcoming` before it lists (with `opensOn`: now when `previewListing` passes, else when the
  last index day its band needs is expected to be final: the five days before the 1st of the month before (RULE), or
  the index's first record (SEEDED)). A month the index started after never lists and is not returned (October on the
  real factory). `k` and `S` are what a sync would apply now.
- **Series.openInterest** is GPU-hours outstanding: token supply plus tokens held in open pay-me-daily long positions
  (the second part from the indexer; without it, the token supply only). `closesAt` is the end of the month's last
  day; `listedAt` the listing block's time.
- **Candles** start at the hour of the month's first trade, not at the listing: before the first trade no price was
  traded, and flat candles at an invented price would skew the 24 h high, low and change the app derives from them. To
  draw the axis from the listing, start it at `Series.listedAt` and leave the hours before the first candle empty.
- **Quote**: `bid` and `ask` are the top of the live book (0 for an empty side); `last` is the last trade, and before
  the first trade the mid on the tick (or the one side); `lastAt` (added) is null until a trade happened.
- **Position.entry** is the average price of how what is still held was acquired (0 when unknown). Router buys are
  read from the user's own RouterFlow rows ((dollarsIn - refund) / tokens), never matched by `txOrigin`: a smart
  account's transactions come from a bundler, and one bundle can carry other users' trades. For a pay-me-daily long,
  its OPEN_LONG_DAILY flow; for a short position, the router's sale in its OPEN_SHORT transaction (read by that
  transaction, taker = the router, sell side); for held tokens, the user's OPEN_LONG flows plus the user's own resting
  bids that someone else filled (never a fill inside the user's own transactions), never a pay-me-daily buy (those
  tokens became positions) or a close-short buy-back (burned); for a short balance (minted pairs whose tokens were sold
  through the user's resting asks, a limit short), those asks' fills by someone else, never a router sale. Held tokens count those in
  Kuru's margin account too (a filled limit buy, a cancelled ask land there): `inMargin` (added) is that part, which
  `withdrawMargin` brings to the wallet before a sale, a settle or a redeem.

**Cost of a read** (measured on Monad testnet, Oct 4, before the first listing): `getMarkets()` is 28 RPC requests
the first time (it also reads the immutable terms, kept for the client's life), then 16, plus up to 3 GraphQL queries
(a listed month adds its book and two queries); `getWallet()` is 5 requests and 1 to 2 queries (a wallet past 1,000 open positions, router flows or trades
reads every further page, ordered by a unique key so no row repeats or goes missing). The public RPC rate-limits: poll markets no faster than every 15 to 30 seconds and the wallet
after the user's own transactions, and let a cache (TanStack Query) share results between components.

## Writes

Each is `fn(client, walletClient, params)` and returns `{hash, txs, result}`: every transaction it sent (approvals and
deposits first, the main one last, each with its gas limit, gas used and decoded events) and the outcome in dollars and
GPU-hours. Every transaction is **simulated first** (eth_call from the user; a revert is a `WriteError` and nothing is
sent), then sent with an **explicit gas limit of ceil(1.2 x eth_estimateGas)** (Monad bills the gas limit, not the gas
used), then its receipt is read. The wallet must be on the deployments' chain (checked first). Slippage defaults to
100 bps.

**Approvals** are exact amounts, sent only when the allowance is short, to the contract that pulls: the factory's router
(its flows pull exactly what they spend), the series (minting pairs), or Kuru's margin account (deposits for limit
orders: Kuru's own design, the third spender). Never unlimited: no flow needs a standing allowance (the router's design
allows one, and an EIP-2612 permit, for a one-click wallet later; `NOPERMIT` is passed).

**Price bounds.** Every market write is bounded twice, before anything is sent and on chain (the router's minimum out,
or the buy-back's maximum in), by the strictest of:

1. the fresh quote (Kuru's own simulation of the buy, or the exact walk of the bids for a fill-or-kill sale) less the
   slippage allowance (`slippageBps`, default 100, 0 to 9,999);
2. **the band**: a token pays its month's value at the end, which lies in [(S + (N - k) F) / N, (S + (N - k) C) / N]
   per GPU-hour (F floor, C cap, k days applied summing to S): [F, C] before the month, narrower inside it, S / N once
   settled. A buy (`buyLong`, `openLongDaily`, the `closeShort` buy-back) averaging above the top, or a sale (`sellLong`,
   `openShort`, `closeLongDaily`) averaging below the bottom, is a sure loss and is refused (`reason` "AboveBand" or
   "BelowBand"), whatever the slippage allowance says. **Depth:** Kuru's market buy is not fill-or-kill (what the asks
   cannot fill comes back), so a minimum out bounds only the part that filled, and the rest of a bigger buy would meet
   whatever asks stand, or are posted, above the book at any price while the average still looked fine. So
   `buyLong` and `openLongDaily` may spend no more than the asks priced at or under the band's top hold: more is
   refused with `reason` "ThinBook" and `error.quote` = what those asks hold (`quote.dollars` is the most the buy may
   spend: "buy at most $X"), and the minimum out is the GPU-hours of a complete fill at those prices (Kuru's own
   rounding and taker fee walked exactly, checked against Kuru's simulation) less the slippage. A front-runner can then
   only take some of those asks, which the minimum out bounds to the slippage. When the simulation fills less than the
   book read a moment before (the book moved), the book is read again with a new simulation; still apart, the buy is
   refused ("PriceMoved", "the book is moving"). A buy-back needs exactly q tokens and is capped as above, so it has
   no remainder;
3. **the price the app showed**, when passed: `maxPrice` (dollars per GPU-hour on average) or `minGpuHours` for a buy,
   `minPrice` or `minDollars` for a sale, `maxPrice` or `maxDollars` for a buy-back, less the slippage allowance. A
   fresh quote worse than that is refused before anything is sent with `reason` "PriceMoved" and the new quote in
   `error.quote` (`{gpuHours, dollars, avgPrice}`): show it and send again once the user confirms.

Every quote in an error is what the dollars actually fill (its `dollars` only the part that fills, its `avgPrice`
over that part). The price checks come first; then a write the wallet's tUSD cannot pay (the spend, the pairs'
collateral q x C, the buy-back's maximum, a limit order's deposit or mint) is refused before its approval with
`reason` "InsufficientBalance" (otherwise the approval lands, the main simulation reverts and the approval is put
back: two fees for nothing).

**Errors.** Every refusal is a `WriteError` with `stage` ("check", "simulate", "estimate", "send", "receipt"), `reason`
(the decoded revert name where there is one, nested Kuru errors included), `hash` (a sent transaction's), `quote`
(above) and `txs`: the transactions that write had already landed. Its message says "nothing was sent" only when `txs`
is empty. When a later step is refused after earlier ones landed (an approval, a deposit, a mint), the error lists them
and says how to undo what moved (`withdrawMargin` for a deposit, `redeem` for minted pairs), and an approval that
nothing used is put back to its old value first (one more transaction, `put back: ...` in `txs`; not when the user's
wallet itself declined to send, so no new prompt follows a "no", nor when a receipt did not come, since that
transaction may still land; the message says so then, and `resetAllowance` clears one by hand). A receipt that
does not come within 120 s is a `WriteError` at stage "receipt" with reason "NoReceipt" and the hash: look the
transaction up before offering to send again.

**Amounts** are decimal strings or bigint **base units** (`BigInt(250)` as dollars is $0.00025, not $250): pass strings
from forms.

| Write | Sends | What it checks first |
|---|---|---|
| `drip` | `AgateDollar.drip()` | `nextDripAt` against chain time |
| `buyLong({gpu, month, dollars, maxPrice?, minGpuHours?, slippageBps?})` | approve tUSD to the router; `router.openLong(series, dollars, minTokensOut)` | `dollars` within what the asks at or under the band's top hold (else "ThinBook"); `minTokensOut`: the complete fill of `dollars` at those asks, checked against Kuru's own simulation (eth_call from address 0), less slippage, never under dollars / the band's top or the shown price less slippage; the wallet holds `dollars` |
| `sellLong({gpu, month, gpuHours, minPrice?, minDollars?, slippageBps?})` | approve the token to the router; `router.closeLong(series, tokens, minDollarsOut)` | the wallet holds the tokens; proceeds walked exactly on the bids (fill-or-kill) less slippage, never under tokens x the band's bottom or the shown price less slippage |
| `openShort({gpu, month, gpuHours, parts, daily, payee, minPrice?, minDollars?})` | approve tUSD (q x C) to the router; `router.openShort(...)` | equal parts of whole LOTs; the sale bounded as sellLong's; the payee is not a market contract |
| `closeShort({gpu, month, positionIds, maxPrice?, maxDollars?})` | approve tUSD to the router; `router.closeShort(series, ids, dollarsIn)` | the positions are the user's, short, opened through the router; `dollarsIn` = the smallest quote Kuru's simulation says buys q, plus slippage, never over q x the band's top (plus Kuru's rounding) or the shown cost plus slippage (the unused part and any surplus tokens come back) |
| `openLongDaily({gpu, month, dollars, parts, payee, maxPrice?, minGpuHours?})` | approve tUSD to the router; `router.openLongDaily(...)` | the buy bounded as buyLong's; the floor of every remaining day is paid at once |
| `closeLongDaily({gpu, month, positionIds, minPrice?, minDollars?})` | approve tUSD (q x C) to the router; `router.closeLongDaily(...)`: the router mints q pairs and sells the q tokens fill-or-kill on the bids | the positions are the user's, long, opened through the router; the sale bounded as sellLong's |
| `claim({gpu, month, positionIds})` / `claimDaily()` | `series.claim(id)` or `claimMany(ids)`; claimDaily: one per series with something claimable | |
| `mintPairs` / `redeem({gpu, month, gpuHours})` | approve tUSD (q x C) to the series; `series.mint` / `series.redeem` | |
| `settle({gpu, month, side})` | `series.settle(LONG, held)` and/or `settle(SHORT, shortBalance)` | every day applied; positions are paid out by their final `claim` |
| `placeLimit({gpu, month, side, price, gpuHours, postOnly, mint})` | long: deposit the missing tUSD into Kuru's margin account (approve exact), `market.addBuyOrder`. short: the wallet's tokens first, the shortfall minted as pairs (`mint: true` mints all of it, a true short), deposited, `market.addSellOrder` | price on the tick and inside the band (what a token can still pay); 1 to 1,000,000 GPU-hours; post-only by default, and a post-only order that would cross the book read now (a bid at or above the best ask, an ask at or below the best bid) is refused before any approve, mint or deposit |
| `cancelLimit({gpu, month, orderIds})` | `market.batchCancelOrders(ids)` | only ids still resting and the user's (Kuru reverts on others) |
| `withdrawMargin({asset, amount})` | `marginAccount.withdraw(amount, token)` | the margin balance |
| `resetAllowance({token, spender})` | `token.approve(spender, 0)` | |

**Pay me daily and limit orders.** A limit order rests on Kuru as the user's own order (the router holds nothing between
calls), and a fill credits tokens to the user's Kuru margin account, with no call into the series. So pay-me-daily cannot
apply to a limit fill, and `OpenOrder` has no `daily` field (the app's mock type has one: drop it there). After a fill,
the user can withdraw the tokens and make them a daily position (`series.streamOut`), a separate step.

**Gas measured** on a fork of Monad testnet with the live deployment (the e2e below, Oct 4 2026; anvil's gas, each
limit sent as 1.2 x anvil's estimate; MON = the limit at 102 gwei, since Monad bills the limit). On Monad each limit
follows Monad's own estimate, which runs 1.0 to 1.7 x anvil's by call (ops/testnet/RUNBOOK.md), so budget up to 1.7 x.

| Transaction | Gas limit sent | Gas used | MON at 102 gwei |
|---|---|---|---|
| `drip` | 89,799 | 74,832 | 0.0092 |
| an exact `approve` (tUSD or a token, any spender) | 55,148 to 55,203 | 45,956 to 46,002 | 0.0056 |
| `openLong` ($1,000, one level) | 340,632 | 227,088 | 0.0347 |
| `closeLong` (100 GPU-hours) | 346,676 | 231,117 | 0.0354 |
| `openShort` (48 GPU-hours, 2 daily parts) | 642,100 | 428,067 | 0.0655 |
| `closeShort` (one position) | 376,473 | 250,982 | 0.0384 |
| `openLongDaily` ($500, 2 parts) | 539,252 | 384,876 | 0.0550 |
| Kuru `deposit` (tUSD or a token) | 90,231 to 90,272 | 69,665 to 69,699 | 0.0092 |
| Kuru `addBuyOrder` / `addSellOrder` | 217,202 / 252,413 | 173,814 / 202,699 | 0.0222 / 0.0257 |
| Kuru `batchCancelOrders` (one id) | 128,469 to 134,464 | 86,625 to 88,595 | 0.0131 to 0.0137 |
| Kuru `withdraw` | 63,141 to 63,262 | 47,437 to 47,537 | 0.0065 |
| `mint` (10 pairs) / `redeem` (10 pairs) | 117,472 / 89,486 | 93,093 / 69,771 | 0.0120 / 0.0091 |
| `claimMany` (3 positions, syncing one day) | 188,560 | 106,782 | 0.0192 |
| `claimMany` (3 positions, the final claims, the month already synced) | 139,931 | 93,232 | 0.0143 |
| `claimMany` (3 positions, the final claims, syncing the month's last 29 days itself) | 606,682 | 434,545 | 0.0619 |
| `settle` (held tokens) | 76,901 | 51,268 to 54,484 | 0.0078 |

A claim (or a settle) first applies every final day the series has not applied yet (`sync`): whoever moves first pays
for it. In five e2e runs the market maker's month-end settle carried the month's 29-day sync before the user's final
claim three times (the claim then 139,931) and the claim came first twice (606,682): a race, not a fixed cost. The estimate covers it either way, so the limit
is always right; the app should not promise a fixed claim cost. The price guards and post-only checks add no gas: a
refusal is a read.

Every router flow above also sent one exact approval first (the policy above): about 0.04 to 0.07 MON a click on the
fork, up to 1.7 x that on Monad. The user pays this gas in MON (the faucet drips tUSD only) until a login provider
sponsors it.

## Mock to live

| Mock (app/src/lib/mock) | Live |
|---|---|
| `getMarket(gpu, state)` | `agate.getMarket(gpu)` (`state` is the real one: `priceDate` null before the first final day; carried days in `history`) |
| `GPUS` | `GPUS` (six; `market.tradable` false for B300, A100, L40S) |
| `indexHistory(gpu, today)` | `market.history` (real days only); `market.prelaunch` for the greyed days before the first (`onchain: false`) |
| `book(gpu, market, mode)` | `agate.book(gpu, month)` |
| `recentFills(gpu, market)` | `agate.recentFills(gpu, month)` |
| `novCandles(gpu, market)` | `agate.candles(gpu, month)` |
| `ticker(state)` | `agate.ticker()` |
| `monthChangePct(gpu)` | from `agate.candles(gpu, month)`: last close against the close 24 h earlier |
| wallet in `store.tsx` | `agate.getWallet(address)` |
| `OpenOrder[]` of the order ticket | `agate.openOrders(address)`; `agate.openOrdersResult(address).complete` false: show "may be incomplete" |
| the ticket's preview price | pass it back to the write (`maxPrice` / `minPrice`) so a moved book is refused with `error.quote` to confirm |
| `AS_OF` | `market.updatedAt`; the countdown: `market.nextUpdateAt` (final about 07:00 UTC, 14:00 WIB, on the production clock; 01:00 UTC is only when the price is published, `nextCloseAt`) |
| `COMPARISON`, `peersFor` | stay in the app (peer prices are the app's own) |

## Tests and the end-to-end run

```sh
bun install
bun test                      # units, book walks (Kuru's rounding), clocks, read helpers, the write policy on fakes,
                              # generated-file drift, browser safety, the app's field names
bun run typecheck
bun run gen                   # regenerate src/abi.ts and src/static.ts after a contract or deploy change
bun run e2e/run.ts fork       # the whole journey on a local fork (below)
bun run e2e/run.ts live       # every read against the live testnet and the indexer, read only
AGATE_E2E_RPC=http://127.0.0.1:<port> AGATE_E2E_GRAPHQL=<url> AGATE_E2E_DAYS=1 bun run e2e/run.ts flows
                              # the journey alone against a fork world that is already up (listed months, a maker)
AGATE_E2E_KEY_CMD='security find-generic-password -s <item> -a private-key -w' \
  bun run e2e/run.ts testnet --i-mean-testnet
                              # the journey on Monad testnet, against the live demo factory of a running demo session
bun run e2e/session-report.ts # read only: a demo session's days, listings, books, claims, alerts and MON per key
```

`e2e/run.ts fork` starts an anvil fork of Monad testnet through `wall/scripts/anvil-safe.sh` (refused under 30 GB
free) with the **live deployment** (`contracts/deployments/10143.json`), writes and countersigns index days as the
index's own writer and attester (impersonated on the fork, the operator kit's `ops/testnet/rehearse/days.ts`), runs
the payer app as the lister and the market maker app with the kit's public rehearsal keys (fork only), and an Envio
indexer of the fork on its own Postgres and Hasura containers (`e2e/indexer.ts`: names, network and free ports of
this run alone, `agate-client-e2e-<pid>-<n>-*`, so two runs at once never touch each other; its own password; never
`envio dev` or `envio stop`, whose Docker resources have fixed global names another indexer may be using). Then a user
(anvil's test account 1, fork only) goes through every flow, checked after each step through the client's reads and
the indexer: drip, buy long (bounded by the ask the app showed), sell part (by the bid), the guards (a stale price, a
crossing post-only order, a buy beyond the asks under the cap and a buy the wallet cannot pay, each refused with
nothing sent), open a short in two daily parts, close one, long pay me daily,
a limit long placed and cancelled and the margin withdrawn, a limit short that mints pairs, cancelled, withdrawn and
redeemed, a day of the month final and the daily claim, then the month's end with the final claims and settle. It
prints a table (step, tx hash, gas limit, gas used, MON at 102 gwei, checks passed) and stops everything it started.
Nothing is sent to Monad testnet: every transaction goes to the loopback fork, which the script checks first.

### The live check on Monad testnet (`e2e/run.ts testnet`)

The fork mode's journey, run for real against the **demo factory of a running demo session** (ops/testnet/RUNBOOK.md,
"A demo session"), in real time with no time travel: drip, buy long $200 (bounded by the ask it read a moment before),
sell 10 GPU-hours (by the bid), open a short of 10 GPU-hours paid daily and close it, pay me daily $100, a post-only
limit bid of 10 GPU-hours placed, cancelled and its deposit withdrawn; then it waits for the next final demo day and
claims (`claimDaily`), and waits for the demo month's end for the final claims and the settle (or redeem) of what is
left. Each step is checked through the client's reads and the indexer, and exactly where the contract fixes a number
(what a daily position is paid at open and at each claim, a short's close, the settle). The payer app claims daily
positions too, after each final day: whoever moves first pays, and the check is the position's paid total either way
(the run says which). It prints the step table (transaction, hash, gas limit, gas used, the gas price the chain
charged, MON = gas limit x that price, since Monad bills the limit) and with `--report <file.json>` writes it all.

It takes as long as the session's clock: started with the session, it waits for the listing (about 16 minutes), sends
its trades in a few minutes, claims within about 15 minutes of the next demo day's end, and ends with the month (5 hours
after the session began, plus about 6 minutes for the last day to turn final). A line every few minutes says what it
waits for.

**Gates, each before anything is sent** (exit 2 when one refuses):

- `--i-mean-testnet` is required; a loopback RPC (a local fork) is refused unless `--allow-fork` (for testing). Each
  URL is read as `fetch` reads it, so every spelling of this machine counts: `localhost` and `*.localhost` in any case
  or with a trailing dot, 127.0.0.0/8 in any notation (`127.0.0.2`, `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`),
  `0.0.0.0`, `[::1]` and `[::ffff:127.0.0.1]`. And whatever its URL says, an RPC is refused when it answers another
  chain id than 10143, or answers `anvil_nodeInfo` or `hardhat_metadata` (a local node reached by a name or an address
  the URL test does not know; one read each, no retry, 5 s at most; an RPC that errors on them is fine). With a list
  in `--rpc`, every URL is asked. An `--rpc` URL is shown and written (lines, refusals, errors that quote it, the
  `--report` file, and `e2e/session-report.ts`'s output and `--json`) by its scheme, host and port only, since a
  provider's key rides in its path.
- The key comes **only** from `AGATE_E2E_KEY_CMD`, a command run once (a Keychain read); the run refuses
  `AGATE_E2E_KEY` and the like, any command-line argument holding 64 hex digits in a row anywhere (an option's value,
  a URL, glued to other characters; the argument is not shown), a command holding a key literally (accepted only
  against a loopback fork with `--allow-fork`), and a key that is also the value of any variable of the environment.
  The key is never printed or written: nothing the command writes is shown, on stdout or stderr, even when it fails
  (only its exit code), and every run of 64 or more hex digits (with or without `0x`, whatever stands beside it, and a
  number that long in decimal) is hidden from every line the mode prints, every refusal and the `--report` file, but
  the transaction hashes this run sent or read from the chain. Every run of 16 or more hex digits in the arguments is
  hidden too, so a key split across two arguments shows no part of it.
- One live run per key: a pid file in `~/.agate-e2e/locks` (per key address, and per port on a fork) is taken once the
  key's address is known and released when the run ends, also after a Ctrl-C, and when the process exits (a second
  Ctrl-C, SIGTERM); a second run of the same key exits 2 while the first lives (and leaves the `--report` file to the
  first), and a lock whose process is gone (a crash, `kill -9`) is taken over, under a guard (`<lock>.takeover`, a
  directory one process at a time can make) so two runs that find it stale at the same moment never both get it. A
  run also refuses to start while the key has a transaction still pending (its pending nonce above its latest: a run
  that stopped mid-send); an RPC that does not answer the pending nonce leaves the lock as the only guard.
- The user's address, MON and tUSD are printed first; then any role refuses the run: the owner, writers, attester and
  guardians of every index, the market admin of every factory and the dollar's minter (read on chain), and every role
  address of `ops/testnet/lib.sh` (the real keys and the rehearsal keys, the maker and the payer among them) and of
  the deploy configs.
- The demo factory by default, only while its session is `active` in the index records (`10143-indexes.json`); the
  production factory only with `--factory real` (`AGATE_E2E_FACTORY` is refused, and a demo entry that shares an
  address with production, names the production index, or sits on an index with the production clock is refused).
- The factory on chain names the deployments' index, router and dollar; the indexer answers and indexes this index
  (else `--no-indexer`: chain-only checks).
- A spend cap: `--max-dollars` (default 500 tUSD). The journey's most (each write's approval: the buy, the short's
  collateral 10 x C, the buy-back at the ask plus 1%, pay me daily, the bid's deposit; about $460 on H100) is checked
  against it before the first send, and each write's maximum before it is sent. A MON floor: `--min-mon` (default 1)
  before every step.

**Resumable.** Ctrl-C finishes the step in progress (every transaction of it and its checks: a Ctrl-C just after
`== short-open` is printed still sends that step's approve and open) or stops a wait at once (for the listing, the
book, a final day, the month's end), then stops; a second Ctrl-C quits at once.
`--stop-after <step>` stops after a step (drip, buy, sell, short-open, short-close, daily, limit, claim, month-end,
settle). Run the same command again: each step is looked up on chain first (this user's router flows on the month's
series, its Kuru orders, its positions, balances and resting orders through the client's reads; the indexer up to its
newest block and the chain's logs above it), and is skipped when done, finished when half done (a resting bid
cancelled, a deposit withdrawn), and sent only when it was not.

**Which month.** `--month`, else the newest month of the GPU in which this key already holds something or has a
journey on this factory, finished or not (the `--report` file of an earlier run of this key, factory and GPU, or the
key's router flows on chain: the indexer's rows, else the chain's `Routed` logs from the factory's start block or
`--from-block`), else, for a key with no journey there yet, the factory's current month. So the same command run
again after a finished journey (exit 0) finds every step done and sends nothing (the drip too, even after the drip
period: a month with any flow of the key is past its drip); a new month for that key needs an
explicit `--month`. The run prints which month it took and why.

Exit codes: 0 every check passed, 1 a check failed or the run stopped on an error (the table shows what landed), 2 a
gate refused, 3 stopped on request (Ctrl-C, `--stop-after`) with every check so far passed.

Options: `--gpu H100|H200|B200` (default H100), `--rpc` (default the public RPC; several URLs separated by commas are
tried in order, since the public RPC allows 15 requests a second per IP for every process on the machine),
`--deployments` (default
`contracts/deployments/10143.json`, its `-indexes.json` beside it), `--graphql` / `--no-indexer`, `--from-block` (where
a chain scan starts without the indexer; default the factory's start block), `--listing-wait-min 60`,
`--claim-wait-min 45`, and on a fork only `--time-travel` (the month's end is written by the kit's `days.ts` as the
index's own writer and attester, impersonated, instead of waited for).

Proven on Oct 4 on a fork of a rehearsal demo session (`ops/testnet/rehearse.sh session`'s steps: the kit's scripts,
rehearsal keys, a private tmux server; an isolated indexer of both factories) with `--allow-fork` and an anvil test
key: the gates refused there too (no `--allow-fork`; the rehearsal maker's key), and the journey ran in three runs that
each resumed from the chain (`--stop-after sell`, `--stop-after claim`, then `--time-travel` for the month's end): 58 of
58 checks, 19 transactions, gas limits 3,460,116 (0.35 MON at 102 gwei; about 0.6 at Monad's estimates, up to 1.7 x
the fork's). A fourth run on the finished month sent nothing; a Ctrl-C during a step stopped after it; a bid left
resting by a run that died was found, cancelled and its deposit withdrawn by the next run.

### A demo session's report (`e2e/session-report.ts`)

Read only (no key): per demo day of the demo index whether each GPU's record is closed, final, countersigned or
carried, and how many slices each writer posted; the demo factory's listings; the maker's books (every level and its
size); the claims per day and how many the payer sent (needs the indexer); the alerts of `~/.agate-wall/alerts/
alerts.jsonl` since the session began; and per key the MON that left it since the session's deploy block (gas and any
top-up it sent; a top-up it received reads as less spent) with its transaction count. A read that failed is said in
words ("read failed" for a writer's slices, "record read failed" for a day's records), never as a count; with
`--no-indexer` the indexer is "not used" and the claims are not read. Run it every 30 minutes during
a live check: `while true; do bun run e2e/session-report.ts | tee -a session.log; sleep 1800; done`. Options:
`--rpc`, `--deployments`, `--indexes`, `--graphql` / `--no-indexer`, `--alerts`, `--roles real|rehearsal` (a fork
rehearsal's keys), `--state` (a snapshot it keeps when the RPC holds no state at the deploy block, as a fork's pruned
history does), `--json <file>`.
