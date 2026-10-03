# agate contracts

Foundry project for the wall (`AgateIndex`) and the market (`src/market/`).

```
forge install --no-git foundry-rs/forge-std@v1.17.0                # lib/ is not committed
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0  # the market
forge build --sizes      # exits 1 only on Ethereum's 24 KB check (the factory); Monad allows 128 KB, see Contract sizes
forge test
forge test --match-path 'test/gas/*' --gas-report --isolate   # the index's call shapes
anvil --code-size-limit 131072                                  # Monad allows 128 KB of runtime code
AGATE_CONFIG=local-demo forge script script/DeployIndex.s.sol --rpc-url anvil --broadcast \
  --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

`AgateIndex` keeps its storage and the cheap views; the logic runs in four linked libraries
(`IndexReports`, `IndexDays`, `IndexViews`, `IndexAdmin`) by DELEGATECALL, so every contract stays under 24 KB.
`forge test` and `forge script` deploy and link them automatically.

Differential vectors (`test/vectors/diff_*.json`, numbers only) come from the reference model, which stays outside
the repo: `AGATE_REFERENCE_MODEL=/path/to/reference_model.py python3 test/vectors/gen_vectors.py`.

## Market

The GPU-hour market (`src/market/`): a series per GPU and month with its token, a factory per (index, dollar) that
lists series and records their Kuru V1 market, a router for one-click flows, and the test dollar.

```
forge build --sizes      # prints the sizes, then exits 1: the factory is over Ethereum's 24 KB (EIP-170), not Monad's 128 KB
forge test --match-path 'test/market/**'                          # every market test (fork tests skip)
forge test --match-path 'test/market/invariant/*'                 # invariants (256 x 128) and the negative controls
FOUNDRY_PROFILE=ci forge test --match-path 'test/market/invariant/*Invariant.t.sol'   # 1,024 x 256
forge test --match-path 'test/market/gas/*' -vv --isolate         # the gas table below (lines "GAS | ...")
script/rehearse-market.sh fork-test                                # every MONAD_FORK_URL test on an anvil-safe fork
script/rehearse-market.sh                                          # the dress rehearsal on an anvil-safe fork
```

Run the gas tests with `--isolate`: each call is then its own transaction, so every account but the target and the
sender is cold, as on chain (forge 1.3.5's `vm.cool` cools storage, not accounts; without `--isolate` the lines are
marked "warm accounts"). Both scripts start their chain only through `../wall/scripts/anvil-safe.sh` after
`df -h /` (they refuse under `AGATE_ANVIL_MIN_FREE_GB` GB free, default 30, anvil-safe's own floor), send only as
fresh impersonated addresses, and stop anvil and remove its state dir on exit (the leak check looks at this run's
own anvil-safe run dir); the fork's
`deployments/fork-10143.json` and its pending twin are removed again (or restored) at the end. `fork-test` runs
every `test/market` file that reads `MONAD_FORK_URL` (`fork/KuruV1.t.sol`, `audit/KuruSquatFork.t.sol`).

**Deployments file.** forge runs a script before it sends anything, so `DeployMarket` writes only
`deployments/<file>.pending`. After the broadcast, run the same config's verify step, which checks that every
address has code (and each router is its factory's) and only then writes `deployments/<file>`:

```
AGATE_MARKET_CONFIG=local forge script script/DeployMarket.s.sol --sig 'verify()' --rpc-url anvil
```

If it refuses (a broadcast that failed or was cut off), rerun `DeployMarket` (it reuses what landed), then verify
again. Pending files are gitignored; the deploy-script tests write theirs under `cache/test-deployments/`.

**Keys (testnet deploy only).** `DeployMarket` reads `AGATE_DEPLOYER_KEY` and `ListSeries` reads
`AGATE_PAYER_KEY` from the forge process's environment (`script/EnvKey.sol`) and sign with that key; the key goes into
the environment of that one command (`AGATE_DEPLOYER_KEY="$(security find-generic-password ...)" forge script ...`),
never onto a command line or into a file. A variable that is set must be a nonzero 0x-prefixed hex key, or the run
stops before any transaction (an empty value from a failed Keychain read included). Only without the variable do
both send as `--sender` / `--account` (the local anvil and the fork rehearsal). `kuru.deployMock` (the test suite's
MockKuruRouter) is refused off chain 31337. A rerun reuses every address; it mints the bot float only if our dollar
has no supply yet.

**For integrators.** A series' views (`state`, `shortOf`, `position`, `claimable`) are consistent between calls only:
with a dollar that has transfer hooks, a hook inside `mint` or `unstream` sees the short credited before the dollar
pull. Do not read series views from inside a dollar hook (tUSD and Kuru's USDC have none). On a factory with a Kuru
router, `attachMarket` records as KURU_V1 only markets Kuru's Router lists (`verifiedMarket`) for the series' token and
the dollar. A market the router cannot use may be re-recorded at the same address under another venue (the pilot's
OTHER to KURU_V1 once the V1 ABI is proven). The app refuses as payee the series, its token, its market, the
factory, the router, and Kuru's MarginAccount and Router.

### Contract sizes

`forge build --sizes` (solc 0.8.30, via_ir, optimizer 200). Monad allows 128 KB of runtime code and 256 KB of
initcode; `--sizes` measures against Ethereum's 24 KB whatever `code_size_limit` says (forge 1.3.5), so it reports
the factory as over the limit, which it is only on Ethereum (its runtime carries the series' and the token's creation
code), and exits 1 after printing the table: do not chain it with `&&`. `forge build` itself exits 0 with no
compiler warning.

| Contract | Runtime (B) | Initcode (B) |
|---|---|---|
| AgateFactory | 33,136 | 44,876 |
| AgateSeries | 12,702 | 20,463 |
| AgateRouter | 9,305 | 9,488 |
| AgateDollar | 3,899 | 5,926 |
| AgateToken | 3,555 | 5,453 |

### Gas

Measured in Foundry at Ethereum's Cancun prices, `--isolate`, every account and slot cold. **used**: execution gas
before refunds. **LIMIT**: the smallest execution gas at which the call succeeds and applies every pending day (binary
search on `call{gas: g}`, every smaller limit sampled reverts, and a success that applied fewer days fails the test,
I36). **tx**: LIMIT + 21,000 + the calldata's gas, the transaction gas limit. `c` is the number of index calls the
call makes (ended days not yet applied); every shape that syncs is measured at c = 0, 1, 5 and 30 (for `settle` and
the final claims c = 0 means every day applied). Series and factory shapes run on the real `AgateIndex` (demo clock)
and December (N = 31); router shapes and `createMarket` on Kuru V1's deployed code on a fork (block 67,606,265;
`createMarket` measured the same at 67,582,358), with the MockKuruOrderBook figure beside them. Monad bills the gas
limit and prices cold state higher (cold SLOAD about 8,100 instead of 2,100, cold account about 10,100 instead of
2,600), so the testnet deploy re-measures every shape with `eth_estimateGas` on Monad testnet and
publishes the larger of each pair (10.4 step 7). Senders use `gasLimit = min(1.5 x LIMIT, ceil(1.2 x estimate))` (9.1
step 3), with LIMIT from the row of the same shape and c.

| Shape | c | used | LIMIT | tx |
|---|---|---|---|---|
| `mint` 100 tokens, holder new to both balances | - | 90,266 | 90,406 | 112,002 |
| `mint` 100 tokens, existing holder | - | 56,066 | 56,066 | 77,662 |
| `redeem` 100 tokens | - | 52,975 | 52,975 | 74,571 |
| `sync(1)` | 1 | 21,727 | 135,249 | 156,453 |
| `sync` | 1 | 22,035 | 135,249 | 156,825 |
| `sync` | 5 | 71,506 | 187,235 | 208,811 |
| `sync` | 30 | 380,628 | 496,353 | 517,929 |
| `sync` (the whole month) | 31 | 392,687 | 508,719 | 530,295 |
| `sync` (nothing pending) | 0 | 3,590 | 3,590 | 25,166 |
| `sync(1)`, first forced day with the full 31-day walk (32 index calls) | 32 | 139,400 | 259,794 | 280,998 |
| `streamOut` LONG | 0 | 117,551 | 117,551 | 140,151 |
| `streamOut` LONG | 1 | 132,829 | 135,242 | 157,842 |
| `streamOut` LONG | 5 | 182,262 | 187,188 | 209,788 |
| `streamOut` LONG | 30 | 491,140 | 496,056 | 518,656 |
| `streamOut` SHORT | 0 | 113,240 | 113,240 | 135,852 |
| `streamOut` SHORT | 1 | 128,518 | 135,242 | 157,854 |
| `streamOut` SHORT | 5 | 177,950 | 187,188 | 209,800 |
| `streamOut` SHORT | 30 | 486,828 | 496,056 | 518,668 |
| `claim` | 0 | 52,372 | 52,372 | 73,576 |
| `claim` | 1 | 67,650 | 135,084 | 156,288 |
| `claim` | 5 | 117,081 | 187,030 | 208,234 |
| `claim` | 30 | 425,953 | 495,898 | 517,102 |
| `claim` final (deletes) | 0 | 40,593 | 40,593 | 61,797 |
| `claim` final (deletes) | 1 | 55,895 | 135,084 | 156,288 |
| `claim` final (deletes) | 5 | 105,302 | 187,006 | 208,210 |
| `claim` final (deletes) | 30 | 414,198 | 495,898 | 517,102 |
| `claimMany` 1 id | 1 | 68,249 | 135,369 | 156,853 |
| `claimMany` 8 ids | 0 | 222,600 | 222,670 | 245,134 |
| `claimMany` 8 ids (about +25,450 per extra id) | 1 | 237,878 | 237,948 | 260,412 |
| `claimMany` 8 ids | 5 | 287,312 | 287,382 | 309,846 |
| `claimMany` 8 ids | 30 | 596,200 | 596,269 | 618,733 |
| `claimMany` 16 ids | 1 | 441,475 | 441,544 | 465,128 |
| `claimMany` 50 ids (the payer's largest batch, 6.6) | 1 | 1,306,805 | 1,306,874 | 1,335,218 |
| `claimMany` 8 ids, final (deletes: the payer's final sweep) | 1 | 225,622 | 225,692 | 248,156 |
| `claimMany` 8 ids, final (deletes) | 5 | 275,032 | 275,102 | 297,566 |
| `claimMany` 8 ids, final (deletes) | 30 | 583,944 | 584,013 | 606,477 |
| `closeWithToken`, SHORT position (burns tokens) | - | 53,952 | 53,952 | 75,524 |
| `closeWithToken`, LONG position (debits short) | - | 52,443 | 52,443 | 74,015 |
| `unstream`, LONG position (takes paid back, mints) | - | 59,798 | 59,798 | 81,370 |
| `unstream`, SHORT position (credits the short) | - | 28,629 | 28,629 | 50,201 |
| `settle` LONG | 0 | 42,348 | 42,348 | 64,072 |
| `settle` LONG | 1 | 57,626 | 135,479 | 157,203 |
| `settle` LONG | 5 | 107,033 | 187,401 | 209,125 |
| `settle` LONG | 30 | 415,882 | 496,245 | 517,969 |
| `settle` SHORT | 0 | 38,196 | 38,196 | 59,932 |
| `settle` SHORT | 1 | 53,474 | 135,479 | 157,215 |
| `settle` SHORT | 5 | 102,881 | 187,401 | 209,137 |
| `settle` SHORT | 30 | 411,729 | 496,245 | 517,981 |
| `setPayout` | - | 13,194 | 13,194 | 34,882 |
| `setOperator` | - | 27,106 | 27,106 | 48,678 |
| `list` December (RULE: two CREATE2, series and token) | - | 3,606,948 | 3,609,379 | 3,631,107 |
| `list` November (SEEDED) | - | 3,536,582 | 3,539,013 | 3,560,741 |
| `createMarket` (Kuru V1's real `deployProxy`, fork; on the MockKuruRouter LIMIT 1,892,754) | - | 1,237,504 | 1,247,597 | 1,269,029 |
| `attachMarket` (replaces a paused market; reads Kuru's `verifiedMarket`) | - | 65,305 | 65,305 | 87,245 |
| `drip` (an address's first) | - | 70,868 | 70,868 | 91,932 |

Router flows, the user with a standing allowance (December before its first day, so streamOut makes no index call):

| Flow | LIMIT on Kuru V1 (fork) | tx on Kuru V1 | LIMIT on the mock book |
|---|---|---|---|
| `openLong`, one maker order crossed | 258,519 | 280,919 | 219,738 |
| `openLong`, two maker orders crossed | 289,355 | 311,779 | 271,269 |
| `openLongDaily`, parts 8 (parts 1 on the mock: 299,793) | 933,246 | 956,154 | 894,465 |
| `openShort`, parts 8 (parts 1 on the mock: 384,242) | 986,838 | 1,009,862 | 941,745 |
| `closeLong` | 246,339 | 268,715 | 201,246 |
| `closeShort`, one id | 288,130 | 310,798 | 249,349 |
| `closeShort`, two ids | 320,039 | 342,847 | 281,258 |
| `closeLongDaily`, one id | 373,915 | 396,547 | 328,822 |
| `closeLongDaily`, two ids | 403,998 | 426,770 | 358,905 |
| `openLong` with a permit (the first click on an asset; mock) | - | - | 269,345 (+49,607) |

On these flows used equals LIMIT. Each extra part of `openLongDaily` or `openShort` adds about 80,000 to 85,000, each
extra id of `closeShort` or `closeLongDaily` about 30,000 to 32,000, each extra maker order crossed about 31,000 on
Kuru (45,000 to 52,000 on the mock).

**FIX_CALL_GAS (12.4 item 6).** The cold `finalFix` of the real `AgateIndex` (`test/market/gas/FinalFixGas.t.sol`):
7,314 for a final record (three cold slots; the same on the production clock with 15 slots and on the demo clock with
3), 2,829 for a day without one; the smallest gas at which it answers is the same, and the cold account access
(2,600) is the caller's, paid out of SYNC_ROUND_GAS. FIX_CALL_GAS = 100,000 is 13.7 times that, and the test asserts at
least 3 times. At Monad's cold SLOAD price the same call is about 7,314 + 3 x 6,000 = 25,314, still under a third of
100,000; the testnet deploy measures it on the deployed wall.

### Tests

- `test/market/invariant/`: `MarketHandler` drives every series function and every router flow (five actors, a maker
  re-quoting a MockKuruOrderBook, donations, token transfers, time jumps up to 70 days, syncs at random gas limits)
  over one of three listed Novembers per run, each run with a random index month (15 percent of days outside the
  band, late and carried records, some indexes that stop or revert). `SeriesInvariant.t.sol`: I1, I1b, I2 to I5, I9
  (everyone exits in `afterInvariant`, with assertions), I12, I26, I29, I30, I31, I36; `RouterInvariant.t.sol`: I25,
  I33, I37. `NegativeControls.t.sol`: each negative-control harness (`Harness.sol`, deployed through the test factory
  `NCFactory`) driven by the same handler in runs of 128 calls must be caught by its invariant within 256 runs
  (complement I1b, floor_mint I1, unstream_short I1, unchecked_top I1, operator_self I30, no_gas_reserve I26,
  keep_surplus I25, any_owner I33), and the same driver on the correct contracts finds nothing. The series index sits
  behind `StarveIndex`, whose finalFix fails fast when starved: an index call that merely runs out of gas burns all it
  was given and leaves the caller too little to force a day, so only a fast failure can show what the gas rule
  prevents.
- `test/market/fork/KuruV1.t.sol`: createMarket through Kuru's Router (address equals `computeAddress`,
  `verifiedMarket` and `marketState` checked, a front-run recorded), every router flow against a maker resting orders
  from the real MarginAccount with the router's wallet and MarginAccount balances 0 after each, the exact-depth close
  (exact cost plus $10 returns 9,999,540 u), the address(0) simulation equal to the fill, Trade events decoded.
  Skipped without `MONAD_FORK_URL`; `script/rehearse-market.sh fork-test` serves it.
- `test/market/gas/`: the table above.
- `test/market/series/Immutability.t.sol` (I15): no reachable DELEGATECALL, CALLCODE or SELFDESTRUCT in the series,
  the token, the factory or the router (PUSH data skipped, and after a halting opcode nothing until the next
  JUMPDEST: via_ir keeps 32-byte constants as data after the final INVALID), and no owner, pause or upgrade entry.
- `test/market/router/Slippage.t.sol`: the router's own `SlippageExceeded` on buys and sells, against a venue that
  under-delivers without reverting.
- `test/market/audit/`: adversarial probes; the ones that showed a hole assert the fixed behaviour
  (`*_FIXED_*`). `KuruSquatFork.t.sol` is a fork test: it skips like `test/market/fork/`, and
  `script/rehearse-market.sh fork-test` runs it too.
