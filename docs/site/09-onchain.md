---
slug: onchain
title: Onchain feeds
description: Read the GPU price from any contract on Monad, through a Chainlink-style feed or the index itself.
group: Reference
order: 9
source: 'contracts/src/examples/AgatePriceFeed.sol'
---

# Any contract on Monad can read the price of a GPU-hour.

Any contract on Monad can read what it costs to rent a GPU for an hour. Two ways: a Chainlink-style feed per GPU
(easiest, and drop-in for code that already reads Chainlink), or the index contract itself (every detail of every
day). Both are on Monad testnet (chain 10143). How the price is made: [How the price is made](04-the-price.md).

## The feeds (Chainlink AggregatorV3 views)

One feed per GPU, `src/examples/AgatePriceFeed.sol`, deployed Oct 8 2026 (`contracts/deployments/10143-feeds.json`):

| GPU | Feed |
|---|---|
| H100 | [`0xC68687dd7d7b40281FB07E9006538aa45fAF3D98`](https://testnet.monadexplorer.com/address/0xC68687dd7d7b40281FB07E9006538aa45fAF3D98) |
| H200 | [`0x53ce1c4B23991164e3BF2EDB99C53fbf2016621D`](https://testnet.monadexplorer.com/address/0x53ce1c4B23991164e3BF2EDB99C53fbf2016621D) |
| B200 | [`0x84A20500923a8A9d5d5b7D6920A09c6f62A56A2E`](https://testnet.monadexplorer.com/address/0x84A20500923a8A9d5d5b7D6920A09c6f62A56A2E) |
| B300 | [`0xE28b9C672Dd4080C52F86E4F9fF218171c164De6`](https://testnet.monadexplorer.com/address/0xE28b9C672Dd4080C52F86E4F9fF218171c164De6) |
| A100 | [`0x9dEdC0e77AFd2D8483fE86eA910f29ee972F559d`](https://testnet.monadexplorer.com/address/0x9dEdC0e77AFd2D8483fE86eA910f29ee972F559d) |
| L40S | [`0xE85Ae44fA84EdE4B86DB276C0481EB15942A4b7f`](https://testnet.monadexplorer.com/address/0xE85Ae44fA84EdE4B86DB276C0481EB15942A4b7f) |

- `latestRoundData()`: the newest **final** day. `answer` is US dollars per GPU-hour with **6 decimals**
  (`3990000` = $3.99), `roundId` is the index's day id, `startedAt` the day's start, `updatedAt` when it became final.
- `getRoundData(day)`: any final day; reverts for a day with no final price.
- `decimals()` is 6, `description()` names the GPU.

A contract that values something in GPU-hours, for example a loan backed by GPU rental income:

```solidity
interface IAggregatorV3 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

contract RentalIncomeValuer {
    IAggregatorV3 public immutable h100 = IAggregatorV3(0xC68687dd7d7b40281FB07E9006538aa45fAF3D98);

    /// dollars (6 decimals) that `gpus` H100s earn over `gpuHours` hours at today's agate price
    function income(uint256 gpus, uint256 gpuHours) external view returns (uint256) {
        (, int256 price,, uint256 updatedAt,) = h100.latestRoundData();
        require(block.timestamp - updatedAt < 3 days, "agate price is stale");
        return uint256(price) * gpus * gpuHours;
    }
}
```

Check from a terminal:

```sh
cast call 0xC68687dd7d7b40281FB07E9006538aa45fAF3D98 "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url https://testnet-rpc.monad.xyz
```

## The index itself

[`AgateIndex` at `0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36`](https://testnet.monadexplorer.com/address/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36)
(interface `contracts/src/interfaces/IAgateIndex.sol`). Each GPU is a `gpuId` (listed in
`contracts/script/config/testnet-production.json`); days are UTC day ids (`dayId(timestamp)`).

- `finalFix(gpuId, day)` returns `(ok, value, status, fresh, late, incomplete)`: the day's final price in millionths of
  a dollar, its status (FULL, DEGRADED, DEMO or CARRIED) and how many companies were fresh. This is what the monthly
  markets settle on.
- `record(gpuId, day)` returns the whole record (who wrote it, when it was posted, final and countersigned).
- Events: `DayClosed`, `RecordSlots` (each source's day price), `Attested`, `RecordReplaced`, `Vetoed`, `DayCarried`.

## Tests

`contracts/test/examples/AgatePriceFeed.t.sol`: unit tests over set records, and a fork test against the live index
(`MONAD_FORK_URL=https://testnet-rpc.monad.xyz forge test --match-contract AgatePriceFeedForkTest`).
