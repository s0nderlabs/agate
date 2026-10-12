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
  as a command, `AGATE_RPC_URLS_CMD`: the three public RPCs, rotated per window, and with `AGATE_KIT_ALCHEMY=light`
  (the default since Oct 4) Alchemy's URL with its key from the Keychain (`agate.alchemy-api-key`, account `api-key`)
  as a `send:` entry for the signing windows and Alchemy's websocket for the attester and the keeper ("Alchemy" below).
  Each process runs it once at start and keeps the URLs in memory.
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

Opens, in the dev session (`AGATE_KIT_DEV_SESSION`, else the first line of `~/.agate-kit/dev-session`, else
`agate-dev`): `prod-primary` (CRE writer), `prod-standby`, `prod-attest`,
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
demo=<block>`), and starts `envio dev` (Postgres and Hasura in Podman). Its RPCs are the three public ones that
`AGATE_RPC_URLS_CMD` prints, rotated for this window (never Alchemy, in any mode: its `eth_getLogs` were two thirds of
the Oct 4 spend, and indexer.sh leaves out an Alchemy URL it is given): the first is the sync RPC, the two others are
Envio fallbacks (`for: fallback`, used when the sync RPC stalls), read at start into `ENVIO_RPC_URL` and
`ENVIO_RPC_URL_FALLBACK_<n>` of the envio process only, never into a file; no `ENVIO_API_TOKEN` is needed. A new
deployments file (a demo session) restarts indexing from scratch, and so does the first run after Oct 4's change
(its config.yaml gained the fallback entries).

GraphQL is served at `http://localhost:8080/v1/graphql` (Hasura; reads need no secret, the admin secret of
`envio dev` is `testing`). The app reads it from `NEXT_PUBLIC_AGATE_GRAPHQL_URL` (agreed with the app's work Oct 4),
default `http://localhost:8080/v1/graphql`. It is a public variable baked in at build time: a hosted build needs it
set to the hosted Envio endpoint before building. The contract addresses come from
`contracts/deployments/10143.json`. The hosted indexer on Envio Cloud (HyperSync) runs its own committed pair,
`indexer/config.testnet.yaml` and `indexer/src/lib/deployments.testnet.generated.ts`: after any deploy that changes
`10143.json` or `10143-indexes.json` (a new factory, a demo session's new index), run `cd indexer && bun run
gen:testnet` and commit, and Envio Cloud redeploys from main (`indexer/README.md`, "The hosted indexer").

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

## Alchemy (since Oct 4)

On the morning of Oct 4 every process used Alchemy first and spent 11.3M compute units in about 7 hours (eth_getLogs
67%, eth_call 16%, eth_getBlockByNumber 11%, eth_blockNumber 5%, transactions about 0%) until the $5 spending limit cut
all of them off. Since then the kit gives Alchemy only to the light roles. `AGATE_KIT_ALCHEMY` picks the mode for
`up.sh`, `status.sh` and `demo-session.sh`:

| Mode | Who gets Alchemy |
|---|---|
| `light` (default) | the signing windows (`*-primary`, `*-standby`, `*-attest`, `*-keep`, `shared-maker`, `shared-payer` with its lister) as a `send:` entry: their own transactions, nonces, gas estimates and receipts; every read stays on the public RPCs. The attester and the keeper also get its websocket (`AGATE_WS_KIND=logs`). Health, the loggers, the page check, the indexer, the repair agent, the Akash reader and `status.sh` never do. |
| `all` | the setup of the morning of Oct 4: Alchemy first for every read and send of every window but the indexer, and its websocket; prints a warning. The meter counts only the websocket here (the reads and sends ride the read list, which it does not count), so the budget does not cover them |
| `off` | nobody: public RPCs only |

`AGATE_KIT_ALCHEMY_WS=prod` keeps the websocket for `prod-attest` and `prod-keep` only (the demo ones poll every 7 and
12 s), `off` for nobody. The key is read from the Keychain (`agate.alchemy-api-key`, account `api-key`) by each
process's own command at its start; `up.sh` checks that the item exists (its attributes only) in `light` and `all`.
A fork never uses the real Alchemy: there `light` and `all` need `AGATE_KIT_ALCHEMY_TEST_URL` (a loopback stand-in) and
are `off` without it. A real (not `--fork`) run refuses `AGATE_KIT_ALCHEMY_TEST_URL` in every mode: left exported after a
rehearsal, it would put the stand-in first for the real processes' transactions (and, while a fork and its counting
proxy still ran there, they would be mined on the fork and never fail over). `unset AGATE_KIT_ALCHEMY_TEST_URL` and
run again.

A send endpoint's own answer about the transaction (a revert, a refused nonce or fee, a known transaction, no funds) is
final; anything else it answers is passed on to the public RPCs: down, a timeout, HTTP 429 or 5xx, and also HTTP 401,
402 or 403 (a revoked or mistyped key, an app's allowlist, a billing block) and a limit named in an HTTP 200 ("Monthly
capacity limit exceeded"). A send endpoint that does not answer in time rests for a minute, so a send pays one timeout,
not one per call.

**The app's own key (Oct 6).** Browsers read through a separate Alchemy app, `agate-browser` (Node API only; its
key in the Keychain as `agate.alchemy-browser-key`), whose key is locked to the domains agate.elpabl0.xyz,
agate-topaz.vercel.app and localhost (any other origin, or none, gets 403) and sits in the public
`NEXT_PUBLIC_AGATE_RPC_URL` ahead of the public RPC: a refusal (403, a limit, an outage) passes the read to the public
RPC. It shares the account's monthly capacity with the robots (51% used on Oct 6) and the robots' meter does not count
it; the markets snapshot keeps most browser reads off the chain.

**The budget.** Every process with Alchemy counts its calls and websocket bytes, writes them to
`<wall home>/rpc-meter/<UTC date>/<role>-<index8 or market>.json` and sums the day's files every minute against
`AGATE_ALCHEMY_DAILY_CU` (default 400,000: the 10.9M left to Oct 31 over the days left; set it in the shell that runs
`up.sh`). At 80% one ALCHEMY_BUDGET info alert; at 100% one action alert, and every process sends through the public
RPCs and polls without the websocket until 00:00 UTC, then comes back by itself. `status.sh` prints the day's compute
units by process and the total against the budget.

**Check the meter against the bill, the first day.** The meter's read prices match the Alchemy dashboard of Oct 4
(eth_getLogs 60, eth_call and eth_getBlockByNumber 20, eth_blockNumber 10); its send prices (estimate, nonce and receipt
20, eth_sendRawTransaction 40) and 0.04 CU a websocket byte (about 70% of the light spend) are Alchemy's list, not yet
checked against a bill. After the first whole UTC day in light mode, compare `status.sh`'s total for that day with the
dashboard's usage for the same UTC day (dashboard.alchemy.com, Usage). If the dashboard reads higher, lower the budget
in proportion, `AGATE_ALCHEMY_DAILY_CU` = 400,000 x meter / dashboard, so the stop still comes before the real spend
passes the day's share.

**What it costs, measured** on two fork rehearsals (Oct 4, `rehearse.sh session` in light mode beside the production
stack, a counting proxy standing in for Alchemy; 0.52 h, then 0.61 h of a demo session up to a budget stop set low on
purpose): the proxy saw only `eth_chainId` (the start check), `eth_estimateGas`, `eth_getTransactionCount`,
`eth_sendRawTransaction` and `eth_getTransactionReceipt` over HTTP and `eth_subscribe` (the finalized `logs`) and its
events over the websocket; 34,594 and 40,804 CU by the processes' meter files (the proxy's own counts priced the same
way: 34,594 and 40,802, the meter rounding up per file). A send costs about 100 CU (estimate 20, broadcast 40, two
receipt polls 40; the writers about 110 to 126 with their nonce checks); a websocket event averages about 1,545 bytes
(62 CU) and each index event reaches both subscribers. The demo's sends ran about 20,400 CU an hour over the second run
(the listings and a user's journey included), its websocket about 46,700 an hour over the whole run and about 53,000
once it ran steady (about 71,600 an hour in all then). Expected, at the higher rates:

| | Sends | Websocket (attester and keeper) | Total |
|---|---|---|---|
| production index, a UTC day (24 slices) | about 12,400 (the maker's requotes 7,200 of it) | about 38,000 | about 50,500 (13% of the budget) |
| demo session, an hour | about 20,400 | about 53,000 | about 73,400 |
| demo session of 5 hours | about 102,000 | about 265,000 | about 367,000 (92%) |

So with the default, a 5-hour demo session beside the production index comes to about 104% of a day's budget (96% to
102% at the second run's own totals, over the whole run and over its steady part): the stop may come near the session's
end. It is graceful (seen live on the second run: every process logged the stop within a minute, the session went on
through the public RPCs and polling, nothing reached the stand-in afterwards). `demo-session.sh start` prints this sum
for its `--hours` and warns from 90%. With `AGATE_KIT_ALCHEMY_WS=prod` the same day takes about 38%. Caveats: the fork
mines a block a second (Monad 0.4 s: the receipt polls may differ), the maker's steady rate rests on few sends, and the
websocket bytes are anvil's log objects (Alchemy's may differ).

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

**The payer's signer (Oct 5).** The production payer signs with its Dynamic server wallet (0x31BC...2c45; the old
Keychain key 0x3786...9505 was swept to the deployer). `AGATE_PAYER_SIGNER=dynamic ops/testnet/up.sh production
--restart-shared` switched it. `up.sh` records an explicit choice once `shared-payer` has started with it (the
top-level `payerSigner: "dynamic"` in the records file, which a redeploy leaves alone; never on a run that stopped
early or left a running payer alone), so every later `up.sh` or `demo-session.sh` run keeps it without the variable,
and `fund.sh` tops up that address. A value other than dynamic or key, in the variable or the file, stops the kit.
`AGATE_PAYER_SIGNER=key` goes back to the Keychain key (fund it first: `AGATE_PAYER_SIGNER=key ops/testnet/fund.sh
--send`). The wallet file `~/.agate-dynamic/payer-wallet.json` (mode 600) and the API token in
`~/.agate-dynamic/api.env` must stay; `up.sh` refuses to open the window without the file. A failed signature raises
`SIGNER_DOWN` and sends nothing.

**The bots' MON during a session.** The maker's and the payer's daily MON budget is paced for the production horizon
(B = (balance - keep) / days to Dec 2: about 3 MON a day for the maker, 1.4 for the payer), and on Oct 4 it refused the
session's six listings (about 0.5 MON each, `list_skipped ... BUDGET` in `shared-payer.log`); on Oct 5 it refused the
production November listings the same way. Since Oct 5 the lister's `list` and `createMarket` are safety sends (they
ignore the day's budget and pacing, never the floor), so listings no longer wait for MON; the maker's quotes still
do. So `start` gives each bot
its share of the session's plan once, on top and unpaced: `AGATE_MM_SESSION_MON` and `AGATE_PAYER_SESSION_MON` (39.0
and 9.8 for 5 h at 102 gwei) until `AGATE_*_SESSION_UNTIL` (unix seconds, an hour after the session's planned end),
passed to the shared windows it restarts. A send takes the day's paced share first and the rest from the session; what
the session used is kept in `~/.agate-wall/market/<role>/session-<until>.json`, so a restart or a new UTC day never
grants it twice. A plan above 1000 MON for one bot (the most a bot accepts) stops `start` before anything is deployed.
The floor (keepMon) always holds. `stop` restarts the shared windows without them while the production stack runs;
that day's spend then counts in full, so the bots send nothing more for production until 00:00 UTC. To give a running
session's bots the MON by hand: `AGATE_MM_SESSION_MON=39.0 AGATE_PAYER_SESSION_MON=9.8
AGATE_MM_SESSION_UNTIL=<unix> AGATE_PAYER_SESSION_UNTIL=<unix> AGATE_KIT_ALCHEMY_WS=prod ops/testnet/up.sh demo --restart-shared`.

The maker keeps the stopped session's books and winds them down at each demo month's end (5 and 10 hours after the
session began). After that (62 demo days and an hour from the session's start) `up.sh` points the shared maker's and
payer's `AGATE_MM_CONFIG` / `AGATE_PAYER_CONFIG` at `ops/testnet/bots-real-only.json` (`{"factories":["real"]}`; to
quote a Kuru Spot V2 book too, give the maker a file of its own, the same plus
`"kuruV2": {"books": [{"market": "<V2 book>", "series": "<series>"}]}`, point `AGATE_MM_CONFIG` at it and restart the
maker's window: the payer refuses an unknown field, so never add kuruV2 to the shared file; see
wall/apps/marketmaker/README.md "Kuru Spot V2"; both
variables name a config FILE) unless the operator set them, so the next
`ops/testnet/up.sh production --restart-shared` stops their MM_INDEX_BEHIND and LISTER_STUCK alerts about the demo
index nothing writes any more (Oct 5); the next `start` gives them the demo factory again. A new session started
before the old one's months end replaces the demo factory in the deployments file, and the old books are left resting
(Kuru orders never expire). To cancel them first, use the maker's kill switch, wait a minute
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

If `start` stops with `respawn pane failed: fork failed: Device not configured` and `stopped: <window>: the launcher did
not start in window @N (left idle; close it with down.sh)`, tmux could not open a pane while the shared windows were
being closed and opened again (seen on this machine in two fork rehearsals in a row at `shared-indexer`, then not in a
third; a private tmux server reproduced it once and not in three more tries). Nothing was sent by that step: wait half
a minute, `ops/testnet/down.sh demo`, then run `demo-session.sh start` again (the active session's index and factory
are reused).

### The live check during a session

A plain user's whole journey against the session's demo factory, from the client (`client/README.md`, "The live check
on Monad testnet"), with a fresh test key that holds no role (the run refuses one that does) and a few MON:

```
cd client
AGATE_E2E_KEY_CMD='security find-generic-password -s <test key item> -a private-key -w' \
  bun run e2e/run.ts testnet --i-mean-testnet --report ~/agate-live-check.json
bun run e2e/session-report.ts            # read only, every 30 minutes (in another window)
```

- Start it any time after `demo-session.sh start`: it prints the user's address, MON and tUSD, checks every gate, then
  waits for H100's demo November to list and be quoted (about 16 minutes into the session), prints the spend plan
  (about $460 against `--max-dollars` 500), and only then sends: drip, buy $200, sell 10, a short of 10 opened and
  closed, pay me daily $100, a limit bid placed, cancelled and withdrawn (a few minutes). Then it waits for the next
  demo day to turn final (about 6 minutes after a day ends; a line every 3 minutes) and claims, then for the month's
  end (5 hours after the session began, plus about 6 minutes; a line every 5 minutes) and makes the final claims and
  the settle.
- The payer claims daily positions after each final day too; the run checks the paid total whoever claimed and says
  which. The run's own gas, measured on a fork rehearsal (Oct 4): 19 transactions, gas limits 3,460,116, 0.35 MON at
  102 gwei; Monad's estimates run up to 1.7 x the fork's, so about 0.6 MON. Fund the test key with 2 MON (the run stops before
  a step when the key is under `--min-mon`, 1 by default, and warns at the start when its estimate would take it there). The fork's gas price is not Monad's: read the step table's MON on testnet.
- Ctrl-C finishes the step in progress (every transaction of it and its checks) or stops a wait at once, then stops; a
  second Ctrl-C quits at once. After that, a dropped connection or a MON top-up needed under `--min-mon`, the same
  command continues from what is on chain. The session must still be `active` in `10143-indexes.json`.
- Which month: `--month`, else the newest month of the GPU this key holds something in or has a journey in on this
  factory (the `--report` file, or the key's router flows on chain), else the factory's current month. So the same
  command run again after a finished journey (exit 0) sends nothing; a new month for that key needs `--month`. The run
  prints the month it took and why.
- One live run per key: a second run of the same key while the first lives exits 2 and leaves the `--report` file to
  the first (a pid lock in `~/.agate-e2e/locks`, taken over when its process is gone); a run also refuses while the key
  has a transaction still pending.
- The report's sections: per demo day closed, final, countersigned and carried GPUs and each writer's slices; the
  listings; the maker's books level by level; the claims per day and the payer's share (with the indexer); the open
  alerts since the session began; per key the MON out since the deploy block and its transaction count.

## The labeled test trader

A small bot that keeps the November books moving until outside traders arrive: in each of H100, H200 and B200 it
reads when the market last traded (the indexer, and its own last trade from `~/.agate-test-trader/state.json`) and, if
nothing traded for an hour, makes one trade at the maker's price: it buys $10 to $20 when it holds under $2 of the
month and sells what it holds (up to $20) when it holds more, so its position stays near zero. Caps: one trade per
market per idle hour, 72 trades and $1,000 of volume a day (00:00 UTC, buys and sales alike), a MON floor of 11, and
nothing while a send of its key is still pending. Its wallet is the test user
`0x14fB2CE8Fb6d7016e4E416bE7E58ca028Cc2C84a` (Keychain `agate.test.user`); it is Agate's own address, labeled as such
in docs/site/16-limits.md, so its trades are never counted as outside traders'. It runs on the local machine (the key
is in its Keychain), in its own window, through its launcher `ops/testnet/test-trader.sh` (a clean environment, a
restart 30 s after a crash), and is not managed by up.sh or down.sh. It holds the same per-key lock as the live check
(`~/.agate-e2e/locks`), so stop it before a live check with this key; while the lock is held elsewhere it waits and
tries again every minute.

```
tmux new-window -t <session> -n test-trader "/bin/sh $PWD/ops/testnet/test-trader.sh"     # start it (from the repo)
tmux pipe-pane -t <session>:test-trader -o "cat >> $HOME/.agate-kit/logs/test-trader.log" # its log
tmux send-keys -t <session>:test-trader C-c                                               # stop it: finishes the trade
tmux kill-window -t <session>:test-trader       # once the log says "stopped" (exact name only, never by number)
tail -f ~/.agate-kit/logs/test-trader.log                                                  # what it decides and sends
```

One pass without sending anything, to see what it would do now (a dry run takes no lock, so it works beside the
running trader):

```
cd client && AGATE_TEST_TRADER_KEY_CMD='security find-generic-password -s agate.test.user -a private-key -w' \
  bun run scripts/test-trader.ts --dry-run --once
```

Each pass prints one JSON line per market: `tick` with the book, what it holds and the plan (`skip`, with the reason,
or `buy`/`sell` with the size and the price bound), then `trade` with the transaction, or `error`. A pass stops before
any market when the indexer does not answer (`indexer_down`) or lags the chain by more than 300 blocks
(`indexer_behind`): a quiet market and an unreadable one must never look alike. A send whose outcome is unknown (a
timeout, no receipt) is counted against the caps (`uncertain` in trades.jsonl), ends the pass and holds every send for
15 minutes (`uncertain_wait`); after that a pass still waits while a send is pending. A market is skipped when the
indexer has no row for its month (`not_indexed`: it cannot tell a quiet market from an unindexed one) or when its book
is more than 10% wide (a stray order at the top, not the maker's price). A state file it cannot read, or cannot write
after a trade, stops it with exit 2 (the launcher does not restart it) rather than resetting the day's counts or
trading past them; move the file aside to start them again. Ctrl-C (or a closed window) finishes the trade in
progress, saves it and exits 0; a kill-window alone does not wait for it. Its gas comes out of its own MON: about 0.05
MON a trade (most trades also send an approval), so the 39 MON above the floor last about 11 days at the cap. Refill
it the way it was first funded, from the deployer (`ops/testnet/send.ts transfers ... --key-env`). `bun test
test/test-trader.test.ts` covers the decision table.

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

## Split across a local machine and a server (since Oct 6)

Most roles run on a Linux server (Vultr, Ubuntu 24.04, on the operator's tailnet; SSH only over Tailscale): the
primary writer, attester, keeper, page check, health, market maker, payer, indexer, Akash reader, its own watcher
logger, the AI server and the indexer's public proxy. The local machine keeps the standby writer, the repair agent, its own
logger and its own health; the public app runs on Vercel. The same kit runs on both:

- **The server's stack:** `ops/server/stack.sh` opens everything in the tmux session `agate` (the kit's windows through
  `AGATE_KIT_WINDOWS`, plus wall-log, graphql-proxy and ai-server with a 10 s restart loop each), and is idempotent. It
  starts at boot from `ops/server/agate-stack.service` (copy it to `/etc/systemd/system/`, `systemctl enable --now
  agate-stack`; it runs as the user `agate`, who is in the `docker` group for the indexer). Tailscale Funnel publishes
  the AI server (port 443, to 127.0.0.1:5191) and `ops/server/graphql-proxy.ts` (port 8443, to 127.0.0.1:8081: POST
  /v1/graphql with every x-hasura-* header dropped, and GET /akash-traded.json). The CRE CLI (Go) needs
  `vm.overcommit_memory = 1` on a 2 GB server, else its simulation dies "out of memory" and the primary posts directly.
  The AI server also serves the app's markets snapshot, `GET /api/markets` (server/API.md).
- **Restarting one of the server's windows:** its launcher (`~/agate/run/<name>.sh`) restarts the process after a
  crash but stops for good on exit 0, 2, 3, 64, 130 or 143, and a plain `kill` is 143: a killed ai-server stayed down
  (Oct 6, about 1.5 minutes). Restart a window by name the way `stack.sh` revives a dead pane:
  `tmux respawn-pane -k -t "=agate:ai-server" "/bin/sh $HOME/agate/run/ai-server.sh"` (it replaces the running
  process too), then check `/health`.

- **Keys on the server:** `ops/server/security` is installed as `/usr/local/bin/security`, a stand-in for the macOS
  command that serves `find-generic-password -s SERVICE -a ACCOUNT [-w]` from owner-only files
  `~/.agate-secrets/SERVICE__ACCOUNT`, so every key command runs unchanged. A key is copied without being printed:
  `security find-generic-password -s agate.wall.primary -a private-key -w | ssh <server> 'umask 077; cat > ~/.agate-secrets/agate.wall.primary__private-key'`.
  The payer's Dynamic files go to `~/.agate-dynamic/` (mode 600).
- **Which windows open where:** `AGATE_KIT_WINDOWS="prod-primary shared-maker shared-payer"` opens only those (and
  checks only their keys); `$AGATE_KIT_STATE/elsewhere` (default `~/.agate-kit/elsewhere`, one machine only) lists
  windows that run on the other machine and are never opened here, so a plain `up.sh production` on the local machine cannot
  start a second process on a key the server uses. The server's session is named with `AGATE_KIT_TMUX_SESSION=agate`.
- **Health on each side:** heartbeat files are local, so each machine runs its own health. On a split stack (either
  of the two above in use) up.sh points it at the roles it opens there: `AGATE_HEALTH_CORE` (log, attest, keep),
  `AGATE_HEALTH_WRITERS` and `AGATE_HEALTH_EXTRA` (pagecheck, repair, akash), with `none` for an empty list. Only the
  machine that runs the keeper gets the chain-wide checks (late days, key balances; `AGATE_HEALTH_GLOBAL=0` on the
  other), so no alert is raised twice. A value set in the shell wins. A demo session refuses to run on a split stack:
  the shared windows it restarts may be on the other machine.
- **Moving a role:** stop it by exact name on one machine (`AGATE_KIT_ONLY=<window> down.sh production --only-named`),
  copy its state folder (`~/.agate-wall/<role>`, the market bots' `~/.agate-wall/market`), start it on the other with
  `AGATE_KIT_WINDOWS=<window> up.sh production`, then add it to the first machine's `elsewhere`. Never run one role on
  both. The attester, keeper and page check read the watcher logger's log: move them only once the server's own logger
  has a complete UTC day, after the local machine's attester has handled the day before.
- **The CRE writer on the server** needs its workflow's own packages (`cd wall/apps/writer-cre/workflow && bun install
  --frozen-lockfile`), else it falls back to direct posting ("cre-compile failed"), and a one-time `cre login` through
  an SSH tunnel (`ssh -L 53682:localhost:53682 <server>`, then `cre login` there and the printed link in the local machine's
  browser). Compiling takes about 50 s and 0.8 GB on a 1-vCPU 2 GB server (a swapfile is set).
- **Notifications:** on Linux `notify.sh` appends each action alert's code and index to
  `~/.agate-wall/notify-spool.jsonl`. On the local machine, `ops/server/alerts-forward.sh` (in its own tmux window, e.g.
  `server-alerts`) reads the new lines over the tailnet each minute (host `agate-1` in `~/.ssh/agate.conf`) and shows
  them with the same notify.sh. It starts after what is already in the spool and moves its offset
  (`~/.agate-kit/notify-spool.offset`) only after a read that worked. Full alerts stay in `~/.agate-wall/alerts` on
  the server (`status.sh production` there). Over plain ssh, give it the PATH and tmux session that
  `ops/server/stack.sh` exports (a non-interactive shell has no bun on PATH): `ssh -F ~/.ssh/agate.conf agate-1 'cd
  ~/agate && PATH=$HOME/.bun/bin:$PATH AGATE_KIT_TMUX_SESSION=agate ops/testnet/status.sh production'`.

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
indexer's containers too, through `indexer.sh stop --fork`). `envio dev` and `envio stop` use fixed Docker names
(`envio-postgres`, `envio-hasura`) whatever the folder, so while another indexer runs on this machine (the live one,
`shared-indexer`) a fork's indexer window refuses to start, and `indexer.sh stop --fork` removes only containers a fork
run created (`.fork-owns-envio` in its folder, naming each container's id as it appears, so a run that stopped halfway still owns what it made): the
rest of the session runs without the fork's indexer. The guard is one-way: never start the live indexer (`indexer.sh
run` without `--fork`) while a rehearsal's fork indexer runs, since it would attach to the fork's containers. The app's data
layer has its own fork run with a separate indexer (`client/e2e`). `deploy`
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
  a fork run refuses the default tmux server and the dev session;
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
