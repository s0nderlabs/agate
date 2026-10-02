// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "../router/RouterBase.sol";

/// Security audit, finding L1 (LOW). The series refused its router and factory as a payee (RC2) but not as a
/// recipient (`to`, `_okTo`), so mint, redeem, settle, closeWithToken, unstream and streamOut could send tokens or
/// dollars to the router or the factory, where nothing can ever move them (the PoC parked 10 tokens in the router and
/// 36 dollars in the factory). FIXED in v3.2 (spec 4.4 `_okTo`, 4.5 streamOut; model
/// test_series_refuses_its_router_and_factory_as_recipient_or_owner): both are refused as `to` (the router only names
/// itself in its own flows) and as a position's owner. Router flows still work.
contract StuckSendsTest is RouterBase {
    function test_POC_L1_FIXED_routerAndFactoryRefusedAsRecipients() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        vm.startPrank(u);
        dollar.approve(address(s), type(uint256).max);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.mint(10 * U, address(router)); // tokens to the router
        s.mint(10 * U, u);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.redeem(5 * U, address(factory)); // dollars to the factory
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.streamOut(Side.LONG, U, u, u, address(router), true);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.LONG, U, address(factory), u, u, true);
        // the payee rule refuses both too
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.streamOut(Side.LONG, U, u, address(router), u, true);
        vm.stopPrank();
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(dollar.balanceOf(address(factory)), 0);
        // router flows (which mint pairs to the router itself) still work and the router holds nothing
        _long(u, 364 * U, 100 * U);
        (uint256[] memory ids,,) = _short(u, 100 * U, 1, 1, u, true);
        assertEq(ids.length, 1);
        _holdsNothing(0, 0);
    }
}
