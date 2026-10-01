// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

contract CloseTest is IndexBase {
    uint32 internal D;
    uint32[] internal V;
    uint32[] internal LOW; // two slots only: below Q_MIN 3

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        LOW = arr(3_000_000, 3_200_000, 0, 0, 0);
    }

    function test_unknownGpu() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, GPU2));
        ix.closeDay(GPU2);
    }

    // C1 and F1
    function test_C1_oneSliceAfterTheDay() public {
        feedDay(D, V, none());
        uint256 at = dEnd(D) + slice();
        warpTo(at - 1);
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C1_DayNotOver.selector, D, uint64(at)));
        ix.closeDay(GPU);
        vm.warp(at);
        vm.prank(w1);
        assertEq(ix.closeDay(GPU), D);
    }

    function test_F1_lateLastSliceOfStandbyAcceptedAndComplete() public {
        feedDay(D, V, none());
        postRange(w2, D, 0, 11, V);
        // the standby's slice 11 reading lands 5 s after midnight
        uint64 ra = readAtOf(D, 11);
        vm.warp(dEnd(D) + 5);
        bytes memory r = rpt(entry(GPU, D, 11, ra, V));
        vm.prank(w2);
        ix.postReport(r);
        assertEq(ix.readings(GPU, D, w2).sliceBits, (1 << 12) - 1, "complete");
        closeEarliest(w1, D);
        // the standby's complete record is a select candidate
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, D, w2);
        assertTrue(ok);
        assertFalse(det.rec.incomplete);
    }

    function test_C2_previousNotFinal() public {
        feedDay(D, V, none());
        closeEarliest(w1, D); // the first record is changed: needsSign, pending
        feedDay(D + 1, V, none());
        warpTo(dEnd(D + 1) + slice());
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C2_PreviousNotFinal.selector, D));
        ix.closeDay(GPU);
        sign(att, D);
        warpTo(rec(D).finalAt);
        vm.prank(w1);
        ix.closeDay(GPU);
        assertEq(ix.head(GPU), D + 2);
    }

    function test_C3_belowQuorum() public {
        feedDay(D, LOW, LOW);
        warpTo(dEnd(D) + slice());
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, D));
        ix.closeDay(GPU);
        warpTo(dEnd(D) + 10 * P.day);
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, D));
        ix.closeDay(GPU);
    }

    function test_C3_noReadings() public {
        warpTo(dEnd(D) + slice());
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, D));
        ix.closeDay(GPU);
    }

    /// v4.3 (T4 E): a quorate incomplete first writer is the source, before and after T_PEND, over a complete
    /// second writer.
    function test_C3_firstWriterPriorityOverCompleteSecond() public {
        uint32[] memory frozen = arr(3_000_000, 3_200_000, 3_300_000, 3_600_000, 3_800_000);
        for (uint8 h; h < 12; ++h) {
            if (h != 7) post1(w1, GPU, D, h, V); // the primary misses one slice
            post1(w2, GPU, D, h, frozen);
        }
        // before T_PEND the standby cannot close the primary's incomplete day
        warpTo(dEnd(D) + slice());
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, w2, w1));
        ix.closeDay(GPU);
        // from T_PEND the primary is still the source (v4.2 would have picked the complete standby)
        uint256 snap = vm.snapshotState();
        closeAt(w2, dEnd(D) + tPend());
        IAgateIndex.Record memory r = rec(D);
        assertEq(r.source, w1);
        assertTrue(r.incomplete);
        assertEq(r.value, 3_400_000);
        vm.revertToState(snap);
        // and the primary itself closes at C1
        closeEarliest(w1, D);
        assertEq(rec(D).source, w1);
    }

    /// The first writer below quorum: the second writer is the source from T_PEND, with needsSign and finalAt 0.
    function test_C3_firstBelowQuorum_secondSourceNeedsSign() public {
        bootDay(D, V, V);
        uint32 d = D + 1;
        postRange(w1, d, 0, 3, V); // a valid value (first writer) but fewer than MIN_READINGS: no FRESH, quorum 0
        postRange(w2, d, 0, 12, V);
        warpTo(dEnd(d) + slice());
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, d));
        ix.closeDay(GPU);
        warpTo(dEnd(d) + tPend() - 1);
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, d));
        ix.closeDay(GPU);
        closeAt(keeper, dEnd(d) + tPend()); // w2 complete: anyone may close
        IAgateIndex.Record memory r = rec(d);
        assertEq(r.source, w2);
        assertFalse(r.changed, "unchanged value");
        assertTrue(r.needsSign, "not the first writer");
        assertEq(r.finalAt, 0);
        // never final on its own
        warpTo(block.timestamp + 5 * P.day);
        assertFalse(isFinal(d));
        sign(att, d);
        assertTrue(isFinal(d));
    }

    /// "First writer" counts only a writer with a valid value: a primary that posted only zeros is not first.
    function test_C3_firstWriterNeedsAValidValue() public {
        bootDay(D, V, V);
        uint32 d = D + 1;
        feedDay(d, fill(5, 0), V);
        closeEarliest(w2, d);
        IAgateIndex.Record memory r = rec(d);
        assertEq(r.source, w2);
        assertFalse(r.needsSign, "w2 is the first writer");
        assertEq(r.finalAt, block.timestamp + tPend());
    }

    /// From T_PEND with no quorate first writer: the first complete quorate writer, else the first quorate one.
    function test_C3_laterOrder() public {
        bootDay(D, V, V);
        uint32 d = D + 1;
        // the primary: valid values on 3 slices only (first writer, quorum 0); the standby incomplete but quorate
        for (uint8 h; h < 12; ++h) {
            if (h < 3) post1(w1, GPU, d, h, V);
            if (h != 3) post1(w2, GPU, d, h, V);
        }
        closeAt(w1, dEnd(d) + tPend());
        assertEq(rec(d).source, w2);
        assertTrue(rec(d).needsSign);
    }

    function test_C4_callers() public {
        // complete source: anyone at the earliest second
        feedDay(D, V, none());
        closeEarliest(keeper, D);
        assertEq(rec(D).source, w1);
        sign(att, D);
        // incomplete source: only itself before T_PEND, any active writer from T_PEND, anyone from GRACE
        uint32 d = D + 1;
        postRange(w1, d, 0, 11, V);
        warpTo(dEnd(d) + slice());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, keeper, w1));
        ix.closeDay(GPU);
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, w2, w1));
        ix.closeDay(GPU);
        warpTo(dEnd(d) + tPend());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, keeper, w1));
        ix.closeDay(GPU);
        uint256 snap = vm.snapshotState();
        vm.prank(w2);
        ix.closeDay(GPU);
        assertEq(rec(d).source, w1);
        vm.revertToState(snap);
        // a suspended writer is no longer an active caller
        vm.prank(g1);
        ix.suspend(w2);
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, w2, w1));
        ix.closeDay(GPU);
        warpTo(dEnd(d) + P.day - 1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, keeper, w1));
        ix.closeDay(GPU);
        vm.warp(dEnd(d) + P.day); // graceStart + GRACE
        vm.prank(keeper);
        ix.closeDay(GPU);
        assertTrue(rec(d).incomplete);
    }

    function test_C4_writerWithCodeIsNotAnActiveCaller() public {
        postRange(w1, D, 0, 11, V);
        warpTo(dEnd(D) + tPend());
        vm.etch(w2, abi.encodePacked(hex"ef0100", address(0xdead)));
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, w2, w1));
        ix.closeDay(GPU);
    }

    function test_C5_C6_C7_unchangedRecordFinalAfterTPend() public {
        bootDay(D, V, none());
        uint32 d = D + 1;
        feedDay(d, V, none());
        (bool okp, IAgateIndex.RecordDetail memory pv) = ix.previewFix(GPU);
        assertTrue(okp);
        uint256 t = dEnd(d) + slice();
        warpTo(t);
        (, pv) = ix.previewFix(GPU);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.DayClosed(
            GPU, d, w1, 3_400_000, IAgateIndex.Status.FULL, 5, 0, 3_400_000, false, false, false, false, pv.rec.digest
        );
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.RecordSlots(GPU, d, w1, pv.rec.digest, pv.p, pv.kinds, pv.counts, pv.post);
        vm.prank(w1);
        ix.closeDay(GPU);
        IAgateIndex.Record memory r = rec(d);
        assertEq(r.value, 3_400_000);
        assertFalse(r.changed);
        assertFalse(r.needsSign);
        assertEq(r.postedAt, t);
        assertEq(r.finalAt, t + tPend());
        assertEq(r.digest, pv.rec.digest);
        assertEq(ix.head(GPU), d + 1);
        (bool fe, uint32 fd) = ix.firstRecordDay(GPU);
        assertTrue(fe);
        assertEq(fd, D);
        vm.warp(t + tPend() - 1);
        assertFalse(isFinal(d));
        (bool ok,,,,,) = ix.finalFix(GPU, d);
        assertFalse(ok);
        vm.warp(t + tPend());
        assertTrue(isFinal(d));
        (ok,,,,,) = ix.finalFix(GPU, d);
        assertTrue(ok);
    }

    function test_C6_firstRecordIsChanged() public {
        feedDay(D, V, none());
        closeEarliest(w1, D);
        IAgateIndex.Record memory r = rec(D);
        assertTrue(r.changed);
        assertTrue(r.needsSign);
        assertEq(r.finalAt, 0);
        IAgateIndex.SlotState memory s0 = lastState(0);
        assertEq(s0.e, 3_000_000);
        assertTrue(s0.inMedian && s0.wasIn);
        assertEq(s0.miss, 0);
        IAgateIndex.SlotState memory b0 = baseState(0);
        assertEq(b0.miss, 6);
        assertFalse(b0.inMedian);
    }

    function test_C6_signAllEveryRecordNeedsSign() public {
        Profile memory p = TEST_P();
        p.signAll = true;
        deploy(p, 0);
        registerSimple(GPU, 5, OCT1);
        bootDay(OCT1, V, none());
        uint32 d = OCT1 + 1;
        feedDay(d, V, none());
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        assertFalse(r.changed);
        assertTrue(r.needsSign);
        assertEq(r.finalAt, 0);
    }

    function test_onlyHeadCloses_oneDayPerCall() public {
        feedDay(D, V, none());
        feedDay(D + 1, V, none());
        closeAt(w1, dEnd(D + 1) + slice());
        assertEq(ix.head(GPU), D + 1, "closes d = head and nothing else");
    }
}
