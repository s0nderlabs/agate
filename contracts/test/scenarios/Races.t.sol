// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// F1 (close race), F2 (veto after select), F6 (complete-only select), T4 E (stolen standby) on the TEST clock.
contract RacesTest is IndexBase {
    uint32 internal D;
    uint32 internal d1;
    uint32[] internal V;
    uint32[] internal STEP; // the median steps 3.40 -> 3.60
    uint32[] internal FAKE;

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        d1 = D + 1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        STEP = arr(3_000_000, 3_200_000, 3_600_000, 3_600_000, 3_800_000);
        FAKE = arr(3_000_000, 3_200_000, 4_400_000, 4_400_000, 4_400_000);
        bootDay(D, V, V);
    }

    /// F1 (V1): the thief closes at the earliest second; the standby's last slice landed 5 s after midnight.
    function test_F1_closeRace() public {
        for (uint8 h; h < 11; ++h) {
            post1(w1, GPU, d1, h, FAKE);
            post1(w2, GPU, d1, h, STEP);
        }
        post1(w1, GPU, d1, 11, FAKE);
        uint64 ra = readAtOf(d1, 11);
        vm.warp(dEnd(d1) + 5);
        bytes memory late = rpt(entry(GPU, d1, 11, ra, STEP));
        vm.prank(w2);
        ix.postReport(late);
        vm.warp(dEnd(d1) + slice() - 1);
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C1_DayNotOver.selector, d1, uint64(dEnd(d1) + slice())));
        ix.closeDay(GPU);
        vm.warp(dEnd(d1) + slice());
        vm.prank(w1);
        ix.closeDay(GPU);
        assertEq(rec(d1).value, 4_400_000);
        assertEq(ix.readings(GPU, d1, w2).sliceBits, (1 << 12) - 1, "the standby is complete");
        selectW(att, d1, w2);
        assertEq(rec(d1).source, w2);
        assertEq(rec(d1).value, 3_600_000);
        warpTo(rec(d1).finalAt);
        (bool ok, uint32 v,,,,) = ix.finalFix(GPU, d1);
        assertTrue(ok);
        assertEq(v, 3_600_000);
    }

    /// F2 (V2): the guardian's veto lands after the attester's select: VetoStale, the select stays, the replaced
    /// writer's readings stay readable for R8.
    function test_F2_vetoAfterSelect() public {
        feedDay(d1, FAKE, STEP);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory thiefs = rec(d1);
        selectW(att, d1, w2);
        IAgateIndex.Record memory sel = rec(d1);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.VetoStale.selector, w2, sel.digest));
        ix.veto(GPU, d1, w1, thiefs.digest);
        assertEq(rec(d1).source, w2);
        assertFalse(ix.isVoided(GPU, d1, w1));
        // R8: recompute the replaced record offchain from readings() and the pre-state emitted earlier
        IAgateIndex.Readings memory rd = ix.readings(GPU, d1, w1);
        assertEq(rd.sums[2] / rd.counts[2], 4_400_000);
        warpTo(sel.finalAt);
        assertTrue(isFinal(d1));
    }

    /// F6: the attester's select of an incomplete day reverts; a guardian's lands; the attester may countersign an
    /// incomplete pending record.
    function test_F6_completeOnlySelect() public {
        feedDay(d1, FAKE, none());
        postRange(w2, d1, 0, 11, STEP);
        closeEarliest(w1, d1);
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.SelectIncomplete.selector, w2));
        ix.attest(GPU, d1, w2, det.rec.digest);
        vm.prank(g1);
        ix.attest(GPU, d1, w2, det.rec.digest);
        assertEq(rec(d1).source, w2);
        // next day: the incomplete primary record is countersigned by the attester
        uint32 d2 = d1 + 1;
        postRange(w1, d2, 0, 11, STEP);
        warpTo(rec(d1).finalAt);
        closeAt(w1, dEnd(d2) + slice());
        assertTrue(rec(d2).incomplete);
        IAgateIndex.Record memory r = rec(d2);
        if (r.needsSign) sign(att, d2);
        warpTo(rec(d2).finalAt);
        assertTrue(isFinal(d2));
    }

    /// T4 E: a stolen standby, the honest primary misses one slice on a step day. The primary is the source (C3),
    /// never the thief; the attester countersigns the honest incomplete record.
    function test_T4E_stolenStandby_primaryMissesASlice() public {
        for (uint8 h; h < 12; ++h) {
            if (h != 7) post1(w1, GPU, d1, h, STEP);
            post1(w2, GPU, d1, h, V); // the thief freezes at 3.40
        }
        // the thief tries to close first: not the source, not allowed before T_PEND
        warpTo(dEnd(d1) + slice());
        vm.prank(w2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C4_CallerNotAllowed.selector, w2, w1));
        ix.closeDay(GPU);
        // nobody but the primary closes before T_PEND; the thief closes at T_PEND and still gets the primary
        closeAt(w2, dEnd(d1) + tPend());
        IAgateIndex.Record memory r = rec(d1);
        assertEq(r.source, w1);
        assertEq(r.value, 3_600_000);
        assertTrue(r.needsSign && r.changed);
        sign(att, d1);
        warpTo(rec(d1).finalAt);
        (bool ok, uint32 v,,,,) = ix.finalFix(GPU, d1);
        assertTrue(ok);
        assertEq(v, 3_600_000);
    }

    /// T4 E variant: the primary below quorum: the thief's unchanged record is the source but needsSign; R12 never
    /// signs it, so it is dropped, never final on one key.
    function test_T4E_primaryBelowQuorum_thiefNeedsSign_dropped() public {
        postRange(w1, d1, 0, 3, STEP); // the primary's process died after 3 slices
        postRange(w2, d1, 0, 12, V); // thief freezes
        closeAt(w2, dEnd(d1) + tPend());
        IAgateIndex.Record memory r = rec(d1);
        assertEq(r.source, w2);
        assertFalse(r.changed);
        assertTrue(r.needsSign, "not the day's first writer");
        warpTo(dEnd(d1) + 7 * uint256(P.day) - 1);
        assertFalse(isFinal(d1), "never final on one key");
        vm.warp(dEnd(d1) + 7 * uint256(P.day));
        ix.carryDay(GPU);
        assertTrue(rec(d1).dropped);
        assertEq(rec(d1).value, 3_400_000);
    }
}

/// T8: the attester's minute on the short profiles.
contract T8RacesTest is IndexBase {
    uint32[] internal V;
    uint32[] internal STEP;

    function setUp() public {
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        STEP = arr(3_000_000, 3_200_000, 3_600_000, 3_600_000, 3_800_000);
    }

    function _margin(Profile memory p) internal returns (int256) {
        deploy(p, NOV1);
        IAgateIndex.Clocks memory c = ix.clocks();
        uint256 gap = p.slices / 8 > 1 ? p.slices / 8 : 1;
        // earliest close + T_PEND against the end of the watcher interval GAP slices after the day's last one
        return int256(uint256(c.closeGrace) + c.tPend) - int256((gap + 1) * uint256(c.slice));
    }

    function test_T8_attesterMinuteOnEveryProfile() public {
        assertGe(_margin(DEMO_P()), 60, "DEMO");
        assertGe(_margin(TEST_P()), 60, "TEST");
        assertGe(_margin(PROD_P()), 60, "PRODUCTION");
        assertLt(_margin(FAST_P()), 60, "FAST cannot: signAll instead");
    }

    /// DEMO: the thief closes an unchanged freeze at the first legal second; the attester's select at the end of
    /// its settle interval lands at least 60 s before finality and is final.
    function test_T8_demo_selectLandsBeforeFinality() public {
        deploy(DEMO_P(), 0);
        uint32 d = NOV1;
        registerSimple(GPU, 5, d);
        bootDay(d, V, V);
        uint32 d1 = d + 1;
        feedDay(d1, V, STEP); // the thief primary freezes; the honest standby sees the step
        warpTo(rec(d).finalAt);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertFalse(r.needsSign);
        assertEq(r.finalAt, dEnd(d1) + 150 + 210);
        uint256 settle = dEnd(d1) + 2 * 150; // the end of the interval GAP (1) slices after the day's last
        assertGe(r.finalAt - settle, 60);
        vm.warp(settle);
        selectW(att, d1, w2);
        warpTo(rec(d1).finalAt);
        assertEq(rec(d1).source, w2);
        assertEq(rec(d1).value, 3_600_000);
        assertTrue(isFinal(d1));
    }

    /// FAST (signAll): the same freeze is never final without a signature.
    function test_T8_fast_signAllFreezeNeverFinalAlone() public {
        deploy(FAST_P(), 0);
        uint32 d = NOV1;
        registerSimple(GPU, 5, d);
        bootDay(d, V, V);
        uint32 d1 = d + 1;
        feedDay(d1, V, STEP);
        warpTo(rec(d).finalAt);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertTrue(r.needsSign);
        assertEq(r.finalAt, 0);
        warpTo(r.postedAt + 6 * uint256(P.day));
        assertFalse(isFinal(d1));
        selectW(att, d1, w2);
        assertTrue(isFinal(d1));
        assertEq(rec(d1).value, 3_600_000);
    }
}
