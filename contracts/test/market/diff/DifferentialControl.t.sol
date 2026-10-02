// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {SeriesTerms} from "../../../src/market/MarketTypes.sol";
import {SeriesComplement, SeriesFloorMint} from "../invariant/Harness.sol";
import {SeriesReplay} from "./SeriesReplay.sol";

/// The differential replay can fail: against a series with a known rounding bug, the model's vectors disagree. The
/// two controls are the invariant suite's own harnesses (BUILD-SPEC 11), so both suites test the same mutation.
contract MarketDifferentialControlTest is SeriesReplay {
    uint256 internal variant;

    function _newSeries(SeriesTerms memory terms) internal override returns (AgateSeries) {
        if (variant == 1) return new SeriesComplement(terms, "c", "c");
        return new SeriesFloorMint(terms, "f", "f");
    }

    function _caught() internal returns (uint256 caught) {
        for (uint256 i; i < 50; ++i) {
            try this.replay(string.concat("random_", i < 10 ? "0" : "", vm.toString(i))) {} catch {
                ++caught;
            }
        }
    }

    function test_complementIsCaught() public {
        variant = 1;
        uint256 caught = _caught();
        emit log_named_uint("random months that catch `complement`", caught);
        assertGt(caught, 0);
    }

    function test_floorMintIsCaught() public {
        variant = 2;
        uint256 caught = _caught();
        emit log_named_uint("random months that catch `floor_mint`", caught);
        assertGt(caught, 0);
    }
}
