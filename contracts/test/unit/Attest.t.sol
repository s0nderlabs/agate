// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

contract AttestTest is IndexBase {
    uint32 internal D;
    uint32 internal d1;
    uint32[] internal V;
    uint32[] internal UP; // the median moves 3.40 -> 3.60

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        d1 = D + 1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        UP = arr(3_000_000, 3_200_000, 3_600_000, 3_600_000, 3_800_000);
        bootDay(D, V, V);
    }

    /// d1: the primary posts `a`, the standby `b`; the primary closes at the earliest second.
    function _pendingD1(uint32[] memory a, uint32[] memory b) internal returns (IAgateIndex.Record memory) {
        feedDay(d1, a, b);
        closeEarliest(w1, d1);
        return rec(d1);
    }

    // ------------------------------------------------------------------ attest checks 1..3

    function test_attest_onlyAttesterOrGuardian() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        address[5] memory nope = [w1, w2, owner, keeper, stranger];
        for (uint256 i; i < 5; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAttesterOrGuardian.selector, nope[i]));
            ix.attest(GPU, d1, w1, r.digest);
        }
        vm.prank(g2);
        ix.attest(GPU, d1, w1, r.digest);
        assertEq(rec(d1).attestedBy, g2);
    }

    function test_attest_hasCode() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        vm.etch(att, abi.encodePacked(hex"ef0100", address(0xdead)));
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.HasCode.selector, att));
        ix.attest(GPU, d1, w1, r.digest);
    }

    function test_attest_unknownGpu() public {
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, GPU2));
        ix.attest(GPU2, d1, w1, bytes32(0));
    }

    function test_attest_noPendingRecord() public {
        // D is final, head is d1: d1 has no record, D is not head - 1 ... D is head - 1 but final
        warpTo(rec(D).finalAt);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NoPendingRecord.selector, GPU, d1));
        ix.attest(GPU, d1, w1, bytes32(0));
        bytes32 dg = rec(D).digest;
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyFinal.selector, GPU, D));
        ix.attest(GPU, D, w1, dg);
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NoPendingRecord.selector, GPU, D));
        ix.attest(GPU, D, w1, r.digest);
    }

    function test_attest_alreadyFinal_unchanged() public {
        IAgateIndex.Record memory r = _pendingD1(V, none());
        assertFalse(r.needsSign);
        vm.warp(r.finalAt);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyFinal.selector, GPU, d1));
        ix.attest(GPU, d1, w1, r.digest);
    }

    function test_attest_alreadyAttested() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        sign(att, d1);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyAttested.selector, GPU, d1));
        ix.attest(GPU, d1, w1, r.digest);
    }

    function test_countersign_digestMismatch() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        bytes32 bad = keccak256("x");
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.DigestMismatch.selector, r.digest, bad));
        ix.attest(GPU, d1, w1, bad);
    }

    function test_countersign_finalAtRule() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        assertTrue(r.changed && r.needsSign);
        // signed early: final at postedAt + T_PEND
        uint256 snap = vm.snapshotState();
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.Attested(GPU, d1, att, w1, r.digest, uint64(r.postedAt + tPend()));
        sign(att, d1);
        IAgateIndex.Record memory s = rec(d1);
        assertEq(s.finalAt, r.postedAt + tPend());
        assertEq(s.attestedAt, block.timestamp);
        assertEq(s.attestedBy, att);
        vm.revertToState(snap);
        // signed late: final at once
        vm.warp(r.postedAt + 3 * P.day);
        sign(att, d1);
        assertEq(rec(d1).finalAt, block.timestamp);
        assertTrue(isFinal(d1));
    }

    function test_countersign_unchangedKeepsFinalAt() public {
        IAgateIndex.Record memory r = _pendingD1(V, none());
        sign(g1, d1);
        assertEq(rec(d1).finalAt, r.finalAt);
        assertEq(rec(d1).attestedBy, g1);
    }

    /// v4.3: the attester may countersign an incomplete pending record (FIX-OK of an incomplete r).
    function test_countersign_incompleteByAttester() public {
        postRange(w1, d1, 0, 11, UP);
        closeAt(w1, dEnd(d1) + slice());
        assertTrue(rec(d1).incomplete);
        sign(att, d1);
        assertEq(rec(d1).attestedBy, att);
    }

    // ------------------------------------------------------------------ select (check 4)

    function test_select_replacesPendingRecord() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        IAgateIndex.Record memory r = _pendingD1(fake, V);
        assertEq(r.value, 4_400_000);
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        assertEq(det.rec.postedAt, r.postedAt, "preview at the pending postedAt");
        vm.warp(r.postedAt + 30);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.RecordReplaced(GPU, d1, att, w1, w2, 4_400_000, 3_400_000, r.digest, det.rec.digest);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.RecordSlots(GPU, d1, w2, det.rec.digest, det.p, det.kinds, det.counts, det.post);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.Attested(GPU, d1, att, w2, det.rec.digest, uint64(r.postedAt + tPend()));
        vm.prank(att);
        ix.attest(GPU, d1, w2, det.rec.digest);
        IAgateIndex.Record memory s = rec(d1);
        assertEq(s.source, w2);
        assertEq(s.value, 3_400_000);
        assertEq(s.postedAt, r.postedAt, "same postedAt");
        assertEq(s.finalAt, r.postedAt + tPend(), "unchanged or not: max(postedAt + T_PEND, now)");
        assertEq(s.attestedBy, att);
        assertEq(s.digest, det.rec.digest);
        assertFalse(s.changed);
        assertTrue(s.needsSign, "the standby is not the first writer");
        // the replaced writer is neither voided nor suspended
        assertFalse(ix.isVoided(GPU, d1, w1));
        assertFalse(ix.isSuspended(w1));
        // last = the selected post-state
        assertEq(lastState(2).e, 3_400_000);
        // a select is final at the later of postedAt + T_PEND and the select
        vm.warp(r.postedAt + tPend());
        assertTrue(isFinal(d1));
    }

    function test_select_lateIsFinalAtOnce() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        IAgateIndex.Record memory r = _pendingD1(fake, V);
        vm.warp(r.postedAt + 2 * P.day);
        selectW(att, d1, w2);
        assertEq(rec(d1).finalAt, block.timestamp);
    }

    function test_select_notEligible() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        vm.startPrank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectNotEligible.selector, w2));
        ix.attest(GPU, d1, w2, r.digest); // no readings
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectNotEligible.selector, stranger));
        ix.attest(GPU, d1, stranger, r.digest);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectNotEligible.selector, address(0)));
        ix.attest(GPU, d1, address(0), r.digest);
        vm.stopPrank();
    }

    function test_select_suspendedAndVoidedNotEligible() public {
        uint32 d = d1;
        feedDay(d, UP, V);
        closeEarliest(w1, d);
        vm.prank(g1);
        ix.suspend(w2);
        (bool ok,) = ix.previewRecord(GPU, d, w2);
        assertFalse(ok);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectNotEligible.selector, w2));
        ix.attest(GPU, d, w2, bytes32(0));
    }

    function test_select_voidedWriterNotEligible() public {
        // w2 closes d1 itself (the primary posts nothing), the guardian vetoes it, then the primary posts and closes:
        // a select back to the voided w2 is refused
        feedDay(d1, none(), V);
        closeEarliest(w2, d1);
        IAgateIndex.Record memory r = rec(d1);
        vm.prank(g1);
        ix.veto(GPU, d1, w2, r.digest);
        // the primary posts d1 late (after the veto): accepted, d1 is open again
        for (uint8 h; h < 12; ++h) {
            uint64 ra = readAtOf(d1, h);
            bytes memory b = rpt(entry(GPU, d1, h, ra, UP));
            vm.prank(w1);
            ix.postReport(b);
        }
        closeAt(w1, block.timestamp);
        assertEq(rec(d1).source, w1);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectNotEligible.selector, w2));
        ix.attest(GPU, d1, w2, r.digest);
    }

    /// F6: the attester may only select a complete day; a guardian may select an incomplete one.
    function test_F6_selectIncomplete() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        feedDay(d1, fake, none());
        postRange(w2, d1, 0, 11, V); // the standby misses the last slice
        closeEarliest(w1, d1);
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        assertTrue(det.rec.incomplete);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectIncomplete.selector, w2));
        ix.attest(GPU, d1, w2, det.rec.digest);
        vm.prank(g1);
        ix.attest(GPU, d1, w2, det.rec.digest);
        assertEq(rec(d1).source, w2);
        assertTrue(rec(d1).incomplete);
    }

    function test_select_belowQuorum() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        feedDay(d1, fake, none());
        postRange(w2, d1, 0, 3, V); // valid values, no FRESH slot: quorum 0
        closeEarliest(w1, d1);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectBelowQuorum.selector, w2));
        ix.attest(GPU, d1, w2, bytes32(0));
    }

    function test_select_digestMismatch() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        _pendingD1(fake, V);
        (, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        bytes32 bad = bytes32(uint256(det.rec.digest) ^ 1);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.DigestMismatch.selector, det.rec.digest, bad));
        ix.attest(GPU, d1, w2, bad);
    }

    function test_select_ofUnchangedPendingRecord() public {
        // T4: an unchanged record replaced by a better complete record
        uint32[] memory shaded = arr(3_000_000, 3_200_000, 3_400_000, 3_700_000, 3_800_000);
        IAgateIndex.Record memory r = _pendingD1(V, shaded);
        assertFalse(r.needsSign);
        selectW(att, d1, w2);
        assertEq(rec(d1).source, w2);
        assertEq(rec(d1).finalAt, r.postedAt + tPend());
    }

    // ------------------------------------------------------------------ veto

    function test_veto_onlyGuardian() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        address[4] memory nope = [att, w1, owner, stranger];
        for (uint256 i; i < 4; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, nope[i]));
            ix.veto(GPU, d1, w1, r.digest);
        }
        vm.etch(g1, abi.encodePacked(hex"ef0100", address(0xdead)));
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.HasCode.selector, g1));
        ix.veto(GPU, d1, w1, r.digest);
        vm.prank(g2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, GPU2));
        ix.veto(GPU2, d1, w1, r.digest);
    }

    function test_veto_noPendingAndFinal() public {
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NoPendingRecord.selector, GPU, d1));
        ix.veto(GPU, d1, w1, bytes32(0));
        IAgateIndex.Record memory r = _pendingD1(V, none());
        vm.warp(r.finalAt);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyFinal.selector, GPU, d1));
        ix.veto(GPU, d1, w1, r.digest);
    }

    /// F2: a veto names the record; a wrong source, a wrong digest or a select in between reverts VetoStale.
    function test_F2_vetoStale() public {
        uint32[] memory fake = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        IAgateIndex.Record memory r = _pendingD1(fake, V);
        vm.startPrank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.VetoStale.selector, w1, r.digest));
        ix.veto(GPU, d1, w2, r.digest);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.VetoStale.selector, w1, r.digest));
        ix.veto(GPU, d1, w1, keccak256("other"));
        vm.stopPrank();
        selectW(att, d1, w2);
        IAgateIndex.Record memory s = rec(d1);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.VetoStale.selector, w2, s.digest));
        ix.veto(GPU, d1, w1, r.digest);
        // the selected record stays
        assertEq(rec(d1).source, w2);
        // the R8 view of the replaced writer stays available
        assertEq(ix.readings(GPU, d1, w1).counts[2], 12);
    }

    function test_veto_effects() public {
        IAgateIndex.SlotState memory before = lastState(2);
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        sign(att, d1); // attested but not yet final: still vetoable
        assertFalse(isFinal(d1));
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.Vetoed(GPU, d1, g1, w1, r.digest, r.value);
        vm.prank(g1);
        ix.veto(GPU, d1, w1, r.digest);
        assertFalse(exists(d1));
        assertEq(ix.head(GPU), d1);
        assertTrue(ix.isVoided(GPU, d1, w1));
        assertFalse(ix.isVoided(GPU, d1, w2));
        assertEq(ix.reopenedAt(GPU, d1), block.timestamp);
        assertFalse(ix.isSuspended(w1), "a veto never suspends");
        IAgateIndex.SlotState memory after_ = lastState(2);
        assertEq(after_.e, before.e, "last = base");
        (bool fe, uint32 fd) = ix.firstRecordDay(GPU);
        assertTrue(fe);
        assertEq(fd, D);
        // the voided writer is not eligible: previewRecord says no
        (bool ok,) = ix.previewRecord(GPU, d1, w1);
        assertFalse(ok);
    }

    function test_veto_firstRecordClearsFirstRecordDay() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, D);
        feedDay(D, V, none());
        closeEarliest(w1, D);
        IAgateIndex.Record memory r = rec(D);
        vm.prank(g1);
        ix.veto(GPU, D, w1, r.digest);
        (bool fe,) = ix.firstRecordDay(GPU);
        assertFalse(fe);
        assertEq(lastState(0).miss, 6, "back to the registration state");
    }

    // ------------------------------------------------------------------ suspend

    function test_suspend() public {
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, att));
        ix.suspend(w1);
        vm.startPrank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAWriter.selector, stranger));
        ix.suspend(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAWriter.selector, address(0)));
        ix.suspend(address(0));
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.WriterSuspended(w2, g1);
        ix.suspend(w2);
        ix.suspend(w2); // idempotent
        vm.stopPrank();
        assertTrue(ix.isSuspended(w2));
        vm.etch(g2, abi.encodePacked(hex"ef0100", address(0xdead)));
        vm.prank(g2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.HasCode.selector, g2));
        ix.suspend(w1);
    }

    function test_writersAndOwnerCannotAttestOrVeto() public {
        IAgateIndex.Record memory r = _pendingD1(UP, none());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, owner));
        ix.veto(GPU, d1, w1, r.digest);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, owner));
        ix.suspend(w1);
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, w1));
        ix.suspend(w2);
    }
}
