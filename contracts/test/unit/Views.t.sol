// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER} from "../../src/interfaces/IAgateIndex.sol";
import {DateLib} from "../../src/lib/DateLib.sol";

contract ViewsTest is IndexBase {
    uint32 internal D;
    uint32[] internal V;
    uint32[] internal UP;

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        UP = arr(3_000_000, 3_200_000, 3_600_000, 3_600_000, 3_800_000);
    }

    function test_finalFix_neverReverts() public {
        (bool ok, uint32 v, IAgateIndex.Status st,,,) = ix.finalFix(GPU2, D);
        assertFalse(ok);
        assertEq(v, 0);
        assertEq(uint8(st), 0);
        (ok,,,,,) = ix.finalFix(GPU, D);
        assertFalse(ok, "no record");
        (ok,,,,,) = ix.finalFix(GPU, type(uint32).max);
        assertFalse(ok);
        feedDay(D, V, none());
        closeEarliest(w1, D);
        (ok,,,,,) = ix.finalFix(GPU, D);
        assertFalse(ok, "pending");
        sign(att, D);
        warpTo(rec(D).finalAt);
        bool late;
        bool inc;
        uint8 fresh;
        (ok, v, st, fresh, late, inc) = ix.finalFix(GPU, D);
        assertTrue(ok);
        assertEq(v, 3_400_000);
        assertEq(uint8(st), uint8(IAgateIndex.Status.FULL));
        assertEq(fresh, 5);
        assertFalse(late);
        assertFalse(inc);
        (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU2, D);
        assertFalse(e || f);
        assertEq(r.value, 0);
    }

    function test_slotState_isFinalOnly() public {
        bootDay(D, V, none());
        warpTo(rec(D).finalAt);
        feedDay(D + 1, UP, none());
        closeEarliest(w1, D + 1);
        // the newest record is pending: slotState shows the state after the newest FINAL record
        assertEq(ix.slotState(GPU, 2).e, 3_400_000);
        assertEq(lastState(2).e, 3_600_000);
        sign(att, D + 1);
        warpTo(rec(D + 1).finalAt);
        assertEq(ix.slotState(GPU, 2).e, 3_600_000);
        assertEq(ix.slotState(GPU, 9).e, 0, "out of range: zero, no revert");
        assertEq(ix.slotState(GPU2, 0).miss, 0, "unknown gpu: zero");
        (uint32 lf, uint32 lu) = ix.slotWindow(GPU, 9);
        assertEq(lf, NEVER);
        assertEq(lu, NEVER);
        (uint8 fam, uint8 q) = ix.familyOf(GPU, 9);
        assertEq(fam + q, 0);
        assertEq(ix.readings(GPU2, D, w1).sums.length, 0);
    }

    function test_disrupted() public {
        bootDay(D, V, none());
        assertFalse(ix.disrupted(GPU));
        uint32 d = D + 1;
        for (uint256 k; k < 5; ++k) {
            warpTo(dEnd(d) + P.day);
            warpTo(uint256(ix.gpu(GPU).lastCarryAt) + P.day / 6);
            ix.carryDay(GPU);
            ++d;
            assertEq(ix.disrupted(GPU), k == 4, "five newest final records CARRIED");
        }
        // a pending computed record on top: the five newest FINAL records are still the carried ones
        feedDay(d, V, none());
        closeAt(w1, block.timestamp > dEnd(d) + slice() ? block.timestamp : dEnd(d) + slice());
        IAgateIndex.Record memory r = rec(d);
        assertEq(r.finalAt, r.postedAt + tPend());
        assertTrue(ix.disrupted(GPU));
        warpTo(r.finalAt);
        assertFalse(ix.disrupted(GPU));
        assertFalse(ix.disrupted(GPU2));
    }

    function test_previewRecord_okFalsePaths() public {
        (bool ok,) = ix.previewRecord(GPU2, D, w1);
        assertFalse(ok, "unknown gpu");
        (ok,) = ix.previewRecord(GPU, D, w1);
        assertFalse(ok, "no readings");
        feedDay(D, V, none());
        (ok,) = ix.previewRecord(GPU, D, stranger);
        assertFalse(ok, "not a writer");
        (ok,) = ix.previewRecord(GPU, D + 1, w1);
        assertFalse(ok, "not the head or pending day");
        (ok,) = ix.previewRecord(GPU, D, w1);
        assertTrue(ok);
        closeEarliest(w1, D);
        (ok,) = ix.previewRecord(GPU, D - 1, w1);
        assertFalse(ok);
        (bool ok2, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, D, w1);
        assertTrue(ok2);
        assertEq(det.rec.digest, rec(D).digest, "I19: equals what closeDay stored");
        assertEq(det.rec.postedAt, rec(D).postedAt);
    }

    function test_previewFix_matchesClose() public {
        (bool ok,) = ix.previewFix(GPU2);
        assertFalse(ok);
        (ok,) = ix.previewFix(GPU);
        assertFalse(ok, "no source");
        feedDay(D, V, V);
        warpTo(dEnd(D) + slice());
        (bool ok2, IAgateIndex.RecordDetail memory det) = ix.previewFix(GPU);
        assertTrue(ok2);
        vm.prank(keeper);
        ix.closeDay(GPU);
        IAgateIndex.Record memory r = rec(D);
        assertEq(det.rec.digest, r.digest);
        assertEq(det.rec.value, r.value);
        assertEq(det.rec.source, r.source);
        assertEq(det.rec.needsSign, r.needsSign);
        assertEq(det.rec.finalAt, r.finalAt);
    }
}

contract DateLibTest is IndexBase {
    function test_roundTrip_1970_to_2099() public pure {
        uint256 end = DateLib.daysFromCivil(2100, 1, 1);
        uint256 prevM = 0;
        for (uint256 z; z < end; ++z) {
            (uint256 y, uint256 m, uint256 d) = DateLib.civilFromDays(z);
            require(DateLib.daysFromCivil(y, m, d) == z, "round trip");
            uint256 mi = DateLib.monthOf(z);
            require(DateLib.isFirstOfMonth(z) == (d == 1), "first");
            require(DateLib.firstDayOf(mi) == z - (d - 1), "firstDayOf");
            require(mi >= prevM, "monotone");
            prevM = mi;
        }
    }

    function test_knownDays() public pure {
        assertEq(DateLib.daysFromCivil(2026, 10, 1), 20_727);
        assertEq(DateLib.daysFromCivil(2026, 11, 1), 20_758);
        assertEq(DateLib.daysFromCivil(2026, 12, 1), 20_788);
        assertEq(DateLib.daysFromCivil(1970, 1, 1), 0);
        (uint256 y, uint256 m, uint256 d) = DateLib.civilFromDays(20_727);
        assertEq(y * 10_000 + m * 100 + d, 20_261_001);
        assertTrue(DateLib.isFirstOfMonth(20_727));
        assertFalse(DateLib.isFirstOfMonth(20_728));
        assertEq(DateLib.monthOf(20_727), 2026 * 12 + 9);
    }

    function test_monthLengths() public pure {
        uint8[12] memory len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        for (uint256 y = 1970; y < 2100; ++y) {
            for (uint256 m; m < 12; ++m) {
                uint256 want = len[m];
                if (m == 1 && (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0))) want = 29;
                assertEq(DateLib.daysIn(y * 12 + m), want);
            }
        }
        assertEq(DateLib.daysIn(2000 * 12 + 1), 29, "2000 is a leap year");
        assertEq(DateLib.daysIn(2100 * 12 + 1), 28, "2100 is not");
    }
}
