// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side, CloseKind, Position} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I6 (path independence), I31 (position integrity) and the unit behaviour of streamOut, claim, claimMany,
/// setPayout and setOperator (BUILD-SPEC 4.5).
contract SeriesPositionsTest is SeriesBase {
    /// A position that runs to the end receives exactly floor(q G_side(N) / (N U)), for any claim schedule.
    function test_I6_pathIndependence(uint256 lots, bool short, uint256 seed) public {
        uint256 q = bound(lots, 1, 1e8) * LOT;
        Side side = short ? Side.SHORT : Side.LONG;
        _mint(a, q);
        (uint256 id, uint256 paidNow) = _stream(a, side, q, a, payer, true);
        uint256 snap = vm.snapshotState();
        uint256[3] memory totals;
        for (uint256 sched; sched < 3; ++sched) {
            vm.revertToState(snap);
            uint256 p0 = dollar.balanceOf(payer);
            for (uint256 kk = 1; kk <= 30; ++kk) {
                bool claimNow = sched == 0 || kk == 30 || (sched == 2 && uint256(keccak256(abi.encode(seed, kk))) % 4 == 0);
                if (!claimNow) continue;
                vm.warp(_afterDay(kk));
                vm.prank(stranger);
                s.claim(id);
            }
            totals[sched] = paidNow + dollar.balanceOf(payer) - p0;
            assertEq(s.position(id).owner, address(0), "deleted by the final claim");
        }
        uint256 g = side == Side.LONG ? 120_000_000 : 30 * uint256(CAP) - 120_000_000;
        assertEq(totals[0], q * g / (30 * U));
        assertEq(totals[1], totals[0]);
        assertEq(totals[2], totals[0]);
    }

    function test_I31_idsIncreaseAndTermsNeverChange() public {
        _mint(a, 100 * U);
        _mint(b, 100 * U);
        (uint256 id1,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        (uint256 id2,) = _stream(b, Side.SHORT, 20 * U, b, c, false);
        (uint256 id3,) = _stream(a, Side.LONG, 30 * U, c, c, true); // a gift: c owns it, a operates it
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
        vm.prank(b);
        s.setPayout(id2, a, true);
        vm.prank(c);
        s.setOperator(id3, b);
        vm.warp(_afterDay(4));
        s.claim(id1);
        s.claim(id2);
        Position memory p2 = s.position(id2);
        assertEq(p2.owner, b);
        assertTrue(p2.side == Side.SHORT);
        assertEq(p2.q, 20 * U);
        assertEq(p2.payee, a);
        assertTrue(p2.daily);
        Position memory p3 = s.position(id3);
        assertEq((p3.owner), c);
        assertEq(p3.operator, b);
        assertEq(p3.q, 30 * U);
        vm.prank(a);
        s.unstream(id1, a);
        (uint256 id4,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        assertEq(id4, 4, "never reused");
        assertEq(_nextId(), 5);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, id1));
        s.claim(id1);
        _check();
    }

    function test_I31_deletedExactlyOnceByTheFinalClaim() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, b, true);
        vm.warp(_afterDay(30));
        uint256 owedTotal = 10 * (30 * uint256(CAP) - 120_000_000) / 30; // 32 dollars
        vm.expectEmit(address(s));
        emit IAgateSeries.Claimed(id, b, owedTotal, owedTotal, 30);
        vm.expectEmit(address(s));
        emit IAgateSeries.PositionClosed(id, a, CloseKind.FINAL, owedTotal, b, stranger);
        vm.prank(stranger);
        assertEq(s.claim(id), owedTotal);
        assertEq(s.position(id).owner, address(0));
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, id));
        s.claim(id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(s.claimMany(ids), 0);
        _check();
    }

    function test_streamOutLongPaysTheFloorAtOnce() public {
        _mint(a, 100 * U);
        vm.expectEmit(address(s));
        emit IAgateSeries.PositionOpened(1, b, c, Side.LONG, 100 * U, 180 * U, a, true, 0, a);
        (uint256 id, uint256 paidNow) = _stream(a, Side.LONG, 100 * U, b, c, true);
        assertEq(paidNow, 100 * uint256(FLOOR)); // q F / U
        Position memory p = s.position(id);
        assertEq(p.owner, b);
        assertEq(p.payee, c);
        assertEq(p.operator, a); // the opener of a gift is its operator
        assertEq(p.paid, 180 * U);
        assertEq(p.openedK, 0);
        assertEq(tok.balanceOf(a), 0);
        assertEq(tok.totalSupply(), 0);
        _check();
    }

    function test_streamOutShortPaysZeroAtK0AndNamesNoOperator() public {
        _mint(a, 100 * U);
        vm.expectEmit(address(s));
        emit IAgateSeries.ShortDebited(a, 100 * U, 0);
        vm.expectEmit(address(s));
        emit IAgateSeries.PositionOpened(1, a, a, Side.SHORT, 100 * U, 0, address(0), false, 0, a);
        (, uint256 paidNow) = _stream(a, Side.SHORT, 100 * U, a, a, false);
        assertEq(paidNow, 0);
        assertEq(s.position(1).operator, address(0));
        assertEq(_shortSupply(), 0);
        _check();
    }

    function test_streamOutErrors() public {
        _mint(a, 100 * U);
        vm.startPrank(a);
        vm.expectRevert(IAgateSeries.BadAmount.selector);
        s.streamOut(Side.LONG, 0, a, a, a, true);
        vm.expectRevert(IAgateSeries.BadAmount.selector);
        s.streamOut(Side.LONG, 150, a, a, a, true);
        vm.expectRevert(IAgateSeries.BadAmount.selector);
        s.streamOut(Side.LONG, (MAXQ / LOT + 1) * LOT, a, a, a, true); // past MAX_Q
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.LONG, U, address(0), a, a, true);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.LONG, U, address(s), a, a, true);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.LONG, U, address(tok), a, a, true);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.SHORT, U, b, a, a, true); // a short only for oneself (I29)
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.streamOut(Side.LONG, U, a, address(0), a, true);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.streamOut(Side.LONG, U, a, router, a, true);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.streamOut(Side.LONG, U, a, a, address(tok), true);
        vm.expectRevert(IAgateSeries.TokenBalance.selector);
        s.streamOut(Side.LONG, 101 * U, a, a, a, true);
        vm.expectRevert(IAgateSeries.ShortBalance.selector);
        s.streamOut(Side.SHORT, 101 * U, a, a, a, true);
        vm.stopPrank();
        vm.warp(_afterDay(30));
        vm.prank(a);
        vm.expectRevert(IAgateSeries.MonthFinal.selector);
        s.streamOut(Side.LONG, U, a, a, a, true);
        assertEq(_k(), 0, "the reverted call left no synced day behind");
    }

    function test_streamOutAtTheMaximumSize() public {
        // a position of MAX_Q rounded down to the lot: paid fits uint96 at any k
        uint256 q = MAXQ / LOT * LOT;
        _give(a, q * CAP / U);
        vm.prank(a);
        s.mint(q, a);
        (uint256 id, uint256 paidNow) = _stream(a, Side.SHORT, q, a, a, true);
        assertEq(paidNow, 0);
        vm.warp(_afterDay(30));
        uint256 got = s.claim(id);
        assertEq(got, q * (30 * uint256(CAP) - 120_000_000) / (30 * U));
        vm.prank(a);
        tok.transfer(b, q);
        vm.prank(b);
        s.settle(Side.LONG, q, b);
        _check();
    }

    function test_claimPaysOnlyThePayeeAndEmits() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, b, true);
        vm.warp(_afterDay(3));
        uint256 expected = 10 * (3 * uint256(CAP) - 3 * uint256(REF)) / 30;
        assertEq(s.claimable(id), expected);
        uint256 b0 = dollar.balanceOf(b);
        vm.expectEmit(address(s));
        emit IAgateSeries.Claimed(id, b, expected, expected, 3);
        vm.prank(stranger);
        assertEq(s.claim(id), expected);
        assertEq(dollar.balanceOf(b) - b0, expected);
        assertEq(dollar.balanceOf(stranger), 0);
        assertEq(s.claimable(id), 0);
        vm.prank(stranger);
        assertEq(s.claim(id), 0); // nothing new
        _check();
    }

    function test_claimManySkipsMissingAndRepeatedIds() public {
        _mint(a, 30 * U);
        (uint256 id1,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        (uint256 id2,) = _stream(a, Side.LONG, 10 * U, a, b, true);
        vm.warp(_afterDay(2));
        uint256[] memory ids = new uint256[](5);
        ids[0] = id1;
        ids[1] = 999;
        ids[2] = id2;
        ids[3] = id1;
        ids[4] = 0;
        uint256 c1 = s.claimable(id1);
        uint256 c2 = s.claimable(id2);
        vm.prank(payer);
        assertEq(s.claimMany(ids), c1 + c2);
        assertEq(s.claimable(id1), 0);
        // at k = N a claimed id is deleted, so a repeat is skipped
        vm.warp(_afterDay(30));
        c1 = s.claimable(id1);
        c2 = s.claimable(id2);
        vm.prank(payer);
        assertEq(s.claimMany(ids), c1 + c2);
        assertEq(s.position(id1).owner, address(0));
        assertEq(s.position(id2).owner, address(0));
        assertEq(s.claimMany(new uint256[](0)), 0);
        _check();
    }

    function test_setPayoutAndSetOperator() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        vm.expectEmit(address(s));
        emit IAgateSeries.PayoutChanged(id, c, false);
        vm.prank(a);
        s.setPayout(id, c, false);
        assertEq(s.position(id).payee, c);
        assertFalse(s.position(id).daily);
        vm.expectEmit(address(s));
        emit IAgateSeries.OperatorSet(id, b);
        vm.prank(a);
        s.setOperator(id, b);
        assertEq(s.position(id).operator, b);
        vm.prank(a);
        s.setOperator(id, address(0)); // zero removes it
        assertEq(s.position(id).operator, address(0));
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadOperator.selector);
        s.setOperator(id, a);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.setPayout(id, address(tok), true);
        vm.prank(b);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.setPayout(id, b, true);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 5));
        s.setPayout(5, b, true);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 5));
        s.setOperator(5, b);
    }

    function test_claimableRevertsWithoutAPosition() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 1));
        s.claimable(1);
    }

    /// Example 3: a renter arriving after 15 fixes; the series pays 5,760 x (57.00 + 15 x 1.80) / 30 at once.
    function test_midMonthEntry() public {
        uint256 q = 5_760 * U;
        _mint(a, q);
        vm.warp(_afterDay(15));
        vm.prank(a);
        s.sync(15);
        assertEq(_S(), 57_000_000);
        uint256 total;
        for (uint256 i; i < 8; ++i) {
            (, uint256 p) = _stream(a, Side.LONG, q / 8, a, a, true);
            total += p;
        }
        assertEq(total, 16_128 * U);
        vm.warp(_afterDay(30));
        uint256 later;
        for (uint256 i; i < 8; ++i) {
            later += s.claim(opened[i]);
        }
        assertEq(later, 6_912 * U);
        _check();
    }
}
