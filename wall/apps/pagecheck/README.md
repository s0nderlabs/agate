# @agate/pagecheck: the free page check (BUILD-SPEC 15.1)

Compares each panel cloud's reading in the watcher's log with the trackers' listed price for the same cloud and GPU, to catch the failure every reader shares: a parser that silently reads the wrong cell. **Alert only**: no key, no RPC, no transaction, never in the price path, never imported by a writer or the watcher (a test greps the imports). It replaces the AI check ("Jev"), which this build does not have.

## Run

```
bun run apps/pagecheck/src/main.ts      # one process per index
```

Env: `AGATE_INDEX`, `AGATE_PANELS` (`Panel[]` or `{panels}`), `AGATE_WALL_HOME` (default `~/.agate-wall`), `AGATE_WATCHER_LOG_DIR` (when the watcher's log is not `<home>/watcher/<index>`), `TRACKER_BASE_URL` (a replayed index: the replay server's `/t_gputable` and `/t_gpu_economy/<h100-sxm|h200|b200|b300|a100-80|l40s>` routes; the page time header `X-Agate-Page-Time` then decides staleness), `AGATE_NOTIFY_CMD`. It refuses to start with any `*_KEY`, `*_KEY_CMD` or `CRE_ETH_PRIVATE_KEY` variable set, takes `pagecheck/<index8>.lock`, and waits for the watcher's `clocks.json` (it reads the index clock from there, read only). launchd: `launchd/xyz.s0nderlabs.agate-pagecheck.plist.template` (not loaded; Label `xyz.s0nderlabs.agate-pagecheck-<index8>`). Heartbeat: `pagecheck/heartbeat-<index8>.json` (period one slice).

## What it reads and compares

- **Trackers.** GPU Economy's per-GPU files (`https://gpueconomy.com/gpu/{h100-sxm,h200,b200,b300,a100-80,l40s}/prices.json`, CC BY 4.0, attribution "GPU Economy (https://gpueconomy.com)") first. GPUTable (`https://gputable.dev/data.json`, free with attribution, keep its `source_url` intact) only per pair, when GPU Economy's file failed, its `data_updated_at` is more than 26 h older than the page time, or it has no usable row. Never GPUTable's Hyperstack H100 row (its PCIe price labelled SXM) or any Together row, and never Hyperstack's A100 in either tracker (both list its PCIe A100 at $1.35 where our row is its SXM A100 at $1.60: an 18.5% gap in 64 of 64 archived hours); that pair is not compared. Runpod, Runpod Community and Crusoe rows are dropped by provider name before any other field is read. Tracker bodies are parsed with `JSON.parse` only and only the named fields are read.
- **GPUs** (GPU Economy file / GPUTable `gpu`): H100 `h100-sxm` / `H100 SXM`, H200 `h200` / `H200`, B200 `b200` / `B200`, B300 `b300` / `B300`, A100 `a100-80` / `A100 SXM`, L40S `l40s` / `L40S`. GPUTable has no Civo B300 row (no compare, not an alarm).
- **Mapping:** p_verda `datacrunch` / `Verda`; p_nebius `nebius` / `Nebius`; p_lambda `lambda` / `Lambda Labs`; p_coreweave `coreweave` / `CoreWeave`; p_civo `civo` / `Civo`; p_hyperstack `hyperstack` / `Hyperstack`; p_seeweb and p_gcore are not compared.
- **Rows:** GPU Economy `price_type == "on_demand"` and `status == "live"`, value `usd_per_gpu_hour`; GPUTable `pricing_type == "on_demand"` and `commitment_months == null`, value `price_per_hour_usd` (already per GPU). Then 8-GPU rows, else 1-GPU rows, else all; of those the nearest to our value (ties: the lower). Decimals become u exactly (half up beyond six decimals; no float arithmetic).
- **Schedule:** one fetch per tracker file per interval (inside the first 19/20 of the interval; GPUTable only when some pair needs the fallback), timeout `min(40 s, slice / 10)`, one retry. Interval k is compared shortly after it ends (`min(120 s, slice / 4)`), against the watcher's VALID reading of that interval. An interval the page check did not see is never compared (it never reads a past tracker hour).
- **Gap:** `10 * |own - t| > t` (exactly 10% is not a gap).

## Alerts (through the watcher's alert sink, stamped with the index)

| Code | When | Severity | Id |
|---|---|---|---|
| PAGECHECK_REVIEW | the first gapped comparison of a run | info | `PAGECHECK_REVIEW:<gpuId>:-:<slot>:-@<index>` |
| PAGECHECK_FAULT | the run has lasted one DAY (start of interval k minus start of the run's first interval) with at least MIN_READINGS gapped comparisons: "likely parser fault" | action, no deadline | `PAGECHECK_FAULT:<gpuId>:-:<slot>:-@<index>` |
| PAGECHECK_TRACKERS_DOWN | no tracker row for any pair for DAY/4 of fetched intervals | info | `PAGECHECK_TRACKERS_DOWN:-:-:-:-@<index>` |

A compared interval within 10% ends the run and clears both alerts; an interval without a comparison (no VALID reading, no tracker row) neither ends nor extends it.

## Files (`<AGATE_WALL_HOME>/pagecheck/<index8>/`)

- `compare.jsonl`: one line per comparison: `{k, at, gpu, gpuId, slot, sourceId, own, t, tracker, row: {gpu_count, listed_since?, last_confirmed_at?}, gapBps, gap, fallback?}` (`fallback`: why GPUTable was used: `file-failed`, `stale`, `no-row`).
- `status.json` (for `guardian status` and the repair agent), written atomically after every compared interval:
  `{kind: "agate.pagecheck-status", index, at, lastComparedK, trackersDownIntervals, attribution, pairs: [{gpu, gpuId, slot, sourceId, lastK, own, t, tracker, gapBps, runStartK, runStartAt, gapped, faultRaised, state}]}` with `state` one of `ok`, `review`, `fault`, `unknown`. A restart resumes the runs from it.
- `raw/<UTC date>/<interval>/gpueconomy.<file>.gz`, `gputable.all.gz` and `meta.json` (`{k, at, fetched, failed}`): the repair agent's evidence; kept 14 days; never in the repo.

## Tests

`bun test apps/pagecheck` (synthetic tracker JSON in the trackers' field names, never a copy of a tracker file): row selection, the exclusions and skips, the fallback triggers, exact decimals, the 10% boundary, REVIEW once per run, FAULT at DAY with MIN_READINGS and not before, a run ended by a good comparison, gaps across missing intervals, TRACKERS_DOWN, no late reads, restart, raw retention, page time through replay-style routes, the key guard, the import grep, the launchd template. **Archive backtest** (skipped without `~/.agate-index-logger/data/raw`): our own parsers on the clouds' archived pages against GPUTable's archived `data.json` of the same hour, 51 hours to Oct 2 18 UTC: 765 comparisons, Hyperstack H100 never compared, and the only gaps are Nebius's 7 early hours (Sep 30 17 to 23 UTC, GPUTable already listing the Oct 1 prices; 3 GPUs each); driven through the page check on a PRODUCTION clock that raises REVIEW for those hours, clears it at 00 UTC, and never raises FAULT. The price-only GPUs over 64 hours to Oct 3 08 UTC: nine pairs compared every hour (576 comparisons), Hyperstack A100 never compared (in either tracker), and the only gaps are Nebius B300's same 7 early hours, which raise REVIEW and never FAULT. With `AGATE_TRACKER_SAMPLES` (the saved Oct 2 GPU Economy files of H100, H200 and B200) and `AGATE_TRACKER_SAMPLES_OCT3` (the Oct 3 files of B300, A100 and L40S) set, each GPU with a saved file is also compared against GPU Economy (16 of 16 and 10 of 10 pairs, no gap); unset, those tests are skipped.
