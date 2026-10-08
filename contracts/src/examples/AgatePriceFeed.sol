// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgateIndex} from "../interfaces/IAgateIndex.sol";

/// @notice An example reader of the agate index: one GPU's price as a Chainlink-style feed (the AggregatorV3Interface
/// views), so a contract that already reads Chainlink feeds can read what it costs to rent that GPU for an hour, with
/// no other change. Example code (docs/onchain.md), not part of the market and not audited.
/// - answer: US dollars per GPU-hour with 6 decimals (3_990_000 = $3.99), the index's own unit;
/// - a round is one UTC day: roundId = the index's day id, startedAt = the day's start, updatedAt = when the price was
///   last computed from fresh readings and made final. Only final days are answered (docs/method.md: a day is final
///   6 hours after its close when unchanged, or once a second key countersigns it).
/// - a CARRIED day (no usable data; the day before's price repeated) answers that price with the updatedAt of the
///   newest computed day before it, so a consumer's staleness check sees how old the price really is.
contract AgatePriceFeed {
    /// how far a carried day looks back for the newest computed day (beyond it, updatedAt is 0: treat as stale)
    uint32 public constant CARRY_WALK_DAYS = 62;
    uint8 public constant decimals = 6;
    uint256 public constant version = 1;

    IAgateIndex public immutable index;
    bytes32 public immutable gpuId;
    string public description;

    error NotRegistered(bytes32 gpuId);
    /// no final day for this round (latestRoundData: none in the last LOOKBACK_DAYS days)
    error NoFinalPrice();

    constructor(IAgateIndex index_, bytes32 gpuId_, string memory description_) {
        if (index_.gpu(gpuId_).recipeHash == bytes32(0)) revert NotRegistered(gpuId_);
        index = index_;
        gpuId = gpuId_;
        description = description_;
    }

    /// The newest final day. The index closes days in order and only after the day before is final, so at most one
    /// record (head - 1) is pending: the newest final day is head - 1, else head - 2.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint32 h = index.head(gpuId);
        for (uint32 back = 1; back <= 2 && back <= h; ++back) {
            (bool exists, bool isFinal, IAgateIndex.Record memory rec) = index.record(gpuId, h - back);
            if (exists && isFinal) return _round(h - back, rec);
        }
        revert NoFinalPrice();
    }

    /// One day's final price; reverts NoFinalPrice for a day with no final record.
    function getRoundData(uint80 roundId_)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundId_ > type(uint32).max) revert NoFinalPrice();
        (bool exists, bool isFinal, IAgateIndex.Record memory rec) = index.record(gpuId, uint32(roundId_));
        if (!exists || !isFinal) revert NoFinalPrice();
        return _round(uint32(roundId_), rec);
    }

    function _round(uint32 d, IAgateIndex.Record memory rec)
        internal
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (d, int256(uint256(rec.value)), index.dayStart(d), _computedAt(d, rec), d);
    }

    /// When the price was last computed: the record's own finalAt, or for a CARRIED day (whose finalAt is the time it
    /// was carried) that of the newest computed final day before it; 0 when none is found within CARRY_WALK_DAYS.
    function _computedAt(uint32 d, IAgateIndex.Record memory rec) internal view returns (uint256) {
        if (rec.status != IAgateIndex.Status.CARRIED) return rec.finalAt;
        for (uint32 back = 1; back <= CARRY_WALK_DAYS && back <= d; ++back) {
            (bool exists, bool isFinal, IAgateIndex.Record memory r) = index.record(gpuId, d - back);
            if (!exists) return 0;
            if (isFinal && r.status != IAgateIndex.Status.CARRIED) return r.finalAt;
        }
        return 0;
    }
}
