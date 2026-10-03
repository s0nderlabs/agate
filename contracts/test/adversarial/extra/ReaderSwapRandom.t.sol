// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../../Base.t.sol";
import {IAgateIndex, ACTION_WINDOW_DAYS} from "../../../src/interfaces/IAgateIndex.sol";

/// Recheck r1: random sequences of reader-swap queue, cancel, execute and time jumps on one slot, as a
/// stolen owner key could send them. After every step: no reader of today or an earlier day changed; the history's
/// fromDay strictly increases; every executed swap waited TIMELOCK from its latest queue and is effective a full
/// slice after its execute at the earliest; queuedEta agrees with what execute allows. TEST clock.
contract ReaderSwapRandomTest is IndexBase {
    uint8 internal constant SLOT = 1;
    uint256 internal constant N_READERS = 3;
    uint256 internal constant LOOKBACK = 4;

    mapping(bytes32 => uint256) internal queuedAt; // id -> time of its latest queue (0: none live)

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
    }

    function _rd(uint256 i) internal pure returns (IAgateIndex.Reader memory r) {
        r.url = "https://lambda.ai/service/gpu-cloud";
        r.parserVersion = i == 0 ? "lambda/2" : i == 1 ? "lambda/3" : "lambda/4";
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    /// readerAt's hash (0 when not swapped) for days today - LOOKBACK .. today.
    function _snap() internal view returns (bytes32[] memory s) {
        s = new bytes32[](LOOKBACK + 1);
        uint32 t = today();
        for (uint256 j; j <= LOOKBACK; ++j) {
            (bool sw, IAgateIndex.ReaderVersion memory v) = ix.readerAt(GPU, SLOT, t - uint32(j));
            s[j] = sw ? v.readerHash : bytes32(0);
        }
    }

    function _checkHistory() internal view {
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, SLOT);
        for (uint256 j; j < h.length; ++j) {
            if (j > 0) assertGt(h[j].fromDay, h[j - 1].fromDay, "fromDay strictly increases");
            assertGe(dStart(h[j].fromDay), uint256(h[j].executedAt) + slice() + 1, "a full slice of notice");
            assertGt(h[j].fromDay, ix.dayId(h[j].executedAt), "never the day of the execute");
        }
    }

    function testFuzz_randomSwapSequences_neverTouchTodayOrThePast(uint256 seed) public {
        _run(seed);
    }

    /// The sequences do reach executes (the fuzz above is not vacuous).
    function test_sequencesExecuteSwaps() public {
        uint256 total;
        for (uint256 seed; seed < 6; ++seed) total += _run(seed);
        assertGt(total, 0);
    }

    function _run(uint256 seed) internal returns (uint256 executed) {
        vm.warp(T0 + (seed % P.day));
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = r % 4;
            IAgateIndex.Reader memory rd = _rd((r >> 8) % N_READERS);
            bytes32 id = ix.readerSwapId(GPU, SLOT, rd);
            bytes32[] memory before = _snap();
            uint256 etaView = ix.queuedEta(id);
            if (op == 0) {
                vm.prank(owner);
                try ix.queueReaderSwap(GPU, SLOT, rd, "random step") {
                    assertEq(etaView, 0, "a queue only succeeds when nothing live is queued under the id");
                    queuedAt[id] = block.timestamp;
                    assertEq(ix.queuedEta(id), block.timestamp + 2 * uint256(P.day));
                } catch {
                    assertTrue(etaView != 0, "a queue fails only while the id is live");
                }
            } else if (op == 1) {
                uint256 n = ix.readerHistory(GPU, SLOT).length;
                vm.prank(owner);
                try ix.executeReaderSwap(GPU, SLOT, rd) {
                    assertTrue(etaView != 0 && block.timestamp >= etaView, "executes only live and past eta");
                    assertGe(block.timestamp, queuedAt[id] + 2 * uint256(P.day), "the full timelock since the latest queue");
                    assertEq(ix.readerHistory(GPU, SLOT).length, n + 1);
                    assertEq(ix.queuedEta(id), 0, "executed: gone");
                    queuedAt[id] = 0;
                    executed += 1;
                } catch {
                    assertEq(ix.readerHistory(GPU, SLOT).length, n);
                }
            } else if (op == 2) {
                vm.prank(owner);
                try ix.cancelReaderSwap(GPU, SLOT, rd) {
                    assertEq(ix.queuedEta(id), 0);
                    queuedAt[id] = 0;
                } catch {}
            } else {
                // up to the window and a bit, so expiries happen
                vm.warp(block.timestamp + ((r >> 16) % (_w() / 4 + 3 * uint256(P.day))));
            }
            // the days that were today or earlier before this step read exactly as before (a time jump moves today)
            if (op != 3) {
                bytes32[] memory after_ = _snap();
                for (uint256 j; j <= LOOKBACK; ++j) {
                    assertEq(after_[j], before[j], "a past or current day's reader changed");
                }
            }
            _checkHistory();
        }
    }

    /// A stolen owner key that lets a swap expire, cancels and re-queues it, or re-queues right at the old deadline,
    /// never executes before a full TIMELOCK from the latest queue.
    function test_requeueAtTheOldDeadline_restartsTheFullTimelock() public {
        IAgateIndex.Reader memory rd = _rd(0);
        bytes32 id = ix.readerSwapId(GPU, SLOT, rd);
        vm.warp(T0 + 5);
        vm.prank(owner);
        ix.queueReaderSwap(GPU, SLOT, rd, "first");
        uint256 eta1 = block.timestamp + 2 * uint256(P.day);
        vm.warp(eta1 + _w()); // the old deadline second: still live, re-queue refused
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, id));
        ix.queueReaderSwap(GPU, SLOT, rd, "second");
        vm.warp(eta1 + _w() + 1); // dead now: a re-queue restarts the timelock
        vm.prank(owner);
        ix.queueReaderSwap(GPU, SLOT, rd, "second");
        uint256 eta2 = block.timestamp + 2 * uint256(P.day);
        assertEq(ix.queuedEta(id), eta2);
        vm.warp(eta2 - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, uint64(eta2)));
        ix.executeReaderSwap(GPU, SLOT, rd);
        vm.warp(eta2);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, SLOT, rd);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, SLOT);
        assertEq(h.length, 1);
        assertEq(h[0].reason, "second", "the history carries the live queue's reason, not the dead one's");
    }
}
