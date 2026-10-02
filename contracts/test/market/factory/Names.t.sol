// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {NameLib} from "../../../src/market/lib/NameLib.sol";

/// BUILD-SPEC 4.2: token names and symbols, the tag prefix rule (v3, finding RC5) and the label rule (10.2).
contract NamesTest is Test {
    uint256 internal constant NOV = 2026 * 12 + 10;

    function _eq(uint256 month, string memory label, string memory tag, string memory name, string memory symbol)
        internal
        pure
    {
        (string memory n, string memory s) = NameLib.names(label, month, tag);
        assertEq(n, name);
        assertEq(s, symbol);
    }

    function test_names_spec() public pure {
        _eq(NOV, "H100", "", "agate H100 Nov 2026", "H100-NOV26");
        _eq(2026 * 12 + 11, "B200", "demo", "agate B200 Dec 2026 demo", "dB200-DEC26");
        _eq(NOV, "H100", "pilot", "agate H100 Nov 2026 pilot", "pH100-NOV26");
        _eq(2027 * 12, "B200", "demo", "agate B200 Jan 2027 demo", "dB200-JAN27"); // model test_token_names
    }

    function test_names_everyMonth() public pure {
        string[12] memory mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        string[12] memory up = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        for (uint256 m; m < 12; ++m) {
            _eq(2027 * 12 + m, "H200", "", string.concat("agate H200 ", mon[m], " 2027"), string.concat("H200-", up[m], "27"));
        }
    }

    function test_names_yearDigits() public pure {
        _eq(2009 * 12, "H100", "", "agate H100 Jan 2009", "H100-JAN09");
        _eq(2099 * 12 + 11, "H100", "", "agate H100 Dec 2099", "H100-DEC99");
        _eq(2100 * 12, "H100", "", "agate H100 Jan 2100", "H100-JAN00");
        _eq(1970 * 12, "H100", "", "agate H100 Jan 1970", "H100-JAN70");
    }

    /// No two factories with distinct prefixes mint the same symbol.
    function test_tag_prefixes() public pure {
        (, string memory a) = NameLib.names("H100", NOV, "");
        (, string memory b) = NameLib.names("H100", NOV, "demo");
        (, string memory c) = NameLib.names("H100", NOV, "pilot");
        assertTrue(keccak256(bytes(a)) != keccak256(bytes(b)));
        assertTrue(keccak256(bytes(a)) != keccak256(bytes(c)));
        assertTrue(keccak256(bytes(b)) != keccak256(bytes(c)));
        (, string memory z) = NameLib.names("H100", NOV, "abcdefgh");
        assertEq(z, "aH100-NOV26");
    }

    function test_tagOk() public pure {
        string[5] memory good = ["", "p", "demo", "pilot", "abcdefgh"];
        for (uint256 i; i < good.length; ++i) {
            assertTrue(NameLib.tagOk(good[i]), good[i]);
        }
        string[8] memory bad = ["Demo", "pilot1", "a b", "abcdefghi", "-", "x_", unicode"é", "PILOT"];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(NameLib.tagOk(bad[i]), bad[i]);
        }
    }

    function testFuzz_tagOk(bytes memory raw) public pure {
        bool ref = raw.length <= 8;
        for (uint256 i; i < raw.length && ref; ++i) {
            ref = uint8(raw[i]) >= 0x61 && uint8(raw[i]) <= 0x7a;
        }
        assertEq(NameLib.tagOk(string(raw)), ref);
    }

    function test_labelOk() public pure {
        string[5] memory good = ["H100", "B200", "x", "MI300X", "~!az09{}"];
        for (uint256 i; i < good.length; ++i) {
            assertTrue(NameLib.labelOk(good[i]), good[i]);
        }
        string[5] memory bad = ["", "H 100", "ABCDEFGHI", unicode"H100é", "H100\n"];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(NameLib.labelOk(bad[i]), bad[i]);
        }
    }

    function testFuzz_labelOk(bytes memory raw) public pure {
        bool ref = raw.length >= 1 && raw.length <= 8;
        for (uint256 i; i < raw.length && ref; ++i) {
            ref = uint8(raw[i]) >= 0x21 && uint8(raw[i]) <= 0x7e;
        }
        assertEq(NameLib.labelOk(string(raw)), ref);
    }
}
