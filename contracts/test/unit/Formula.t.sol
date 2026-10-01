// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER} from "../../src/interfaces/IAgateIndex.sol";

/// Table tests of the daily formula (BUILD-SPEC 4.6), TEST clock (12 slices, 6 readings for fresh).
contract FormulaTest is IndexBase {
    uint32[] internal V;

    function setUp() public {
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
    }

    function _deploy(uint32 epochDay, uint8 qMin, bool demo) internal {
        Profile memory p = TEST_P();
        p.epochDay = epochDay;
        p.qMin = qMin;
        p.demo = demo;
        deploy(p, 0);
    }

    /// Feeds the head day with v (primary, every slice), closes it at the earliest second, signs it if needed.
    function _day(uint32[] memory v) internal returns (IAgateIndex.Record memory r) {
        uint32 d = ix.head(GPU);
        feedDay(d, v, none());
        if (exists(d - 1)) warpTo(rec(d - 1).finalAt);
        closeEarliest(w1, d);
        r = rec(d);
        if (r.needsSign) sign(att, d);
        r = rec(d);
    }

    function _kind(uint32 d, uint256 i) internal view returns (IAgateIndex.Kind) {
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, w1);
        require(ok, "no preview");
        return det.kinds[i];
    }

    /// Carries every no-data day until head == d (no eligible writer: no counter moves).
    function _carryUntil(uint32 d) internal {
        while (ix.head(GPU) < d) {
            uint32 h = ix.head(GPU);
            uint256 at = dEnd(h) + P.day;
            uint256 st = uint256(ix.gpu(GPU).lastCarryAt) + P.day / 6;
            warpTo(at > st ? at : st);
            ix.carryDay(GPU);
        }
    }

    // ------------------------------------------------------------------ rounding and medians

    function test_flickerNeedsHalfTheSlices() public {
        uint32[2] memory got;
        for (uint256 k = 5; k <= 6; ++k) {
            _deploy(OCT1, 1, true);
            uint8[] memory fam = new uint8[](1);
            uint8[] memory q = new uint8[](1);
            q[0] = 1;
            registerWith(GPU, fam, q, OCT1, 1);
            for (uint8 h; h < 12; ++h) {
                post1(w1, GPU, OCT1, h, fill(1, h < k ? 3_610_000 : 3_600_000));
            }
            closeEarliest(w1, OCT1);
            got[k - 5] = rec(OCT1).value;
        }
        assertEq(got[0], 3_600_000, "5 of 12 slices: no change");
        assertEq(got[1], 3_610_000, "6 of 12 (the 12-of-24 line): 3.605 -> 3.61, half up");
    }

    function test_centHalfUp_familyAndFixLevels() public {
        _deploy(OCT1, 1, true);
        // family 0: two slots 3.00 and 3.01 -> median 3.005 -> 3.01; family 1: 2.00; family 2: 4.00;
        // family 3: 3.00 -> families {3.01, 2.00, 4.00, 3.00}: median (3.00 + 3.01) / 2 = 3.005 -> 3.01
        uint8[] memory fam = new uint8[](5);
        (fam[0], fam[1], fam[2], fam[3], fam[4]) = (0, 0, 1, 2, 3);
        uint8[] memory q = new uint8[](4);
        (q[0], q[1], q[2], q[3]) = (1, 1, 1, 1);
        registerWith(GPU, fam, q, OCT1, 0x1f);
        IAgateIndex.Record memory r = _day(arr(3_000_000, 3_010_000, 2_000_000, 4_000_000, 3_000_000));
        assertEq(r.value, 3_010_000);
        assertEq(r.freshMedian, 3_010_000);
        assertEq(r.fresh, 4);
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.DEGRADED));
    }

    function test_dayMeanToTheCent() public {
        _deploy(OCT1, 1, true);
        uint8[] memory fam = new uint8[](1);
        uint8[] memory q = new uint8[](1);
        q[0] = 1;
        registerWith(GPU, fam, q, OCT1, 1);
        // 12 readings: six at 3.00, six at 3.03 -> mean 3.015 -> 3.02
        for (uint8 h; h < 12; ++h) {
            post1(w1, GPU, OCT1, h, fill(1, h % 2 == 0 ? 3_000_000 : 3_030_000));
        }
        closeEarliest(w1, OCT1);
        assertEq(rec(OCT1).value, 3_020_000);
        // 7 readings only (the rest dark): mean of the 7
        uint32 d = OCT1 + 1;
        sign(att, OCT1);
        for (uint8 h; h < 12; ++h) {
            post1(w1, GPU, d, h, fill(1, h < 7 ? 3_100_000 : 0));
        }
        closeEarliest(w1, d);
        assertEq(rec(d).value, 3_100_000);
        assertEq(rec(d).incomplete, false, "every slice posted, some values 0: complete");
    }

    function test_evenFamilyCount() public {
        _deploy(OCT1, 3, false);
        registerSimple(GPU, 4, OCT1);
        uint32[] memory v = new uint32[](4);
        (v[0], v[1], v[2], v[3]) = (3_000_000, 3_200_000, 3_500_000, 3_900_000);
        IAgateIndex.Record memory r = _day(v);
        assertEq(r.value, 3_350_000, "(3.20 + 3.50) / 2");
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.DEGRADED), "4 fresh families");
    }

    // ------------------------------------------------------------------ grades and quorum

    function test_grades() public {
        _deploy(OCT1, 1, true);
        registerSimple(GPU, 5, OCT1);
        assertEq(uint8(_day(V).status), uint8(IAgateIndex.Status.FULL));
        assertEq(_day(V).fresh, 5);
        IAgateIndex.Record memory r = _day(arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 0));
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.DEGRADED));
        assertEq(r.held, 1);
        r = _day(arr(3_000_000, 3_200_000, 3_400_000, 0, 0));
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.DEGRADED), "3 fresh");
        r = _day(arr(3_000_000, 3_200_000, 0, 0, 0));
        assertEq(uint8(r.status), uint8(IAgateIndex.Status.DEMO), "2 fresh");
        assertEq(r.held, 3);
        assertEq(r.quorum, 5, "held slots count toward the quorum");
        assertEq(r.freshMedian, 3_100_000, "fresh families only");
        assertEq(r.value, 3_400_000, "held at their last values: 3.0 3.2 3.4 3.6 3.8");
    }

    function test_quorumNeedsOneFreshSlot() public {
        _deploy(OCT1, 3, false);
        registerSimple(GPU, 5, OCT1);
        _day(V);
        uint32 d = ix.head(GPU);
        postRange(w1, d, 0, 12, fill(5, 0)); // posted, nothing valid
        postRange(w2, d, 0, 5, V); // 5 of 12: not fresh anywhere
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, w2);
        assertFalse(ok, "every slot HELD and none FRESH: quorum 0");
        det;
        warpTo(dEnd(d) + P.day);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.C3_BelowQuorum.selector, d));
        ix.closeDay(GPU);
    }

    function test_trackerFamily_famQ3() public {
        _deploy(OCT1, 3, false);
        // slots 0..2: one tracker family (famQ 3); slots 3, 4: one family each
        uint8[] memory fam = new uint8[](5);
        (fam[0], fam[1], fam[2], fam[3], fam[4]) = (0, 0, 0, 1, 2);
        uint8[] memory q = new uint8[](3);
        (q[0], q[1], q[2]) = (3, 1, 1);
        registerWith(GPU, fam, q, OCT1, 0x1f);
        // the tracker has 2 of its 3 slots: it neither counts for the quorum nor as fresh, but its value counts
        feedDay(OCT1, arr(3_000_000, 3_100_000, 0, 3_600_000, 3_800_000), none());
        warpTo(dEnd(OCT1) + slice());
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, OCT1, w1);
        assertFalse(ok, "quorum 2 < 3");
        det;
        // with all three tracker slots the family counts
        _deploy(OCT1, 3, false);
        registerWith(GPU, fam, q, OCT1, 0x1f);
        IAgateIndex.Record memory r = _day(arr(3_000_000, 3_100_000, 3_300_000, 3_600_000, 3_800_000));
        assertEq(r.quorum, 3);
        assertEq(r.fresh, 3);
        assertEq(r.value, 3_600_000, "families {3.10, 3.60, 3.80}");
        // next day the tracker loses one slot: held fills its quorum, it is no longer a fresh family
        r = _day(arr(3_000_000, 3_100_000, 0, 3_600_000, 3_800_000));
        assertEq(r.quorum, 3);
        assertEq(r.fresh, 2);
        assertEq(r.held, 1);
        assertEq(r.freshMedian, 3_700_000, "fresh families {3.60, 3.80}");
        assertEq(r.value, 3_600_000);
    }

    // ------------------------------------------------------------------ membership

    function test_hold5ComputedDays_thenOut_thenReentry() public {
        _deploy(OCT1, 3, false);
        registerSimple(GPU, 5, OCT1);
        assertTrue(_day(V).changed, "first record");
        uint32[] memory dark4 = withV(V, 4, 0);
        for (uint256 k = 1; k <= 5; ++k) {
            IAgateIndex.Record memory r = _day(dark4);
            assertFalse(r.changed, "held: unchanged");
            assertEq(r.held, 1);
            assertEq(lastState(4).miss, k);
            assertEq(lastState(4).e, 3_800_000);
            assertTrue(lastState(4).inMedian);
        }
        IAgateIndex.Record memory out = _day(dark4);
        assertTrue(out.changed, "the exit is a changed record");
        assertEq(out.value, 3_300_000, "median of 3.0 3.2 3.4 3.6");
        assertFalse(lastState(4).inMedian);
        assertEq(lastState(4).miss, 6);
        assertTrue(lastState(4).wasIn);
        IAgateIndex.Record memory still = _day(dark4);
        assertFalse(still.changed);
        assertEq(lastState(4).miss, 6, "saturates at HOLD_DAYS + 1");
        IAgateIndex.Record memory back = _day(V);
        assertTrue(back.changed, "re-entry on the first fresh computed day (wasIn)");
        assertTrue(lastState(4).inMedian);
        assertEq(back.value, 3_400_000);
    }

    function test_neverInSlotJoinsOnlyOnTheFirst() public {
        _deploy(OCT1 + 28, 3, false); // Oct 29
        uint32 oct29 = OCT1 + 28;
        registerSimple(GPU, 5, oct29);
        uint32[] memory dark4 = withV(V, 4, 0);
        IAgateIndex.Record memory r = _day(dark4); // Oct 29, the first record: slot 4 never IN
        assertFalse(lastState(4).wasIn);
        r = _day(V); // Oct 30: slot 4 fresh but not an entry day: stays OUT
        assertFalse(r.changed);
        assertFalse(lastState(4).inMedian);
        assertEq(lastState(4).miss, 0, "its counter and value move");
        assertEq(lastState(4).e, 3_800_000);
        assertEq(uint8(_kind(oct29 + 1, 4)), uint8(IAgateIndex.Kind.OUT));
        r = _day(V); // Oct 31
        assertFalse(lastState(4).inMedian);
        r = _day(V); // Nov 1: entry day
        assertEq(ix.head(GPU) - 1, NOV1);
        assertTrue(r.changed, "entry with a live slot out");
        assertTrue(lastState(4).inMedian);
        assertEq(r.value, 3_400_000);
    }

    function test_entryDayWithLiveSlotOutIsChanged() public {
        _deploy(OCT1 + 28, 3, false);
        uint32 oct29 = OCT1 + 28;
        registerSimple(GPU, 5, oct29);
        uint32[] memory dark4 = withV(V, 4, 0);
        _day(dark4);
        _day(dark4);
        _day(dark4);
        IAgateIndex.Record memory r = _day(dark4); // Nov 1, slot 4 still dark: OUT on an entry day
        assertTrue(r.changed);
        assertTrue(r.needsSign);
    }

    function test_shadowEntryHeldAtShadowValue() public {
        uint32 oct29 = OCT1 + 28;
        _deploy(oct29, 3, false);
        registerWith(GPU, _fam(5), _q(5), oct29, 0x0f); // slot 4 reserved
        // queue slot 4 live from Dec 1 (before Nov 1: one listing cycle of notice), execute after 48 h
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.LIVE_FROM;
        a.gpuId = GPU;
        a.slot = 4;
        a.day = DEC1;
        vm.prank(owner);
        ix.queue(a);
        _day(V); // Oct 29
        _carryUntil(DEC1 - 6);
        warpTo(block.timestamp + 2 * P.day);
        vm.prank(owner);
        ix.execute(a);
        (uint32 lf,) = ix.slotWindow(GPU, 4);
        assertEq(lf, DEC1);
        // Nov 25: not yet readable (DEC1 - 6 < liveFrom - SHADOW_DAYS)
        IAgateIndex.Record memory r = _day(withV(V, 4, 4_000_000));
        assertEq(ix.readings(GPU, DEC1 - 6, w1).counts[4], 0, "E8b: not readable");
        // Nov 26 .. Nov 30: shadow days: value and counter move, never the median
        for (uint32 d = DEC1 - 5; d < DEC1; ++d) {
            r = _day(withV(V, 4, 4_000_000));
            assertFalse(lastState(4).inMedian);
            assertEq(r.value, 3_300_000, "slot 4 not in the median (3.0 3.2 3.4 3.6)");
        }
        assertEq(lastState(4).e, 4_000_000);
        assertEq(lastState(4).miss, 0);
        // Dec 1: dark, enters HELD at its shadow value
        r = _day(withV(V, 4, 0));
        assertTrue(r.changed);
        assertTrue(lastState(4).inMedian);
        assertEq(lastState(4).miss, 1);
        assertEq(r.held, 1);
        assertEq(r.value, 3_400_000, "3.0 3.2 3.4 3.6 4.0");
    }

    function _fam(uint256 n) internal pure returns (uint8[] memory f) {
        f = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            f[i] = uint8(i);
        }
    }

    function _q(uint256 n) internal pure returns (uint8[] memory q) {
        q = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            q[i] = 1;
        }
    }

    function test_liveUntilRemovesSlot() public {
        _deploy(OCT1, 3, false);
        registerSimple(GPU, 5, OCT1);
        _day(V);
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.LIVE_UNTIL;
        a.gpuId = GPU;
        a.slot = 4;
        a.day = OCT1 + 4; // >= dayId(now + TIMELOCK) + 1
        vm.prank(owner);
        ix.queue(a);
        _day(V);
        _day(V);
        vm.prank(owner);
        ix.execute(a);
        _day(V); // Oct 4: still live
        assertTrue(lastState(4).inMedian);
        IAgateIndex.Record memory r = _day(V); // Oct 5: removed
        assertTrue(r.changed);
        assertFalse(lastState(4).inMedian);
        assertEq(lastState(4).miss, 6);
        assertEq(ix.readings(GPU, OCT1 + 4, w1).counts[4], 0, "E8b after liveUntil");
    }
}
