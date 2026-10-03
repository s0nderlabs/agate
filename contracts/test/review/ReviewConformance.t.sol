// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex, P_MIN, P_MAX} from "../../src/interfaces/IAgateIndex.sol";

/// Review-pinned tests (adversarial review of contracts/src against BUILD-SPEC v2, rule R v4.3).
/// Names starting with test_SPEC_ pin a spec rule the code does not follow and are expected to FAIL until fixed.
/// Every other test pins an untested edge or a hazard the spec allows and passes on the current code.
contract ReviewConformanceTest is IndexBase {
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
        bootDay(D, V, V);
    }

    function _act(IAgateIndex.ActionKind k, uint8 slot, address addr, IAgateIndex.WriterMode m)
        internal
        pure
        returns (IAgateIndex.Action memory a)
    {
        a.kind = k;
        a.slot = slot;
        a.addr = addr;
        a.mode = m;
    }

    function _queueExec(IAgateIndex.Action memory a) internal {
        vm.prank(owner);
        ix.queue(a);
        vm.warp(block.timestamp + 2 * uint256(P.day));
        vm.prank(owner);
        ix.execute(a);
    }

    // ------------------------------------------------------------------ 4.12 previewRecord (spec deviations)

    /// 4.12: previewRecord computes "for the pending day (pre = base, t = its postedAt) or the head day; ok = false
    /// for any other day". A FINAL computed record at head - 1 is not the pending day.
    function test_SPEC_previewRecord_finalHeadMinusOneIsNotPending() public {
        IAgateIndex.Record memory r = rec(D);
        warpTo(r.finalAt);
        assertTrue(isFinal(D), "D is final");
        assertEq(ix.head(GPU), d1);
        (bool ok,) = ix.previewRecord(GPU, D, w1);
        assertFalse(ok, "4.12: a final day is neither the pending day nor the head day");
    }

    /// I19 / 4.12: previewRecord for the pending day "equals what closeDay or select would store". For the pending
    /// record's own source it must return the stored record. It recomputes needsSign from the first writer at the
    /// time of the view, so a suspension after the close flips needsSign and finalAt away from what is stored.
    function test_SPEC_previewRecord_pendingSourceEqualsStoredAfterSuspend() public {
        // d1: the primary is the first writer (one valid slice, below quorum); the standby is complete and quorate
        post1(w1, GPU, d1, 0, V);
        postRange(w2, d1, 0, P.slices, V);
        closeAt(w2, dEnd(d1) + tPend());
        IAgateIndex.Record memory r = rec(d1);
        assertEq(r.source, w2);
        assertTrue(r.needsSign, "source is not the first writer");
        assertFalse(r.changed, "unchanged");
        assertEq(r.finalAt, 0);
        vm.prank(g1);
        ix.suspend(w1);
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        assertEq(det.rec.digest, r.digest);
        assertEq(det.rec.needsSign, r.needsSign, "I19: preview of the pending source equals the stored record");
        assertEq(det.rec.finalAt, r.finalAt, "I19: preview finalAt equals the stored finalAt");
    }

    // ------------------------------------------------------------------ 4.9 dead branch

    /// 4.9 case 2 lists Carry2_PreviousNotFinal, but a pending record at head - 1 always routes to case 1, so the
    /// error is unreachable: an unsigned unchanged pending record gives Carry1_NotDroppable at any time.
    function test_carry_pendingUnchanged_isCase1NeverCarry2PreviousNotFinal() public {
        feedDay(d1, V, V);
        uint32 d = closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d);
        vm.warp(uint256(r.finalAt) - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.Carry1_NotDroppable.selector, GPU, d1));
        ix.carryDay(GPU);
    }

    // ------------------------------------------------------------------ timestamp edges

    /// A countersign landing exactly at postedAt + T_PEND makes the record final in that same second: the
    /// guardian's veto window ends at postedAt + T_PEND whatever the attester does (4.8 step 3).
    function test_countersignAtTPendBoundary_finalAtOnce_vetoTooLate() public {
        feedDay(d1, UP, UP);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertTrue(r.needsSign);
        vm.warp(uint256(r.postedAt) + tPend());
        sign(att, d1);
        assertTrue(isFinal(d1));
        assertEq(rec(d1).finalAt, block.timestamp);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyFinal.selector, GPU, d1));
        ix.veto(GPU, d1, w1, r.digest);
    }

    /// An unchanged record is final at postedAt + T_PEND exactly: a select one second earlier lands, at that second
    /// it reverts AlreadyFinal.
    function test_selectDeadlineIsPostedAtPlusTPend() public {
        feedDay(d1, V, UP);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertFalse(r.needsSign);
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        uint256 snap = vm.snapshotState();
        vm.warp(r.finalAt);
        vm.prank(att);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyFinal.selector, GPU, d1));
        ix.attest(GPU, d1, w2, det.rec.digest);
        vm.revertToState(snap);
        vm.warp(uint256(r.finalAt) - 1);
        vm.prank(att);
        ix.attest(GPU, d1, w2, det.rec.digest);
        assertEq(rec(d1).source, w2);
    }

    // ------------------------------------------------------------------ hazards the spec allows

    /// 4.8 lets the attester or a guardian countersign a record that does not need it. That sets attestedAt, and
    /// AlreadyAttested then blocks every select of a better record on that day; only a veto remains. The attester
    /// must never countersign an unchanged record.
    function test_countersignOfUnchangedRecordBlocksLaterSelect() public {
        feedDay(d1, V, UP);
        closeEarliest(w1, d1);
        IAgateIndex.Record memory r = rec(d1);
        assertFalse(r.needsSign);
        sign(att, d1);
        assertEq(rec(d1).finalAt, r.finalAt, "unchanged keeps postedAt + T_PEND");
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d1, w2);
        assertTrue(ok);
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyAttested.selector, GPU, d1));
        ix.attest(GPU, d1, w2, det.rec.digest);
        vm.prank(g1);
        ix.veto(GPU, d1, w1, r.digest);
        assertEq(ix.head(GPU), d1);
    }

    /// 4.11 (Oct 3, the execute window): a queued action survives an OWNER rotation, but only until
    /// eta + ACTION_WINDOW_DAYS * DAY; a year later it is dead (it was executable for ever before Oct 3).
    function test_queuedActionSurvivesOwnerRotation_untilItsWindowEnds() public {
        address newAtt = makeAddr("newAttester");
        IAgateIndex.Action memory a = _act(IAgateIndex.ActionKind.ATTESTER, 0, newAtt, IAgateIndex.WriterMode.TX_ORIGIN);
        bytes32 id = keccak256(abi.encode(a));
        vm.prank(owner);
        ix.queue(a);
        address owner2 = makeAddr("owner2");
        _queueExec(_act(IAgateIndex.ActionKind.OWNER, 0, owner2, IAgateIndex.WriterMode.TX_ORIGIN));
        assertEq(ix.owner(), owner2);
        assertGt(ix.queuedEta(id), 0, "inherited by the new owner");
        vm.warp(block.timestamp + 365 * uint256(P.day));
        assertEq(ix.queuedEta(id), 0);
        vm.prank(owner2);
        vm.expectPartialRevert(IAgateIndex.ActionExpired.selector);
        ix.execute(a);
        assertEq(ix.attester(), att);
    }

    /// 4.5 / 4.11: FORWARDER has no checks. With WORKFLOW_OWNER mode on a forwarder that does not authenticate
    /// metadata (the simulation forwarder), anyone posts as any writer: the writer is read from caller-supplied
    /// bytes. Pinned as a configuration hazard (WORKFLOW_OWNER only with the KeystoneForwarder of a real DON).
    function test_workflowOwnerModeOnUnauthenticatedForwarder_anyoneIsAnyWriter() public {
        _queueExec(_act(IAgateIndex.ActionKind.FORWARDER, 0, address(fwd), IAgateIndex.WriterMode.WORKFLOW_OWNER));
        uint32 today_ = today();
        uint8 h = uint8((block.timestamp - dStart(today_)) / slice());
        uint64 ra = uint64(block.timestamp);
        bytes memory meta = abi.encodePacked(bytes32(0), bytes10(0), w1, bytes2(0));
        vm.prank(stranger, stranger);
        fwd.forward(address(ix), meta, rpt(entry(GPU, today_, h, ra, V)));
        IAgateIndex.Readings memory rd = ix.readings(GPU, today_, w1);
        assertEq(rd.sliceBits, uint256(1) << h, "a stranger posted as the primary");
    }

    // ------------------------------------------------------------------ stricter than the spec (pinned as built)

    /// 4.11 lists no Q_MIN or famQ <= members check; the code refuses both (a GPU that could never be quorate).
    /// Safer than the spec: pinned as built, the spec should say so.
    function test_registerGpu_stricterThanSpec() public {
        uint8[] memory fam2 = new uint8[](2);
        fam2[1] = 1;
        uint8[] memory q2 = new uint8[](2);
        q2[0] = 1;
        q2[1] = 1;
        vm.prank(owner);
        vm.expectRevert(IAgateIndex.BadFamilies.selector);
        ix.registerGpu(GPU2, bytes32(0), fam2, q2, D, 3); // 2 families < Q_MIN 3

        uint8[] memory fam3 = new uint8[](3);
        fam3[1] = 1;
        fam3[2] = 2;
        uint8[] memory q3 = new uint8[](3);
        q3[0] = 2; // family 0 has one slot
        q3[1] = 1;
        q3[2] = 1;
        vm.prank(owner);
        vm.expectRevert(IAgateIndex.BadFamilies.selector);
        ix.registerGpu(GPU2, bytes32(0), fam3, q3, D, 7);
    }
}

/// Accumulator packing at its limits: 15 slots (three words, five slots each) x 255 slices, P_MAX and P_MIN
/// interleaved so a carry out of any slot's 48 bits would show in its neighbour (word boundaries at 4|5 and 9|10).
contract ReviewAccumulatorTest is IndexBase {
    function test_fifteenSlotsTwoHundredFiftyFiveSlices_noBleed() public {
        IAgateIndex.InitParams memory ip = initParams(TEST_P());
        ip.day = 255 * 12 * 4;
        ip.slices = 255;
        ip.minReadings = 128;
        ip.qMin = 1;
        ip.demoLabel = true;
        vm.warp(T0);
        AgateIndex big = new AgateIndex(ip);
        uint8[] memory fam = new uint8[](15);
        uint8[] memory q = new uint8[](15);
        uint32[] memory v = new uint32[](15);
        for (uint256 i; i < 15; ++i) {
            fam[i] = uint8(i);
            q[i] = 1;
            v[i] = i % 2 == 0 ? P_MAX : P_MIN;
        }
        vm.prank(owner);
        big.registerGpu(GPU, bytes32(0), fam, q, OCT1, (1 << 15) - 1);
        uint256 sl = ip.day / 255;
        for (uint256 h; h < 255; ++h) {
            uint64 ra = uint64(T0 + h * sl);
            warpTo(ra);
            IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](1);
            es[0] = entry(GPU, OCT1, uint8(h), ra, v);
            vm.prank(w1);
            big.postReport(abi.encode(uint8(1), CHAIN, address(big), es));
        }
        IAgateIndex.Readings memory rd = big.readings(GPU, OCT1, w1);
        for (uint256 i; i < 15; ++i) {
            assertEq(rd.counts[i], 255, "count");
            assertEq(uint256(rd.sums[i]), 255 * uint256(v[i]), "sum");
        }
        warpTo(T0 + ip.day + sl);
        vm.prank(w1);
        big.closeDay(GPU);
        (bool ok, IAgateIndex.RecordDetail memory det) = big.previewRecord(GPU, OCT1, w1);
        assertTrue(ok);
        for (uint256 i; i < 15; ++i) {
            assertEq(det.p[i], v[i], "slot day value");
        }
        assertEq(det.rec.value, P_MAX, "median of 8 x P_MAX and 7 x P_MIN");
    }
}
