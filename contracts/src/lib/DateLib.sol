// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DateLib: civil calendar on a day count since 1970-01-01 (BUILD-SPEC 3). Shared with the series factory.
/// Every input is a dayId >= 0 (on or after 1970-01-01), so all divisions are plain unsigned divisions.
/// A month index is y * 12 + (m - 1).
library DateLib {
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        d = doy - (153 * mp + 2) / 5 + 1;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }

    /// Valid for dates on or after 1970-01-01 (reverts on underflow before it).
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    function monthOf(uint256 day) internal pure returns (uint256) {
        (uint256 y, uint256 m,) = civilFromDays(day);
        return y * 12 + (m - 1);
    }

    function firstDayOf(uint256 month) internal pure returns (uint256) {
        return daysFromCivil(month / 12, month % 12 + 1, 1);
    }

    function daysIn(uint256 month) internal pure returns (uint256) {
        return firstDayOf(month + 1) - firstDayOf(month);
    }

    function isFirstOfMonth(uint256 day) internal pure returns (bool) {
        (,, uint256 d) = civilFromDays(day);
        return d == 1;
    }
}
