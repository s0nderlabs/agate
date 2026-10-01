// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {World} from "./World.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// The freeze thief (production clock, 7 single-cloud families): a stolen primary repeats day 1's readings through
/// a +1/6 step on day 5. With an honest standby the attester's select leaves 0 wrong final days.
contract FreezeThiefTest is World {
    uint32[7] internal PANEL = [uint32(3_150_000), 3_450_000, 3_550_000, 3_600_000, 3_850_000, 3_900_000, 3_990_000];
    bool internal hasStandby;

    function setUp() public {
        deploy(PROD_P(), NOV1);
        nSlots = 7;
        registerSimple(GPU, 7, NOV1);
    }

    function page(uint256 i, uint32 d, uint8) internal view override returns (uint32) {
        uint256 v = PANEL[i];
        if (d >= NOV1 + 5) v = (v * 7 / 6 + 5_000) / 10_000 * 10_000;
        return uint32(v);
    }

    function posted(address w, uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        if (w == w1 && d >= NOV1 + 1) return page(i, NOV1 + 1, h); // frozen at day 1
        return page(i, d, h);
    }

    function standby() internal view override returns (address) {
        return hasStandby ? w2 : address(0);
    }

    function _run() internal returns (uint256 wrong, uint256 selects) {
        for (uint32 k; k < 12; ++k) {
            uint32 d = NOV1 + k;
            postDay(d);
            if (k > 0) settle(d - 1);
            closeEarliest(w1, d);
            vm.warp(block.timestamp + 30 minutes);
            IAgateIndex.Record memory r = rec(d);
            (bool ok, IAgateIndex.RecordDetail memory sb) = ix.previewRecord(GPU, d, w2);
            if (hasStandby && ok && !sb.rec.incomplete && sb.rec.value != r.value) {
                selectW(att, d, w2);
                ++selects;
            } else if (r.needsSign) {
                sign(att, d);
            }
        }
        settle(NOV1 + 11);
        for (uint32 k; k < 12; ++k) {
            (bool ok, uint32 v,,,,) = ix.finalFix(GPU, NOV1 + k);
            assertTrue(ok);
            if (v != (k >= 5 ? 4_200_000 : 3_600_000)) ++wrong;
        }
    }

    function test_freeze_withStandby_zeroWrong() public {
        hasStandby = true;
        (uint256 wrong, uint256 selects) = _run();
        assertEq(wrong, 0);
        assertEq(selects, 7, "every frozen day from the step on");
        assertEq(rec(NOV1 + 5).source, w2);
        assertTrue(rec(NOV1 + 5).changed);
    }

    /// Residual 1 of 6.8, stated: without a standby a stolen key freezes the price through a real step (unchanged
    /// records are final on one key) until a person suspends it; then every day is carried at the last value.
    function test_freeze_withoutStandby_isTheStatedResidual() public {
        (uint256 wrong,) = _run();
        assertEq(wrong, 7);
        vm.prank(g1);
        ix.suspend(w1);
        uint32 d = NOV1 + 12;
        postDay(d); // the suspended key posts nothing (A2)
        assertEq(ix.readings(GPU, d, w1).sliceBits, 0);
        settle(d);
        assertEq(uint8(rec(d).status), uint8(IAgateIndex.Status.CARRIED));
        assertLe(rec(d).finalAt, dEnd(d) + 2 * uint256(P.day));
    }
}

/// T3 (D): a queued slot's shadow plant. Slot 4 is queued for Dec 1 (its page shows 3.40); the stolen primary types
/// 4.50 for it on the five shadow days. TEST clock.
contract QueuedSlotPlantTest is World {
    uint32 internal constant NOV21 = 20_778;
    bool internal hasStandby = true;
    bool internal selectShadow = true;
    bool internal dec1Dark; // slot 4 dark for everyone on Dec 1
    bool internal standbyBlockedDec1; // slot 4 blocked for the standby only on Dec 1

    function setUp() public {
        Profile memory p = TEST_P();
        p.epochDay = OCT1 + 30; // Oct 31: Dec 1 can still be queued today
        deploy(p, 0);
        nSlots = 5;
        uint8[] memory fam = new uint8[](5);
        uint8[] memory q = new uint8[](5);
        for (uint256 i; i < 5; ++i) {
            fam[i] = uint8(i);
            q[i] = 1;
        }
        registerWith(GPU, fam, q, NOV21, 0x0f);
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.LIVE_FROM;
        a.gpuId = GPU;
        a.slot = 4;
        a.day = DEC1;
        vm.prank(owner);
        ix.queue(a);
        vm.warp(block.timestamp + 2 * uint256(P.day));
        vm.prank(owner);
        ix.execute(a);
    }

    function page(uint256 i, uint32 d, uint8) internal view override returns (uint32) {
        if (i == 4) return (dec1Dark && d >= DEC1) ? 0 : 3_400_000;
        return [uint32(3_000_000), 3_200_000, 3_600_000, 3_800_000][i];
    }

    function posted(address w, uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        uint32 v = page(i, d, h);
        if (w == w1 && i == 4 && v != 0) return 4_500_000;
        if (w == w2 && i == 4 && standbyBlockedDec1 && d >= DEC1) return 0;
        return v;
    }

    function standby() internal view override returns (address) {
        return hasStandby ? w2 : address(0);
    }

    /// Runs Nov 21 .. Dec 2. The attester (D3) selects the standby on every shadow day whose primary record
    /// carries a slot-4 value no page showed, and on Dec 1 when the primary's slot 4 differs.
    function _run() internal {
        for (uint32 d = NOV21; d <= DEC1 + 1; ++d) {
            postDay(d);
            if (d > NOV21) settle(d - 1);
            closeEarliest(w1, d);
            IAgateIndex.Record memory r = rec(d);
            bool bad = lastState(4).e == 4_500_000;
            if (hasStandby && selectShadow && bad) {
                selectW(att, d, w2);
            } else if (r.needsSign && (hasStandby || !bad)) {
                sign(att, d);
            }
        }
    }

    function test_T3_standbyHonest_slotEntersAtThePage() public {
        _run();
        settle(DEC1 + 1);
        IAgateIndex.SlotState memory s = ix.slotState(GPU, 4);
        assertTrue(s.inMedian);
        assertEq(s.e, 3_400_000);
        assertEq(rec(DEC1).value, 3_400_000, "3.0 3.2 3.4 3.6 3.8");
        assertEq(rec(DEC1).source, w2);
    }

    function test_T3_dec1DarkForEveryone_entersHeldAtTheStandbysShadowValue() public {
        dec1Dark = true;
        _run();
        settle(DEC1 + 1);
        IAgateIndex.SlotState memory s = ix.slotState(GPU, 4);
        assertTrue(s.inMedian);
        assertEq(s.e, 3_400_000, "held at the shadow value the select kept");
        assertEq(s.miss, 2);
    }

    function test_T3_standbyBlockedOnDec1_stillEntersAt340() public {
        standbyBlockedDec1 = true;
        _run();
        settle(DEC1 + 1);
        assertEq(rec(DEC1).source, w2, "the thief's fresh 4.50 is replaced by the standby's held 3.40");
        assertEq(ix.slotState(GPU, 4).e, 3_400_000);
    }

    /// Control: without the shadow-day selects the plant lands on Dec 1.
    function test_T3_control_withoutSelectThePlantLands() public {
        selectShadow = false;
        dec1Dark = true;
        _run();
        settle(DEC1 + 1);
        assertEq(ix.slotState(GPU, 4).e, 4_500_000);
        assertEq(rec(DEC1).value, 3_600_000);
    }

    /// No standby, nobody acting: the Dec 1 entry record carries the plant, is never signed and is dropped once;
    /// the next day slot 4 cannot enter (not an entry day), the record is unchanged and final: the loop ends after
    /// one drop (L1b, at most HOLD_DAYS).
    function test_T3_noStandby_nobodyActing_loopEndsWithinHoldDays() public {
        hasStandby = false;
        dec1Dark = true;
        uint256 drops;
        for (uint32 d = NOV21; d <= DEC1 + 3; ++d) {
            postDay(d);
            if (d > NOV21) {
                if (exists(d - 1) && rec(d - 1).finalAt == 0) ++drops;
                settle(d - 1);
            }
            if (ix.head(GPU) != d) continue;
            closeEarliest(w1, d);
            IAgateIndex.Record memory r = rec(d);
            if (r.needsSign && d == NOV21) sign(att, d); // the first record, honest
        }
        settle(DEC1 + 3);
        assertEq(drops, 1);
        assertTrue(rec(DEC1).dropped);
        assertFalse(ix.slotState(GPU, 4).inMedian);
        assertEq(ix.slotState(GPU, 4).miss, 4, "advanced once by the drop's carry (no writer read it), then per computed day");
        assertFalse(rec(DEC1 + 1).changed);
    }

    /// No standby, the guardian acting (R12 signs the plant within GUARD_ACT): every day final within LAG_MAX.
    function test_T3_noStandby_guardianSigns_L1Holds() public {
        hasStandby = false;
        dec1Dark = true;
        for (uint32 d = NOV21; d <= DEC1 + 1; ++d) {
            postDay(d);
            if (d > NOV21) settle(d - 1);
            closeEarliest(w1, d);
            IAgateIndex.Record memory r = rec(d);
            if (r.needsSign) {
                vm.warp(r.postedAt + uint256(P.day) / 4); // GUARD_ACT
                sign(g1, d);
            }
        }
        settle(DEC1 + 1);
        for (uint32 d = NOV21; d <= DEC1 + 1; ++d) {
            assertLe(rec(d).finalAt, dEnd(d) + 2 * uint256(P.day));
        }
        assertEq(ix.slotState(GPU, 4).e, 4_500_000, "residual 1: the plant lands without a standby");
    }
}
