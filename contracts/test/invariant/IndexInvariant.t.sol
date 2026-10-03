// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IndexBase} from "../Base.t.sol";
import {IndexHandler} from "./IndexHandler.sol";
import {IAgateIndex, HOLD_DAYS, TICK, P_MIN, P_MAX} from "../../src/interfaces/IAgateIndex.sol";

/// Invariants I16 to I22 (BUILD-SPEC 12.1) over random sequences of handler actions, and the liveness property that
/// the head can always advance by the spec's honest actions (I22).
/// forge-config: default.invariant.runs = 96
/// forge-config: default.invariant.depth = 96
contract IndexInvariantTest is IndexBase {
    IndexHandler internal h;

    function setUp() public {
        deploy(TEST_P(), 0);
        // 6 slots in 5 families: one family of two (famQ 1), one slot reserved
        uint8[] memory fam = new uint8[](6);
        (fam[0], fam[1], fam[2], fam[3], fam[4], fam[5]) = (0, 0, 1, 2, 3, 4);
        uint8[] memory q = new uint8[](5);
        (q[0], q[1], q[2], q[3], q[4]) = (1, 1, 1, 1, 1);
        registerWith(GPU, fam, q, OCT1, 0x1f);
        h = new IndexHandler(ix, [w1, w2, att, g1, keeper, owner], OCT1, 6);
        targetContract(address(h));
        // weights by repetition: mostly posting, closing and signing, sometimes vetoes, suspensions and long waits
        bytes4[] memory sel = new bytes4[](28);
        uint256 k;
        for (uint256 i; i < 4; ++i) sel[k++] = IndexHandler.postAll.selector;
        for (uint256 i; i < 2; ++i) sel[k++] = IndexHandler.post.selector;
        for (uint256 i; i < 3; ++i) sel[k++] = IndexHandler.close.selector;
        for (uint256 i; i < 3; ++i) sel[k++] = IndexHandler.attest.selector;
        for (uint256 i; i < 2; ++i) sel[k++] = IndexHandler.carry.selector;
        for (uint256 i; i < 3; ++i) sel[k++] = IndexHandler.wait.selector;
        sel[k++] = IndexHandler.waitLong.selector;
        sel[k++] = IndexHandler.veto.selector;
        sel[k++] = IndexHandler.suspendStandby.selector;
        sel[k++] = IndexHandler.reappointStandby.selector;
        // Oct 3 (I31, I32): reader swaps and the owner queue's execute window, with time warps to its boundaries
        for (uint256 i; i < 2; ++i) sel[k++] = IndexHandler.queueSwap.selector;
        for (uint256 i; i < 2; ++i) sel[k++] = IndexHandler.executeSwap.selector;
        sel[k++] = IndexHandler.cancelSwap.selector;
        sel[k++] = IndexHandler.warpToBoundary.selector;
        sel[k++] = IndexHandler.executeReappointAnyTime.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    function invariant_noViolationInsideActions() public view {
        assertEq(h.violation(), "");
    }

    function invariant_records_I16_I17_I18_I19() public view {
        assertEq(h.checkRecords(), "");
    }

    /// I31 (a reader swap moves nothing recorded; fromDay strictly increases) and I32 (queuedEta is 0 outside a live
    /// window). The checks inside the swap and execute actions report through violation().
    function invariant_queue_I31_I32() public view {
        assertEq(h.checkQueue(), "");
    }

    function invariant_slotStates() public view {
        (IAgateIndex.SlotState[] memory b, IAgateIndex.SlotState[] memory l) = ix.slotStates(GPU);
        for (uint256 k; k < 2; ++k) {
            IAgateIndex.SlotState[] memory s = k == 0 ? b : l;
            for (uint256 i; i < s.length; ++i) {
                assertLe(s[i].miss, HOLD_DAYS + 1);
                assertEq(s[i].e % TICK, 0);
                if (s[i].inMedian) {
                    assertTrue(s[i].wasIn);
                    assertLe(s[i].miss, HOLD_DAYS);
                    assertGe(s[i].e, P_MIN);
                }
            }
        }
        // slot 5 is reserved: never read, never in
        assertFalse(l[5].inMedian || l[5].wasIn);
    }

    function invariant_readings_I20() public view {
        uint32 hd = ix.head(GPU);
        address[2] memory ws = [w1, w2];
        for (uint32 d = hd > OCT1 + 2 ? hd - 2 : OCT1; d <= hd + 1; ++d) {
            for (uint256 k; k < 2; ++k) {
                IAgateIndex.Readings memory r = ix.readings(GPU, d, ws[k]);
                uint256 bits = r.sliceBits;
                uint256 pop;
                while (bits != 0) {
                    pop += bits & 1;
                    bits >>= 1;
                }
                assertLe(pop, 12);
                for (uint256 i; i < r.counts.length; ++i) {
                    assertLe(r.counts[i], pop, "a count per posted slice at most");
                    if (r.counts[i] > 0) {
                        assertEq(r.sums[i] % TICK, 0);
                        assertGe(r.sums[i], uint256(P_MIN) * r.counts[i]);
                        assertLe(r.sums[i], uint256(P_MAX) * r.counts[i]);
                    }
                }
                assertEq(r.counts[5], 0, "E8b: the reserved slot never counts");
            }
        }
    }

    /// I21: a veto never suspends; only the handler's explicit suspension of the standby does.
    function invariant_primaryNeverSuspended() public view {
        assertFalse(ix.isSuspended(w1));
    }

    /// I22: from any reachable state, honest permissionless calls plus the guardian's countersign advance the head
    /// and make the newest day final, within bounded time.
    function invariant_headCanAlwaysAdvance() public {
        uint256 snap = vm.snapshotState();
        uint32 h0 = ix.head(GPU);
        uint256 t0 = vm.getBlockTimestamp();
        bool done;
        for (uint256 step; step < 40 && !done; ++step) {
            uint32 hd = ix.head(GPU);
            if (hd > h0 && (!exists(hd - 1) || isFinal(hd - 1))) {
                done = true;
                break;
            }
            (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, hd - 1);
            if (hd > OCT1 && e && !f) {
                if (r.needsSign && r.attestedAt == 0) {
                    vm.prank(g1);
                    ix.attest(GPU, hd - 1, r.source, r.digest);
                } else {
                    vm.warp(r.finalAt > vm.getBlockTimestamp() ? r.finalAt : vm.getBlockTimestamp() + 1);
                }
                continue;
            }
            uint256 closable = ix.dayStart(hd) + uint256(P.day) + P.day / P.slices;
            if (vm.getBlockTimestamp() < closable) vm.warp(closable);
            if (_tryClose(keeper) || _tryClose(w1) || _tryClose(w2)) continue;
            vm.prank(keeper);
            try ix.carryDay(GPU) {
                continue;
            } catch {}
            // waits: GRACE, STEP, REOPEN_WAIT (at most a day and a quarter past the later of them)
            vm.warp(vm.getBlockTimestamp() + P.day / 4);
        }
        assertTrue(done, "the head advanced and its newest record is final");
        assertLe(vm.getBlockTimestamp() - t0, 12 * uint256(P.day), "within bounded time");
        vm.revertToState(snap);
    }

    function _tryClose(address who) internal returns (bool) {
        vm.prank(who);
        try ix.closeDay(GPU) {
            return true;
        } catch {
            return false;
        }
    }

    function afterInvariant() external view {
        bytes32[16] memory k = [
            bytes32("post"), "close", "carry", "drop", "attest", "select", "veto", "suspend", "reappoint", "postReverted",
            "attestReverted", "swapQueue", "swapExecute", "swapCancel", "warpBoundary", "refusedInWindow"
        ];
        for (uint256 i; i < k.length; ++i) {
            console2.log(string(abi.encodePacked(k[i])), h.calls(k[i]));
        }
        console2.log("head - first", ix.head(GPU) - OCT1);
    }
}
