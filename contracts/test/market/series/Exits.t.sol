// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side, CloseKind, Position} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I7: whole pairs leave whole. redeem pays exactly q C / U; closeWithToken exactly q C / U - paid; unstream takes
/// back exactly paid, returns q and leaves the series as if the position had never been opened.
contract SeriesExitsTest is SeriesBase {
    function test_I7_redeemExact() public {
        uint256 q = 12_345 * LOT;
        uint256 cost = _mint(a, q);
        assertEq(cost, q * CAP / U);
        vm.prank(a);
        assertEq(s.redeem(q, a), cost);
        assertEq(_ledger(), 0);
    }

    function test_I7_closeWithTokenExact() public {
        uint256 q = 720 * U;
        _mint(a, 2 * q);
        (uint256 sid,) = _stream(a, Side.SHORT, q, a, a, true);
        (uint256 lid,) = _stream(a, Side.LONG, q / 2, a, a, true);
        vm.warp(_afterDay(7));
        s.claim(sid);
        s.claim(lid);
        uint256 paidS = s.position(sid).paid;
        uint256 paidL = s.position(lid).paid;
        assertGt(paidS, 0);
        assertGt(paidL, 0);
        uint256 before = dollar.balanceOf(c);
        vm.expectEmit(address(s));
        emit IAgateSeries.PositionClosed(sid, a, CloseKind.WITH_TOKEN, q * CAP / U - paidS, c, a);
        vm.prank(a);
        assertEq(s.closeWithToken(sid, c), q * CAP / U - paidS);
        vm.prank(a);
        assertEq(s.closeWithToken(lid, c), (q / 2) * CAP / U - paidL);
        assertEq(dollar.balanceOf(c) - before, q * CAP / U - paidS + (q / 2) * CAP / U - paidL);
        assertEq(s.position(sid).owner, address(0));
        assertEq(s.position(lid).owner, address(0));
        _check();
    }

    function _snapshot() internal view returns (uint256[8] memory v) {
        (uint8 k, uint64 sum,,,, uint128 led,, uint256 sh) = s.state();
        v = [
            uint256(k),
            sum,
            led,
            sh,
            tok.totalSupply(),
            tok.balanceOf(a),
            s.shortOf(a),
            dollar.balanceOf(a)
        ];
    }

    function test_I7_unstreamRestoresState() public {
        for (uint256 side; side < 2; ++side) {
            uint256 snap = vm.snapshotState();
            uint256 q = 720 * U;
            _mint(a, q);
            vm.warp(_afterDay(5));
            s.sync(type(uint256).max);
            uint256[8] memory before = _snapshot();
            (uint256 id, uint256 paidNow) = _stream(a, Side(side), q, a, a, true);
            assertGt(paidNow, 0);
            vm.warp(_afterDay(9));
            s.claim(id);
            uint256 paid = s.position(id).paid;
            s.sync(type(uint256).max); // already synced: no change
            uint256[8] memory mid = _snapshot();
            vm.expectEmit(address(s));
            emit IAgateSeries.PositionClosed(id, a, CloseKind.UNSTREAMED, paid, a, a);
            vm.prank(a);
            assertEq(s.unstream(id, a), paid);
            uint256[8] memory afterU = _snapshot();
            // ledger, supplies and a's balances are what they were before the position, at the new k and S
            assertEq(afterU[2], before[2], "ledger");
            assertEq(afterU[3], before[3], "short supply");
            assertEq(afterU[4], before[4], "token supply");
            assertEq(afterU[5], before[5], "a's tokens");
            assertEq(afterU[6], before[6], "a's short");
            assertEq(afterU[7], before[7], "a's dollars");
            assertEq(afterU[0], mid[0]);
            _check();
            vm.revertToState(snap);
        }
    }

    /// L2: a position that was paid nothing (a SHORT at k = 0) unstreams without moving a dollar.
    function test_I7_unstreamAtK0MovesNoDollar() public {
        _mint(a, 10 * U);
        (uint256 id, uint256 paidNow) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        assertEq(paidNow, 0);
        vm.prank(a);
        dollar.approve(address(s), 0); // no allowance needed
        vm.recordLogs();
        vm.prank(a);
        assertEq(s.unstream(id, a), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(dollar), "a dollar moved");
        }
        assertEq(s.shortOf(a), 10 * U);
        _check();
    }

    function test_I7_unstreamLongToAnotherAccount() public {
        _mint(a, 10 * U);
        (uint256 id, uint256 paidNow) = _stream(a, Side.LONG, 10 * U, a, a, true);
        assertEq(paidNow, 18 * U); // the floor at once
        vm.expectEmit(address(tok));
        emit IERC20.Transfer(address(0), b, 10 * U);
        vm.prank(a);
        s.unstream(id, b); // a long goes wherever its owner says
        assertEq(tok.balanceOf(b), 10 * U);
        _check();
    }

    function test_closeWithTokenErrors() public {
        uint256 q = 10 * U;
        _mint(a, 2 * q);
        (uint256 sid,) = _stream(a, Side.SHORT, q, a, a, true);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 99));
        s.closeWithToken(99, a);
        vm.prank(b);
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        s.closeWithToken(sid, a);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.closeWithToken(sid, address(0));
        vm.prank(a);
        tok.transfer(b, 2 * q - 1); // a keeps 1 base unit
        vm.prank(a);
        vm.expectRevert(IAgateSeries.TokenBalance.selector);
        s.closeWithToken(sid, a);
        vm.prank(a);
        s.setOperator(sid, b);
        vm.prank(b);
        vm.expectRevert(IAgateSeries.OperatorMustPayOwner.selector);
        s.closeWithToken(sid, b);
        // a LONG position needs short units of the caller
        vm.prank(b);
        tok.transfer(a, q);
        (uint256 lid,) = _stream(a, Side.LONG, q, a, a, true);
        vm.prank(a);
        s.unstream(sid, a); // a's short back
        vm.prank(b);
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        s.closeWithToken(lid, a);
        _mint(c, LOT);
        vm.prank(a);
        s.setOperator(lid, c);
        vm.prank(c);
        vm.expectRevert(IAgateSeries.ShortBalance.selector);
        s.closeWithToken(lid, a);
        _check();
    }

    function test_unstreamErrors() public {
        _mint(a, 20 * U);
        (uint256 sid,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        (uint256 lid,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 7));
        s.unstream(7, a);
        vm.prank(b);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.unstream(sid, b);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.unstream(sid, b); // a short goes back to its owner only (I29)
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.unstream(lid, address(s));
        vm.prank(a);
        dollar.approve(address(s), 0);
        vm.prank(a);
        vm.expectRevert(); // the long was paid its floor: unstream pulls it back
        s.unstream(lid, a);
        Position memory p = s.position(lid);
        assertEq(p.owner, a);
        _check();
    }
}
