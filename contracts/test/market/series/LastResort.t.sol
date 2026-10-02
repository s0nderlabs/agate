// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {LAST_RESORT_FLOOR, FLAG_FORCED} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I26: no series waits for ever. Every day is applied no later than lastResort = max(60 DAY, 3 days) after it ended,
/// whether the index answers, stays silent or reverts; no day is forced before; a forced day repeats lastX (one walk,
/// then x0). Example 5 of BUILD-SPEC 12.1.
contract SeriesLastResortTest is SeriesBase {
    bytes32 internal constant FIX_APPLIED = keccak256("FixApplied(uint8,uint32,uint32,uint32,uint8,uint8,uint64)");

    function _forcedIn(Vm.Log[] memory logs) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s) || logs[i].topics[0] != FIX_APPLIED) continue;
            (,,, uint8 fl,) = abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            if (fl & FLAG_FORCED != 0) ++n;
        }
    }

    function test_I26_silentHaltAfterDay15() public {
        for (uint32 d = NOV1 + 15; d < DEC1; ++d) {
            index.del(GPU, d);
        }
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 15);
        vm.warp(_deadline(16) - 1);
        s.sync(type(uint256).max);
        assertEq(_k(), 15, "never forced early");
        vm.warp(_deadline(16));
        vm.recordLogs();
        s.sync(type(uint256).max);
        assertEq(_k(), 16, "forced exactly at its end + 60 DAY");
        assertEq(_forcedIn(vm.getRecordedLogs()), 1);
        vm.warp(_deadline(30));
        vm.recordLogs();
        s.sync(type(uint256).max);
        assertEq(_forcedIn(vm.getRecordedLogs()), 14);
        assertEq(_k(), 30);
        assertEq(_S(), 120_000_000, "days 16 to 30 at the last value, 4.20");
        assertFalse(_walked(), "a series that applied a real fix never walks");
    }

    function test_I26_revertingIndexWalksBackOnce() public {
        _world(86_400, 0, 0, 21_600, 4_000_000); // October at 4.00, x0 = Sep 30's 3.60
        index.setRevertFrom(GPU, NOV1);
        vm.warp(_deadline(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        assertEq(_S(), 30 * uint256(4_000_000), "Oct 31's 4.00, not x0's 3.60");
        assertTrue(_walked());
    }

    function test_I26_indexDeadEverywhereUsesX0() public {
        _world(86_400, 0, 0, 21_600, 4_000_000);
        index.setRevertFrom(GPU, 0);
        vm.warp(_deadline(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        assertEq(_S(), 30 * uint256(REF));
    }

    function test_I26_walkRunsOnce() public {
        _world(86_400, 0, 0, 21_600, 4_000_000);
        index.setRevertFrom(GPU, NOV1);
        vm.warp(_deadline(1));
        s.sync(type(uint256).max);
        assertEq(_k(), 1);
        assertEq(_lastX(), 4_000_000);
        index.setRevertFrom(GPU, 0); // the index then fails on every call
        uint256 t = _deadline(30);
        vm.warp(t);
        vm.expectCall(address(index), abi.encodeWithSelector(IAgateIndex.finalFix.selector), 29);
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        assertEq(_S(), 30 * uint256(4_000_000), "repeats lastX, does not re-walk to x0");
    }

    /// The walk needs the reserve for each of its calls, or the whole call reverts: walked is never set half way.
    function test_I26_walkNeedsGasOrRevertsWhole() public {
        _world(86_400, 0, 0, 21_600, 4_000_000);
        index.setRevertFrom(GPU, NOV1);
        for (uint32 d = OCT1 - 5; d < NOV1; ++d) {
            index.del(GPU, d); // the walk goes 31 days back and finds nothing
        }
        vm.warp(_deadline(1));
        // enough for the day's own round and a dozen walk calls, not for 31 of them
        (bool ok, bytes memory ret) = address(s).call{gas: RESERVE + 60_000}(abi.encodeCall(IAgateSeries.sync, (1)));
        assertFalse(ok);
        assertEq(_sel(ret), IAgateSeries.SyncGasLow.selector);
        assertEq(_k(), 0);
        assertFalse(_walked());
        s.sync(type(uint256).max);
        assertEq(_k(), 1);
        assertEq(_lastX(), REF, "x0");
        assertTrue(_walked());
    }

    /// A revived index: days applied normally until the halt, forced only past their own deadline, real again after.
    function test_I26_indexRevivedBeforeTheDeadline() public {
        for (uint32 d = NOV1 + 5; d < NOV1 + 8; ++d) {
            index.del(GPU, d);
        }
        vm.warp(_afterDay(20));
        s.sync(type(uint256).max);
        assertEq(_k(), 5);
        for (uint32 d = NOV1 + 5; d < NOV1 + 8; ++d) {
            _post(d, 5_000_000); // the index catches up with final records
        }
        vm.warp(_afterDay(20) + 3_600); // day 21 still running
        vm.recordLogs();
        s.sync(type(uint256).max);
        assertEq(_forcedIn(vm.getRecordedLogs()), 0);
        assertEq(_k(), 20);
    }

    /// v2 (finding D1): on the demo clock a day is forced only 3 real days after it ended, never earlier.
    function test_I26_demoLastResortFloor() public {
        uint64 t0 = 1_790_000_000;
        _world(600, t0, OCT1, 210, REF);
        assertEq(s.terms().lastResort, LAST_RESORT_FLOOR);
        for (uint32 d = NOV1 + 5; d < DEC1; ++d) {
            index.del(GPU, d);
        }
        uint32 d6 = NOV1 + 5;
        vm.warp(_dayEnd(d6) + 60 * 600); // the old 10-hour deadline: not yet
        s.sync(type(uint256).max);
        vm.warp(_dayEnd(d6) + LAST_RESORT_FLOOR - 1);
        s.sync(type(uint256).max);
        assertEq(_k(), 5);
        vm.warp(_dayEnd(d6) + LAST_RESORT_FLOOR);
        vm.recordLogs();
        s.sync(type(uint256).max);
        assertEq(_k(), 6);
        assertEq(_forcedIn(vm.getRecordedLogs()), 1);
    }

    /// Random halts, silent or reverting: at every deadline (and one second before) no day is forced early and
    /// every day is applied by its deadline; real days equal the index, forced days are only those it never closed.
    /// forge-config: default.fuzz.runs = 64
    function test_I26_randomHalts(uint256 seed) public {
        uint32 pre = uint32(200 + seed % 400) * 10_000;
        _world(86_400, 0, 0, 21_600, pre);
        uint32 stop = NOV1 + uint32(uint256(keccak256(abi.encode(seed, "stop"))) % 30);
        for (uint32 d = stop; d < DEC1; ++d) {
            index.del(GPU, d);
        }
        if (uint256(keccak256(abi.encode(seed, "mode"))) % 2 == 0) index.setRevertFrom(GPU, stop);
        for (uint32 d = NOV1; d < DEC1; ++d) {
            uint256 kk = d - NOV1 + 1;
            vm.warp(_deadline(kk) - 1);
            vm.recordLogs();
            s.sync(type(uint256).max);
            _checkForced(vm.getRecordedLogs(), stop);
            vm.warp(_deadline(kk));
            vm.recordLogs();
            s.sync(type(uint256).max);
            _checkForced(vm.getRecordedLogs(), stop);
            assertGe(_k(), kk, "a day not applied by its deadline");
        }
        assertEq(_k(), 30);
        uint256 expected;
        for (uint32 d = NOV1; d < DEC1; ++d) {
            expected += d < stop ? (d < NOV1 + 10 ? REF : STEP) : (stop == NOV1 ? pre : (stop <= NOV1 + 10 ? REF : STEP));
        }
        assertEq(_S(), expected);
    }

    function _checkForced(Vm.Log[] memory logs, uint32 stop) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s) || logs[i].topics[0] != FIX_APPLIED) continue;
            uint32 day = uint32(uint256(logs[i].topics[2]));
            (uint32 x,,, uint8 fl,) = abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            if (fl & FLAG_FORCED != 0) {
                assertGe(block.timestamp, _dayEnd(day) + _lastResort(), "a day forced before its deadline");
                assertGe(day, stop, "a day the index closed was forced");
            } else {
                assertEq(x, day < NOV1 + 10 ? REF : STEP);
            }
        }
    }

    function test_I26_lateFinalFixAfterTheDeadlineIsTooLate() public {
        // the record exists but becomes final only after the deadline: the day was forced, and stays forced
        index.put(GPU, NOV1, 5_000_000, uint64(_deadline(1) + 10), IAgateIndex.Status.FULL, 5, false, false);
        vm.warp(_deadline(1));
        s.sync(1);
        assertEq(_k(), 1);
        assertEq(_S(), REF, "forced at the walk's value (Oct 31 = 3.60)");
        vm.warp(_deadline(1) + 11);
        s.sync(1);
        assertEq(_S(), REF + REF, "day 2 is real; day 1 is never re-applied");
    }

    function test_I26_productionLastResortIsSixtyDays() public view {
        assertEq(s.terms().lastResort, 60 days);
    }
}
