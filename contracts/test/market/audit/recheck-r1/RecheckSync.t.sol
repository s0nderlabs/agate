// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAgateSeries} from "../../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side, FLAG_FORCED} from "../../../../src/market/MarketTypes.sol";
import {SeriesBase} from "../../series/SeriesBase.sol";

/// Cold recheck r1, sync and last resort: one missing day in the middle of a month whose later days are all final.
contract RecheckSyncTest is SeriesBase {
    bytes32 internal constant FIX_APPLIED = keccak256("FixApplied(uint8,uint32,uint32,uint32,uint8,uint8,uint64)");
    uint32 internal constant HIGH = 5_000_000;

    /// Day 15 at 5.00, day 16 never closes, days 17 to 30 final at 4.20.
    function _hole() internal {
        _post(NOV1 + 14, HIGH);
        index.del(GPU, NOV1 + 15);
    }

    /// The hole holds every later final day (days apply in order, none is skipped) until its own deadline; then one
    /// call forces day 16 at day 15's 5.00 and applies 17 to 30 from the index; claimable equals each claim; a record
    /// for day 16 that turns up later changes nothing.
    function test_RC4_oneMissingDayHoldsTheRestThenFillsInWithTheLastValue() public {
        _hole();
        _mint(a, 720 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 720 * U, a, a, true);

        vm.warp(_afterDay(30));
        uint256 shown = s.claimable(id);
        vm.prank(stranger);
        assertEq(s.claim(id), shown, "I36 claimable is the claim");
        assertEq(_k(), 15, "day 16 holds days 17 to 30 although they are final");

        vm.warp(_deadline(16) - 1);
        s.sync(type(uint256).max);
        assertEq(_k(), 15, "never forced early");

        vm.warp(_deadline(16));
        (uint8 kp, uint64 sp) = s.previewSync();
        shown = s.claimable(id);
        vm.recordLogs();
        vm.prank(stranger);
        assertEq(s.claim(id), shown, "I36 at the deadline, the final claim");
        assertEq(_k(), 30, "the forced day and every final day after it, in one call");
        assertEq(kp, 30);
        assertEq(sp, _S());
        assertEq(_S(), 10 * uint256(REF) + 4 * uint256(STEP) + 2 * uint256(HIGH) + 14 * uint256(STEP));
        assertFalse(_walked(), "a series that applied a real fix never walks");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s) || logs[i].topics[0] != FIX_APPLIED) continue;
            uint256 kk = uint256(logs[i].topics[1]);
            (uint32 x,,, uint8 fl,) = abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            if (kk == 16) {
                assertTrue(fl & FLAG_FORCED != 0, "day 16 forced");
                assertEq(x, HIGH, "at day 15's value");
            } else {
                assertTrue(fl & FLAG_FORCED == 0, "days 17 to 30 real");
                assertEq(x, STEP);
            }
            ++seen;
        }
        assertEq(seen, 15);

        _post(NOV1 + 15, 9_000_000); // the index closes day 16 late
        uint256 sum = _S();
        assertEq(s.sync(type(uint256).max), 0);
        assertEq(_S(), sum, "a late record changes nothing once the day is applied");
        _check();
    }

    /// At the hole's deadline, at every gas limit a sync either reverts as a whole or applies all fifteen days:
    /// never the forced day alone, never a forced day 17 to 30 (whose fixes are final).
    function test_RC5_gasSweepOverTheHoleAppliesAllOrNothing() public {
        _hole();
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 15);
        vm.warp(_deadline(16));
        uint256 okCalls;
        for (uint256 g = 30_000; g <= 2_500_000; g += 7_919) {
            uint256 snap = vm.snapshotState();
            (bool ok, bytes memory ret) =
                address(s).call{gas: g}(abi.encodeCall(IAgateSeries.sync, (type(uint256).max)));
            if (ok) {
                ++okCalls;
                assertEq(_k(), 30, "a successful call applies every day");
                assertEq(_S(), 10 * uint256(REF) + 4 * uint256(STEP) + 2 * uint256(HIGH) + 14 * uint256(STEP));
            } else {
                assertEq(_k(), 15, "a failed call applies nothing");
                if (ret.length >= 4) assertEq(_sel(ret), IAgateSeries.SyncGasLow.selector);
            }
            vm.revertToState(snap);
        }
        assertGt(okCalls, 0, "the sweep reached the working limit");
    }
}
