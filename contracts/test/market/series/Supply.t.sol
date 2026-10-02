// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I12: token supply and short supply change only through mint, redeem, streamOut, closeWithToken, unstream and
/// settle; only the series mints or burns the token; every burn is from msg.sender (RC6).
contract SeriesSupplyTest is SeriesBase {
    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    function test_I12_onlyTheSeriesMintsOrBurns() public {
        _mint(a, 10 * U);
        vm.prank(a);
        vm.expectRevert(IAgateToken.OnlySeries.selector);
        tok.mint(a, 1);
        vm.prank(a);
        vm.expectRevert(IAgateToken.OnlySeries.selector);
        tok.burn(a, 1);
        vm.expectRevert(IAgateToken.OnlySeries.selector);
        tok.burn(a, 1);
    }

    /// Runs `data` as `who` and asserts every token burn in it is from `who` and every supply change is as stated.
    function _call(address who, bytes memory data, int256 dToken, int256 dShort) internal {
        uint256 t0 = tok.totalSupply();
        uint256 s0 = _shortSupply();
        vm.recordLogs();
        vm.prank(who);
        (bool ok, bytes memory ret) = address(s).call(data);
        assertTrue(ok, string(ret));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(tok) || logs[i].topics[0] != TRANSFER) continue;
            address from = address(uint160(uint256(logs[i].topics[1])));
            address to = address(uint160(uint256(logs[i].topics[2])));
            if (to == address(0)) assertEq(from, who, "I12 a burn from someone other than msg.sender");
        }
        assertEq(int256(tok.totalSupply()) - int256(t0), dToken, "token supply change");
        assertEq(int256(_shortSupply()) - int256(s0), dShort, "short supply change");
    }

    function test_I12_supplyChangesAndBurnsFromTheCaller() public {
        _give(a, 1_000 * U);
        _give(b, 1_000 * U);
        int256 q = int256(10 * U);
        _call(a, abi.encodeCall(IAgateSeries.mint, (40 * U, a)), 4 * q, 4 * q);
        _call(a, abi.encodeCall(IAgateSeries.redeem, (10 * U, a)), -q, -q);
        _call(a, abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, 10 * U, b, b, a, true)), -q, 0); // 1, op a
        _call(a, abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 10 * U, a, a, a, true)), 0, -q); // 2
        _call(b, abi.encodeCall(IAgateSeries.mint, (10 * U, b)), q, q);
        // a operates b's LONG position 1: it delivers its own short units
        _call(a, abi.encodeCall(IAgateSeries.closeWithToken, (1, b)), 0, -q);
        // b operates a's SHORT position 2 after a grants it: b burns its own tokens, never a's
        vm.prank(a);
        s.setOperator(2, b);
        vm.prank(a);
        tok.transfer(b, 1); // a still holds tokens, which must stay
        uint256 aTokens = tok.balanceOf(a);
        _call(b, abi.encodeCall(IAgateSeries.closeWithToken, (2, a)), -q, 0);
        assertEq(tok.balanceOf(a), aTokens);
        _call(a, abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 5 * U, a, a, a, true)), 0, -q / 2); // 3
        _call(a, abi.encodeCall(IAgateSeries.unstream, (3, a)), 0, q / 2);
        _call(a, abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, 5 * U, a, a, a, true)), -q / 2, 0); // 4
        _call(a, abi.encodeCall(IAgateSeries.unstream, (4, a)), q / 2, 0);
        // claims, payouts, operators and syncs change no supply
        _call(a, abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, 5 * U, a, a, a, true)), -q / 2, 0); // 5
        vm.warp(_afterDay(30));
        _call(stranger, abi.encodeCall(IAgateSeries.sync, (3)), 0, 0);
        _call(a, abi.encodeCall(IAgateSeries.setPayout, (5, c, true)), 0, 0);
        _call(stranger, abi.encodeCall(IAgateSeries.claim, (5)), 0, 0);
        int256 aT = int256(tok.balanceOf(a));
        int256 aS = int256(s.shortOf(a));
        _call(a, abi.encodeCall(IAgateSeries.settle, (Side.LONG, uint256(aT), a)), -aT, 0);
        _call(a, abi.encodeCall(IAgateSeries.settle, (Side.SHORT, uint256(aS), a)), 0, -aS);
        int256 bT = int256(tok.balanceOf(b));
        _call(b, abi.encodeCall(IAgateSeries.settle, (Side.LONG, uint256(bT), b)), -bT, 0);
        _call(b, abi.encodeCall(IAgateSeries.settle, (Side.SHORT, s.shortOf(b), b)), 0, -int256(s.shortOf(b)));
        assertEq(tok.totalSupply(), 0);
        assertEq(_shortSupply(), 0);
        _check();
    }

    function test_I12_transferIsTheOnlyOtherTokenMove() public {
        _mint(a, 3 * U);
        vm.expectEmit(address(tok));
        emit IERC20.Transfer(a, b, U);
        vm.prank(a);
        tok.transfer(b, U);
        assertEq(tok.totalSupply(), 3 * U);
        assertEq(_shortSupply(), 3 * U);
    }
}
