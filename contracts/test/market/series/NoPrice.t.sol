// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I14: mint, redeem, closeWithToken and unstream make no index call, and the only index view a series ever reads
/// is finalFix (counted with vm.expectCall, A.9).
contract SeriesNoPriceTest is SeriesBase {
    function _never(bytes4 sel) internal {
        vm.expectCall(address(index), abi.encodeWithSelector(sel), 0);
    }

    function test_I14_priceFreeMovesReadNoFix() public {
        _give(a, 1_000 * U);
        _mint(a, 40 * U);
        uint256 t5 = _afterDay(5);
        vm.warp(t5); // five final days pending: a sync-bearing call would read them
        _never(IAgateIndex.finalFix.selector);
        vm.startPrank(a);
        s.mint(U, a);
        s.redeem(U, a);
        vm.stopPrank();
        assertEq(_k(), 0);
    }

    function test_I14_closeAndUnstreamReadNoFix() public {
        _mint(a, 40 * U);
        (uint256 pl,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        (uint256 ps,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        (uint256 pl2,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        vm.prank(a);
        s.setOperator(pl2, b);
        vm.warp(_afterDay(5));
        _never(IAgateIndex.finalFix.selector);
        vm.startPrank(a);
        s.closeWithToken(pl, a);
        s.unstream(ps, a);
        s.setPayout(pl2, c, false);
        s.setOperator(pl2, address(0));
        vm.stopPrank();
        assertEq(_k(), 0);
    }

    /// Over a whole month (list, trade, stream, claim, settle) the series reads no index view but finalFix.
    function test_I14_onlyFinalFixIsEverRead() public {
        uint256[4] memory t = [_afterDay(3), _afterDay(16), _afterDay(30), _deadline(30) + 1];
        _never(IAgateIndex.record.selector);
        _never(IAgateIndex.firstRecordDay.selector);
        _never(IAgateIndex.gpu.selector);
        _never(IAgateIndex.clocks.selector);
        _never(IAgateIndex.dayId.selector);
        _never(IAgateIndex.dayStart.selector);
        _never(IAgateIndex.head.selector);
        _mint(a, 40 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        vm.warp(t[0]);
        s.claim(id);
        s.previewSync();
        s.claimable(id);
        vm.warp(t[1]);
        s.sync(2);
        vm.warp(t[2]);
        s.claim(id);
        vm.warp(t[3]);
        vm.prank(a);
        s.settle(Side.LONG, 40 * U, a);
    }

    /// A running day makes no index call: before the month and right after a sync the loop stops first.
    function test_I14_runningDayMakesNoIndexCall() public {
        uint256 t3 = _afterDay(3);
        _mint(a, 10 * U);
        vm.warp(t3);
        s.sync(type(uint256).max);
        assertEq(_k(), 3);
        vm.warp(t3 + 3_600); // day 4 still running
        _never(IAgateIndex.finalFix.selector);
        s.sync(type(uint256).max);
        _stream(a, Side.LONG, U, a, a, true);
        s.claim(1);
        assertEq(_k(), 3);
    }
}
