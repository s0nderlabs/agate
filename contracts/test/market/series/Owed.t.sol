// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {U, LOT, GRID, Side, SeriesTerms} from "../../../src/market/MarketTypes.sol";
import {SeriesBase, SeriesKS} from "./SeriesBase.sol";

/// The fuzz of owed against an exact-rational reference (BUILD-SPEC 12.2 A): at any band, month length, k and S,
/// owed(LONG, q) is the floor of q (S + (N - k) F) / (N U) and owed(SHORT, q) the floor of q (k C - S) / (N U), each
/// from its own numerator: checked as exact integer inequalities, never through a complement.
contract SeriesOwedTest is SeriesBase {
    struct Case {
        uint256 f;
        uint256 c;
        uint256 n;
        uint256 k;
        uint256 s;
        uint256 q;
    }

    function _harness(Case memory x) internal returns (SeriesKS h) {
        SeriesTerms memory t = _terms(address(dollar), uint32(x.f), uint32(x.c), REF);
        t.n = uint8(x.n);
        h = new SeriesKS(t, "n", "s");
        h.setKS(uint8(x.k), uint64(x.s));
    }

    function _case(uint256 fSteps, uint256 width, uint256 n, uint256 k, uint256 sPos, uint256 q)
        internal
        pure
        returns (Case memory x)
    {
        x.f = bound(fSteps, 1, 20_000) * GRID;
        x.c = x.f + bound(width, 1, 20_000) * GRID; // C up to $2,000
        x.n = bound(n, 28, 31);
        x.k = bound(k, 0, x.n);
        x.s = x.k * x.f + bound(sPos, 0, x.k * (x.c - x.f)); // kF <= S <= kC
        x.q = bound(q, 1, MAXQ);
    }

    function testFuzz_owedIsTheExactFloor(uint256 fSteps, uint256 width, uint256 n, uint256 k, uint256 sPos, uint256 q)
        public
    {
        Case memory x = _case(fSteps, width, n, k, sPos, q);
        SeriesKS h = _harness(x);
        uint256 nu = x.n * U;
        uint256 numL = x.s + (x.n - x.k) * x.f;
        uint256 numS = x.k * x.c - x.s;
        uint256 l = h.owed(Side.LONG, x.q);
        uint256 sh = h.owed(Side.SHORT, x.q);
        assertLe(l * nu, x.q * numL);
        assertGt((l + 1) * nu, x.q * numL);
        assertLe(sh * nu, x.q * numS);
        assertGt((sh + 1) * nu, x.q * numS);
        // together never above the certain value of the pair, and at most 1 u below it
        uint256 both = x.q * (numL + numS);
        assertLe((l + sh) * nu, both);
        assertGt((l + sh + 2) * nu, both);
        // the views of the pair, exact under the lot rule
        uint256 ql = x.q / LOT * LOT;
        assertEq(h.mintCost(ql) * U, ql * x.c);
        assertEq(h.redeemValue(ql) * U, ql * x.c);
    }

    /// Owed only grows as days are applied, on both sides, for any applied value in the band.
    function testFuzz_owedNeverFalls(uint256 fSteps, uint256 width, uint256 k, uint256 sPos, uint256 cPos, uint256 q)
        public
    {
        Case memory x = _case(fSteps, width, 30, k, sPos, q);
        if (x.k == 30) x.k = 29;
        x.s = x.k * x.f + bound(sPos, 0, x.k * (x.c - x.f));
        SeriesKS h = _harness(x);
        uint256 l0 = h.owed(Side.LONG, x.q);
        uint256 s0 = h.owed(Side.SHORT, x.q);
        uint256 c = x.f + bound(cPos, 0, x.c - x.f);
        h.setKS(uint8(x.k + 1), uint64(x.s + c));
        assertGe(h.owed(Side.LONG, x.q), l0);
        assertGe(h.owed(Side.SHORT, x.q), s0);
    }

    /// The worked example's table (BUILD-SPEC 12.1 example 1), per token.
    function test_workedExampleTable() public {
        uint256[6] memory ks = [uint256(0), 1, 10, 11, 20, 30];
        uint256[6] memory ss = [uint256(0), 3_600_000, 36_000_000, 40_200_000, 78_000_000, 120_000_000];
        uint256[6] memory longs = [uint256(1_800_000), 1_860_000, 2_400_000, 2_480_000, 3_200_000, 4_000_000];
        uint256[6] memory shorts_ = [uint256(0), 120_000, 1_200_000, 1_300_000, 2_200_000, 3_200_000];
        Case memory x = Case(FLOOR, CAP, 30, 0, 0, U);
        SeriesKS h = _harness(x);
        for (uint256 i; i < 6; ++i) {
            h.setKS(uint8(ks[i]), uint64(ss[i]));
            assertEq(h.owed(Side.LONG, U), longs[i]);
            assertEq(h.owed(Side.SHORT, U), shorts_[i]);
        }
    }
}
