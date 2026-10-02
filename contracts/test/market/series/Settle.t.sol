// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I10 (every balance exits) and the unit behaviour of settle (BUILD-SPEC 4.5).
contract SeriesSettleTest is SeriesBase {
    function test_I10_anyAmountSettlesAndClaimsNeverExpire() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 3 * U, a, a, false);
        vm.prank(a);
        tok.transfer(b, 1); // one base unit
        vm.warp(_afterDay(30) + 3_650 days); // ten years later
        vm.prank(b);
        assertEq(s.settle(Side.LONG, 1, b), uint256(1) * 120_000_000 / (30 * U)); // rounds to 0
        vm.startPrank(a);
        s.settle(Side.LONG, tok.balanceOf(a), a);
        s.settle(Side.SHORT, s.shortOf(a), a);
        vm.stopPrank();
        s.claim(id);
        assertEq(tok.totalSupply(), 0);
        assertEq(_shortSupply(), 0);
        assertEq(s.position(id).owner, address(0));
        assertLe(_ledger(), 4, "dust under one u per payout path");
        _check();
    }

    function test_I10_mintRedeemAfterFinalStreamOutClosed() public {
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        uint256 cost = _mint(a, 100 * U);
        vm.prank(a);
        assertEq(s.redeem(100 * U, a), cost);
        _mint(a, LOT);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.MonthFinal.selector);
        s.streamOut(Side.LONG, LOT, a, a, a, true);
    }

    function test_I10_subLotSettle() public {
        _mint(a, 31 * U + 300);
        vm.prank(a);
        tok.transfer(b, 33);
        vm.warp(_afterDay(30));
        vm.prank(b);
        assertEq(s.settle(Side.LONG, 33, b), 33 * uint256(120_000_000) / (30 * U));
        vm.prank(a);
        assertEq(s.settle(Side.SHORT, 33, a), 33 * (30 * uint256(CAP) - 120_000_000) / (30 * U));
        _check();
    }

    function test_settlePerTokenAndEvents() public {
        _mint(a, 5 * U);
        vm.warp(_afterDay(30));
        vm.expectEmit(address(s));
        emit IAgateSeries.Settled(a, Side.LONG, 5 * U, 20 * U, c);
        vm.prank(a);
        assertEq(s.settle(Side.LONG, 5 * U, c), 20 * U); // the token pays 4.00
        vm.expectEmit(address(s));
        emit IAgateSeries.ShortDebited(a, 5 * U, 0);
        vm.expectEmit(address(s));
        emit IAgateSeries.Settled(a, Side.SHORT, 5 * U, 16 * U, c);
        vm.prank(a);
        assertEq(s.settle(Side.SHORT, 5 * U, c), 16 * U); // a short unit 3.20; together 7.20 = C
        assertEq(dollar.balanceOf(c), 36 * U);
        assertEq(_ledger(), 0);
    }

    function test_settleErrors() public {
        _mint(a, 5 * U);
        vm.warp(_afterDay(12));
        vm.prank(a);
        vm.expectRevert(IAgateSeries.MonthNotFinal.selector);
        s.settle(Side.LONG, U, a);
        assertEq(_k(), 0, "the reverted settle left no synced day behind");
        vm.warp(_afterDay(30));
        vm.startPrank(a);
        vm.expectRevert(IAgateSeries.BadAmount.selector);
        s.settle(Side.LONG, 0, a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.settle(Side.LONG, U, address(s));
        vm.expectRevert(IAgateSeries.TokenBalance.selector);
        s.settle(Side.LONG, 5 * U + 1, a);
        vm.expectRevert(IAgateSeries.ShortBalance.selector);
        s.settle(Side.SHORT, 5 * U + 1, a);
        vm.stopPrank();
    }

    /// Settle after the last day while the last fix is still pending: MonthNotFinal until it is final.
    function test_settleWaitsForTheLastFix() public {
        _mint(a, U);
        vm.warp(_dayEnd(DEC1 - 1) + 1); // the month is over by the clock, day 30 not final
        vm.prank(a);
        vm.expectRevert(IAgateSeries.MonthNotFinal.selector);
        s.settle(Side.LONG, U, a);
        vm.warp(_afterDay(30));
        vm.prank(a);
        assertEq(s.settle(Side.LONG, U, a), 4 * U);
    }

    /// Fuzz against the exact rational: for any split of a pair between the sides, settle pays
    /// floor(q S / (N U)) and floor(q (N C - S) / (N U)), never more than q C / U together.
    function testFuzz_settleExact(uint256 lots, uint256 longPart, uint256 seed) public {
        uint256 q = bound(lots, 1, 1e8) * LOT;
        longPart = bound(longPart, 1, q);
        for (uint32 d = NOV1; d < DEC1; ++d) {
            uint256 r = uint256(keccak256(abi.encode(seed, d)));
            _post(d, uint32(100_000 + (r % 2_000) * 10_000)); // $0.10 to $20.09, often out of the band
        }
        _mint(a, q);
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        uint256 sum = _S();
        vm.startPrank(a);
        uint256 pl = s.settle(Side.LONG, longPart, b);
        uint256 ps = s.settle(Side.SHORT, longPart, b);
        vm.stopPrank();
        assertLe(pl * 30 * U, longPart * sum);
        assertGt((pl + 1) * 30 * U, longPart * sum);
        uint256 numS = 30 * uint256(CAP) - sum;
        assertLe(ps * 30 * U, longPart * numS);
        assertGt((ps + 1) * 30 * U, longPart * numS);
        assertLe(pl + ps, longPart * CAP / U);
        assertGe(pl + ps + 1, longPart * CAP / U);
        _check();
    }
}
