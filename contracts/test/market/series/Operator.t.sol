// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I30: only the position's creator (when not its owner) or an address the owner set is its operator; an operator
/// can only closeWithToken with to == owner, from its own opposite balance; the owner receives at least the
/// position's remaining value at the most favourable future.
contract SeriesOperatorTest is SeriesBase {
    function test_I30_whoIsTheOperator() public {
        _mint(a, 30 * U);
        (uint256 own,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        (uint256 gift,) = _stream(a, Side.LONG, 10 * U, b, b, true);
        assertEq(s.position(own).operator, address(0), "opened by its owner: no operator");
        assertEq(s.position(gift).operator, a, "a gift: its opener");
        vm.prank(b);
        s.setOperator(gift, address(0));
        _mint(a, 10 * U);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.NotOwnerOrOperator.selector);
        s.closeWithToken(gift, b); // revoked
        vm.prank(b);
        s.setOperator(gift, c);
        assertEq(s.position(gift).operator, c);
    }

    function test_I30_operatorPowers() public {
        _mint(b, 20 * U);
        (uint256 id,) = _stream(b, Side.LONG, 10 * U, a, a, true); // owner a, operator b
        vm.warp(_afterDay(4));
        vm.startPrank(b);
        uint256 a0 = dollar.balanceOf(a);
        uint256 got = s.claim(id); // anyone may claim, but it pays the payee
        assertEq(dollar.balanceOf(a) - a0, got);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.setPayout(id, b, true);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.setOperator(id, c);
        vm.expectRevert(IAgateSeries.NotOwner.selector);
        s.unstream(id, b);
        vm.expectRevert(IAgateSeries.OperatorMustPayOwner.selector);
        s.closeWithToken(id, b);
        vm.expectRevert(IAgateSeries.OperatorMustPayOwner.selector);
        s.closeWithToken(id, c);
        uint256 paid = s.position(id).paid;
        a0 = dollar.balanceOf(a);
        uint256 bShort = s.shortOf(b);
        assertEq(s.closeWithToken(id, a), 10 * uint256(CAP) - paid);
        vm.stopPrank();
        assertEq(dollar.balanceOf(a) - a0, 10 * uint256(CAP) - paid);
        assertEq(s.shortOf(b), bShort - 10 * U, "from the operator's own balance");
        _check();
    }

    /// The close pays q C / U - paid, which is at least the position's remaining value in its best future.
    function test_I30_operatorCloseIsWorthAtLeastThePosition(uint256 lots, bool short, uint256 openDay, uint256 closeDay, uint256 seed)
        public
    {
        uint256 q = bound(lots, 1, 1e7) * LOT;
        openDay = bound(openDay, 0, 29);
        closeDay = bound(closeDay, openDay, 30);
        for (uint32 d = NOV1; d < DEC1; ++d) {
            _post(d, uint32(100_000 + (uint256(keccak256(abi.encode(seed, d))) % 1_500) * 10_000));
        }
        Side side = short ? Side.SHORT : Side.LONG;
        _mint(b, 2 * q);
        if (openDay > 0) vm.warp(_afterDay(openDay));
        uint256 id;
        if (side == Side.LONG) {
            (id,) = _stream(b, Side.LONG, q, a, a, true);
        } else {
            _mint(a, q);
            (id,) = _stream(a, Side.SHORT, q, a, a, true);
            vm.prank(a);
            s.setOperator(id, b);
        }
        if (closeDay > openDay) {
            vm.warp(_afterDay(closeDay));
            s.claim(id);
        }
        if (s.position(id).owner == address(0)) return; // the final claim closed it
        uint256 k = _k();
        uint256 sum = _S();
        uint256 best = side == Side.LONG ? sum + (30 - k) * uint256(CAP) : sum + (30 - k) * uint256(FLOOR);
        uint256 num = side == Side.LONG ? best : 30 * uint256(CAP) - best;
        uint256 paid = s.position(id).paid;
        uint256 remainingMax = q * num / (30 * U) - paid;
        vm.prank(b);
        uint256 got = s.closeWithToken(id, a);
        assertEq(got, q * CAP / U - paid);
        assertGe(got, remainingMax, "I30 the operator close paid less than the position is worth");
        _check();
    }
}
