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
- **API:** `GET /v1/prices/{gpu}` gives each source's price beside the median, and the daily history. Each source
  row also carries `page`: the sha256 of the exact bytes of that cloud's page as the watcher fetched it that day, and
  when, so anyone holding a saved copy of the page can hash it and confirm it is the very page the price was checked
  against.
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

### Check any day yourself

The steps above check one day by hand. The SDK does the same for any day, reading only the chain: the source writer's
readings of that day as the index stores them (`readings(gpuId, day, writer)`: each cloud's sum and count of hourly
readings, kept for ever), then the rules of section 3 (each cloud's average to the cent, at least 12 readings, the hold
for up to 5 days, the median across companies), then a comparison with the stored record, its digest included. Which
clouds were being held, and at what price, depends on the days before, so it replays every day from the GPU's first
one the same way and reports any that disagree.

```sh
git clone https://github.com/s0nderlabs/agate && cd agate && bun install && cd client
bun run check-day H100 2026-10-09   # leave out the date for the newest final day
```

```text
H100 on 2026-10-09 (index day 20735), final, DEGRADED
Recomputed from Monad Testnet (chain 10143), index 0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36, source writer 0xf0be5c7461c0743acde590a22bccb66fc2112335

  company     readings  day price  counted
  Verda             24      $3.92  yes, at its day price
  Nebius             0          -  yes, at its last good day price $4.50 (under 12 readings)
  Lambda            24      $3.99  yes, at its day price
  CoreWeave         23      $6.16  yes, at its day price
  Civo              24      $2.99  yes, at its day price
  Hyperstack         0          -  no

Median of the 5 counted: $3.99
Stored $3.99, recomputed $3.99: MATCH (price, status, counts and the record's digest)
Replayed the 5 earlier days from 2026-10-04 for the held prices: each matches its record
```

In code it is `agate.checkDay({ gpu: "H100", date: "2026-10-09" })` ([SDK](10-sdk.md#check-any-day)), which returns
the stored and the recomputed price, whether they match, and each source's inputs. It uses the public RPC unless
`AGATE_RPC_URL` names another. It is not in the npm release yet: `@s0nderlabs/agate` gets it in its next version, so
until then run it from a clone as above.

On Oct 11 2026 every final day so far matched: Oct 4 to 10, all six GPUs, 42 of 42 days. What it checks is the
arithmetic from the stored readings; whether each reading matched the cloud's page is what the attester (section 4)
and the page check (section 6) watch. The hourly readings themselves are in each writer's `ReadingsPosted` events.

## 9. Why these rules

Each rule above was chosen against the alternatives, from how existing benchmarks and settlement contracts work, from
published research and failures, and from Agate's own tests. Where a rule rests only on Agate's own reasoning and tests,
this section says so.

| Rule | Why | What it rests on |
|---|---|---|
| **The median across companies, not the average** | An average moves with every input, so one wrong or dishonest source moves the price. A median stays inside the range of the honest sources until half of them are wrong. In Agate's test the median held with 2 bad inputs of 5 and 3 of 7; an average held with none. | Hampel (1971), [A General Qualitative Definition of Robustness](https://doi.org/10.1214/aoms/1177693054); Eisl, Jankowitsch and Subrahmanyam (2017), [The Manipulation Potential of Libor and Euribor](https://doi.org/10.1111/eufm.12126), which finds that alternative fixings "could significantly reduce the effect of manipulation"; the New York Fed's SOFR is a (volume-weighted) median; Agate's own test |
| **An odd number of sources** | With an even count a median is the mean of the two middle values, so a single source can move it again. | MakerDAO's [median contract](https://github.com/makerdao/median) refuses an even quorum |
| **One vote per company, and no trackers as inputs** | Feeds that copy each other are one opinion. Counting six price trackers as six votes moved one day's median by 6.6% in Agate's test, and an error they share moves the price instead of being outvoted. | Agate's own test; the Synthetix sKRW incident (2019), where two feeds of one wrong price were averaged |
| **One price class only (on-demand list prices)** | A median needs inputs that measure the same thing. Mixed with other price classes, the middle can jump with no price having changed. | Eskandari et al. (2021), [SoK: Oracles from the Ground Truth to Market Manipulation](https://doi.org/10.1145/3479722.3480994) |
| **A plain average inside the day, with no "must last 24 hours" rule** | A rule that only counts a price once it has persisted can be gamed by flickering the page: in Agate's test four of seven attack patterns moved one source's month by 13% to 14.5% under that rule, and none under a plain average of the day's readings. | Mackinga, Nadahalli and Wattenhofer (2022), [TWAP Oracle Attacks: Easier Done than Said?](https://eprint.iacr.org/2022/445); the CME CF Bitcoin Reference Rate (medians inside a slice, a mean across slices); Agate's own test |
| **"Fresh" means read that day, not "the value changed"** | List prices are unchanged on 98.4% to 99.7% of days in Agate's data, so a reader that silently stopped looks exactly like an honest unchanged price unless each day needs its own readings. | Agate's own data and reasoning |
| **A dark source is held 5 days, then leaves** | Holding a short time keeps one outage from moving the price; leaving after it keeps a dead source from voting for ever. | No source prescribes 5. The nearest practice is ISDA's 2005 Commodity Definitions (at most 5 days of disruption) and the LME's rules; the number is Agate's choice |
| **A minimum number of fresh sources, with a label below it** | A benchmark should say what the least data it will publish on is, and what happens below that. | IOSCO [Principles for Financial Benchmarks](https://www.iosco.org/library/pubdocs/pdf/IOSCOPD415.pdf) (2013), Principle 11; ISDA's reference-dealer fallback (at least three quotations) |
| **Values outside $0.10 to $1,000 count as no price; nothing is ever clamped into range** | A guard that quietly changes a number is itself a price source. Lending protocols lost money when a hard-coded floor or a rate limit substituted its own value for the market's. | The Venus and Blizz losses (2022); Aave's CAPO post-mortem (2026); the Moonwell cbETH mispricing (2026) |
| **Sources join or leave only on an announced date** | People holding a month's market must know in advance what will be measured. | IOSCO Principle 12 (advance notice and an exact effective date); EU Benchmarks Regulation, Article 13 |
| **A waiting period, and a second key that can stop a price but never write one** | A stolen writer key alone must not be able to make a price count, and a checker must not become a second writer. | MakerDAO's [Oracle Security Module](https://github.com/makerdao/osm) (a delay, `stop`, `void`); in Agate's test a per-day limit on one key still let a stolen writer move 87% to 98% of the maximum over a month |
| **A changed day needs a countersign; an unchanged one only waits** | Most days nothing changes, so the second check is spent where the risk is. | Agate's own reasoning and tests; no outside source |
| **A final day is never restated** | Contracts that have paid out cannot be re-run. | CME Rule 812; the ICE Swap Rate's no-republication policy; IOSCO Principle 11 |
| **A month pays the plain average of its days** | A renter pays every day, so the month's average is what a month of renting costs, and a wrong day moves it by only one part in the month's days. | All 14 monthly-average contracts Agate read settle this way, including NYMEX's [H100 rental futures filing](https://www.cftc.gov/filings/ptc/ptc08112615405.pdf) (Aug 2026) and ISDA's 2005 Commodity Definitions; Duffie and Stein (2015), [Reforming LIBOR and Other Financial Market Benchmarks](https://doi.org/10.1257/jep.29.2.191): a wider averaging window is harder to manipulate |
| **Every calendar day counts** | GPUs are rented on weekends too. A business-day average left up to 7.14% of a price step unhedged for a renter billed daily in Agate's test. | CBOT 30-Day Fed Funds and CME One-Month SOFR futures count every calendar day; Agate's own test |
| **Each day is kept inside the floor and ceiling before averaging** | The month's payout then never leaves the range the locked dollars can pay, with no early stop or knock-out when a day touches an edge. | CME's degree-day weather contracts (a daily floor at zero, a monthly sum); products that stopped on a touch ended badly (MacroShares Oil, 2008) |

What the research does not settle: a median only promises a value inside the honest sources' range, not the right one
(Breidenbach et al., the [Chainlink 2.0 whitepaper](https://research.chain.link/whitepaper-v2.pdf), section 7.2.2), and
the checking rules of the attester and the watcher are Agate's own design, tested by Agate and by no outside party.

## 10. Limits, stated

- These are **posted list prices**, not prices clouds actually transact at. Clouds change their list prices in steps,
  so the index moves rarely and in steps (for example, an H100 list price can sit unchanged for weeks).
- On testnet the index runs under the DEMO label with a minimum of one fresh source.
- The CRE workflow runs in Chainlink's simulator (`cre workflow simulate --broadcast`), which is one node: until a
  deployment on Chainlink's network, the CRE writer's agreement step is not decentralized. The second writer and the
  attester's countersign still apply.
