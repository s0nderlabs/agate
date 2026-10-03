// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, ACTION_WINDOW_DAYS, READER_SWAP_TAG} from "../../src/interfaces/IAgateIndex.sol";

/// Audit (contract and security lens): the view the guardian filters on (queuedEta) against what execute
/// actually allows, the reason of a re-queued swap, and swaps executed at day edges and during a pending day.
contract QueueSwapAuditTest is IndexBase {
    string internal constant URL = "https://lambda.ai/service/gpu-cloud";
    string internal constant PV = "lambda/2";

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
    }

    function _rd() internal pure returns (IAgateIndex.Reader memory r) {
        r.url = URL;
        r.parserVersion = PV;
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    /// For any time after queueing: queuedEta != 0 exactly while the entry can still execute or is waiting, execute
    /// succeeds exactly inside [eta, eta + window], and past the window a fresh queue restarts the full timelock.
    function testFuzz_queuedEtaMatchesExecute(uint32 dt, bool swap) public {
        vm.warp(T0 + 77);
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.ATTESTER;
        a.addr = keeper;
        IAgateIndex.Reader memory r = _rd();
        vm.prank(owner);
        bytes32 id = swap ? ix.queueReaderSwap(GPU, 2, r, "audit") : ix.queue(a);
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        uint256 t = block.timestamp + bound(uint256(dt), 0, 2 * uint256(P.day) + 2 * _w());
        vm.warp(t);
        uint64 shown = ix.queuedEta(id);
        assertEq(shown != 0, t <= eta + _w(), "queuedEta live iff not past the window");
        if (shown != 0) assertEq(shown, eta);
        vm.prank(owner);
        (bool ok,) = swap
            ? address(ix).call(abi.encodeCall(IAgateIndex.executeReaderSwap, (GPU, 2, r)))
            : address(ix).call(abi.encodeCall(IAgateIndex.execute, (a)));
        assertEq(ok, eta <= t && t <= eta + _w(), "execute iff inside the window");
        if (ok) {
            assertEq(ix.queuedEta(id), 0, "cleared by the execute");
            return;
        }
        if (t > eta + _w()) {
            vm.prank(owner);
            bytes32 id2 = swap ? ix.queueReaderSwap(GPU, 2, r, "audit again") : ix.queue(a);
            assertEq(id2, id);
            assertEq(ix.queuedEta(id), t + 2 * uint256(P.day), "a dead entry is queued afresh with a full timelock");
        }
    }

    /// A live swap's reason cannot be replaced (AlreadyQueued); an expired one queued afresh carries the new reason
    /// into the event and the history.
    function test_requeuedSwap_carriesTheNewReason() public {
        IAgateIndex.Reader memory r = _rd();
        vm.prank(owner);
        bytes32 id = ix.queueReaderSwap(GPU, 3, r, "first reason");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, id));
        ix.queueReaderSwap(GPU, 3, r, "a swapped-in reason");
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        vm.warp(eta + _w() + 1);
        uint64 eta2 = uint64(block.timestamp + 2 * uint256(P.day));
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapQueued(id, GPU, 3, URL, PV, "second reason", eta2);
        vm.prank(owner);
        ix.queueReaderSwap(GPU, 3, r, "second reason");
        vm.warp(eta2);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 3, r);
        assertEq(ix.readerHistory(GPU, 3)[0].reason, "second reason");
    }

    /// Executed in the day's very last second: from the day after next. Executed after a day ended but while that day
    /// is still open for reposts (GRACE): neither that day nor today changes reader.
    function test_dayEdges_andPendingDay() public {
        IAgateIndex.Reader memory r = _rd();
        vm.prank(owner);
        ix.queueReaderSwap(GPU, 0, r, "edge");
        vm.prank(owner);
        ix.queueReaderSwap(GPU, 1, r, "grace");
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        uint32 d = ix.dayId(uint64(eta));
        vm.warp(dEnd(d) - 1);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 0, r);
        assertEq(ix.readerHistory(GPU, 0)[0].fromDay, d + 2);
        // the next day, first second: day d is ended but nobody closed it (pending, still taking reposts)
        vm.warp(dEnd(d));
        assertEq(today(), d + 1);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 1, r);
        assertEq(ix.readerHistory(GPU, 1)[0].fromDay, d + 2);
        (bool s0,) = ix.readerAt(GPU, 1, d);
        (bool s1,) = ix.readerAt(GPU, 1, d + 1);
        (bool s2,) = ix.readerAt(GPU, 1, d + 2);
        assertFalse(s0);
        assertFalse(s1);
        assertTrue(s2);
    }

    /// The two id spaces cannot meet: an Action encodes to six words, a swap id's preimage to four.
    function test_idPreimagesDiffer() public pure {
        IAgateIndex.Action memory a;
        assertEq(abi.encode(a).length, 192);
        assertEq(abi.encode(READER_SWAP_TAG, GPU, uint8(0), bytes32(0)).length, 128);
    }
}
