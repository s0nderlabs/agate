// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {World} from "./World.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// T1 / T2 (the v4.2 freeze loops) and L1b on the contract: TEST clock, 5 single-cloud families
/// [3.00 3.20 3.40 3.60 3.80], two honest writers. LAG_MAX = 2 DAY.
contract FreezeLoopTest is World {
    uint32 internal D; // the day the trouble starts
    uint8 internal darkSlot;
    uint8 internal darkFromSlice; // on D the slot is read on slices < darkFromSlice only
    uint32 internal moveDay; // every page +0.60 from this day
    bool internal attesterUp = true;
    bool internal guardianActs;

    uint32[5] internal BASE = [uint32(3_000_000), 3_200_000, 3_400_000, 3_600_000, 3_800_000];

    function setUp() public {
        deploy(TEST_P(), 0);
        nSlots = 5;
        registerSimple(GPU, 5, OCT1);
        D = OCT1 + 3;
    }

    function page(uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        if (i == darkSlot && (d > D || (d == D && h >= darkFromSlice))) return 0;
        return BASE[i] + (d >= moveDay ? 600_000 : 0);
    }

    /// The kinds an honest record must have on the head day, from the onchain pre-state alone (D1), given which slots
    /// the writers read fresh. Rule R's expected kinds; equals previewRecord's kinds (I29, the contract half).
    function _expectedKinds(uint32 d, bool[] memory fresh) internal view returns (IAgateIndex.Kind[] memory k) {
        k = new IAgateIndex.Kind[](nSlots);
        (, IAgateIndex.SlotState[] memory pre) = ix.slotStates(GPU);
        for (uint256 i; i < nSlots; ++i) {
            uint8 miss = fresh[i] ? 0 : (pre[i].miss >= 5 ? 6 : pre[i].miss + 1);
            bool inM = miss <= 5 && (pre[i].wasIn || d == OCT1);
            if (inM) k[i] = miss == 0 ? IAgateIndex.Kind.FRESH : IAgateIndex.Kind.HELD;
        }
    }

    bool internal refuseExit; // v4.2's attester: refuses the exit (its walked count disagreed with the chain)

    function _policy(uint32 d) internal returns (bool signedIt) {
        if (!exists(d)) return false;
        IAgateIndex.Record memory r = rec(d);
        if (!r.needsSign || r.attestedAt != 0 || r.finalAt != 0) return false;
        bool exit = !lastState(darkSlot).inMedian && baseState(darkSlot).inMedian;
        if (attesterUp && !(refuseExit && exit)) {
            warpTo(r.postedAt + slice()); // the settle point (GAP = 1 slice)
            sign(att, d);
            return true;
        }
        if (guardianActs) {
            warpTo(r.postedAt + uint256(P.day) / 4); // GUARD_ACT
            sign(g1, d);
            return true;
        }
    }

    function _run(uint32 last) internal returns (uint256 drops, uint256 signed) {
        for (uint32 d = OCT1; d <= last; ++d) {
            postDay(d);
            if (d > OCT1) {
                if (exists(d - 1) && rec(d - 1).finalAt == 0) ++drops;
                settle(d - 1);
            }
            if (ix.head(GPU) == d) {
                // D1: the expected kinds come from the onchain pre-state and match the computed record
                bool[] memory fresh = new bool[](nSlots);
                IAgateIndex.Readings memory rd = ix.readings(GPU, d, w1);
                for (uint256 i; i < nSlots; ++i) {
                    fresh[i] = rd.counts[i] >= 6;
                }
                IAgateIndex.Kind[] memory exp = _expectedKinds(d, fresh);
                warpTo(dEnd(d) + slice());
                (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, w1);
                assertTrue(ok);
                for (uint256 i; i < nSlots; ++i) {
                    assertEq(uint8(det.kinds[i]), uint8(exp[i]), "expected kind from the pre-state");
                }
                closeEarliest(w1, d);
            }
            if (_policy(d)) ++signed;
        }
        if (exists(last) && rec(last).finalAt == 0) ++drops;
        settle(last);
    }

    function _assertLag(uint32 last) internal view {
        for (uint32 d = OCT1; d <= last; ++d) {
            assertLe(rec(d).finalAt, dEnd(d) + 2 * uint256(P.day), "L1: final by dayEnd + LAG_MAX");
        }
    }

    /// T1 (A): slot 4 (3.80, not the median) sells out from slice 5 of D (5 readings: not fresh, miss 1 on D), is
    /// dark for everyone from D+1, every page +0.60 from D+8. The exit is on D+4 by the onchain counter; the attester
    /// signs it (expected OUT from pre.miss 5). 0 drops, the move followed, every day within LAG_MAX.
    function test_T1_pageDarkMidDayThenGone() public {
        darkSlot = 4;
        darkFromSlice = 5;
        moveDay = D + 8;
        (uint256 drops, uint256 signed) = _run(D + 10);
        assertEq(drops, 0);
        assertEq(signed, 3, "the first record, the exit, the move");
        IAgateIndex.Record memory exit = rec(D + 5);
        assertTrue(exit.changed);
        assertEq(exit.value, 3_300_000);
        for (uint32 d = D; d < D + 5; ++d) {
            assertFalse(rec(d).changed, "D .. D+4 held (miss 1 .. 5), unchanged");
        }
        assertEq(rec(D + 8).value, 3_900_000, "follows the move");
        _assertLag(D + 10);
    }

    /// T2 (G): slot 3 blocked for both writers all day X (the watcher reads it), dark for everyone from X+1. The
    /// exit lands one day ahead of the watcher's walk; it is the honest exit (D1) and is signed. 0 drops.
    function test_T2_writersBlockedThenPageDies() public {
        darkSlot = 3;
        darkFromSlice = 0;
        moveDay = D + 9;
        (uint256 drops,) = _run(D + 10);
        assertEq(drops, 0);
        assertTrue(rec(D + 5).changed, "the exit by the onchain counter (miss 1 on X .. 6 on X+5)");
        assertEq(rec(D + 5).value, 3_300_000);
        assertEq(rec(D + 9).value, 3_900_000);
        _assertLag(D + 10);
    }

    /// The attester down: the guardian's hand signature (R12) within GUARD_ACT keeps every day within LAG_MAX.
    function test_T1_attesterDown_guardianWithinGuardAct() public {
        darkSlot = 4;
        darkFromSlice = 5;
        moveDay = D + 8;
        attesterUp = false;
        guardianActs = true;
        (uint256 drops,) = _run(D + 10);
        assertEq(drops, 0);
        _assertLag(D + 10);
    }

    /// v4.2's loop, pinned on the contract: an attester that refuses the honest exit makes it recur after every drop
    /// (a carry never takes a slot out: the counter stays at HOLD_DAYS). D1 (the exit expected from pre.miss 5) is
    /// what ends it: once the attester signs, the loop is over.
    function test_T1_refusedExitRecursUntilSigned() public {
        darkSlot = 4;
        darkFromSlice = 5;
        moveDay = type(uint32).max;
        refuseExit = true;
        (uint256 drops,) = _run(D + 7);
        assertGe(drops, 2, "the exit recurs after each drop");
        assertTrue(lastState(4).inMedian, "a carry never exits the slot");
        assertEq(lastState(4).miss, 5);
        // D1: the attester signs the next exit; the loop ends
        refuseExit = false;
        uint32 d = ix.head(GPU);
        if (exists(d - 1) && rec(d - 1).finalAt == 0) _policy(d - 1);
        settle(d - 1);
        postDay(ix.head(GPU));
        closeEarliest(w1, ix.head(GPU));
        _policy(ix.head(GPU) - 1);
        settle(ix.head(GPU) - 1);
        assertFalse(lastState(4).inMedian);
    }
}

/// L1b: a drop loop held by a slot that no eligible writer can read ends by itself within HOLD_DAYS drops (the carry
/// advance of 4.9). The primary plants slot 0 at 3.30 on day X (an unchanged record, final on one key: residual 1);
/// slot 0's page dies for everyone from X+1 while the median page steps 3.40 -> 3.10. Every computed record then
/// holds the planted value, the attester refuses it (R9: unvouched held value) and nobody acts.
contract CarryAdvanceLoopTest is World {
    uint32 internal X;

    function setUp() public {
        deploy(TEST_P(), 0);
        nSlots = 5;
        registerSimple(GPU, 5, OCT1);
        X = OCT1 + 1;
    }

    function page(uint256 i, uint32 d, uint8) internal view override returns (uint32) {
        if (i == 0 && d > X) return 0;
        if (i == 2 && d > X) return 3_100_000;
        return [uint32(3_000_000), 3_200_000, 3_400_000, 3_600_000, 3_800_000][i];
    }

    function posted(address w, uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        if (w == w1 && d == X && i == 0) return 3_300_000;
        return page(i, d, h);
    }

    function _planted() internal view returns (bool) {
        IAgateIndex.SlotState memory s = lastState(0);
        return s.inMedian && s.e == 3_300_000;
    }

    function test_L1b_dropLoopEndsWithinHoldDays() public {
        // Oct 1 honest, X planted and final on one key
        feedDay(OCT1, arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000), arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000));
        closeEarliest(w1, OCT1);
        sign(att, OCT1);
        postDay(X);
        settle(OCT1);
        closeEarliest(w1, X);
        assertFalse(rec(X).needsSign);
        assertTrue(_planted());
        settle(X);
        // both writers post the following days (late posts are fine: the days are still open)
        for (uint32 d = X + 1; d <= X + 8; ++d) {
            postDay(d);
        }
        uint256 drops;
        bool exited;
        for (uint256 guard; guard < 40 && !exited; ++guard) {
            uint32 h = ix.head(GPU);
            if (exists(h - 1)) {
                IAgateIndex.Record memory r = rec(h - 1);
                if (r.finalAt == 0) {
                    if (_planted()) {
                        // refused: nobody signs; carryDay drops it at its time (and closes the next day)
                        uint256 at = _nextCarry(h - 1);
                        warpTo(at);
                        vm.prank(keeper);
                        ix.carryDay(GPU);
                        ++drops;
                        continue;
                    }
                    sign(att, h - 1); // the exit record holds no planted value: signed
                    exited = true;
                    continue;
                }
                warpTo(r.finalAt);
            }
            warpTo(dEnd(h) + slice());
            vm.prank(keeper);
            try ix.closeDay(GPU) {} catch {}
        }
        assertTrue(exited, "the loop ended");
        assertEq(drops, 5, "within HOLD_DAYS drops");
        IAgateIndex.SlotState memory s = lastState(0);
        assertFalse(s.inMedian);
        assertEq(s.miss, 6);
        assertEq(s.e, 3_300_000, "a carry never changes e");
    }

    /// The same world with the guardian acting (R12 accepts a held value on a page no writer can read): no drop.
    function test_L1b_guardianSigns_noDrop() public {
        feedDay(OCT1, arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000), arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000));
        closeEarliest(w1, OCT1);
        sign(att, OCT1);
        for (uint32 d = X; d <= X + 7; ++d) {
            postDay(d);
            settle(d - 1);
            closeEarliest(w1, d);
            IAgateIndex.Record memory r = rec(d);
            if (r.needsSign) {
                vm.warp(r.postedAt + uint256(P.day) / 4);
                sign(g1, d);
            }
        }
        settle(X + 7);
        for (uint32 d = X; d <= X + 7; ++d) {
            assertFalse(rec(d).dropped);
            assertLe(rec(d).finalAt, dEnd(d) + 2 * uint256(P.day));
        }
    }
}
