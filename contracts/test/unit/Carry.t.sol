// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

contract CarryTest is IndexBase {
    uint32 internal D;
    uint32 internal d1;
    uint32[] internal V;
    uint32[] internal UP;

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        d1 = D + 1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        UP = arr(3_000_000, 3_200_000, 3_600_000, 3_600_000, 3_800_000);
    }

    function _carry(address who) internal returns (uint8) {
        vm.prank(who);
        return ix.carryDay(GPU);
    }

    /// A writer posts valid values on 3 slices only: eligible, no FRESH slot, quorum 0.
    function _sparse(address w, uint32 d) internal {
        postRange(w, d, 0, 3, V);
    }

    function test_unknownGpu() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, GPU2));
        ix.carryDay(GPU2);
    }

    // ------------------------------------------------------------------ case 2

    function test_case2_dayNotOver() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_DayNotOver.selector, D));
        ix.carryDay(GPU);
    }

    function test_case2_skippedBeforeFirstRecord_atGraceBoundary() public {
        uint256 at = dEnd(D) + P.day; // graceStart + GRACE (one DAY, v4.3)
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_TooEarly.selector, uint64(at)));
        ix.carryDay(GPU);
        vm.warp(at);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.DaySkipped(GPU, D, 2);
        assertEq(_carry(keeper), 2);
        assertEq(ix.head(GPU), D + 1);
        assertFalse(exists(D));
        assertEq(ix.gpu(GPU).lastCarryAt, at);
        assertEq(lastState(0).miss, 6, "no state change");
    }

    function test_case2_graceStartsAtRegistration() public {
        // registered three days after its firstDay (a backfill): the carry clock starts at registration
        vm.warp(dStart(D + 3) + 100);
        registerSimple(GPU2, 3, D);
        uint256 reg = dStart(D + 3) + 100;
        assertEq(ix.gpu(GPU2).registeredAt, reg);
        vm.warp(reg + P.day - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_TooEarly.selector, uint64(reg + P.day)));
        ix.carryDay(GPU2);
        vm.warp(reg + P.day);
        ix.carryDay(GPU2);
        assertEq(ix.head(GPU2), D + 1);
    }

    function test_case2_carriesPreviousValue_andStepBetweenCarries() public {
        bootDay(D, V, none());
        // no data for d1 and d1 + 1
        uint256 at = dEnd(d1 + 1) + P.day; // both days are past their grace
        vm.warp(at);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.DayCarried(GPU, d1, 3_400_000, 2, false, 0);
        _carry(keeper);
        IAgateIndex.Record memory r = rec(d1);
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.CARRIED));
        assertEq(r.value, 3_400_000);
        assertEq(r.source, address(0));
        assertEq(r.digest, bytes32(0));
        assertEq(r.finalAt, at);
        assertFalse(r.dropped);
        assertTrue(isFinal(d1), "carried: final at once");
        // the next carry waits STEP after the last one
        uint256 next = at + P.day / 6;
        vm.warp(next - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_TooEarly.selector, uint64(next)));
        ix.carryDay(GPU);
        vm.warp(next);
        _carry(keeper);
        assertEq(ix.head(GPU), d1 + 2);
    }

    function test_case2_hasQuorum() public {
        bootDay(D, V, none());
        postRange(w2, d1, 0, 7, V); // incomplete but quorate
        vm.warp(dEnd(d1) + P.day);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_HasQuorum.selector, w2));
        ix.carryDay(GPU);
        // a quorate day is closed, not carried: anyone may close once GRACE has passed
        vm.prank(keeper);
        ix.closeDay(GPU);
        assertEq(rec(d1).source, w2);
    }

    function test_case2_suspendedQuorateWriterDoesNotBlock() public {
        bootDay(D, V, none());
        postRange(w2, d1, 0, 7, V);
        vm.prank(g1);
        ix.suspend(w2);
        vm.warp(dEnd(d1) + P.day);
        _carry(keeper);
        assertEq(uint8(rec(d1).status), uint8(IAgateIndex.Status.CARRIED));
    }

    function test_case2_reopenWaitAfterVeto() public {
        bootDay(D, V, none());
        feedDay(d1, UP, none());
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        // the guardian vetoes late in the day after: REOPEN_WAIT dominates GRACE
        vm.warp(dEnd(d1) + P.day * 9 / 10);
        vm.prank(g1);
        ix.veto(GPU, d1, w1, r.digest);
        uint256 at = vm.getBlockTimestamp() + P.day / 4;
        assertGt(at, dEnd(d1) + P.day);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_TooEarly.selector, uint64(at)));
        ix.carryDay(GPU);
        vm.warp(at);
        _carry(keeper);
        assertEq(rec(d1).value, 3_400_000);
        // an early veto: GRACE dominates
    }

    function test_case2_reopenWaitShorterThanGrace() public {
        bootDay(D, V, none());
        feedDay(d1, UP, none());
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        vm.prank(g1);
        ix.veto(GPU, d1, w1, r.digest);
        uint256 at = dEnd(d1) + P.day;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry2_TooEarly.selector, uint64(at)));
        ix.carryDay(GPU);
        vm.warp(at);
        _carry(keeper);
    }

    /// The day after a veto: the vetoed writer is void, so it neither blocks the carry nor advances a counter.
    function test_case2_vetoedWriterAdvancesNothing() public {
        bootDay(D, V, none());
        feedDay(d1, UP, none());
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        vm.prank(g1);
        ix.veto(GPU, d1, w1, r.digest);
        vm.warp(dEnd(d1) + P.day);
        vm.recordLogs();
        _carry(keeper);
        assertEq(_carriedMask(vm.getRecordedLogs()), 0);
        for (uint256 i; i < 5; ++i) {
            assertEq(lastState(i).miss, 0);
        }
    }

    function _carriedMask(Vm.Log[] memory logs) internal pure returns (uint32 mask) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IAgateIndex.DayCarried.selector) {
                (,,, mask) = abi.decode(logs[i].data, (uint32, uint8, bool, uint32));
                return mask;
            }
        }
        revert("no DayCarried");
    }

    // ------------------------------------------------------------------ the carry advance (4.9 carryPost, v4.3)

    function test_carryAdvance_case2_everyEligibleWriterNotFresh() public {
        bootDay(D, V, V);
        _sparse(w1, d1); // eligible, all 5 slots below MIN_READINGS
        vm.warp(dEnd(d1) + P.day);
        vm.recordLogs();
        _carry(keeper);
        assertEq(_carriedMask(vm.getRecordedLogs()), 0x1f);
        for (uint256 i; i < 5; ++i) {
            IAgateIndex.SlotState memory s = lastState(i);
            assertEq(s.miss, 1);
            assertEq(s.e, V[i], "e unchanged");
            assertTrue(s.inMedian && s.wasIn, "membership unchanged");
            assertEq(baseState(i).miss, 0, "base = the pre-state");
        }
    }

    function test_carryAdvance_noEligibleWriter_noAdvance() public {
        bootDay(D, V, V);
        vm.warp(dEnd(d1) + P.day);
        vm.recordLogs();
        _carry(keeper);
        assertEq(_carriedMask(vm.getRecordedLogs()), 0);
        assertEq(lastState(0).miss, 0);
    }

    function test_carryAdvance_capsAtHoldDays_thenExitOnComputedRecord() public {
        bootDay(D, V, V);
        uint32 d = d1;
        for (uint256 k; k < 6; ++k) {
            _sparse(w1, d);
            warpTo(dEnd(d) + P.day);
            vm.recordLogs();
            _carry(keeper);
            uint32 mask = _carriedMask(vm.getRecordedLogs());
            assertEq(mask, k < 5 ? 0x1f : 0, "advance until HOLD_DAYS, then nothing");
            assertEq(lastState(2).miss, k < 5 ? k + 1 : 5);
            assertTrue(lastState(2).inMedian, "a carry never takes a slot out");
            ++d;
        }
        // the next computed record: slot 2 dark again -> miss 6, OUT, changed
        uint32[] memory v = withV(V, 2, 0);
        feedDay(d, v, none());
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        assertTrue(r.changed, "the exit happens on a computed record");
        assertTrue(r.needsSign);
        assertFalse(lastState(2).inMedian);
        assertEq(lastState(2).miss, 6);
    }

    function test_carryAdvance_case1_onlySlotsEveryWriterMissed() public {
        bootDay(D, V, V);
        // d1: both writers miss slot 3; only the standby misses slot 4; the primary's record changes (slot 2 up)
        uint32[] memory a = withV(UP, 3, 0);
        uint32[] memory b = withV(withV(V, 3, 0), 4, 0);
        feedDay(d1, a, b);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertTrue(r.needsSign);
        uint256 at = dEnd(d1) + 7 * P.day;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry1_TooEarly.selector, uint64(at)));
        ix.carryDay(GPU);
        vm.warp(at);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.FixDropped(GPU, d1, w1, r.value, r.digest);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.DayCarried(GPU, d1, 3_400_000, 1, true, 1 << 3);
        assertEq(_carry(keeper), 1);
        IAgateIndex.Record memory c = rec(d1);
        assertEq(uint8(c.status), uint8(IAgateIndex.Status.CARRIED));
        assertTrue(c.dropped);
        assertEq(c.value, 3_400_000);
        assertEq(lastState(3).miss, 1);
        assertEq(lastState(4).miss, 0);
        assertEq(lastState(2).e, 3_400_000, "the dropped value never lands");
        // a drop voids nobody
        assertFalse(ix.isVoided(GPU, d1, w1));
    }

    function test_carryAdvance_unreadableSlotNotAdvanced() public {
        uint8[] memory fam = new uint8[](4);
        uint8[] memory q = new uint8[](4);
        (fam[1], fam[2], fam[3], q[0], q[1], q[2], q[3]) = (1, 2, 3, 1, 1, 1, 1);
        registerWith(GPU2, fam, q, D, 0x7); // slot 3 reserved
        uint32[] memory v = new uint32[](4);
        (v[0], v[1], v[2], v[3]) = (3_000_000, 3_200_000, 3_400_000, 3_600_000);
        for (uint8 h; h < 12; ++h) {
            post1(w1, GPU2, D, h, v);
        }
        warpTo(dEnd(D) + slice());
        vm.prank(w1);
        ix.closeDay(GPU2);
        (,, IAgateIndex.Record memory r0) = ix.record(GPU2, D);
        vm.prank(att);
        ix.attest(GPU2, D, w1, r0.digest);
        for (uint8 h; h < 3; ++h) {
            post1(w1, GPU2, D + 1, h, v);
        }
        warpTo(dEnd(D + 1) + P.day);
        vm.recordLogs();
        ix.carryDay(GPU2);
        assertEq(_carriedMask(vm.getRecordedLogs()), 0x7, "slot 3 is not readable");
    }

    // ------------------------------------------------------------------ case 1

    function test_case1_notDroppable() public {
        bootDay(D, V, none());
        // an unchanged pending record of the first writer: final by itself
        feedDay(d1, V, none());
        closeEarliest(w1, d1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry1_NotDroppable.selector, GPU, d1));
        ix.carryDay(GPU);
    }

    function test_case1_attestedNotDroppable() public {
        bootDay(D, V, none());
        feedDay(d1, UP, none());
        closeEarliest(w1, d1);
        sign(att, d1);
        assertFalse(isFinal(d1));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry1_NotDroppable.selector, GPU, d1));
        ix.carryDay(GPU);
    }

    function test_case1_holdMinDominates() public {
        bootDay(D, V, none());
        postRange(w1, d1, 0, 11, UP); // incomplete: only the primary closes before GRACE, it does not
        uint256 t = dEnd(d1) + 6 * P.day + P.day / 2;
        closeAt(keeper, t); // anyone after GRACE
        assertTrue(rec(d1).needsSign);
        uint256 at = t + 3 * P.day / 4; // postedAt + HOLD_MIN beats dayEnd + HOLD_MOVE
        assertGt(at, dEnd(d1) + 7 * P.day);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry1_TooEarly.selector, uint64(at)));
        ix.carryDay(GPU);
        vm.warp(at);
        _carry(keeper);
        assertTrue(rec(d1).dropped);
    }

    function test_case1_dropOfFirstRecord_skipsTheDay() public {
        feedDay(D, V, none());
        closeEarliest(w1, D);
        vm.warp(dEnd(D) + 7 * P.day);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.DaySkipped(GPU, D, 1);
        _carry(keeper);
        assertFalse(exists(D));
        (bool fe,) = ix.firstRecordDay(GPU);
        assertFalse(fe);
        assertEq(ix.head(GPU), d1);
        assertEq(lastState(0).miss, 6);
    }

    function test_case1_signAllUnchangedRecordIsDroppable() public {
        Profile memory p = TEST_P();
        p.signAll = true;
        deploy(p, 0);
        registerSimple(GPU, 5, D);
        bootDay(D, V, none());
        feedDay(d1, V, none());
        closeEarliest(w1, d1);
        assertFalse(rec(d1).changed);
        vm.warp(dEnd(d1) + 7 * P.day);
        _carry(keeper);
        assertTrue(rec(d1).dropped);
    }

    function test_case1_nonFirstSourceDroppable() public {
        bootDay(D, V, V);
        _sparse(w1, d1);
        postRange(w2, d1, 0, 12, V);
        closeAt(keeper, dEnd(d1) + tPend());
        assertEq(rec(d1).source, w2);
        assertTrue(rec(d1).needsSign);
        vm.warp(dEnd(d1) + 7 * P.day);
        _carry(keeper);
        assertTrue(rec(d1).dropped);
    }

    // ------------------------------------------------------------------ the chained close

    function test_chainedCloseAfterCarry() public {
        bootDay(D, V, none());
        // no data on d1; d1 + 1 complete
        feedDay(d1 + 1, V, none());
        vm.warp(dEnd(d1 + 1) + slice());
        _carry(keeper);
        assertEq(uint8(rec(d1).status), uint8(IAgateIndex.Status.CARRIED));
        assertTrue(exists(d1 + 1), "the complete next day closed in the same call");
        assertEq(rec(d1 + 1).source, w1);
        assertEq(ix.head(GPU), d1 + 2);
    }

    function test_chainedCloseSilentOnFailure_andUsesTheCaller() public {
        bootDay(D, V, none());
        postRange(w1, d1 + 1, 0, 11, V); // incomplete: before T_PEND only its source may close it
        vm.warp(dEnd(d1 + 1) + slice());
        uint256 snap = vm.snapshotState();
        _carry(keeper);
        assertFalse(exists(d1 + 1), "the keeper's chained close fails silently");
        assertEq(ix.head(GPU), d1 + 1);
        vm.revertToState(snap);
        _carry(w1);
        assertTrue(exists(d1 + 1), "the source as caller closes it");
        assertEq(ix.head(GPU), d1 + 2);
    }

    function test_oneDayPerCall() public {
        bootDay(D, V, none());
        vm.warp(dEnd(d1 + 5) + P.day);
        _carry(keeper);
        assertEq(ix.head(GPU), d1 + 1);
    }
}
