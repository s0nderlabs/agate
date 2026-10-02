// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I29: shorts never move between accounts. A debit is always of msg.sender; a credit is always to msg.sender (mint)
/// or to a SHORT position's owner (unstream, to == owner); a SHORT position's owner is the account whose short it was
/// made from, or the caller of the factory's router; no function transfers short.
contract SeriesShortTest is SeriesBase {
    bytes32 internal constant CREDITED = keccak256("ShortCredited(address,uint256,uint256)");
    bytes32 internal constant DEBITED = keccak256("ShortDebited(address,uint256,uint256)");

    /// Runs data as `who` and checks every short event in it (owner: the position owner an unstream may credit).
    function _act(address who, bytes memory data, address owner) internal returns (bytes memory ret) {
        vm.recordLogs();
        vm.prank(who);
        bool ok;
        (ok, ret) = address(s).call(data);
        assertTrue(ok, "call failed");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s)) continue;
            address acct = address(uint160(uint256(logs[i].topics.length > 1 ? logs[i].topics[1] : bytes32(0))));
            if (logs[i].topics[0] == DEBITED) assertEq(acct, who, "I29 a debit of someone other than msg.sender");
            if (logs[i].topics[0] == CREDITED) {
                assertTrue(acct == who || acct == owner, "I29 a short credited to a third account");
            }
        }
    }

    function test_I29_shortMovesOnlyForTheActor() public {
        _give(a, 10_000 * U);
        _give(b, 10_000 * U);
        _act(a, abi.encodeCall(IAgateSeries.mint, (100 * U, b)), address(0)); // b gets tokens, a gets the short
        assertEq(s.shortOf(a), 100 * U);
        assertEq(s.shortOf(b), 0);
        _act(a, abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 30 * U, a, b, a, true)), address(0)); // id 1
        _act(b, abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, 30 * U, a, a, b, true)), address(0)); // id 2, op b
        _act(a, abi.encodeCall(IAgateSeries.closeWithToken, (2, a)), address(0)); // owner delivers its own short
        _act(a, abi.encodeCall(IAgateSeries.unstream, (1, a)), a);
        vm.prank(b);
        tok.transfer(a, 10 * U);
        _act(a, abi.encodeCall(IAgateSeries.redeem, (10 * U, b)), address(0));
        vm.warp(_afterDay(30));
        _act(a, abi.encodeCall(IAgateSeries.settle, (Side.SHORT, s.shortOf(a), a)), address(0));
        assertEq(s.shortOf(a), 0);
        assertEq(_shortSupply(), 0);
        _check();
    }

    function test_I29_everyPathThatMovedAShortIsRefused() public {
        _give(a, 10_000 * U);
        vm.prank(a);
        s.mint(10 * U, b); // v1's shortTo is gone: the payer keeps the short
        assertEq(s.shortOf(a), 10 * U);
        assertEq(s.shortOf(b), 0);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadOwner.selector);
        s.streamOut(Side.SHORT, 10 * U, b, b, a, true); // a SHORT position for another owner
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.unstream(id, b); // a SHORT position returns to its owner only
        (bool ok,) = address(s).call(abi.encodeWithSignature("transferShort(address,uint256)", b, 1));
        assertFalse(ok, "there is no short transfer");
        assertEq(s.shortOf(b), 0);
    }

    function test_I29_onlyTheFactoryRouterOpensAShortForAnotherOwner() public {
        _give(router, 10_000 * U);
        uint256 q = 720 * U;
        vm.prank(router);
        s.mint(q, router); // the router minted in the same call: it holds the short for an instant
        uint256 before = s.shortOf(router);
        vm.prank(router);
        (uint256 id, uint256 paidNow) = s.streamOut(Side.SHORT, q, a, a, a, true);
        opened.push(id);
        assertEq(paidNow, 0);
        assertEq(s.shortOf(router), before - q, "back to its starting value");
        assertEq(s.shortOf(a), 0, "the owner's balance is not touched");
        assertEq(s.position(id).owner, a);
        assertEq(s.position(id).operator, router);
        // the router opens it for its caller only by delivering its own tokens later (closeWithToken, to == owner)
        vm.prank(router);
        vm.expectRevert(IAgateSeries.OperatorMustPayOwner.selector);
        s.closeWithToken(id, router);
        vm.prank(router);
        assertEq(s.closeWithToken(id, a), q * CAP / U);
        assertEq(tok.balanceOf(router), 0);
        _check();
    }

    function test_I29_operatorCloseOfLongBurnsTheOperatorsOwnShort() public {
        _mint(b, 20 * U);
        (uint256 id,) = _stream(b, Side.LONG, 10 * U, a, a, true); // b gifts a LONG position to a: operator b
        _mint(a, 5 * U);
        uint256 aShort = s.shortOf(a);
        vm.prank(b);
        s.closeWithToken(id, a);
        assertEq(s.shortOf(a), aShort, "the owner's short is not debited");
        assertEq(s.shortOf(b), 10 * U, "the operator's own short paid for the close");
        _check();
    }

    function test_I29_lotsOfShortsStayPut(uint256 qa, uint256 qb) public {
        qa = bound(qa, 1, 1_000) * LOT;
        qb = bound(qb, 1, 1_000) * LOT;
        _mint(a, qa);
        _mint(b, qb);
        vm.prank(a);
        tok.transfer(b, qa); // tokens move freely; shorts do not
        assertEq(s.shortOf(a), qa);
        assertEq(s.shortOf(b), qb);
        assertEq(_shortSupply(), qa + qb);
    }
}
