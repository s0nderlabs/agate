---
slug: the-price
title: How the price is made
description: The clouds' own price pages, read hourly, combined as a median of companies, written onchain and countersigned.
group: Concepts
order: 4
source: 'wall/packages/sources, contracts/src/AgateIndex.sol'
---

# One number per GPU per day, made in the open.

The Agate index is one number per GPU per day: what it costs to rent that GPU for an hour on demand, taken from the
clouds' own public price pages, combined in the open and written onchain on Monad. This page is the method in full:
what is read, how a day's price is computed, who checks it, and what happens when something goes wrong. The
contracts enforce every rule below; nothing here depends on trusting a person to type a number.

Live values: the app's **Index** page, or `GET https://agate.elpabl0.xyz/api/v1/prices` ([Developer API](08-api.md)).

## 1. What the number is

For each GPU: the **posted on-demand list price per GPU-hour**, in US dollars, excluding VAT.

- **The product:** the exact GPU in its SXM form (H100, H200, B200, B300, A100 80GB); L40S, which only exists as a
  PCIe card, in PCIe. Never PCIe variants of the others, NVL racks, or other chips.
- **The price class:** on-demand only. Never spot, preemptible, reserved or committed, cluster, serverless or
  marketplace prices.
- **The instance:** the per-GPU price of the 8-GPU on-demand instance, or the 1-GPU one when a cloud has no 8-GPU
  instance; never 2- or 4-GPU sizes. A price per instance is divided by its GPU count (8 GPUs at $49.24 an hour is
  $6.16 per GPU-hour, rounded to the cent, halves up).
- **Dates:** a price shown "from date X" counts from 00:00 UTC on X.
- **Availability:** a row shown sold out, waitlisted, "contact sales" or "coming soon" counts as no price that hour.
- **Sanity bounds:** a value outside $0.10 to $1,000 per GPU-hour counts as no price.
- **No memory in the readers:** they read and report. No averaging, smoothing or filtering happens before the
  contract.

All arithmetic is in whole numbers (millionths of a dollar on a cent grid); there are no floating-point steps.

## 2. The sources

The clouds' own pricing pages, one vote per company. Today's panels:

| GPU | Counted | Reserve |
|---|---|---|
| H100 | Verda, Nebius, Lambda, CoreWeave, Civo | Hyperstack |
| H200 | Verda, Nebius, CoreWeave, Civo, Hyperstack | |
| B200 | Verda, Nebius, Lambda, CoreWeave, Hyperstack | |
| B300 | Verda, Nebius, Civo | Hyperstack |
| A100 | Verda, Lambda, CoreWeave | Hyperstack |
| L40S | Verda, CoreWeave, Civo | |

- **Odd counts on purpose.** The price is a median; with an even number of sources it would be the mean of the two
  middle ones, which a single source can move. A **reserve** source is registered but not counted, and steps in to
  keep the count odd if a counted one leaves.
- **Who is never read:** clouds that asked us not to read them, and public price trackers. Trackers are used only to
  check our readings (section 6), never as an input.
- Every source's day price is published beside the index price, in the app and onchain.

## 3. A day's price

Days are UTC days. Each cloud's page is read once an hour (24 readings a day) by each of two independent writers.

1. **Each cloud's day price** is the average of its readings that day, and needs at least **12 of the 24**.
2. **The day's index price** is the **median across companies** of those day prices, to the cent.
3. **A cloud that goes dark** (fewer than 12 good readings) is held at its last day price for up to **5 days**, then
   leaves the median. It comes back on its first good day.
4. **A new source joins only on the 1st of a month**, so a panel never changes in the middle of a month that is being
   traded.
5. **Status:** each day is labelled by how many companies were fresh that day: FULL (5 or more), DEGRADED (3 or 4),
   DEMO (fewer). On Monad testnet the index runs under a DEMO label with a minimum of one fresh source to close a day;
   a mainnet index would require at least three.

## 4. From readings to a final price

```
 the clouds' pages, read hourly
        |                         \
 writer 1: Chainlink CRE workflow   writer 2: standby        watcher: its own hourly reading of the same pages
        |                         /                                   |
        v                        v                                    v
 AgateIndex keeps each writer's readings apart  <-------  attester: countersigns or replaces a changed day
        |                                                  guardian (a person): can veto a day before it is final
        v
 day closes 1 h after it ends  ->  final 6 h later (unchanged)  or  only once countersigned (changed)
```

- **Two writers, kept apart.** The primary writer is a Chainlink CRE workflow: each run fetches every page through
  CRE's HTTP capability, the nodes agree on each parsed number, and it reports through Chainlink's forwarder. A standby
  writer reads the same pages on its own. The contract keeps each writer's readings separately and computes the day
  from **one** writer's readings, never a mix.
- **Close:** one hour after the day ends (01:00 UTC) the day is closed, and the contract computes the price itself
  from the stored readings.
- **Final:**
  - If nothing changed (same price, same sources), the day becomes **final 6 hours later** (about 07:00 UTC).
  - If anything changed, it becomes final **only when a second, independent key countersigns** that exact record:
    the attester, which judges it against the watcher's own readings of the same pages, or a guardian. The attester can
    instead **select** the other writer's record of the same day when that one is right.
- **Only final days count.** Markets read only final days.

## 5. When something goes wrong

- **A wrong day:** a guardian (a person) can veto a day before it is final; the day is then recomputed. A veto can
  only hit the exact record the guardian checked.
- **A misbehaving writer:** a guardian can suspend it; the other writer carries on.
- **No usable data:** a day with no quorum is **carried** after 24 hours at the day before's price, labelled
  "carried, unverified" in the app and `CARRIED` onchain. A changed record nobody countersigns is dropped after 7 days.
- **Bounded delay:** with a person acting, no day becomes final later than two days after it ends.
- **Markets never get stuck:** a market day with no final price 60 days after it ended takes the last value that
  market applied, so every month settles.

## 6. Watching the readers, and changing them

- **Page check:** every hour each reading is compared with what public trackers list for the same cloud and GPU; a gap
  above 10% raises an alert for a person to look at. It catches the failure every reader shares: a parser quietly
  reading the wrong cell.
- **When a cloud changes its page:** a repair agent drafts a new reader, and a person approves it. The change is
  queued publicly onchain with its reason and takes effect only after **48 hours**, at the start of a day. Days
  already recorded never change.
- **Other changes** to the index (new GPUs aside) go through the same 48-hour public queue.

## 7. What a month pays

Each monthly market reads the index's final day prices for that month. Each day's price is kept inside the month's
floor and ceiling, and the month's token pays the average of those 30 (or 28 to 31) days. The floor and ceiling are
fixed when the month is listed, from five final days of the index: the rule and a worked example are in
[The monthly market](05-the-market.md#the-floor-and-the-ceiling).

## 8. Check it yourself

- **Onchain:** the index contract on Monad testnet is
  [`0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36`](https://testnet.monadexplorer.com/address/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36).
  Each day emits `DayClosed` (price, status, fresh companies) and `RecordSlots` (every source's day price and whether
  it counted); `Attested`, `Vetoed`, `RecordReplaced` and `DayCarried` record every check.
- **API:** `GET /v1/prices/{gpu}` gives each source's price beside the median, and the daily history.
- **Code:** the readers and the recipe in `wall/packages/sources`, the contract in `contracts/src`.

One real day, H100 on Oct 9 2026 (day id 20735), checked from a terminal:

```sh
curl -s https://agate.elpabl0.xyz/api/v1/prices/H100 | jq -c '[.date, .price, [.sources[] | [.company, .price]]]'
```

```text
["2026-10-09",3.99,[["Verda",3.92],["Nebius",4.5],["Lambda",3.99],["CoreWeave",6.16],["Civo",2.99],["Hyperstack",null]]]
```

Five companies counted (Hyperstack is the panel's reserve, not counted that day). Sorted, their day prices are $2.99,
$3.92, **$3.99**, $4.50, $6.16: the median is $3.99. The contract says the same:

```sh
cast call 0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36 "finalFix(bytes32,uint32)(bool,uint32,uint8,uint8,bool,bool)" \
  0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955 20735 --rpc-url https://testnet-rpc.monad.xyz
```

```text
true
3990000 [3.99e6]
2
4
false
false
```

Final (`true`), $3.99 (millionths of a dollar), status `2` (DEGRADED, see below), 4 companies fresh (enough clean readings that day), 1 held (counted at its last good day price, rule 3 above), not
late, not incomplete. The day was
closed by the CRE writer in transaction
[`0x67a75408...`](https://testnet.monadexplorer.com/tx/0x67a754089eb2117e7b76a17c6c58467178322d66b6771804631245f35aefef87)
(block 69,688,641), whose `DayClosed` and `RecordSlots` events carry the same numbers per source.

| `status` | Name | Meaning |
|---|---|---|
| 0 | NONE | no record |
| 1 | FULL | 5 or more companies fresh |
| 2 | DEGRADED | 3 or 4 companies fresh |
| 3 | DEMO | fewer than 3 (allowed only on testnet) |
| 4 | CARRIED | no usable data: the day before's price, carried |

Each GPU's `gpuId` is the keccak256 of its spec string (H100: `cast keccak "H100-SXM/on-demand-list/neocloud/v1"`),
checked at deploy (`contracts/script/DeployIndex.s.sol`); the six, from `contracts/script/config/testnet-production.json`:

| GPU | `gpuId` |
|---|---|
| H100 | `0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955` |
| H200 | `0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d` |
| B200 | `0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27` |
| B300 | `0x08c6236b69837cbbc194f0e5543b52ec92d53b309e164e1139b0076f2151b07f` |
| A100 | `0x32422c52fa2c8e908a3d943000e08e47ac121b194f11f4d58f0149ef008418de` |
| L40S | `0x5d0a54c25c386ef135340ebc802b2bc2538004e5538d436114a5b3c9398b30e4` |

## 9. Limits, stated

- These are **posted list prices**, not prices clouds actually transact at. Clouds change their list prices in steps,
  so the index moves rarely and in steps (for example, an H100 list price can sit unchanged for weeks).
- On testnet the index runs under the DEMO label with a minimum of one fresh source.
- The CRE workflow runs in Chainlink's simulator (`cre workflow simulate --broadcast`), which is one node: until a
  deployment on Chainlink's network, the CRE writer's agreement step is not decentralized. The second writer and the
  attester's countersign still apply.
