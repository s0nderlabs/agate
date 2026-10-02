// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgateFactory} from "../interfaces/IAgateFactory.sol";
import {GRID} from "../MarketTypes.sol";

/// @title BandLib: the 0.5x / 2x band of a month from the sum of its five anchor values (BUILD-SPEC 3.2)
library BandLib {
    /// F = 0.5 x (sum5 / 5) rounded DOWN to GRID = floor(sum5 / 500,000) x GRID;
    /// C = 2 x (sum5 / 5) rounded UP to GRID = ceil(sum5 / 125,000) x GRID. One division per edge.
    /// Reverts BadBand(sum5) unless GRID <= F < C, and when C would not fit uint32 (only a broken index gets there:
    /// five values at P_MAX give C = 2,000,000,000).
    function band(uint256 sum5) internal pure returns (uint32 floor, uint32 cap) {
        uint256 f = sum5 / 500_000 * GRID;
        uint256 c = (sum5 + 124_999) / 125_000 * GRID;
        if (f < GRID || f >= c || c > type(uint32).max) revert IAgateFactory.BadBand(sum5);
        return (uint32(f), uint32(c));
    }
}
