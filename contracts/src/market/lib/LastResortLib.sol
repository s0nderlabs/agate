// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LAST_RESORT_DAYS, LAST_RESORT_FLOOR} from "../MarketTypes.sol";

/// @title LastResortLib: how long after a day's end a series forces that day without a final fix (BUILD-SPEC 1, 4.6)
library LastResortLib {
    /// max(LAST_RESORT_DAYS x day, LAST_RESORT_FLOOR), in real seconds, for an index DAY of `day` seconds. The one
    /// copy of the rule: the factory writes it into the terms and the series refuses terms that differ (BadTerms).
    function lastResort(uint256 day) internal pure returns (uint256 lr) {
        lr = LAST_RESORT_DAYS * day;
        if (lr < LAST_RESORT_FLOOR) lr = LAST_RESORT_FLOOR;
    }
}
