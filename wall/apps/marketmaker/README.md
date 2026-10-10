# agate market maker (P1)

Keeps two-sided resting quotes on every listed month's Kuru V1 book, so there is always someone to trade with
(BOTS-SPEC section 3). In the demo, say it plainly: **the book is quoted by our bot**.

- **Fair value** of a token is the month's expected average: `(S + (N - k) x xc) / N`, with `(k, S)` from
  `series.previewSync()` and `xc` the newest final index value (a walk of up to 32 days from `min(today, head) - 1`)
  clamped into `[F, C]`. Before the month it is `xc`; at `k = N` it is `S / N`.
- **The band of newer public values** (audit M-H1, recheck R1-M1): a closed day's record is public while it waits
  for finality (T_PEND, or a countersign), and `index.previewFix` shows an ended day before the wall closes it; two or
  more can be public at once. Fair stays on the final value, but the ladder is placed around `[lo, hi]` = the min and
  max of fair and the fair each newer value gives: no bid at or over `lo`, no ask at or under `hi`, until they are
  final. Whichever turns final first, a taker who read it gains nothing. Since recheck R2-M1 the band also holds each
  other writer's value for the pending day (`index.previewRecord`) while it is not attested, since the attester may
  select it (final at once); and while the wall is two or more ended days behind (`head < today - 1`) it is the whole
  `[fair at F, fair at C]`, with `MM_INDEX_BEHIND` (action), because no view bounds the days past `head`.
- **Ladder**: half-spread `max(1 tick, 1 %)`, 3 levels a tick apart, 1,000 / 2,000 / 4,000 tokens, never outside
  `[F, C]`, never crossing anyone (the book minus its own orders), post-only. Inventory gates (audit M-M1): each side
  is cut to the room it has left, asks to `maxNetTokens + E`, bids to `maxNetTokens - E`, so no fill carries the net
  exposure `|E|` past `maxNetTokens`.
- **Requote** (one `batchUpdate` that cancels every order of the book and places the whole ladder) only when fair (or
  the band) moved through the quotes, more than a tick, the top order is under half its size, the book is 6 h stale or
  empty. A move through the quotes is urgent but paid from the day's budget (audit M-M2): when the budget stops it,
  only the crossed orders are cancelled (a safety send); the re-placement waits for the budget.
- **Inventory**: pairs minted with `series.mint` (the short side stays with the bot), tokens and dollars deposited into
  Kuru's MarginAccount before the batch that needs them (one dollar deposit for every due book).
- **Wind-down**: from `stopBeforeEndS` before the month ends (1 h on production, 60 s on the demo clock) every order is
  cancelled, the token withdrawn, pairs redeemed; after the last day both sides are settled and the series dropped.
  The settle keeps the D1 hold (audit M-H2): it never forces a day the wall has not closed, or closed and not yet
  final (`MM_FORCE_HELD`, action, until it has). A settle refused `GAS_CAP` is preceded by `sync` chunks that fit.

## Run

```sh
# from a copy of wall/ outside ~/Documents (launchd jobs hang on files there); the key never touches a file
AGATE_KEY_CMD='security find-generic-password -s agate.market.bot -a private-key -w' \
AGATE_RPC_URLS_CMD='<prints the Alchemy URL, the public RPC, the Alchemy wss URL>' \
AGATE_CHAIN_ID=10143 AGATE_DEPLOYMENTS=<copy of contracts/deployments/10143.json> \
sh apps/marketmaker/launchd/run-marketmaker.sh
```

The process runs `AGATE_KEY_CMD` itself and keeps the key in memory only (audit M-K1): a key exported to it would stay
readable in its exec-time environment (`ps -wwE`) for its whole life. Tests pass a throwaway key in `AGATE_MM_KEY`
instead; never put the real key there.

`launchd/xyz.s0nderlabs.agate-marketmaker.plist.template` is the agent (written, never loaded by a test). Config:
`AGATE_MM_CONFIG` (JSON of BOTS-SPEC 3.11; an unknown field is refused). Files under
`~/.agate-wall/market/marketmaker/`: `state.json`, `heartbeat.json`, `quotes.jsonl` (one line per requote),
`budget-<day>.json`, the lock. Alerts go to `~/.agate-wall/alerts/alerts.jsonl` (`MM_*`, `GAS_CAP`, `NONCE_STUCK`;
since the audit also `MM_FORCE_HELD`, action, and `MM_MARK_FALLBACK`, info; since recheck R2-M1
`MM_INDEX_BEHIND`, action). `GAS_CAP` is keyed by bot, shape and target; a `sync` chunk or a `settle` the maker answers
with smaller calls is only logged.

`AGATE_DRY_RUN=1` with `AGATE_MM_ADDRESS=<the bot's address>`: simulates and estimates every send, signs nothing,
needs no key. A dry run has no MON budget (it writes no `budget-<day>.json`, which a real start the same UTC day would
reload) and raises no `MM_KEY_LOW`.

## Commands

| Command | What it does |
|---|---|
| `bun run src/main.ts run` | the loop (default) |
| `bun run src/main.ts status` | heartbeat, open alerts, the budget day, the state summary; sends nothing |
| `bun run src/main.ts kill [reason]` | writes `KILL`: every order cancelled within one tick, nothing placed, settling continues |
| `bun run src/main.ts unkill` | removes it. After a **loss** kill the limit re-arms `maxLossU` under the value at unkill |
| `bun run src/main.ts cancel-all` | cancels every book once without killing; the next tick requotes |
| `bun run src/main.ts withdraw-all` | with the kill switch on: every token and the dollar out of the MarginAccount |
| `bun run src/main.ts rebase` | the loss baseline := the value now; every book is requoted once (after a float top-up) |

Each request is a file the running process acts on within one tick; when no maker process runs, the command boots one
(key and RPC from the environment) and runs a single tick itself. That one-shot tick places, mints and deposits
nothing (cancels, the cancel of crossed orders, wind-down and the state change only): the process exits right after,
and a ladder nobody requotes would rest unmanaged (Kuru orders never expire). After `unkill`, `rebase` or `cancel-all`
with no maker running, start `run` to quote again.

**Kill while the maker is down** (audit M-L3): Kuru orders never expire, so a stopped maker leaves its ladder resting.
Run `kill` with the same environment as the run script, and it cancels at once:

```sh
AGATE_KEY_CMD='security find-generic-password -s agate.market.bot -a private-key -w' \
AGATE_RPC_URLS_CMD='<as in the plist>' AGATE_CHAIN_ID=10143 AGATE_DEPLOYMENTS=<the deployments copy> \
bun run apps/marketmaker/src/main.ts kill "maker down"
```

Without them the `KILL` file only waits for the next start.

## Float, loss limit, MON budget

- **Float**: `DeployMarket`'s one-time mint of 10,000,000 tUSD to the bot (`botFloat`, MS 10.3). The bot never holds
  the deployer key. Under `dollarLowU` (500,000 tUSD) in wallet plus margin it raises `MM_FLOAT_LOW` and redeems idle
  pairs. **Top-up**: a one-off `cast send <dollar> 'mint(address,uint256)' <bot> <amount>` from the deployer (the
  dollar's minter; testnet deploy runbook), then `rebase` so the top-up is not counted as profit.
- **Loss limit**: the mark is wallet + margin dollars + bid locks + each series at its own fair
  (`(T x fair + Sh x (C - fair)) / U`); under `baseline - maxLossU` (500,000 tUSD) the kill switch engages with
  `MM_LOSS_LIMIT`. A person decides: `unkill` (re-armed from there) or `rebase`. A series whose index walk finds no
  final value is marked at its last fair, else at the worst case of `[F, C]` (`MM_MARK_FALLBACK`, info), so the limit
  never switches off for every book (audit M-M4).
- **MON**: Monad bills the gas limit. The day's budget is `(balance - keepMon) / days to runUntil`, paced hourly; when it
  is spent the requotes wait (largest fair move first), while safety sends (kill, wind-down, and the cancel of orders a
  fair move crossed) still go out as long as `keepMon` (20 MON) stays. Placements, mints and deposits are always the
  budget's (audit M-M2). `runUntil` defaults to `2026-12-02T00:00:00Z`: through judging and the November series'
  settle (the real calendar's November settles Dec 1); 7 days at a time once it has passed.
- **One dollar** (audit M-L1): a configured factory whose dollar is not the deployments file's is refused at start
  (the pilot settles in Kuru's USDC, which the maker does not hold).
- **Restart** (3.10): a send whose outcome is unknown (every URL failed after the request went out) keeps its id scan,
  so a ladder that landed is never forgotten (audit M-M3). Without `state.json` the full id scan covers the books of the
  current and next months and the two before (audit M-L4); an orphan book is cancelled. A `state.json` of another
  chain or deployment (a fork rehearsal with the same `AGATE_WALL_HOME`, a testnet reset) is set aside as
  `state.stale-<ms>.json` and the maker starts as without one.

## Kuru Spot V2 (`kuruV2`, Oct 10 2026)

Kuru's Spot V2 lists a token only through Kuru's own governance (Kuru agreed on Oct 9 to list the November H100 token
against its test USDC). Config `kuruV2` makes the same process and key quote such a book beside the V1 one, from the
same fair value, band and ladder (`src/v2.ts`):

```json
{ "factories": ["real"], "kuruV2": { "books": [{ "market": "<V2 book>", "series": "<the series it trades>" }] } }
```

Optional fields: `accountCore` (default Kuru's testnet AccountCore `0xdbaa...8038`), `maxBaseTokens` (100: tokens the V2
account may hold for one book; at the cap the bids close) and the ladder and requote fields `spreadBps`, `levels`,
`levelStepTicks`, `sizesTokens`, `requoteMoveU`, `replenishBelowPct`, `staleS`, `minRequoteS` over the top level (not
`perFactory`; the pilot's own defaults are two levels of 10 and 20 tokens). The wind-down time is the series' (V1's) and
the mint stays inside the top level's `maxPairsTokens`, so `maxNetTokens`, `maxPairsTokens` and `stopBeforeEndS` are
refused under `kuruV2`. What differs from V1:

- **Funds sit in a V2 account.** Tokens for the asks come from the account, then the wallet, then a mint (the dollar's,
  at the cap); the bids need Kuru's test USDC in the wallet (no public faucet: Kuru sends it). Both are deposited into
  AccountCore before the batch.
- **Slots, not ids.** One `batch` cancels every occupied slot and places the ladder, post-only GTC; the cancels run
  first, so the slots are reused. The next tick adopts what the slots hold (a crossing order is skipped by Kuru), then a
  slot losing its order or the market's locked reserves falling under `replenishBelowPct` count as fills.
- **The same safety.** Kill, `cancel-all` and wind-down cancel the V2 book too (`cancelAllOrders`); a one-shot CLI tick
  places nothing. The V2 account's tokens and USDC (and the USDC in the wallet) are in the loss limit's mark; a book the
  chain cannot read raises `MM_V2_UNREADABLE` (action), sends nothing and is marked at its last holdings. A series the V2
  desk mints or deposits for is held like a V1 one, and is not dropped while the V2 account still holds its tokens. A
  final series' tokens are withdrawn to the wallet before the V1 wind-down settles them; `withdraw-all` (kill on) also
  takes the USDC. A V2 withdrawal costs about 0.66 MON of gas on testnet (its withdrawal limiter), so it happens only then.
- **Limits** (Monad estimates, Oct 10): deposit 269k gas, a batch of one placement 394k, one cancel and two placements
  512k, `cancelAllOrders` 261k, withdraw 4.96M; the shapes `kuruV2.*` carry provisional ceilings in the LIMIT table.
  An order must be worth at least the book's minimum notional (MON/USDC: $10) and under its fixed maximum price.

## Shared layer (`@agate/market`)

The chain wiring is the shared layer in `wall/packages/market`, the same one the payer uses: the process bootstrap
(key into memory, RPC pool, lock, alert sink, deployments file with Kuru's margin account required), `MarketSender`
(2.3), `ViemReads` (Multicall3 batching), the LIMIT table (2.4), the MON `Budget` (2.6), the generated ABIs, Kuru's ABI
subset and the constants. The maker's core uses only the `MarketReads` and `Sender` interfaces and is itself the
sender's spend guard (`canSpend` / `record`), so it raises `MM_KEY_LOW` and `MM_BUDGET_SPENT` from its own tick.

One number differs from MS 9.2: the `series.mint` LIMIT is 142,000, not 90,406. A series' **first** mint (the maker's, on
every new month) also takes the token supply, the short supply and the series' dollar balance from zero: 163,174 gas in
the receipt on the Kuru V1 fork (about 141,550 of execution). With 90,406 the CAP refused it (`GAS_CAP`). The shared
table carries 142,000 (BOTS-SPEC 2.4, v2).

## Tests

```sh
bun test test/*.test.ts                                     # unit tests over the fakes (FakeKuru follows Kuru's rules)
AGATE_FORGE_OUT=<forge out> bun run scripts/fork-test.ts    # the fork tests on Kuru V1's real book (anvil-safe)
```

The fork runner checks the disk (refuses under 30 GB free), starts an anvil-safe fork of
`https://testnet-rpc.monad.xyz`, runs `test/fork/` against it (fresh viem keys only), stops it and checks no run dir is
left. Build the artifacts first: `cd contracts && FOUNDRY_OUT=$HOME/.agate-build/p1/out
FOUNDRY_CACHE_PATH=$HOME/.agate-build/p1/cache forge build src/market test/market/mocks/MockIndex.sol`.

`test/adversarial/` holds the audit's probes, flipped by the fix round to assert the fixed behaviour; `test/fixes.test.ts`
covers the fixes without an audit test of their own.
