// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I11: claim pays only the stored payee, whoever calls, and reverts for a missing id; zero, the series and the token
/// are refused as owner, payee and recipient; the router and the factory are refused as payee in streamOut and
/// setPayout (RC2); only the owner changes the payout or the operator, or unstreams.
contract SeriesAuthorityTest is SeriesBase {
    function test_I11_claimPaysThePayeeWhoeverCalls() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, payer, true);
        vm.warp(_afterDay(3));
        address[4] memory callers = [a, b, stranger, payer];
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            vm.warp(_afterDay(3 + i));
            uint256 b0 = dollar.balanceOf(callers[i]);
            uint256 p0 = dollar.balanceOf(payer);
            vm.prank(callers[i]);
            uint256 got = s.claim(id);
            total += got;
            assertEq(dollar.balanceOf(payer) - p0, got);
            if (callers[i] != payer) assertEq(dollar.balanceOf(callers[i]), b0);
        }
        assertGt(total, 0);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, 999));
        s.claim(999);
    }

    function test_I11_badAddressesRejected() public {
        _mint(a, 10 * U);
        vm.startPrank(a);
        address[3] memory bad = [address(0), address(s), address(tok)];
        for (uint256 i; i < 3; ++i) {
            vm.expectRevert(IAgateSeries.BadOwner.selector);
            s.streamOut(Side.LONG, U, bad[i], a, a, true);
            vm.expectRevert(IAgateSeries.BadPayee.selector);
            s.streamOut(Side.LONG, U, a, bad[i], a, true);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.streamOut(Side.LONG, U, a, a, bad[i], true);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.mint(U, bad[i]);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.redeem(U, bad[i]);
        }
        vm.stopPrank();
    }

    /// RC2: a claim paid to the factory's router or to the factory could never leave.
    function test_I11_routerAndFactoryRefusedAsPayee() public {
        _mint(a, 10 * U);
        vm.startPrank(a);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.streamOut(Side.LONG, U, a, router, a, true);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.streamOut(Side.SHORT, U, a, factory, a, true);
        (uint256 id,) = s.streamOut(Side.LONG, U, a, a, a, true);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.setPayout(id, router, true);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.setPayout(id, factory, true);
        vm.expectRevert(IAgateSeries.BadPayee.selector);
        s.setPayout(id, address(s), true);
        vm.stopPrank();
    }

    /// v3.2 (audit L1): nothing ever moves a token or a dollar out of the router or the factory, so neither is a
    /// recipient in any path nor a position's owner; only the router names itself, in its own flows.
    function test_I11_routerAndFactoryRefusedAsRecipientAndOwner() public {
        _mint(a, 40 * U);
        (uint256 lid,) = _stream(a, Side.LONG, U, a, a, true);
        (uint256 sid,) = _stream(a, Side.SHORT, U, a, a, true);
        address[2] memory bad = [router, factory];
        vm.startPrank(a);
        for (uint256 i; i < 2; ++i) {
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.mint(U, bad[i]);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.redeem(U, bad[i]);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.streamOut(Side.LONG, U, a, a, bad[i], true);
            vm.expectRevert(IAgateSeries.BadOwner.selector);
            s.streamOut(Side.LONG, U, bad[i], a, a, true);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.closeWithToken(sid, bad[i]);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.unstream(lid, bad[i]);
        }
        vm.stopPrank();
        // the router's own flow: it mints pairs to itself and passes them on in the same call
        _give(router, 1_000 * U);
        vm.startPrank(router);
        s.mint(U, router);
        assertEq(tok.balanceOf(router), U);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.SHORT, U, router, a, a, true); // never an owner, not even of its own short
        s.redeem(U, router);
        vm.stopPrank();
        // after the month: settle refuses both as well
        vm.warp(_afterDay(30));
        vm.startPrank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.settle(Side.LONG, U, factory);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.settle(Side.SHORT, U, router);
        assertGt(s.settle(Side.LONG, U, a), 0);
        vm.stopPrank();
        _check();
    }

    function test_I11_onlyOwnerChangesPayoutOperatorOrUnstreams() public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, Side.LONG, 10 * U, a, a, true);
        vm.prank(a);
        s.setOperator(id, c);
        address[2] memory others = [b, c];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(IAgateSeries.NotOwner.selector);
            s.setPayout(id, others[i], true);
            vm.expectRevert(IAgateSeries.NotOwner.selector);
            s.unstream(id, others[i]);
            vm.expectRevert(IAgateSeries.NotOwner.selector);
            s.setOperator(id, others[i]);
            vm.stopPrank();
        }
    }

    /// A payee that reverts (a blacklist) blocks only its own position; the owner moves the payout.
    function test_I11_revertingPayeeBlocksOnlyItsOwnClaims() public {
        _mint(a, 20 * U);
        (uint256 id1,) = _stream(a, Side.SHORT, 10 * U, a, b, true);
        (uint256 id2,) = _stream(a, Side.SHORT, 10 * U, a, c, true);
        vm.warp(_afterDay(2));
        // b becomes unpayable: transfers to it revert
        vm.mockCallRevert(
            address(dollar), abi.encodeWithSignature("transfer(address,uint256)", b, s.claimable(id1)), "blocked"
        );
        vm.expectRevert();
        s.claim(id1);
        s.claim(id2); // the other position is unaffected
        vm.prank(a);
        s.setPayout(id1, a, true);
        assertGt(s.claim(id1), 0);
        vm.clearMockedCalls();
        _check();
    }
}
