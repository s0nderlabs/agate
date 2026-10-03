# wall

The index's offchain side, as Bun workspaces: the price readers and the recipe (`packages/sources`), the report
encoding and shared types (`packages/report`), the two writers (`apps/writer-cre`, the Chainlink CRE workflow and its
runner; `apps/writer-standby`), the watcher with its logger, attester, keeper and health (`apps/watcher`), the
guardian CLI (`apps/guardian`), the page check (`apps/pagecheck`), the repair agent (`apps/repair`), the Akash reader
(`apps/akash`), the market bots (`apps/marketmaker`, `apps/payer`, `packages/market`) and the end-to-end harness
(`e2e`). Each app has its own README.

## GPUs

Six GPUs get an index price: H100, H200 and B200, each with a market, and B300 (SXM), A100 (SXM4 80GB) and L40S
(PCIe), which are priced only. The list lives in one place, `GPUS` in `packages/sources/src/pure/recipe.ts` (with
`GpuModel` in `packages/report/src/types.ts`): the writers, the watcher, the guardian, the page check and the repair
agent take it from there, and a report carries one entry per GPU its index registers, from the panel file
(`packages/sources/panels/launch.json` for the two launch indexes, `default.json` for tests). A deploy config's
`gpus` comes from the panel file through `bun run packages/sources/scripts/deploy-gpus.ts <config name>`: a testnet
config takes `launch.json` only (default.json's L40S has one live source and its A100 is another set; a test pins every
`contracts/script/config/testnet-*.json` to launch.json's entries), the local and fork configs `default.json`. The market keeps three:
the factories of `contracts/script/config/market-*.json` list H100, H200 and B200, and the lister and the maker serve
only their factory's GPUs, whatever the index prices.

## Tests

```sh
bun install
bun run typecheck
bun test
```

Archive tests read the logger's saved pages from `AGATE_RAW_DIR` (default `~/.agate-index-logger/data/raw`) and skip
without them. Tests that compare with research files kept outside the repo read them from `AGATE_PRICE_ONLY_READINGS`,
`AGATE_TRACKER_SAMPLES` and `AGATE_TRACKER_SAMPLES_OCT3`, and skip with a printed line when those are unset. Every
local chain starts through `scripts/anvil-safe.sh` (pruned history, a private HOME removed on exit, no start under
30 GB free, at most 12 at once); the chain tests need `anvil` and a `forge build` of `contracts/`.

End to end and chaos, each scenario on its own local anvil with the real AgateIndex:

```sh
bun run e2e/scripts/run.ts --list
bun run e2e/scripts/run.ts [name ...]          # no name: every scenario
```

The base runs (`fast-base`, `fast-archive-full`, `fast-long-150d`, `demo-base`) and `coreweave-launch-panel` register
all six GPUs; `demo-base` runs them on the DEMO clock (six closes a 600 s day). The chaos scenarios keep H100 alone.

The market on a fork of Monad testnet (the network is read once; every transaction goes to the loopback fork):

```sh
AGATE_MARKET_E2E=1 AGATE_FORGE_OUT=<forge out dir> AGATE_FORGE_CACHE=<forge cache dir> bun test e2e/test/market-fork.test.ts
```

The fork's index registers the six GPUs of `fork-demo.json`, its factory three; the run checks that the lister lists
and the maker quotes only those three.

## Gas with six GPUs

`bun run e2e/scripts/gas.ts --gwei <price> [--run-hours <h>]` measures every call below on a local anvil and prints
the limits, the MON a day per key and what each key needs for a run of that length. Monad bills a transaction's gas
limit, not the gas it uses, so the limits set the cost.

Measured on Oct 3 2026, receipts' `gasUsed` (intrinsic gas and calldata included; the PRODUCTION and DEMO clocks gave
the same figures to within 12 gas). Cold is a writer's first slice of a day for those GPUs (its accumulators are new
storage), warm any later slice. Launch slots: H100 6, H200 5, B200 5, B300 4, A100 4, L40S 3 (27 in all); worst case:
15 slots in 15 families per GPU, the contract's maximum.

| One report | 3 entries, cold / warm | 6 entries, cold / warm |
|---|---|---|
| `postReport`, launch slots | 325,747 / 171,883 | 610,276 / 302,548 |
| `postReport`, 15 slots per GPU | 512,744 / 256,280 | 994,276 / 481,348 |
| `onReport` through the test MockForwarder, launch slots | 335,221 / 181,357 | 619,950 / 312,222 |
| `onReport` through the test MockForwarder, 15 slots per GPU | 522,399 / 265,935 | 1,004,357 / 491,429 |
| `onReport` through the CRE simulation forwarder's own code, cold: used / least limit that lands | | launch 646,829 / 671,908; 15 slots 1,032,119 / 1,075,276 |

The CRE simulation forwarder (the one the primary writes through, `0xB9F79d86...D192` on Monad testnet) parses the
Keystone metadata, records the transmission and asks for ERC165 before its try/catch, and keeps a 64th of the gas back
around that call: a report lands only from a limit above its `gasUsed`
(`apps/writer-standby/test/adversarial/six-entry-sim-forwarder.test.ts` runs its bytecode from foundry's RPC cache
and prints both).

| Per GPU, one call each | H100 | H200 | B200 | B300 | A100 | L40S | 15 slots |
|---|---|---|---|---|---|---|---|
| `closeDay` (first writer quorate) | 275,103 | 265,787 | 265,775 | 243,052 | 243,028 | 234,814 | 455,413 |
| `attest` (countersign) | 69,584 | 69,596 | 69,584 | 69,596 | 69,560 | 69,596 | 69,596 |
| `carryDay` (the keeper; a no-data day with the miss advance) | 326,147 | 314,499 | 314,487 | 232,930 | 232,906 | 227,765 | 380,884 to 546,555 |

`closeDay`'s worst case (the first writer below quorum, both writers computed; `forge test --gas-report --isolate`):
630,284 at 15 slots (MEASURED 630,218), 358,353 at 6 slots, the most a launch GPU has
(`contracts/test/gas/LaunchPanelGas.t.sol`).

**Limits.** The writers send `min(CAP, ceil(1.5 x max(estimate, MEASURED)))` with `CAP = 2 x MEASURED`
(`apps/writer-standby/src/pipeline/sender.ts`), and the CRE run's `writeReport` uses `ceil(1.5 x MEASURED onReport)`.
MEASURED for a report is now the measured six-entry shape (prices with more nonzero bytes use up to about 1,200 more, which the 1.5x limit holds): `postReport` 994,276 (receipt) and `onReport` 1,076,000, the
least limit at which a cold 6 x 15 report lands through the CRE simulation forwarder's own code (1,075,276), rounded up
to 1,000 (they were 512,718 and 518,247 at three entries). So the standby's report limit is 1,491,414 (anvil's
estimate of a 6 x 15 report, 1,008,987, gives 1,513,481, under the cap of 1,988,552) and the CRE workflow's `gasLimit`
is 1,614,000, a full 1.5x over that least landing limit (anvil has run 15 to 45% under Monad). It was 777,371, which
a 6 x 15 report runs out of inside the forwarder's try/catch: a transaction that writes nothing
(`apps/writer-standby/test/six-entry-gas.test.ts` pins both). A six-entry report through the real
`cre workflow simulate --broadcast` at 1,614,000 lands every GPU's slice (`AGATE_CRE_SIMULATE=1 bun test
apps/writer-cre/test/cre-simulate.test.ts`, run on Oct 3 2026: 643,461 gas used cold on default.json's 22 slots).
`AGATE_GAS_POST` and `AGATE_GAS_ONREPORT` override them. `closeDay` keeps MEASURED 630,218 (a close is per GPU): limit 945,327. The watcher's `attest` and
`carryDay` without `AGATE_GAS_MEASURED` send 1.5 x their estimate (about 105,000 and up to 498,111). Unchanged by six
GPUs: every per-GPU call, and the market's `SyncGasLow` guard (a series syncs its own GPU only).

**MON a real day per key**, at 102 gwei (Monad testnet `eth_gasPrice`, read once on Oct 3 2026 at 12:25 UTC: base fee
100 gwei plus a 2 gwei tip):

| Key | DEMO (600 s day: 144 index days and 576 slices a real day) | Real calendar (one day, 24 slices) |
|---|---|---|
| primary (CRE) | 178.1: 576 reports x 1,614,000 + 864 closes x 945,327 | 4.53 |
| standby | 87.6: 576 reports x 1,491,414 | 3.65 |
| attester | up to 9.3 (a countersign per GPU and day; only a changed record needs one) | up to 0.06 |
| keeper | 0 on a day the writers close; up to 43.9 if every GPU's day were carried | up to 0.30 |

For comparison, three GPUs at the earlier limits: DEMO primary 87.3 and standby 45.2 MON a day.

**Funding a DEMO run.** On the DEMO clock a key holding 10 MON pays for about 80 minutes of the primary's sends. Fund
each key for the run (`--run-hours`): at 102 gwei, 10 days from Oct 4 to the Oct 14 deadline need about 1,781 MON on
the primary, 876 on the standby and up to 93 on the attester (keys holding 100, 100 and 50 MON last about 13 hours,
27 hours and 5 days). Or, for a DEMO index that registers exactly the launch panel, cut the limits to that panel's own
worst cases with the overrides: `AGATE_GAS_ONREPORT=672000` (its least landing limit through the simulation
forwarder, 671,908, rounded up: CRE limit 1,008,000), `AGATE_GAS_POST=619063` (anvil's estimate of a cold launch
report: limit 928,595) and `AGATE_GAS_CLOSE=358353` (limit 537,530). That costs about 106.6 MON a day on the primary
and 54.6 on the standby. These override figures are anvil's; Monad has estimated 15 to 45% above anvil (13.4), and the sender refuses any send estimated above 4/3 of its MEASURED (GAS_CAP), so before using them take each one from Monad testnet itself: the receipt and `eth_estimateGas` of the first cold launch report and close on that index, run with the shipped defaults. Measure them again before any GPU or slot is added to that index.

**KEY_LOW.** `watcher health` raises KEY_LOW for a key under 10 MON, and for one holding less than
`AGATE_KEY_LOW_HOURS` (default 24) of its own spend at the rate it saw over the last max(1 h, DAY) (top-ups are not
spending): on the DEMO clock the primary is flagged half an hour after start unless it holds a day of its sends, about
178 MON.
