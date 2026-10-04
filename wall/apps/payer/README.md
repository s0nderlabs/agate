# @agate/payer: the daily payer and the lister

One process, one key (`agate.market.payer`), for every factory of the deployments file (docs/market/BOTS-SPEC.md 4).
Each tick, in chain time:

1. **Lister** (4.2): for each factory, GPU and month in {current, next}: `previewListing` (eth_call); when it
   answers, `list`, then `createMarket` on Kuru V1 (the pilot factory, with no Kuru router, lists only). `NotReady`
   waits (`LISTER_STUCK` once past the expected time; also a ready month whose `list` the day's budget keeps refusing
   past that time, recheck R1-H1), `MonthNotOpen` waits, `IndexStartsAfterMonth` is never asked
   again (`LISTER_INDEX_STARTS_AFTER`, info, once), any other revert is `LISTER_REFUSED` and retried hourly; a
   reverted `createMarket` simulation is `LISTER_MARKET_REFUSED`, retried hourly. Both calls are idempotent on chain.
   Only a receipt with a revert status counts as the chain's refusal: a send whose outcome is not known yet
   (`BROADCAST_UNCONFIRMED`, or `NONCE_STUCK` after every replacement, which the sender alerts itself) is retried at
   the next tick, whose views show whether it landed. A month or market inside its hour after a refusal is not owed
   (no spend can land it then: recheck R2-L2); a market refusal of a month that left the window clears (R2-L4).
2. **Payer** (4.3 to 4.5): after each index day becomes final, for each series with open positions: one
   `sync(kPrev - kState)`, then `claimMany` batches of at most 50 ids for the positions with `daily = true` and
   claimable >= $0.01, largest claimable first, as many as the day's MON budget pays. After the last day, the final
   sweep claims every position with claimable >= $0.01, or q >= 1 token and anything claimable; dust is left to its
   owner (claims never expire). The D1 hold (`PAYER_FORCE_HELD`) keeps our bot from forcing ANY day the call would
   apply that the wall has not closed, or closed and not yet final, nor any later day (day kPrev first) within an hour
   of its last resort, which the call's own sync would force if it crossed before landing; it is checked again right
   before each `claimMany` (audit P-H1, recheck R1-L1). A sync refused `GAS_CAP` is sent in chunks that fit; when
   not even `sync(1)` fits, `claimMany` carries the sync itself and `PAYER_SYNC_CAPPED` (action) asks for
   `AGATE_MARKET_GAS_LIMITS` (audit P-M1). While the lister owes anything (a month of its window not listed, for
   whatever reason, a ready month whose `list` the budget refused included; a listed series of a Kuru factory without
   its market; a factory whose pass failed), the claims leave one listing's cost to it, at least the gas the sender
   last planned for each send (audit P-L2, recheck R1-H1). When pacing is what cuts the claims, only whole batches go
   out: each series' next 50 ids (or all it has left), the batches in the order of their largest candidate, each as
   soon as it fits, as long as the day can still pay the first one, instead of paying each transaction's fixed gas for
   two ids (recheck R1-L2; per series since R2-L1, so the largest position no longer waits for every series at once).
   Each batch's simulated total is checked against the scanned positions (`PAYER_DRIFT`); a batch whose simulation
   reverts is bisected and the failing ids skipped until their payout changes (`PAYER_BAD_ID`); a claim that would pay
   0 is never sent.

Positions come from the payer's own log scan (4.1): `eth_getLogs` per 100 blocks up to the `finalized` block, through
the RPC pool (the key-free public RPCs since Oct 4: Alchemy takes only the payer's own transactions, as a `send:`
entry), kept only when the emitter is a known factory or a series one of them listed. A rate limit (a 429) fails over to
the next URL; a halved chunk grows back; a catch-up is paced at about 10 calls a second (audit P-M2). `cursor.json` and
`state.json` name their chain, start block and factory set: a cursor or state of another chain or deployment (a fork
rehearsal with the same `AGATE_WALL_HOME`, a testnet reset) restarts the scan from the start block into a fresh
`events.jsonl` and sets the old state aside (audit P-M3). FixApplied is not scanned (the payer never reads it), and a
large `events.jsonl` is compacted at start to the open positions' newest events (audit S-L1). A scan that starts over
while running (the chain's finalized tip far below the cursor: a reset) rebuilds the positions from the new events and
sets `state.json` aside the same way.

## Run

```
bun run src/main.ts run                 # the loop (default)
bun run src/main.ts status              # heartbeat, open alerts, budget day, state: files only, no key, no RPC
bun run src/main.ts list-once [--dry]   # one lister pass
bun run src/main.ts claim-once [--dry]  # one payer pass, after the scan has caught up
```

Environment: `AGATE_KEY_CMD` (run by the process itself at start; the key stays in its memory only and never in its
exec-time environment, which `ps -wwE` shows: audit M-K1; tests pass a throwaway key in `AGATE_PAYER_KEY` instead),
`AGATE_RPC_URLS_CMD` or `AGATE_RPC_URLS` (two or more URLs; never printed), `AGATE_CHAIN_ID`
(10143), `AGATE_DEPLOYMENTS` (a copy of `contracts/deployments/<chainId>.json`), `AGATE_PAYER_CONFIG`,
`AGATE_WALL_HOME` (default `~/.agate-wall`), `AGATE_NOTIFY_CMD`, `AGATE_MAX_FEE_GWEI` (default 200),
`AGATE_MARKET_GAS_LIMITS` (the LIMIT table override, JSON `{shape: limit}` or `{shape: {c: limit}}`),
`AGATE_MARKET_LOG_CHUNK`. `AGATE_DRY_RUN=1` simulates and estimates only and signs nothing; without a key it needs
`AGATE_PAYER_ADDRESS`. A dry run never ticks the MON budget: no `budget-<day>.json` (which a real start the same UTC
day would reload, frozen from the dry run's balance) and no `PAYER_KEY_LOW`.

Config (`AGATE_PAYER_CONFIG`, every field optional, an unknown field refused):

```json
{
  "factories": null,
  "lister": true, "payer": true,
  "claimThresholdU": 10000, "maxIdsPerCall": 50,
  "claimEveryDays": { "demo": 1, "real": 1, "pilot": 1 },
  "keepMon": 15, "lowBalanceMon": 60, "runUntil": "2026-12-02T00:00:00Z",
  "tickS": null, "logChunk": 100
}
```

`tickS: null` is `clamp(min DAY / 20, 10, 300)`: 30 s on the demo clock, 300 s on production. If MON runs short, set
`claimEveryDays.demo` to 6 (once a real hour). `runUntil` defaults to `2026-12-02T00:00:00Z`: through judging and the
November series' settle and final sweep (the real calendar's November settles Dec 1).

## Gas and MON

Every send follows MS 9.1 (`@agate/market` `sender.ts`): `eth_call` and `eth_estimateGas` at `latest`, gas limit
`ceil(1.2 x estimate)` under `CAP = 1.5 x (LIMIT + 21,000 + calldata gas)` (above it: not sent, `GAS_CAP`), fees
capped at `AGATE_MAX_FEE_GWEI`. Monad bills the gas limit, so the cost of a send is `gasLimit x effectiveGasPrice`.
A `GAS_CAP` alert is per bot, shape and target, and a call the payer answers with smaller ones (a halved `claimMany`,
a `sync` chunk above 1) is only logged (`gas_cap_split`): the alert means even the smallest call is over its cap. A
replacement transaction (a higher fee after 120 s unmined) asks the MON floor again before it is signed.

The budget (2.6): `B = (balance - keepMon) / days to runUntil` (7 days once it has passed), computed at the first
tick of each UTC day of chain time and kept in `budget-<day>.json`, paced hourly (by second s of the day the spend
may reach `B x (s + 3,600) / 86,400`); never below `keepMon`. The lister spends first. What the budget leaves waits
for the next day or for its owner's Claim button (`PAYER_BUDGET_SPENT`, info, once a day). `PAYER_KEY_LOW` under
`lowBalanceMon`.

**One deviation from BOTS-SPEC 2.4, measured.** The README table's `claimMany` (25,450 gas per id) was measured with
payees that already hold the dollar. A payee new to the dollar costs 17,100 more per id (a zero-to-nonzero balance
write). On a local anvil, `claimMany` of 50 ids to 50 fresh payees estimated 1,940,342 gas against the table's
1,291,570, so every batch was refused `GAS_CAP`. `limitFor("series.claimMany")` therefore counts every payee as new
(`FRESH_PAYEE_GAS`, `@agate/market` `limits.ts`), and a batch still over the cap is split in two until it fits. The testnet deploy's
Monad re-measurement should measure `claimMany` with fresh payees.

## Files

Under `$AGATE_WALL_HOME/market/payer/`: `payer.lock` (one process), `heartbeat.json`, `state.json` (lastClaimK and
sweepDone per series, skipped ids, the lister's never-list and retry times, and the identity of 4.6),
`budget-<YYYY-MM-DD>.json`, `events.jsonl` and `cursor.json` (the scan, with its identity); set-aside files are named
`state.stale-<ms>.json` and `events.stale-<ms>.jsonl`. Alerts go to the shared `alerts/alerts.jsonl`. Every file and line is
scrubbed of the RPC URLs; the key is never written or printed.

## The shared layer

`wall/packages/market` (`@agate/market`, BOTS-SPEC sections 1 and 2, Appendices A and C: types, Kuru ABI, constants,
the generated ABIs, deployments, math, limits, sender, reads, scanner, budget, runtime) is shared with the market
maker. Its unit tests live there (`wall/packages/market/test`). Regenerate the ABIs after a contracts change:

```
cd contracts && FOUNDRY_OUT=$HOME/.agate-build/payer/out FOUNDRY_CACHE_PATH=$HOME/.agate-build/payer/cache forge build src/market test/market/mocks/MockIndex.sol test/market/mocks/MockKuruRouter.sol test/market/mocks/MockKuruOrderBook.sol
cd wall/packages/market && AGATE_FORGE_OUT=$HOME/.agate-build/payer/out bun run gen:abi
```

## launchd

`launchd/xyz.s0nderlabs.agate-payer.plist.template` and `launchd/run-payer.sh`: written, never loaded. The job runs a
copy of `wall/` outside `~/Documents` (launchd jobs hang on files there), with a copy of the deployments file next to
it. No key and no URL in the plist: `AGATE_KEY_CMD` is
`security find-generic-password -s agate.market.payer -a private-key -w`, run by the process (the run script only
checks it is set). A front-run `list` or `createMarket` clears its `LISTER_REFUSED` / `LISTER_MARKET_REFUSED` as soon as
the slot is filled (audit P-L1). A websocket wake re-reads the nonce at `pending` but never below the local counter
(audit P-L3).

## Tests

```
bun test test/                 # unit tests, then the local-anvil tests (anvil-safe, skipped without anvil or the forge build)
bun run test:fork              # the fork test: an anvil-safe fork of Monad testnet (read only), the payer as a child process
```

The anvil tests deploy from a Foundry build (`AGATE_FORGE_OUT`, default `~/.agate-build/payer/out`, else
`contracts/out`), check `df -h /` first (30 GB floor) and stop their chain at the end.
