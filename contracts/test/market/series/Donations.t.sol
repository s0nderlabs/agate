// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {U, LOT, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I13: dollars or tokens sent to a series change no payout and block no call (no payout reads a balance).
contract SeriesDonationsTest is SeriesBase {
    function _run(bool donate) internal returns (uint256[8] memory pays) {
        if (donate) {
            dollar.mint(b, 100_000 * U);
            vm.prank(b);
            dollar.transfer(address(s), 12_345 * U + 7); // before the first mint, off the grid
        }
        _mint(a, 50 * U);
        if (donate) {
            _mint(b, U);
            vm.prank(b);
            tok.transfer(address(s), U);
            vm.prank(b);
            dollar.transfer(address(s), 3);
        }
        (uint256 id, uint256 o) = _stream(a, Side.SHORT, 20 * U, a, a, true);
        (uint256 id2, uint256 o2) = _stream(a, Side.LONG, 10 * U, a, a, true);
        pays[0] = o;
        pays[1] = o2;
        vm.warp(_afterDay(5));
        pays[2] = s.claim(id);
        vm.warp(_afterDay(17));
        pays[3] = s.claim(id);
        vm.prank(a);
        pays[4] = s.unstream(id2, a);
        vm.warp(_afterDay(30));
        pays[5] = s.claim(id);
        vm.startPrank(a);
        pays[6] = s.settle(Side.LONG, 40 * U, a);
        pays[7] = s.redeem(10 * U, a); // mint and redeem stay open after the month
        vm.stopPrank();
        _check();
    }

    function test_I13_donationsChangeNoPayout() public {
        uint256 snap = vm.snapshotState();
        uint256[8] memory plain = _run(false);
        uint256 ledgerPlain = _ledger();
        vm.revertToState(snap);
        uint256[8] memory donated = _run(true);
        for (uint256 i; i < 8; ++i) {
            assertEq(donated[i], plain[i]);
        }
        // the donated token's value (and the donor's pair) stays in the ledger; the donated dollars are not in it
        assertEq(_ledger(), ledgerPlain + 7_200_000, "the donor's mint is in the ledger, the donations are not");
        assertEq(dollar.balanceOf(address(s)), _ledger() + 12_345 * U + 10);
        assertEq(tok.balanceOf(address(s)), U); // nobody can settle the series' own tokens
    }

    function test_I13_donationBlocksNoCall() public {
        dollar.mint(b, 10 * U);
        vm.prank(b);
        dollar.transfer(address(s), 10 * U);
        _mint(a, LOT); // the exact-delta check still passes with a nonzero starting balance
        vm.prank(a);
        s.redeem(LOT, a);
        assertEq(_ledger(), 0);
        assertEq(dollar.balanceOf(address(s)), 10 * U);
    }
}
