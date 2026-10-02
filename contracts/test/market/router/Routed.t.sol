// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {U, Flow} from "../../../src/market/MarketTypes.sol";
import {RouterFuzz} from "./RouterFuzz.sol";

/// I37 (BUILD-SPEC 8.4, finding F6): in every router flow the caller's dollar balance changes by
/// dollarsOut - dollarsIn and its token balance by tokensOut - tokensIn, with each field defined per flow; then the
/// same over random books and random flows (the model's TestRouterFuzz: 150 worlds x 40 flows).
contract RouterRoutedTest is RouterFuzz {
    /// One click of each flow, every Routed field as the table of 8.4 defines it.
    function test_I37_everyFlowAsTheTableSays() public {
        _bookWorld();
        _ask(3_650_000, 100 * U); // a second level, so a buy can come back with a refund
        address u = _user("u", 100_000 * U);
        uint256 d0;
        uint256 t0;
        R memory r;

        // OPEN_LONG: tokens = bought, dollarsIn = quote, dollarsOut = refund = Kuru's unused quote, tokensOut = bought
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        uint256 got = _long(u, 364 * U, 100 * U);
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.OPEN_LONG));
        assertEq(r.series, address(s));
        assertEq(
            abi.encode(r.tokens, r.dollarsIn, r.dollarsOut, r.refund, r.tokensIn, r.tokensOut, r.ids.length),
            abi.encode(got, 364 * U, 0, 0, 0, got, 0)
        );

        // OPEN_LONG_DAILY: dollarsOut = refund + the floors paid at once, tokensOut = bought - per x parts
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        uint256[] memory lids = _longDaily(u, 364_036_400, 100_010_000, 3, u);
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.OPEN_LONG_DAILY));
        assertEq(r.tokens, 100_010_000);
        assertEq(r.dollarsIn, 364_036_400);
        assertEq(r.refund, 0);
        assertEq(r.dollarsOut, 3 * (33_336_600 * uint256(F) / U));
        assertEq(r.tokensOut, 200);
        assertEq(keccak256(abi.encode(r.ids)), keccak256(abi.encode(lids)));

        // OPEN_SHORT: tokens = sold = minted, dollarsIn = mint cost, dollarsOut = proceeds + paidNow
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        (uint256[] memory sids, uint256 cost, uint256 out) = _short(u, 100 * U, U, 2, u, true);
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.OPEN_SHORT));
        assertEq(
            abi.encode(r.tokens, r.dollarsIn, r.dollarsOut, r.refund, r.tokensIn, r.tokensOut),
            abi.encode(100 * U, cost, out, 0, 0, 0)
        );
        assertEq(keccak256(abi.encode(r.ids)), keccak256(abi.encode(sids)));

        // CLOSE_LONG: tokens = sold = tokensIn, dollarsOut = proceeds
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        out = _closeLong(u, 100 * U, U);
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.CLOSE_LONG));
        assertEq(
            abi.encode(r.tokens, r.dollarsIn, r.dollarsOut, r.refund, r.tokensIn, r.tokensOut, r.ids.length),
            abi.encode(100 * U, 0, out, 0, 100 * U, 0, 0)
        );

        // CLOSE_SHORT, the book shallower than the quote: refund > 0 and surplus tokens > 0
        vm.warp(_afterDay(3));
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        (uint256 paid, uint256 surplus, uint256 refund) = _closeShort(u, sids, 50_000 * U); // the asks cost ~17,837
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.CLOSE_SHORT));
        assertGt(refund, 0);
        assertGt(surplus, 0);
        assertEq(r.tokens, 100 * U + surplus);
        assertEq(r.dollarsIn, 50_000 * U);
        assertEq(r.dollarsOut, refund + paid);
        assertEq(r.refund, refund);
        assertEq(r.tokensIn, 0);
        assertEq(r.tokensOut, surplus);
        assertEq(keccak256(abi.encode(r.ids)), keccak256(abi.encode(sids)));
        assertEq(m.levels(true).length, 0); // the whole ask side was bought

        // CLOSE_LONG_DAILY: tokens = sold = minted, dollarsIn = mint cost, dollarsOut = proceeds + close payments
        d0 = dollar.balanceOf(u);
        t0 = token.balanceOf(u);
        vm.recordLogs();
        (uint256 cost2, uint256 out2, uint256 paid2) = _closeLongDaily(u, lids, U);
        r = _routed(vm.getRecordedLogs());
        _assertRoutedTruth(r, u, d0, t0);
        assertEq(uint8(r.flow), uint8(Flow.CLOSE_LONG_DAILY));
        assertEq(
            abi.encode(r.tokens, r.dollarsIn, r.dollarsOut, r.refund, r.tokensIn, r.tokensOut),
            abi.encode(3 * 33_336_600, cost2, out2 + paid2, 0, 0, 0)
        );
        assertEq(keccak256(abi.encode(r.ids)), keccak256(abi.encode(lids)));
        _holdsNothing(0, 0);
    }

    /// The model's router fuzz (150 worlds x 40 flows): one world per run.
    /// forge-config: default.fuzz.runs = 150
    /// forge-config: ci.fuzz.runs = 600
    function testFuzz_I37_randomFlows(uint256 seed) public {
        _fuzzWorld(seed, 0, 0);
        Stats memory st;
        _run(40, st);
    }

    /// Twelve fixed worlds: every flow really runs, many times (a suite whose flows all revert proves nothing).
    function test_I37_seededWorldsExerciseEveryFlow() public {
        Stats memory st;
        for (uint256 seed = 1; seed <= 12; ++seed) {
            _fuzzWorld(seed * 7_919, 0, 0);
            _run(40, st);
        }
        for (uint256 f; f < 6; ++f) {
            assertGt(st.ok[f], 10, "a flow barely ran");
        }
        assertGt(st.routed, 200);
        emit log_named_uint("routed calls checked", st.routed);
    }
}
