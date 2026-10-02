// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {P_MIN, P_MAX} from "../../../src/interfaces/IAgateIndex.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {BandLib} from "../../../src/market/lib/BandLib.sol";
import {GRID} from "../../../src/market/MarketTypes.sol";

contract BandHarness {
    function band(uint256 sum5) external pure returns (uint32, uint32) {
        return BandLib.band(sum5);
    }
}

/// I32: F = 0.5 x I5 rounded DOWN to GRID, C = 2 x I5 rounded UP to GRID, one division per edge, no float
/// (BUILD-SPEC 3.2). Checked against the defining inequalities in exact integers: with I5 = sum5 / 5,
/// F <= I5 / 2 < F + GRID  <=>  10 F <= sum5 < 10 (F + GRID), and C - GRID < 2 I5 <= C  <=>  5 (C - GRID) < 2 sum5 <= 5 C.
contract BandTest is Test {
    BandHarness internal h = new BandHarness();

    function _check(uint256 sum5) internal pure {
        (uint32 f, uint32 c) = BandLib.band(sum5);
        uint256 F = f;
        uint256 C = c;
        assertLe(10 * F, sum5, "F <= I5/2");
        assertLt(sum5, 10 * (F + GRID), "I5/2 < F + GRID");
        assertLt(5 * (C - GRID), 2 * sum5, "C - GRID < 2 I5");
        assertLe(2 * sum5, 5 * C, "2 I5 <= C");
        assertEq(F % GRID, 0);
        assertEq(C % GRID, 0);
        assertGe(F, GRID);
        assertLt(C, 2 ** 32);
    }

    function testFuzz_I32_band(uint256 sum5) public pure {
        _check(bound(sum5, 5 * uint256(P_MIN), 5 * uint256(P_MAX)));
    }

    /// Sums one u either side of every grid edge of both divisions.
    function testFuzz_I32_bandGridEdges(uint256 k, int8 off) public pure {
        uint256 step = k % 2 == 0 ? 500_000 : 125_000;
        uint256 m = bound(k / 2, 5 * uint256(P_MIN) / step + 1, 5 * uint256(P_MAX) / step - 1);
        uint256 sum5 = m * step;
        int256 o = int256(off) % 3; // -2 .. 2
        sum5 = o >= 0 ? sum5 + uint256(o) : sum5 - uint256(-o);
        _check(sum5);
    }

    /// The model's sweep (TestI32Band): every sum from 500,000 to 2,500,000 in steps of 7.
    function test_I32_sweep() public pure {
        uint256 n;
        uint256 bad;
        for (uint256 s = 5 * uint256(P_MIN); s < 5 * uint256(P_MIN) + 2_000_000; s += 7) {
            (uint32 f, uint32 c) = BandLib.band(s);
            uint256 F = f;
            uint256 C = c;
            if (
                10 * F > s || s >= 10 * (F + GRID) || 5 * (C - GRID) >= 2 * s || 2 * s > 5 * C || F % GRID != 0
                    || C % GRID != 0
            ) ++bad;
            ++n;
        }
        assertEq(n, 285_715);
        assertEq(bad, 0);
    }

    function test_I32_workedExample() public pure {
        (uint32 f, uint32 c) = BandLib.band(5 * 3_600_000);
        assertEq(f, 1_800_000);
        assertEq(c, 7_200_000);
        (f, c) = BandLib.band(5 * 3_630_000); // 0.5 x 3.63 = 1.815 down; 2 x 3.63 = 7.26 up
        assertEq(f, 1_800_000);
        assertEq(c, 7_300_000);
    }

    function test_I32_edgesFit() public pure {
        (uint32 f,) = BandLib.band(5 * uint256(P_MIN));
        assertEq(f, GRID, "F never below the grid");
        (, uint32 c) = BandLib.band(5 * uint256(P_MAX));
        assertEq(c, 2_000_000_000, "C fits uint32 and Kuru's uint32 price");
    }

    function test_I32_badBand() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.BadBand.selector, 499_999));
        h.band(499_999); // below 5 x P_MIN: F would be 0
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.BadBand.selector, 0));
        h.band(0);
        // a broken index far above P_MAX: C would not fit uint32 (never truncated)
        uint256 huge = 5 * uint256(type(uint32).max);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.BadBand.selector, huge));
        h.band(huge);
        // the largest sum whose cap still fits uint32 passes
        uint256 top = (uint256(type(uint32).max) / GRID) * 125_000;
        (, uint32 c) = h.band(top);
        assertLe(c, type(uint32).max);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.BadBand.selector, top + 1));
        h.band(top + 1);
    }

    /// Negative control: a band computed through I5 first (two divisions per edge) differs somewhere, so the
    /// exact checks above can fail.
    function test_I32_negativeControl_twoDivisions() public pure {
        uint256 diffs;
        for (uint256 s = 5 * uint256(P_MIN); s < 5 * uint256(P_MIN) + 400_000; s += 3) {
            uint256 i5 = s / 5;
            uint256 cNaive = (2 * i5 + GRID - 1) / GRID * GRID;
            (, uint32 c) = BandLib.band(s);
            if (cNaive != c) ++diffs;
        }
        assertGt(diffs, 0);
    }
}
