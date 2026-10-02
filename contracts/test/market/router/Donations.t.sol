// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "./RouterBase.sol";

/// I13 and I25, router side (BUILD-SPEC 6.2): dollars or tokens sent to the router stay there as donations and jam
/// no flow (the router measures by balance change, never by balance); no path credits short units to the router
/// (the model's TestI25Router.test_donations_do_not_jam_the_router and the attacker's TestN1).
contract RouterDonationsTest is RouterBase {
    function test_I13_donationsDoNotJamTheRouter() public {
        _bookWorld();
        address u = _user("u", 100_000 * U);
        vm.prank(u);
        dollar.transfer(address(router), 777);
        vm.prank(mm);
        token.transfer(address(router), LOT);
        uint256 got = _long(u, 3_640, 10 * LOT); // 0.001 token at 3.64 = 3,640 u
        assertEq(got, 10 * LOT);
        _holdsNothing(777, LOT);
        (uint256[] memory sids,,) = _short(u, 20 * U, U, 4, u, true);
        assertEq(sids.length, 4);
        _holdsNothing(777, LOT);
        uint256[] memory lids = _longDaily(u, 364 * U, 100 * U, 2, u);
        _holdsNothing(777, LOT);
        _closeLong(u, 1_000, 1);
        _holdsNothing(777, LOT);
        _closeShort(u, sids, 80 * U);
        _holdsNothing(777, LOT);
        _closeLongDaily(u, lids, U);
        _holdsNothing(777, LOT);
    }

    /// Donations in the middle of a flow's inputs: a donation equal to what a flow needs is not used as its input.
    function test_I13_aDonationIsNeverSpentForTheCaller() public {
        _bookWorld();
        vm.prank(mm);
        token.transfer(address(router), 100 * U);
        address u = _user("u", 1_000 * U);
        // u holds no token: closeLong must pull u's own tokens, never spend the donated 100
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, u, 0, 100 * U));
        router.closeLong(address(s), 100 * U, U, _none());
        _holdsNothing(0, 100 * U);
        _give(address(router), 720 * U);
        address v = makeAddr("v"); // no dollars, no allowance
        vm.prank(v);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, 720 * U)
        );
        router.openShort(address(s), 100 * U, U, 1, v, true, _none());
        _holdsNothing(720 * U, 100 * U);
    }

    /// No path credits another account's short, so nobody can hand the router short units: a mint names the router
    /// as recipient no more (v3.2, audit L1; tokens reach it only by a plain transfer, a donation), the short stays
    /// with the payer, and a SHORT position owned by the router is refused.
    function test_I13_donatedShortIsInert() public {
        _bookWorld();
        address d = _user("d", 1_000 * U);
        address e = makeAddr("e");
        vm.startPrank(d);
        dollar.approve(address(s), type(uint256).max);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.mint(10 * U, address(router));
        s.mint(10 * U, d);
        token.transfer(address(router), 10 * U); // tokens to the router: a plain donation
        assertEq(s.shortOf(address(router)), 0);
        assertEq(s.shortOf(d), 10 * U);
        s.mint(10 * U, d);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.SHORT, 10 * U, address(router), d, d, true); // the router as owner: the generic guard
        // v3.3 (review): an owner that passes the generic guard reaches the A1 / I29 rule itself (a SHORT
        // position for someone else is refused unless the router calls)
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.SHORT, 10 * U, e, d, d, true);
        assertEq(s.shortOf(d), 20 * U, "nothing moved");
        vm.stopPrank();
        address u = _user("u", 100_000 * U);
        (uint256[] memory sids,,) = _short(u, 100 * U, U, 1, u, true);
        uint256[] memory lids = _longDaily(u, 364 * U, 100 * U, 1, u);
        _closeShort(u, sids, 365 * U);
        _closeLongDaily(u, lids, U);
        assertEq(s.shortOf(address(router)), 0);
        _holdsNothing(0, 10 * U); // the donated tokens stay donations
    }
}
