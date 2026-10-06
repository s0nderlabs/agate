# agate indexer

Envio HyperIndex (envio 3.12.1) over the agate market on Monad testnet (chain 10143): the factories and their series,
tokens, test dollar and routers, the Kuru V1 order books of the series, and both price indexes. It serves a GraphQL API
for the app. Spec: `docs/market/BOTS-SPEC.md` section 5 (local only); events: `docs/market/BUILD-SPEC.md` section 8.

## Run

```sh
bun install                 # in indexer/ only
bun run codegen             # envio codegen: .envio/types.d.ts from config.yaml and schema.graphql
bun run test                # vitest: every handler, drift, the local replay, the README queries. No Docker.
bun run gen:abis            # abis/*.json from a forge build (AGATE_FORGE_OUT, else ../contracts/out)
bun run gen:config <deployments.json> [--rpc] [--index-start demo=<block> --index-start real=<block> | --no-index-start] [--out config.yaml]
bun run gen:testnet         # the hosted indexer's pair: config.testnet.yaml + src/lib/deployments.testnet.generated.ts
bun run capture             # rebuild test/fixtures/local-lifecycle.json on a local anvil (anvil-safe), by hand
```

`config.yaml` and `src/lib/deployments.generated.ts` are generated, never edited. The committed pair comes from
`test/fixtures/deployments.test.json` (the local test world that `capture` deploys); the operator's indexer
(`ops/testnet/indexer.sh`) renders its own copy from `contracts/deployments/10143.json` with `--index-start` for each
index (`scripts/index-starts.ts`), so the price history starts at each index's first day, and the hosted indexer has
its own committed pair (below). `gen:config` fails closed (audit M-2): for any input but the test world's file it refuses to write unless
every index has an `--index-start` (through a factory over it), or `--no-index-start` says on purpose that the indexes
start at the factories' start block (losing `GpuRegistered` and every day closed before the market deploy).

**The hosted indexer (Envio Cloud, since Oct 6 2026)** runs a second committed pair, `config.testnet.yaml` and
`src/lib/deployments.testnet.generated.ts`, written by `bun run gen:testnet` from `contracts/deployments/10143.json`
with each index starting at its deploy block from `10143-indexes.json` (`scripts/index-starts.ts`, the rule
`ops/testnet/indexer.sh` uses too), on HyperSync. The hosted indexer's settings (Envio Cloud project
s0nderlabs/agate, Development plan): root directory `indexer`, config file `config.testnet.yaml`, branch `main`; every
push to main redeploys it. The free plan has no environment variables, so nothing selects a pair:
`src/lib/deployments.ts` merges both: handlers look a factory or index up by the address an event came from, and an
event only comes from a contract of the running config (the clock enumerates every factory and finds market rows only
for the running config's; the default pair wins on an address in both). Envio Cloud installs with pnpm 10.32.0 from
`pnpm-lock.yaml`, kept beside `bun.lock`. Rerun `gen:testnet` after any deploy that changes either deployments file; `test/drift.test.ts` fails while
the pair is stale. The default pair (`config.yaml`, `src/lib/deployments.generated.ts`) stays the test world's, and
`indexer.sh` regenerates its own copy for the operator's indexer. A run with another `--out` (a fork) rewrites
`src/lib/deployments.generated.ts` too (the handlers read it): regenerate the default pair before a commit. If `DeployMarket`'s first broadcast died after it had
deployed the dollar and minted the bot float, rerun the deploy from scratch: a rerun reuses the dollar and stamps the
factories' `startBlock` after that mint, so `DollarBalance` would miss the float.

**Data source.** HyperSync serves chain 10143 (`https://10143.hypersync.xyz`, checked Oct 3), so the hosted service
needs no RPC and no token. Local and self-hosted runs need `ENVIO_API_TOKEN` for HyperSync; without one, generate
with `--rpc`, which adds `rpc: [{url: "${ENVIO_RPC_URL}", for: sync, interval_ceiling: 100}]`, and export
`ENVIO_RPC_URL` at run time (never commit a URL). A fork run writes `--out config.fork.yaml` (gitignored); regenerate
the committed pair afterwards.

## Units

- Dollars are `u`: 1 u = $0.000001, so divide by 10^6 for dollars. Token amounts are base units: 10^6 per token (one
  token = one GPU-hour of the month).
- Prices (`priceU`, `markU`, `bestBidU`, index `value`) are u per token (or per GPU-hour), on the $0.01 grid, except
  `vwapU` (a volume-weighted mean) and the trade prices of Kuru's AMM vault (audit L-8).
- Kuru sizes (`BookOrder.size`, `remaining`, `BookLevel.size`) are Kuru size units: one unit is 0.0001 token
  (x 100 for base units).
- Days, months, k and counts are `Int`; timestamps are `BigInt` seconds of chain time. A month is
  `year * 12 + (month - 1)` (`monthLabel` gives `2026-11`). Index days are day counts since 1970-01-01 (`date` gives
  the calendar day; the demo clock maps its short days onto real calendar days too).
- Ids: addresses lowercase; joins with a hyphen; event rows `<block>-<logIndex>`.

## Entities

Every relation `x` is also readable as the column `x_id` in `where` filters.

**Account** (id: address). `firstSeenAt`; `nextDripAt` (when its next faucet drip opens, from `Dripped`). Lists:
`tokenBalances`, `shortBalances`, `dollarBalances`, `positionsOwned`, `positionsPaid` (positions it is payee of),
`flows` (its router clicks). Every address a handler names gets one.

**Factory** (id: address). `name` (the deployments key: demo, real, pilot), `tag` (symbol prefix source), `index`
(its PriceIndex), `dollar`, `router`, `clockAnchor` and `day` (its index clock: `dayStart(d) = clockAnchor + d * day`,
known from its first series), `series`.

**Series** (id: series address). Terms: `factory`, `index`, `gpuId`, `label` (H100), `month`, `monthLabel`, `token`,
`name`, `symbol`, `startDay`, `n` (days), `startTs`, `endTs`, `day`, `lastResort`, `floor` and `cap` (the band F and C,
u per GPU-hour), `x0`, `bandGrade` (RULE, STALE, SEEDED), `anchorCarried`, `anchorMinFresh`, `anchorLate`. State: `k`
(days applied), `sum` (sum of clamped fixes, u), `state` (LISTED, ACCRUING, FINAL at k = n), `lastFixDay`, `ledger`
(dollars the series holds for its payouts; equals the contract's `state().ledger`), `tokenSupply`, `shortSupply`,
`openPositions`, `qInPositionsLong`, `qInPositionsShort`. Market: `market` (the current one), `venue` (NONE, KURU_V1,
OTHER), `pricePoint`. Also `listedAt`, `listedBlock`, `days` (SeriesDay), `positions`.

**Token** (id: token address). `series`, `supply` (base units).

**TokenBalance** (id: `<token>-<account>`). `token`, `series`, `account`, `balance`.

**ShortBalance** (id: `<series>-<account>`). `series`, `account`, `balance` (short units, base units). Shorts never move
between accounts: only mints, debits and unstreams change them.

**DollarBalance** (id: `<dollar>-<account>`). `dollar`, `account`, `balance` (u) of the deployments file's test
dollar (never the pilot's USDC).

**Position** (id: `<series>-<positionId>`, a "pay me daily" position). `series`, `positionId`, `owner`, `payee`,
`operator` (null: none; the router is the operator of router-opened positions), `side` (LONG, SHORT), `q` (base
units), `paid` (u paid so far), `daily`, `openedK`, `openedAt`, `openTo`, `status` (OPEN, CLOSED_FINAL,
CLOSED_WITH_TOKEN, UNSTREAMED), `lastClaimAt`, `closedAmount`, `closedTo`, `closedBy`, `closedAt`, `claims`.

**Claim** (id: event). `position`, `series`, `payee`, `amount` (u; a claim of 0 is still a row), `paidTotal`, `k`,
`by` (the transaction sender), `timestamp`, `block`, `txHash`.

**Mint**, **Redeem**, **Settle** (id: event). Pairs in (`payer`, `to`, `q`, `cost`), pairs out (`holder`, `to`, `q`,
`paid`), month-end payouts (`holder`, `side`, `q`, `paid`, `to`); each with `series`, `timestamp`, `txHash`.

**SeriesDay** (id: `<series>-<k>`). The series' own view of each applied day: `k`, `day`, `x` (the fix), `c` (clamped
into the band), `status` (NONE when forced, FULL, DEGRADED, DEMO, CARRIED), `flags` and its bits `late`,
`incomplete`, `forced`, `belowFloor`, `aboveCap`, `carried`, `sumAfter`, `appliedAt`.

**RouterFlow** (id: event, one per click). `router`, `user`, `series`, `flow` (OPEN_LONG, OPEN_LONG_DAILY, OPEN_SHORT,
CLOSE_LONG, CLOSE_SHORT, CLOSE_LONG_DAILY), `tokens`, `dollarsIn`, `dollarsOut`, `refund` (the unspent quote, shown as
"returned"), `tokensIn`, `tokensOut`, `net` (= dollarsOut - dollarsIn; negative for a buy), `positionIds`,
`timestamp`, `block`, `txHash`.

**Drip** (id: event). A faucet drip: `account`, `amount`, `nextAt`, `timestamp`.

**Market** (id: market address). `series`, `venue`, `created` (deployed by createMarket, else attached), `by`,
`previous` (the market it replaced), `current` (false once replaced; its orders and trades stay as history), `state`
(Kuru's ACTIVE, SOFT_PAUSED, HARD_PAUSED; a state Kuru adds later is read as HARD_PAUSED and logged, never a halt:
audit L-5), `recordedAt`, `orders`, `trades`. When `Market.created` is false (a market attached by the admin, or one
someone deployed with our parameters before `createMarket`), its book may hold orders placed before `MarketRecorded`,
which the indexer never saw (it follows a book from that block): read the market's `getL2Book()` for its depth
(audit L-4).

**BookOrder** (id: `<market>-<orderId>`). A resting Kuru order: `market`, `series`, `orderId`, `owner`, `isBuy`,
`price`, `size`, `remaining`, `status` (ACTIVE, FILLED, CANCELED), `isFlip`, `flippedId`, `flippedPrice`,
`createdAt`, `updatedAt`.

**BookLevel** (id: `<market>-<bid|ask>-<price>`). Resting `size` and `orders` at one price on one `side` (BID, ASK).
A level that empties is deleted.

**Trade** (id: event). A Kuru fill: `market`, `series`, `orderId`, `maker`, `taker` (our router for router flows),
`txOrigin` (the user), `takerIsBuy`, `priceU`, `tokens` (base units), `notionalU`, `makerRemaining`, `dayId` (index day
on the series' clock), `timestamp`, `block`, `txHash`.

**PricePoint** (id: series address, one per series). `series`, `market`, `forward`, `gpuId`, `month`, `monthLabel`,
`lastTradePriceU`, `lastTradeAt`, `bestBidU`, `bestAskU`, `midU` (their mean, floored to $0.01), `markU` and
`markSource` (TRADE, MID, NONE), `updatedAt`. The mark (audit M-1) is the last trade while it lies inside the live
book (between the best bid and ask, or with a side missing), else the mid, else null: once the maker requotes on a new
final day, a trade the book has moved away from is no price anyone can trade at, so the forward curve shows the mid
until someone trades again (`lastTradePriceU` and `lastTradeAt` keep the trade). Only the series' current market moves
it.

**DailyCandle** (id: `<series>-<dayId>`). Per index day of the series' clock: `open`, `high`, `low`, `close`,
`volumeTokens`, `notionalU`, `vwapU`, `trades`. Built from the series' current market only, as the price point (audit
L-3): a replaced market's late fills stay in `Trade` as history.

**MarketForward** (id: `<factory>-<gpuId>`). The forward curve of one GPU on one factory ("the
market's own" prices): `label`, `currentMonth`, `nearSeries` and `nextSeries` (this month's and next month's series),
`nearMarkU`, `nextMarkU`, `updatedAt`, `points` (every PricePoint of the GPU, one per listed month, past months
included: the app keeps `month >= currentMonth`, or reads only `nearMarkU` and `nextMarkU`; audit L-8).

**PriceIndex** (id: index address). `names` (the factories over it), `tPend` (seconds from close to final), `gpus`.

**IndexGpu** (id: `<index>-<gpuId>`). `gpuId`, `recipeHash`, `firstDay`, `registeredAt`.

**DailyFix** (id: `<index>-<gpuId>-<day>`). One index day: `day`, `date`, `value` (u per GPU-hour), `status` (FULL,
DEGRADED, DEMO, CARRIED; NONE, with value 0, for a skipped day, even one whose record was dropped or vetoed first:
audit L-1), `fresh`, `held`, `freshMedian`, `changed`, `needsSign`, `late`,
`incomplete`, `source` (the writer), `digest`, `postedAt`, `finalAt` (null: not known yet, waiting for the attester or
vetoed or dropped), `attestedAt`, `attestedBy`, `replaced` (the attester selected another writer's record), `vetoed`,
`vetoCount`, `dropped`, `state` (below), `updatedAt`, `events` (its audit history).

**FixEvent** (id: event). `fix`, `kind` (DayClosed, Attested, RecordReplaced, Vetoed, FixDropped, DayCarried,
DaySkipped), `value`, `by`, `source`, `timestamp`, `txHash`.

**OwnerAction**, **ReaderSwap** (id: `<index>-<id>`). The index owner's timelocked changes and reader swaps:
`status` (QUEUED, EXECUTED, CANCELLED), `eta`, `queuedAt`, `executedAt`, `cancelledAt`, plus the action's fields
(`kind`, `slot`, `addr`, `gpuId`, `day`, `mode`) or the reader (`gpuId`, `slot`, `url`, `parserVersion`, `reason`,
`fromDay`, `readerHash`). `day` is a Postgres integer: a LIVE_UNTIL day beyond 2^31 - 1 (the owner's NEVER,
2^32 - 1) is stored as 2,147,483,647, read "beyond int32: see the action on chain" (audit M-3: the write would fail
and halt the indexer).

**WriterSuspension** (id: event). `writer`, `by`, `timestamp`.

## The day label

From a DailyFix (the wall's dayLabel, wall spec 9.6; `src/lib/labels.ts`): no row: "open"; `SKIPPED`: "skipped";
`NEEDS_SIGN`, `VETOED`, `DROPPED`: "pending"; `PENDING`: "pending" before `finalAt`, "final" from it; `FINAL`:
"final"; `CARRIED`: "carried"; `CARRIED_UNVERIFIED`: "carried, unverified" (a carried day whose record was dropped or
vetoed).

## What lags, and what is live only

- **Finality and the month turn.** No event fires when a record becomes final or a month begins. A clock runs every
  200 blocks (about a minute) and moves `PENDING` days past `finalAt` to `FINAL` and each forward curve to its current
  month. Envio's block handlers carry no timestamp, so the clock uses the newest event time at or before its block: it
  is never early, and it waits while the indexed contracts are silent. `finalAt` always gives the exact second, so the
  app should label from `finalAt` against its own clock rather than wait for `FINAL`.
- **k and sum** are the last days applied on chain. The index can be ahead by days nobody has synced; live claimable
  is `series.claimable(id)` (or MS 4.5's formula on `previewSync()`).
- **The book** is best effort from events. The authoritative live book is the market's `getL2Book()`; Kuru's AMM
  vault has no orders here, so its fills appear as trades only.
- **Kuru margin balances** move on fills and cancels without any event: read `getBalance` live.
- After an attester's select (`RecordReplaced`), `value`, `source`, `digest` and `finalAt` are the new record's; its
  `status`, `fresh`, `held`, `needsSign`, `late` and `incomplete` are not in the event and stay the old record's: when
  `replaced` is true, the History view reads `record()` for them (audit L-2).
- Envio Cloud has no aggregate queries, so counts, supplies, ledgers and candles are stored by the handlers.

## Queries

Each of these runs in `test/graphql.test.ts` against the local replay (with a few index days added), checked field by
field against `schema.graphql`.

```graphql
# the forward curve of one GPU ("the market's own" prices, two points)
query Forward($gpu: String!, $factory: String!) {
  MarketForward(where: {gpuId: {_eq: $gpu}, factory_id: {_eq: $factory}}) {
    label currentMonth nearMarkU nextMarkU
    points(order_by: {month: asc}) { month monthLabel markU markSource bestBidU bestAskU lastTradePriceU series { symbol endTs floor cap } }
  }
}
# a wallet's holdings and positions
query Me($a: String!) {
  TokenBalance(where: {account_id: {_eq: $a}, balance: {_gt: "0"}}) { balance series { symbol floor cap k sum n pricePoint { markU } } }
  ShortBalance(where: {account_id: {_eq: $a}, balance: {_gt: "0"}}) { balance series { symbol cap } }
  Position(where: {_or: [{owner_id: {_eq: $a}}, {payee_id: {_eq: $a}}], status: {_eq: "OPEN"}}) {
    positionId side q paid daily payee_id operator_id series { id symbol k sum n floor cap } }
  RouterFlow(where: {user_id: {_eq: $a}}, order_by: {block: desc}, limit: 50) { flow tokens dollarsIn dollarsOut refund net positionIds txHash timestamp }
}
# 30 index days of one GPU with their labels
query History($index: String!, $gpu: String!) {
  DailyFix(where: {index_id: {_eq: $index}, gpuId: {_eq: $gpu}}, order_by: {day: desc}, limit: 30) {
    day date value status state finalAt vetoed dropped }
}
# one month's candles and recent trades
query Chart($series: String!) {
  DailyCandle(where: {series_id: {_eq: $series}}, order_by: {dayId: asc}) { dayId open high low close volumeTokens vwapU }
  Trade(where: {series_id: {_eq: $series}}, order_by: {block: desc}, limit: 20) { priceU tokens takerIsBuy txOrigin timestamp }
}
```

Addresses and gpuIds are lowercase in every filter. BigInt filters take strings (`"0"`).

## Schema changes from the spec

None: `schema.graphql` is BOTS-SPEC Appendix B verbatim (a test compares them while the spec is on disk); Envio's
codegen accepted every construct.

## Tests

`test/*.test.ts` with Envio's `createTestIndexer` (no Docker, no database): every handler with simulated events that are
real ABI encodings (`test/ev.ts`: viem encodes each event from `abis/`, decodes it back, and hands it to `simulate`
with its address, block and log index); ABI and config drift; the clock through Envio's block handler; the local replay
of a scripted month on anvil (`test/fixtures/local-lifecycle.json`), compared with the chain's views at the last block;
the README queries. `test/fork/` is the fork replay: the market fork e2e
(`wall/e2e/scripts/market-fork.ts`, an anvil-safe fork of Monad testnet with the real AgateIndex, Kuru V1's real books
and both bots) writes `test/fork/fixtures/fork-lifecycle.json` (every raw log of the run plus the chain's views at its
last block) and `fork-deployments.json`, then runs `bun run test/fork/run.ts`. That script copies this folder into a
scratch dir, renders `config.yaml` and `src/lib/deployments.generated.ts` there from the fork's deployments (nothing
here changes), and runs `vitest run test/fork` with `AGATE_FORK_REPLAY=1`: series state, token, short and dollar
balances, positions and payouts, every daily fix of the index, every Kuru order, each book's levels and the price
points must equal the chain. A plain `bun run test` skips it.
