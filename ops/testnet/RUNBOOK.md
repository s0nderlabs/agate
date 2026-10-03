# Monad testnet deploy: runbook

What the operator runs to put the index, the market and their processes on Monad testnet (chain 10143), and to run
a demo session. Every script lives in `ops/testnet/`, runs from the repo root, and takes `--dry-run`: it then prints
each command it would run and sends nothing, reads no Keychain item, writes no file and opens no tmux window.
Everything below was run first on a local fork of Monad testnet (`ops/testnet/rehearse.sh`, last section); the
numbers are from there unless marked as Monad's own.

## The whole sequence

Run each line with `--dry-run` first and read what it prints (`gas-headroom.ts` only reads, so it has none).

```
ops/testnet/fund.sh --send                       # top-ups from agate.deployer (read the plan without --send first)
ops/testnet/deploy-index.sh testnet-production   # the real-calendar index (owner key)
ops/testnet/deploy-market.sh production          # tUSD, the maker's float, the real factory (deployer key)
ops/testnet/up.sh production                     # the processes, in the dev session
ops/testnet/status.sh production                 # read-only status, any time
ops/testnet/demo-session.sh start --hours 5      # a demo session, any time after the market
bun run ops/testnet/gas-headroom.ts              # read only: the bots' gas against their caps, after the first listing
ops/testnet/demo-session.sh stop
ops/testnet/down.sh production                   # every window off
ops/testnet/indexer.sh stop                      # the indexer's containers and database off
```

Afterwards these files hold the public record of the deploy and belong in the repo: `contracts/deployments/
10143-indexes.json` (the indexes, their deploy blocks and firstDay), `contracts/deployments/10143.json` (the market),
`contracts/deployments/10143-demo-history.json` (earlier demo factories), and `contracts/script/config/
testnet-production.json` with the firstDay the deploy wrote.

## How keys and URLs are handled

- A signing step reads its key from the macOS Keychain inline, into the environment of that one command:
  `AGATE_OWNER_KEY="$(security find-generic-password -s agate.wall.owner -a private-key -w)" forge script ...`.
  A missing item or a value that is not a 0x-prefixed 32-byte key stops the script before anything is sent. No key is
  ever printed, written to a file, or put on a command line. Never run the scripts with `bash -x`: the signing helper
  turns tracing off around the key, but nothing else in a traced run is meant for a log.
- forge and the send helper (`send.ts`) always use the key-free public RPC, `https://testnet-rpc.monad.xyz`.
- The long-running processes get key commands (`security find-generic-password ... -w`), never keys, and the RPC list
  as a command, `AGATE_RPC_URLS_CMD`: Alchemy's URL with its key from the Keychain (`agate.alchemy-api-key`, account
  `api-key`) first, the public RPC second, Alchemy's websocket third. Each process runs it once at start and keeps the
  URLs in memory.
- Each tmux window runs a launcher in `~/.agate-kit/run/<window>.sh` with a clean environment (`env -i` and a short
  allowlist); the launchers hold no key and no URL. Output goes to `~/.agate-kit/logs/<window>.log` from its first
  line (the window opens idle, its log pipe is attached, then the launcher starts in it).

Keys and their roles: `agate.wall.owner` deploys the indexes (and later queues owner actions);
`agate.deployer` deploys the market, holds the dollar's minter and the market admin roles, and tops up the other keys;
`agate.wall.primary` and `agate.wall.standby` are writer slots 0 and 1; `agate.wall.attester` countersigns;
`agate.wall.keeper` carries days nobody closed; `agate.market.bot` is the market maker; `agate.market.payer` lists each
month's series and pays daily positions. `agate.wall.guardian` and `agate.wall.kick` are only for the guardian CLI.

## Before the first deploy

1. The watcher logger runs (window `wall-log` of the dev session, PRODUCTION profile, log dir
   `~/.agate-wall/watcher/production-0`). It must have run since before the index's first day began.
2. Tools: `forge`, `cast`, `bun`, `jq`, `tmux`; `cd wall && bun install`; `cd indexer && bun install`. The primary
   writer needs the CRE CLI logged in (`~/.cre/bin/cre`, `cre login`); without the login it posts directly.
3. The indexer needs Podman (or Docker) for Postgres and Hasura: `podman machine start`.
4. The first forge run compiles the contracts into `~/.agate-build/testnet-kit/out` (about 4 minutes once).
5. The plan's MON: `ops/testnet/fund.sh` prints every key's balance, what the plan needs and the top-ups. Read it,
   then send the top-ups (one plain transfer per key from the deployer, never under its reserve):

   ```
   ops/testnet/fund.sh --days 12 --sessions 2 --hours 5            # read only
   ops/testnet/fund.sh --days 12 --sessions 2 --hours 5 --send     # the top-ups, signed by agate.deployer
   ```

   Worked when: one JSON line per transfer with `"status":"success"`, then `"done":<n>`. A second run prints
   "every key already holds its plan: nothing to send". With the balances of Oct 3 the default plan tops up the
   primary (+44 MON) and the payer (+45 MON) and leaves the deployer about 1,230 MON.

## The real deploy

### 1. The real-calendar index

```
ops/testnet/deploy-index.sh testnet-production
```

It writes `firstDay` (the UTC day after the deploy) into `contracts/script/config/testnet-production.json`, runs a
read-only simulation (predicted address, gas), records the address as pending in
`contracts/deployments/10143-indexes.json` with the current block (`pendingBlock`), broadcasts `DeployIndex.s.sol`
with the owner key, records the address and the block it was created in (from the creation transaction's receipt),
then checks by eth_call: code, clocks, every role, the CRE simulation forwarder in TX_ORIGIN mode, and each of the six
GPUs' recipeHash, slot count and firstDay against `wall/packages/sources/panels/launch.json`.

- When: any time except the 15 minutes before 00:00 UTC (it refuses then: the deploy could land on the other side
  of midnight). firstDay is the next UTC day either way; `up.sh` holds the writers until 10 minutes before it.
- Worked when it prints `created in block <n> (the creation transaction's receipt)` and ends with
  `index testnet-production at 0x...: every check passed` and `firstDay <n> = <date>`. If the owner has sent nothing
  before, the index lands at `0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36` (the fork and a read-only forge simulation
  against the public RPC both predict it).
- Cost: 11 transactions (four libraries by CREATE2, the index, six registerGpu), gas limits 24,222,740: 2.47 MON at
  102 gwei. Monad's own eth_estimateGas of each of them (the creates as they are; the six registerGpu with the fork's
  index passed as a state override) is 0.89 to 1.019 times the fork's gas used, inside forge's 1.3x margin.

### 2. The market (test dollar, the maker's float, the real factory)

```
ops/testnet/deploy-market.sh production
```

It writes `contracts/script/config/market-kit-production.json`, a copy of `market-testnet.json` with the recorded
index in the `real` factory and the demo entry disabled (the committed `market-testnet.json` stays as it is: a wall
test pins its bytes; the copy is removed after the run), simulates, broadcasts `DeployMarket.s.sol` with the deployer
key, then runs `DeployMarket --sig 'verify()'`, which writes `contracts/deployments/10143.json` only once every
address has code. That file, with `10143-indexes.json`, is the record of what is deployed.

- Worked when it prints the deployments JSON and `factory real 0x...: index 0x..., router 0x..., GPUs 3`, then
  `market production deployed and verified`. A run that finds everything already deployed prints `nothing sent`.
- Expected and harmless: forge's output of the simulation and the broadcast (in
  `~/.agate-kit/logs/deploy-market-*.log`, and in the last lines the script shows when a step fails) holds
  ``Error: `Unknown0` is above the contract size limit (33136 > 24576).`` (or `Unknown1`) for the 33 KB AgateFactory.
  That is Ethereum's 24 KB limit; `contracts/foundry.toml` sets `code_size_limit` to 131072 and Monad allows 128 KB,
  so the factory deploys. The line comes back in every market deploy, a demo session's too. It is not why a step
  failed.
- Also harmless, from the second demo session on: `WARNING bot float below botFloat.amount (not topped up by a rerun)`
  (the maker has spent some of its float; a rerun never mints more).
- Cost: 3 transactions (dollar, float mint of 10,000,000 tUSD to `agate.market.bot`, factory with its router), gas
  limits 13,634,269: 1.39 MON. Monad's own estimates (the mint and the factory with the fork's state as override) are
  0.94 to 1.01 times the fork's gas used.

### 3. The processes

```
ops/testnet/up.sh production
```

Opens, in the dev session `agate-dev`: `prod-primary` (CRE writer), `prod-standby`, `prod-attest`,
`prod-keep`, `prod-pagecheck`, the shared windows `shared-maker`, `shared-payer`, `shared-indexer`, `shared-repair`,
`shared-akash` and `shared-awake` (`caffeinate -i -s`), then `prod-health` 30 seconds later, so the roles it watches
have written a first heartbeat. It never touches `bun` or `wall-log`. It checks first that every Keychain item the
windows will read exists (attributes only), and warns when the logger's heartbeat is missing or more than 2 hours old.
`shared-maker` and `shared-payer` get `AGATE_MARKET_GAS_LIMITS` from `ops/testnet/market-gas-limits.json` (see "The
market bots' gas limits on Monad" below); up.sh checks the file with the bots' own parser first and prints it
(`market bots' gas limits (AGATE_MARKET_GAS_LIMITS, from market-gas-limits.json): {"series.mint":200000,...}`).
It refuses to start while `AGATE_MARKET_GAS_LIMITS` is set in the shell, so the file is the only source.

The production writers start 10 minutes before firstDay begins (health 9 minutes before): their windows open at once
and print `prod-primary waits until <time> UTC (10 minutes before firstDay)` (`prod-health ... (9 minutes before
firstDay)`), the first line of each window's log. A reading of an earlier day is skipped by the index and still billed
(the rehearsal saw it: 0.165 MON on the primary for one slice), so nothing is posted before the index can use it.

Worked when each window's log starts with a `"event":"start"` line naming the index, the six GPUs and the RPC URLs
(redacted) (the three waiting windows: with their wait line, then that), the writers (from firstDay minus 10 minutes)
print `skip` or `read` lines (a writer started mid-slice skips that slice by design), the maker prints `started` with
factories `["real"]` (`["demo","real"]` during a session) and `"gasLimits":"AGATE_MARKET_GAS_LIMITS"`, the payer a
`start` line with the same `gasLimits` and a `tick` every 5 minutes, and the indexer `Chain: 10143 100%` with GraphQL
at `http://localhost:8080/v1/graphql`. A role that has not written its first heartbeat yet can still raise a
HEARTBEAT_LOST in health's first minutes; it clears once the heartbeat appears (the Akash reader's first one can take a
few minutes).

### 4. What follows on its own

- firstDay ends at 00:00 UTC; the primary closes it after CLOSE_GRACE (01:00 UTC). A first record always needs the
  attester's countersign; the attester signs once the watcher's log agrees. Then the payer's lister lists November
  for H100, H200 and B200 (SEEDED from that first record) and creates each Kuru V1 market, and the maker mints, deposits
  and quotes three levels each side. December lists on Nov 1 (RULE: the five final days before it). Measured on the
  fork: `list` 4,272,372 to 4,357,005 gas limit (0.44 MON), `createMarket` 1,522,835 (0.16 MON); on Monad the payer
  sends 1.2 x Monad's estimate, about 4,352,700 for a SEEDED `list` and 1,540,500 for `createMarket`.
- Checks, any time (read only, no key): `ops/testnet/status.sh production` (or `demo`) runs the guardian CLI's
  status (each GPU's head and last final fixes, the writers' balances, queued owner actions, the page check, every
  heartbeat with its age, the open alerts), the maker's and the payer's status, and lists the kit's open windows.
  Healthy: every heartbeat a few seconds to one tick old, `oldest day without a final record` no older than LAG_MAX,
  the maker's books at 6 orders each.
- On the first cold report and close on testnet, take Monad's numbers for wall spec 18.6 item 1 (the receipts'
  gasUsed and `eth_estimateGas` of the same calls).
- The market's FIX_CALL_GAS check (market spec 10.4 step 2) passes on Monad's own gas: `eth_estimateGas` of `finalFix`
  on a final record (Monad's public RPC, the fork's index state passed as a state override, Oct 3, n = 1) is 31,369 gas
  in all, about 10,000 of it execution; three times that, about 30,000, is well under FIX_CALL_GAS 100,000. Once the
  real index has its first final record, the same call against it confirms it (read only):
  `cast estimate <index> 'finalFix(bytes32,uint32)' <gpuId> <firstDay> --rpc-url https://testnet-rpc.monad.xyz`.
- After the first listing and the maker's first quotes, run `bun run ops/testnet/gas-headroom.ts` (next section).

### 5. The indexer and the app

`shared-indexer` runs `ops/testnet/indexer.sh run`: it copies `indexer/` into `~/.agate-kit/indexer` (the repo's
committed `config.yaml` and `src/lib/deployments.generated.ts` never change), renders `config.yaml` there from
`contracts/deployments/10143.json` with RPC sync and each index's deploy block (`--index-start real=<block>
demo=<block>`), and starts `envio dev` (Postgres and Hasura in Podman). The RPC URL is the first http(s) entry that
`AGATE_RPC_URLS_CMD` prints (Alchemy), read at start into `ENVIO_RPC_URL` of the envio process only, never into a
file; no `ENVIO_API_TOKEN` is needed. A new deployments file (a demo session) restarts indexing from scratch.

GraphQL is served at `http://localhost:8080/v1/graphql` (Hasura; reads need no secret, the admin secret of
`envio dev` is `testing`). The app reads it from `NEXT_PUBLIC_AGATE_GRAPHQL_URL` (agreed with the app's work Oct 4),
default `http://localhost:8080/v1/graphql`. It is a public variable baked in at build time: a hosted build needs it
set to the hosted Envio endpoint before building. The contract addresses come from
`contracts/deployments/10143.json`. The hosted service (HyperSync) needs the committed pair regenerated from
`10143.json` with both `--index-start` blocks first (`indexer/README.md`, testnet deploy checklist).

## The market bots' gas limits on Monad

The maker and the payer set each transaction's gas limit to 1.2 times the chain's own `eth_estimateGas`, and refuse
to send (GAS_CAP, an action alert) when that is above the call's cap, 1.5 x (LIMIT + 21,000 + calldata gas), where
LIMIT comes from a table measured with Foundry at Ethereum's prices (`wall/packages/market/src/limits.ts`). Monad
prices storage differently: a cold slot costs about 6,100 gas more than on Ethereum, while neighbours of a touched slot
cost almost nothing. So the table is overridden by `ops/testnet/market-gas-limits.json`, which up.sh hands to
`shared-maker` and `shared-payer` as `AGATE_MARKET_GAS_LIMITS`.

Every value in it is set so that Monad's own estimate of the call fits with 1.25 headroom (cap / (1.2 x estimate)).
Monad's estimates were taken read only on the public RPC, with the fork's state of the contracts each call touched
passed as a state override: every transaction the bots sent in a fork session on Oct 3 UTC (80 of them) replayed one by
one at the block before it, plus a redeem probe. With the shipped table:

| Call (sends) | Monad | anvil | Ratio | Shipped table | The file |
|---|---|---|---|---|---|
| series.mint, the maker's first of a series (6) | 217,659 | 163,585 | 1.33 | **refused** (cap 245,412, wants 261,191) | `200000`: 1.27 |
| series.mint, a later one (2) | 147,952 | 94,914 | 1.56 | fits | 1.87 |
| series.redeem (probe) | 121,781 | 74,583 | 1.63 | **refused** (cap 111,875, wants 146,138) | `110000`: 1.35 |
| series.settle | not measurable before a month ends | | | refused if priced like redeem (cap 96,126) | c 0 `105000`: 1.30 at redeem's price |
| series.sync(1) (4) | 164,558 | 156,453 | 1.05 | fits, 1.19 | c 1 `144000`: 1.25 |
| series.sync(2) (the Oct 3 check) | 188,246 | 171,330 | 1.10 | fits, 1.13 | c 2 `168000`: 1.26 |
| series.claimMany, 2 fresh payees (4) | 104,911 to 121,979 | 74,570 to 91,670 | 1.33 to 1.41 | fits, 1.29 | (table) |
| factory.list, SEEDED (6) | 3,627,233 | 3,561,206 | 1.02 | fits, 1.25 | `3800000`: 1.32 |
| factory.createMarket (6) | 1,283,747 | 1,269,029 | 1.01 | fits, 1.24 | `1300000`: 1.29 |
| erc20.approve (13) | 52,915 | 46,338 | 1.14 | fits, 2.8 (provisional ceiling) | (table) |
| kuru.deposit (8) | 141,492 | 89,417 | 1.58 to 1.73 | fits, 2.6 (provisional ceiling) | (table) |
| kuru.batchUpdate, 6 adds, 0 to 6 cancels (20) | 1,136,938 | 903,067 | 1.20 to 1.27 | fits, 3.0 to 4.0 (provisional ceiling) | (table) |
| finalFix (the index, read by every sync) | 31,369 | 29,042 | 1.08 | 10.4 step 2 passes | |

Not measured on Monad: `settle` (a series must reach its last day), a RULE listing (December on the real factory; on
the fork it used 70,000 gas more than a SEEDED one: at SEEDED's measured 1.02 the file leaves it 1.29 headroom, and
1.25 up to 1.05 times the fork), `withdraw`. The settle rows are set from the closest measured calls (c 0 from the
redeem, which also burns one side and pays dollars; c 1 and up from sync), and the sync rows above c 2 follow Monad's
measured slope (about 23,700 gas a day against the table's 13,000). The bots answer a sync or a settle over its cap by
smaller calls anyway (a `gas_cap_split` log line, not an alert), so a row set too low costs only transactions. A cap
only refuses: Monad bills the limit the bot sets, 1.2 x the estimate, so a higher LIMIT never raises the bill.

After the first listing and the maker's first quotes on testnet (and again after the first demo session's), check
every shape the bots have sent:

```
bun run ops/testnet/gas-headroom.ts
```

It reads the bots' `sent` lines from `~/.agate-kit/logs/shared-{maker,payer}.log`, each transaction and receipt from
the public RPC (read only, no key), and prints per shape the closest send: its gas limit (1.2 x Monad's estimate), the
cap, the headroom (cap / gas limit) and, under 1.25, the LIMIT that restores 1.25. Then every refusal the logs and
`~/.agate-wall/alerts/alerts.jsonl` hold (GAS_CAP alerts, `gas_cap_split` lines) with the LIMIT it needed. `--since
<unix time>` reads only what came after a change. To act on it:

1. Put the printed LIMIT in `ops/testnet/market-gas-limits.json`: a number for `series.mint`, `series.redeem`,
   `factory.list` or `factory.createMarket`; for `series.sync` a `{"<c>": LIMIT}` object, which replaces the whole
   sync row, so copy the table's other points with it (`limits.ts`: c 0: 3,590; 1: 135,249; 5: 187,235; 30: 496,353;
   31: 508,719) and raise each by the same factor. For the shapes marked "raise by hand": `claimMany` and `settle`
   split themselves on GAS_CAP (halved batches, smaller syncs), so only a refusal of the smallest call matters; raise
   their rows the same way (`{"<c>": LIMIT}`, for claimMany the 8-id row, from `limits.ts`). The Kuru calls (approve,
   deposit, withdraw, batchUpdate) run on generous provisional ceilings; a number for one of them replaces its ceiling
   with a measured LIMIT (batchUpdate's then no longer grows with the orders it carries: leave it unless refused).
2. `ops/testnet/up.sh production --restart-shared` (up.sh checks the file before it closes anything).
3. Run `gas-headroom.ts --since <the restart's unix time>` once the bots have sent again.

## A demo session

```
ops/testnet/demo-session.sh start --hours 5
...
ops/testnet/demo-session.sh stop
```

`start` prints what the session will spend, then deploys a fresh demo-clock index (`testnet-demo`: a 600-second day,
day 1 = 2026-11-01 begins at the deploy block), a demo factory on it (`deploy-market.sh demo`: the previous session's
demo factory moves out of `10143.json` into `10143-demo-history.json`; the dollar and the real factory are reused),
and opens `demo-replay` (the replay server on port 8787), `demo-log`, `demo-primary`, `demo-standby`, `demo-attest`,
`demo-keep`, `demo-pagecheck`, `demo-health`, restarting the shared windows so the maker, the payer, the indexer and
the repair agent take the new factory and index. A start cut off halfway resumes when run again (an active session's
index is reused). `stop` closes the demo windows and marks the session stopped; the next start deploys a fresh
index.

The maker keeps the stopped session's books and winds them down at each demo month's end (5 and 10 hours after the
session began); a new session started before then replaces the demo factory in the deployments file, and the old
books are left resting (Kuru orders never expire). To cancel them first, use the maker's kill switch, wait a minute
(one maker tick), start the session, then lift it:

```
(cd wall && AGATE_WALL_HOME=~/.agate-wall bun run apps/marketmaker/src/main.ts kill "new demo session")
ops/testnet/demo-session.sh start --hours 5
(cd wall && AGATE_WALL_HOME=~/.agate-wall bun run apps/marketmaker/src/main.ts unkill)
```

What a session shows (the fork rehearsals, one-second blocks, the real clock; the last one, Oct 3 UTC, ran 47 minutes):
both writers post every slice for all six GPUs (the primary through `cre workflow simulate --broadcast` and the
simulation forwarder, the standby directly), 114 readings each by the end; the first demo day closes about 2.5 minutes
after it ends and the attester countersigns every first record about 2 minutes later; within 2 minutes of that the
payer lists November and December for H100, H200 and B200 on the demo factory (SEEDED) with their Kuru V1 markets, and
the maker approves, mints, deposits and quotes all six books (6 orders each); trades through the router fill against
those quotes, and the payer syncs and pays daily positions after each final day; the indexer serves the series
(`dH100-NOV26` and so on, with band grade, floor and cap), the six markets, both indexes and their twelve GPUs, the
daily fixes, the book, positions, claims, trades, router flows and the forward curve. Four demo days (20758 to 20761)
closed, final and countersigned where needed in 47 minutes, every transaction succeeded, no process restarted.

Alerts to expect on a demo: PAGECHECK_REVIEW (info) for Nebius in the first demo days (the replay starts at the
archive's first hours, where GPUTable already listed Nebius's Oct 1 prices); R10_SPLIT_STEP (action) when one cloud's
archived price change moves a median (the designed check; five in 47 minutes); R1_SIGNED and R1_SELECTED (info) for
each countersign and selection.

MON per real hour of a session at 102 gwei (the gas limits the fork's transactions carried; three runs of 37 to 47
minutes, the last with two users trading): primary 5.21 to 5.79, standby 3.68 to 3.96, maker 4.11 to 5.13, payer 4.69
to 5.91 in its first hour (3.5 of it the six listings and markets), keeper 0.55 to 0.74, attester 0.23 to 0.33: about
19 to 20 an hour on the fork, plus about 2 to start a session (index 0.75, factory 1.26). On Monad the bots' share runs
higher (their limits follow Monad's estimates: "The market bots' gas limits on Monad"), so `demo-session.sh start`
prints its estimate with the bots' figures x 1.5.

## Stopping

```
ops/testnet/down.sh demo                      # the demo stack (the shared windows stay while production runs)
ops/testnet/down.sh production                # the production stack, and the shared ones once no demo runs
ops/testnet/down.sh production --cancel-books # first the maker's kill switch: every resting Kuru order cancelled
```

The maker has one kill switch for every factory, so `--cancel-books` is refused while the other stack still runs
(cancelling a demo session's books would cancel and freeze production's too): stop the demo stack first, then
`down.sh production --cancel-books`.

Each window is found by its exact name and closed one at a time: Ctrl-C (the process stops between ticks and releases
its lock), up to 20 seconds, then the window. The indexer's Postgres and Hasura containers outlive its window, so a
restart resumes indexing where it stopped; `ops/testnet/indexer.sh stop` removes them and their database (the next
start indexes again from the deploy blocks). After `--cancel-books` the maker stays killed until
`cd wall && AGATE_WALL_HOME=~/.agate-wall bun run apps/marketmaker/src/main.ts unkill`. Kuru orders never expire: a
maker stopped without `--cancel-books` leaves its ladder resting until it runs again.

## A half-done deploy

Every step can be run again; none sends what has already landed.

- `deploy-index.sh`: an index recorded with code is never deployed again. If the broadcast stopped after the index
  landed, the next run records it, finds the GPUs that are missing and registers each one (`send.ts call registerGpu`,
  owner key), then checks again. If the index itself never landed, the next run deploys it.
  The deploy block it records feeds the watchers' `AGATE_FROM_BLOCK` and the indexer's `--index-start`, so it is never
  later than the real one: first the creation transaction's receipt (saved by forge in
  `~/.agate-kit/broadcast/DeployIndex.s.sol/10143/run-*.json`, or read from the chain by the transaction hash forge
  saved), printed as `created in block <n> (the creation transaction's receipt)`; without one, the `pendingBlock`
  recorded just before the broadcast (the index was created after it, so a scan from there misses none of its
  events), printed as a WARNING. With neither, it stops and records nothing: find the block of the owner's transaction
  that created the index, write it as `deployBlock` (status `deployed`) into `10143-indexes.json`, and run it again.
- `deploy-market.sh`: DeployMarket reuses every address that landed (dollar, float, factory); `verify()` refuses until
  every address has code, and the next run broadcasts only what is missing (`nothing sent` when nothing is).
- `fund.sh --send`: tops up only the shortfall that is left.
- `up.sh`: opens only the windows that are not open; `--restart-shared` restarts the shared ones. A window left idle
  by a failed start (up.sh says so) closes with `down.sh` like any other.

## The MON plan

`fund.sh` uses these (102 gwei, gas limits): the real-calendar index 4.53 MON a day on the primary, 3.65 on the
standby, up to 0.06 on the attester and 0.30 on the keeper (wall/README.md); a demo session, per real hour, up to 7.42
on the primary (the shipped limits; 5.79 measured), 4.00 on the standby (3.96 measured), up to 0.39 on the attester
and 1.83 on the keeper, up to 5.2 on the maker, and the payer 4.0 a session plus 0.5 an hour; the deploys 3.0, 1.0,
2.0 and 1.5 MON (measured 2.47, 0.75, 1.39, 1.26). Every sending key keeps 10 MON, the payer stays over its 60 MON
alert.

The bots' figures are the fork's, and Monad prices their calls higher: each bot sets its limit from the chain's own
estimate, and Monad's estimates run 1.0 to 1.7 times anvil's by call (the table in "The market bots' gas limits on
Monad": mint 1.32 and 1.66, approve 1.24, sync 1.05 to 1.10, createMarket 1.01). So `fund.sh` and `demo-session.sh`
multiply the maker's and the payer's figures by 1.5 (`AGATE_KIT_BOT_FACTOR`). The writers are not affected: their
limits come from the wall's measured worst case and the CRE path's fixed limit, not from an estimate. The finalFix
check of market spec 10.4 step 2 passed on Monad's gas (section 4 above).

The default plan (12 days, two 5-hour sessions) needs about 89 MON of top-ups (primary 44, payer 45) and leaves the
deployer about 1,230 of its 1,324; the maker needs about 110 of its 200 even at 1.5 times its fork rate.

Run longer or more sessions and the primary is the key to watch: `fund.sh --days 12 --sessions 6 --hours 5` tops it
up to about 290 MON. `watcher health` raises KEY_LOW for any key holding less than 24 hours of its own recent spend.

## Gas per call (fork receipts, and Monad's own estimates)

Monad's column is its eth_estimateGas, read only: of the deploy transactions as they are where testnet can run them,
and with the fork's state passed as a state override where they need contracts testnet does not have yet. forge sends
1.3 x anvil's estimate; the bots send 1.2 x the chain's own, so on Monad they send 1.2 x the Monad column.

| Call | Gas limit sent (fork) | MON at 102 gwei | Gas used on the fork | Monad's estimate |
|---|---|---|---|---|
| production index deploy, 11 transactions | 24,222,740 | 2.47 | 17,540,651 | 0.89 to 1.019 x the fork's gas used, per transaction |
| demo index deploy, 7 transactions | 7,379,290 | 0.75 | 5,554,747 | (the same transactions) |
| market deploy: dollar, float, real factory | 13,634,269 | 1.39 | 10,483,636 | 980,675 / 63,867 / 9,539,357 |
| demo factory | 12,305,213 | 1.26 | 9,465,549 | (as the real factory) |
| registerGpu (recovery) | 395,182 to 459,781 | 0.04 to 0.05 | 299,895 to 348,837 | 267,718 to 311,510 |
| MON transfer | 21,000 | 0.002 | 21,000 | 21,000 |
| `list` November / December | 4,272,372 / 4,357,005 | 0.44 | 3,557,879 / 3,628,406 | 3,627,233 (SEEDED; RULE not yet estimable) |
| `createMarket` (Kuru V1) | 1,522,835 | 0.16 | 1,258,936 | 1,283,747 |

The maker's and the payer's other calls: "The market bots' gas limits on Monad".

## The rehearsal

```
ops/testnet/rehearse.sh deploy            # about 10 minutes
ops/testnet/rehearse.sh session 40        # about 50 minutes; Podman running for the indexer
```

Both start their own anvil fork through `wall/scripts/anvil-safe.sh` (refused under 30 GB free), never read a key,
run their processes in a private tmux server (`tmux -L agate-rehearsal`), and stop everything when they exit (the
indexer's containers too, through `indexer.sh stop --fork`). `deploy`
runs the real configs with the real addresses impersonated: both indexes, both factories, the top-ups, index days
written as the real writers while the fork's clock runs forward, and the payer's lister listing November and December
with Kuru V1 markets. `session` runs a demo session's processes; because a process signs its own transactions and no
key exists here for the real addresses, the roles that run as processes use public rehearsal keys
(`AGATE_KIT_ROLES=rehearsal`: keccak256 of "agate kit rehearsal <role>"), for the fork only. At its end `session`
checks that the maker and the payer started on `market-gas-limits.json` and that the waiting production windows' logs
start with their wait line, and fails otherwise.

Each script also takes `--fork` by itself. A run by hand needs:

- `AGATE_KIT_FORK_RPC=http://127.0.0.1:<port>`: an anvil fork of Monad testnet (any other URL, or a node that is not
  an anvil fork, is refused);
- `AGATE_KIT_TMUX_SOCKET=<name>` and `AGATE_KIT_TMUX_SESSION=<name>` for up.sh, down.sh, demo-session.sh and status.sh:
  a fork run refuses the default tmux server and the session `agate-dev`;
- `AGATE_KIT_STATE=<dir>` (default `~/.agate-kit-rehearsal`): logs, launchers, forge's broadcast files and the
  processes' data (never `~/.agate-wall`);
- with `AGATE_KIT_ROLES=rehearsal` (processes on the fork), the maker's float moved to the rehearsal maker once the
  market is deployed: DeployMarket mints it to the real `agate.market.bot`, which has no key on the fork. rehearse.sh
  does it like this (anvil only):

  ```
  DOL="$(jq -r .dollar contracts/deployments/fork-kit-10143.json)"
  cast rpc anvil_impersonateAccount 0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8 --rpc-url "$AGATE_KIT_FORK_RPC"
  cast send --unlocked --from 0xBFAa70A8b399097FACF4A84B98Da5B304587C8B8 "$DOL" 'transfer(address,uint256)' \
    0x9A410E49A53115E85b751fE8D3b589bb8F1a717F 10000000000000 --rpc-url "$AGATE_KIT_FORK_RPC"
  ```

Records go to `contracts/deployments/fork-kit-*` (gitignored), with `fork-kit-fork.json` naming the fork they belong
to (its port and fork block): a run against any other fork refuses them, so two fork runs never share records. Move
the `fork-kit-*` files out (rehearse.sh moves them into its state dir) before a run on a new fork.
