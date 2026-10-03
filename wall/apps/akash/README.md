# @agate/akash: the Akash traded-price reader (BUILD-SPEC 16)

A display number for the comparison panel: what H100s actually rent for on the Akash chain, labelled **"traded, Akash chain"**. **Display only: never an agate index input, never a settlement value.** No key, no RPC of ours, no transaction; it reads Akash's public REST endpoints with an honest user agent (`agate-wall/akash/0.1 (+https://github.com/s0nderlabs/agate)`).

## Run

```
bun run apps/akash/src/cli.ts run      # one run, then exit (0 ok, 1 every endpoint failed)
bun run apps/akash/src/cli.ts watch    # every AGATE_AKASH_INTERVAL_S (default 3,600 s)
```

Env: `AGATE_WALL_HOME` (default `~/.agate-wall`), `AGATE_AKASH_INTERVAL_S` (at least 60), `AGATE_AKASH_ENDPOINTS` (comma-separated REST bases; default `https://api.akashnet.net`, `https://akash-api.polkachu.com`, `https://rest-akash.ecostake.com`, `https://akash-rest.publicnode.com`). It refuses to start with any `*_KEY`, `*_KEY_CMD` or `CRE_ETH_PRIVATE_KEY` variable set, and takes a lock (`akash/akash.lock`) so only one copy runs. launchd: `launchd/xyz.s0nderlabs.agate-akash.plist.template` (not loaded; Label `xyz.s0nderlabs.agate-akash`). Heartbeat: `akash/heartbeat.json` (period: its interval).

## Method (16)

1. Block time: the latest header and the one 10,000 blocks earlier; `blockMs` in whole milliseconds, half up.
2. Active leases: `akash/market/v1beta5/leases/list?filters.state=active&pagination.limit=1000`, every page.
3. Group specs from the cache `akash/groups.json` (kept to the groups of active leases); missing ones by `akash/deployment/v1beta4/deployments/info` (at most 200 deployments a run), more than that (the first run) by the active `deployments/list` in pages of 500.
4. A lease counts for a GPU when every GPU resource of its group names exactly one model (`vendor/<v>/model/<m>[/...]`, the model segment equal to `h100`, `h200` or `b200`) and all name the same one. A resource naming several models or none, or a group mixing models, excludes the lease (`excluded.ambiguousModel`, counted for every GPU it names); another denom than `uact` is `excluded.otherDenom`. Units = sum of `gpu.units * count`.
5. Per GPU-hour, exact integers: `u = round_half_up(amount_uact_per_block * 3,600,000 / blockMs / units)`; the amount is the chain's 18-decimal string. 1 uact is read as 1 u (10^-6 USD) because ACT is pegged at 1 USD by Akash's design (a claim, not verified by agate; the output says so).
6. GPU-weighted median (each lease counts `units` times; odd: the middle; even: the mean of the two middle, half up to a whole u), nearest-rank p25 and p75 (rank `ceil(p * n / 100)`), min, max, sellers (providers), buyers (owners), the top buyer's and top seller's share of the GPUs in basis points (floor).
7. Endpoints in order; a read that fails is retried once on the same endpoint, then the whole run moves to the next endpoint (an error, a 60 s timeout, or a chain id other than `akashnet-2`), so one run's numbers always come from one endpoint.

## Verified with real read-only calls (Oct 3 2026, 01:47 to 02:03 WIB; n = 2 runs)

- `api.akashnet.net/cosmos/bank/v1beta1/denoms_metadata/uact`: base `uact` of the **Akash Compute Token (ACT)**, `act` exponent 6. Every active lease price was `{denom: "uact", amount: "<18-decimal string>"}`, **per block**.
- Block time: **5,894 ms** over 10,000 blocks (heights 28,879,293 to 28,889,293, 2026-10-02 02:25:01.627 to 18:47:23.243 UTC); the same 5,894 ms in both runs.
- Live run 1 (no cache, 6 min 49 s: `api.akashnet.net` timed out on a deployments page, `akash-api.polkachu.com` served the run) and run 2 (cached groups, 64 s, `api.akashnet.net`): 1,399 active leases; **H100: 36 exactly-H100 leases, 40 GPUs, 3 sellers, 3 buyers, top buyer 70.00% of the GPUs; median 2.60 (2,604,011 u), p25 2.60, p75 2.66, max 3.33**; 4 GPUs state SXM, 36 no interface; 28 leases excluded as ambiguous (they also accept other models); no exactly-H200 or exactly-B200 lease. The spec's snapshot (Oct 2 18:36 UTC) had 35 leases, 39 GPUs and 2 buyers: one lease was added since.

## Output (for the app and the indexer)

`<AGATE_WALL_HOME>/akash/akash-traded.json`, written atomically every run, and one line per run in `akash/history/<UTC date>.jsonl`:

```json
{
  "kind": "agate.akash-traded", "version": 1,
  "label": "traded, Akash chain", "displayOnly": true,
  "generatedAt": 1790967845,
  "chain": { "id": "akashnet-2", "height": 28889444, "time": "2026-10-02T19:02:16.319941301Z" },
  "endpoint": "api.akashnet.net",
  "blockMs": 5894, "blockMsOverBlocks": 10000,
  "unit": { "denom": "uact", "act": "ACT", "uactPerAct": 1000000, "usdPerAct": "1 (Akash's peg, not verified by agate)" },
  "gpus": {
    "H100": {
      "median": "2.60", "medianU": 2604011, "p25U": 2604011, "p75U": 2664144, "minU": 2604011, "maxU": 3330721,
      "gpus": 40, "leases": 36, "sellers": 3, "buyers": 3,
      "topBuyerGpuShareBps": 7000, "topSellerGpuShareBps": 7000,
      "interfaces": { "sxm": 4, "pcie": 0, "unstated": 36 },
      "excluded": { "ambiguousModel": 28, "otherDenom": 0 }
    }
  },
  "leasesSeen": 1399, "missingGroups": 0,
  "notes": "Price per GPU-hour of active leases, GPU-weighted median; a lease's price covers its whole bundle (GPU, CPU, memory, storage). Display only, never an agate index input.",
  "error": null
}
```

Field notes for the app:
- Show `median` (USD per GPU-hour, cents) with the label, and **always the seller and buyer counts** (`sellers`, `buyers`): a thin, concentrated market. Every `*U` value is u (10^-6 USD) per GPU-hour.
- `H100` is always present; with no exactly-H100 lease its prices are `null` and its counts 0. `H200` and `B200` appear only when an exactly-modelled lease exists.
- `interfaces` counts GPUs; `excluded.*` counts leases. `leasesSeen` is every active lease read (GPU or not); `missingGroups` counts leases whose group could not be read (left out, never guessed). These two fields are additions to the spec's shape.
- A run that fails everywhere keeps the last good numbers and sets `error` to a short reason (the endpoints are public; no secret can appear). `generatedAt` then stays the last good run's time.
- Server-side use: `computeTraded(leases, groups, blockMs)` in `src/akash.ts` is pure (no Node, Bun or DOM API), so the hosted app can compute the same numbers itself; how the file reaches the hosted app is the app's choice (17.4 item 2).

## Tests

`bun test apps/akash`: the conversion vectors of 16 (4,263.344103 uact per block gives 2,604,011 u at 5,894 ms and 2,603,569 u at 5,895 ms), half-up ties, the weighted median (odd, even, one lease) and percentiles, ambiguous, mixed and other-denom exclusions, units from `units * count`, sellers, buyers and shares, interface buckets, the block-time measurement, the group cache (incremental lookups, the 200 cap switching to the list), lease paging, endpoint failover on mock servers (an error, a hang, a wrong chain id), the output shape, a failed run keeping the last good file, the key guard, the launchd template.
