// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title NameLib: token names and symbols, and the factory's label and tag rules (BUILD-SPEC 4.2, 10.2)
/// name   = "agate " + label + " " + Mon + " " + YYYY [+ " " + tag]     "agate H100 Nov 2026", "agate B200 Dec 2026 demo"
/// symbol = [tag's first letter] + label + "-" + MON + YY               "H100-NOV26", "dB200-DEC26", "pH100-NOV26"
library NameLib {
    bytes internal constant MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
    bytes internal constant MONTHS_UPPER = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";

    /// month = year * 12 + (month - 1).
    function names(string memory label, uint256 month, string memory tag)
        internal
        pure
        returns (string memory name, string memory symbol)
    {
        uint256 y = month / 12;
        uint256 m = month % 12;
        bytes memory tg = bytes(tag);
        name = string.concat("agate ", label, " ", _mon(MONTHS, m), " ", Strings.toString(y));
        if (tg.length != 0) name = string.concat(name, " ", tag);
        uint256 yy = y % 100;
        bytes memory twoDigits = new bytes(2);
        twoDigits[0] = bytes1(uint8(48 + yy / 10));
        twoDigits[1] = bytes1(uint8(48 + yy % 10));
        symbol = string.concat(label, "-", _mon(MONTHS_UPPER, m), string(twoDigits));
        if (tg.length != 0) symbol = string.concat(string(abi.encodePacked(tg[0])), symbol);
    }

    /// A tag is "" or 1 to 8 letters a to z, so a symbol prefix is always one lowercase letter.
    function tagOk(string memory tag) internal pure returns (bool) {
        bytes memory b = bytes(tag);
        if (b.length > 8) return false;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] < 0x61 || b[i] > 0x7a) return false;
        }
        return true;
    }

    /// A label is 1 to 8 printable ASCII characters other than the space (0x21 to 0x7e).
    function labelOk(string memory label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        if (b.length == 0 || b.length > 8) return false;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] < 0x21 || b[i] > 0x7e) return false;
        }
        return true;
    }

    function _mon(bytes memory table, uint256 m) private pure returns (string memory) {
        bytes memory out = new bytes(3);
        out[0] = table[3 * m];
        out[1] = table[3 * m + 1];
        out[2] = table[3 * m + 2];
        return string(out);
    }
}
