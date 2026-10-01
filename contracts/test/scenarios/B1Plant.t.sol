// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {World} from "./World.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// B1 pre-positioning (the final audit's A1, world S7), production clock, 5 single-cloud families, Q_MIN 3.
/// A stolen primary posts slot 0 at 3.40 (the panel median) on days 1 to 4, so its records stay UNCHANGED; slot 0's
/// page is dark for everyone on days 5 to 7 while slot 3 moves 3.60 -> 3.00. Honest fixes: 3.40 on days 0 to 4,
/// 3.20 from day 5. The contract's part of the defence: an unchanged record is replaceable by a select until it is
/// final, and the select also replaces the post-state, so the planted held value never enters `last`.
contract B1PlantTest is World {
    uint32[5] internal TRUE_ = [uint32(3_000_000), 3_200_000, 3_400_000, 3_600_000, 3_800_000];
    bool internal thief;
    bool internal hasStandby;

    function setUp() public {
        deploy(PROD_P(), NOV1);
        nSlots = 5;
        registerSimple(GPU, 5, NOV1);
    }

    function page(uint256 i, uint32 d, uint8) internal view override returns (uint32) {
        uint32 k = d - NOV1;
        if (i == 0 && k >= 5 && k <= 7) return 0;
        if (i == 3 && k >= 5) return 3_000_000;
        return TRUE_[i];
    }

    function posted(address w, uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        uint32 v = page(i, d, h);
        if (thief && w == w1 && d >= NOV1 + 1 && i == 0 && v != 0) return 3_400_000;
        return v;
    }

    function standby() internal view override returns (address) {
        return hasStandby ? w2 : address(0);
    }

    function _truth(uint32 k) internal pure returns (uint32) {
        return k <= 4 ? 3_400_000 : 3_200_000;
    }

    /// Runs days 0..9. policy 0: rule R v4.1+ (select the standby over a planted record, sign honest changes);
    /// policy 1: the control (no select; the attester signs every changed record, as rule R v4 as audited would).
    /// Returns the wrong final days.
    function _run(uint8 policy) internal returns (uint256 wrong, uint256 selects) {
        for (uint32 k; k < 10; ++k) {
            uint32 d = NOV1 + k;
            postDay(d);
            if (k > 0) settle(d - 1);
            closeEarliest(w1, d);
            IAgateIndex.Record memory r = rec(d);
            vm.warp(block.timestamp + 30 minutes);
            bool planted = thief && k >= 1 && lastState(0).e == 3_400_000 && lastState(0).inMedian;
            if (policy == 0 && planted && hasStandby) {
                selectW(att, d, w2);
                ++selects;
            } else if (r.needsSign && (policy == 1 || !planted)) {
                sign(att, d);
            }
        }
        settle(NOV1 + 9);
        for (uint32 k; k < 10; ++k) {
            (bool ok, uint32 v,,,,) = ix.finalFix(GPU, NOV1 + k);
            assertTrue(ok, "every day final");
            if (v != _truth(k)) ++wrong;
        }
    }

    function test_B1_honestControl_zeroWrong() public {
        hasStandby = true;
        (uint256 wrong,) = _run(0);
        assertEq(wrong, 0);
    }

    function test_B1_withStandby_selectsDefeatThePlant() public {
        thief = true;
        hasStandby = true;
        (uint256 wrong, uint256 selects) = _run(0);
        assertEq(wrong, 0, "0 wrong final days with an honest standby");
        assertEq(selects, 6, "every planted record replaced: days 1 to 4, 8 and 9");
        assertEq(rec(NOV1 + 5).value, 3_200_000);
        assertFalse(ix.isSuspended(w1), "a select suspends nobody");
    }

    function test_B1_control_withoutSelectThePlantIsHarvested() public {
        thief = true;
        hasStandby = true;
        (uint256 wrong,) = _run(1);
        // days 5 to 7 harvest the planted held value; days 8 and 9 are fresh plants: all final at 3.40 on one key
        assertEq(wrong, 5, "the attack the select answers");
        for (uint32 k = 5; k <= 9; ++k) {
            IAgateIndex.Record memory r = rec(NOV1 + k);
            assertFalse(r.changed, "unchanged: no countersign needed");
            assertEq(r.attestedAt, 0);
        }
    }

    /// No standby, the guardian acting within one hour: R3 vetoes each planted record by name (slot reason), R8
    /// suspends on the second; with no writer left every day is carried at the last value (the freeze residual)
    /// and no planted value is ever final. Every day is still final within LAG_MAX (2 DAY).
    function test_B1_noStandby_guardianVetoes_plantNeverFinal() public {
        thief = true;
        uint256 vetoes;
        for (uint32 k; k < 10; ++k) {
            uint32 d = NOV1 + k;
            postDay(d);
            if (k > 0) settle(d - 1);
            if (!ix.isSuspended(w1)) {
                closeEarliest(w1, d);
                IAgateIndex.Record memory r = rec(d);
                if (lastState(0).e == 3_400_000) {
                    vm.warp(r.postedAt + 1 hours);
                    vm.prank(g1);
                    ix.veto(GPU, d, w1, r.digest);
                    ++vetoes;
                    if (vetoes == 2) {
                        vm.prank(g1);
                        ix.suspend(w1);
                    }
                } else if (r.needsSign) {
                    sign(att, d);
                }
            }
            assertTrue(ix.slotState(GPU, 0).e != 3_400_000, "the planted value is never in a final state");
        }
        settle(NOV1 + 9);
        assertEq(vetoes, 2);
        for (uint32 k; k < 10; ++k) {
            IAgateIndex.Record memory r = rec(NOV1 + k);
            assertLe(r.finalAt, dEnd(NOV1 + k) + 2 * uint256(P.day), "L1: final within LAG_MAX");
            assertTrue(r.value == 3_400_000, "carried at the last honest fix (freeze residual)");
        }
    }
}
