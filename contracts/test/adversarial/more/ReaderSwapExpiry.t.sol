// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../../Base.t.sol";
import {IAgateIndex, ACTION_WINDOW_DAYS, READER_SWAP_TAG} from "../../../src/interfaces/IAgateIndex.sol";

/// Recheck r2: two reader-swap properties the existing suite does not assert directly (BUILD-SPEC
/// 4.15): (1) an expired-but-never-cancelled swap leaves NO reader side effect (history and readerAt stay empty) and
/// reports queuedEta 0 at the exact deadline second + 1, and re-queueing after expiry then executing produces one
/// entry whose fromDay is the EXECUTION day, never the first queue's; (2) the SAME reader (url + parserVersion) may be
/// swapped onto a slot twice over time, since an executed swap frees its id to be queued afresh, yielding two history
/// entries with the same readerHash and strictly increasing fromDay.
contract ReaderSwapExpiryTest is IndexBase {
    string internal constant URL = "https://lambda.ai/service/gpu-cloud";
    string internal constant PV = "lambda/2";

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
    }

    function _rd(string memory url, string memory pv) internal pure returns (IAgateIndex.Reader memory r) {
        r.url = url;
        r.parserVersion = pv;
    }

    function _id(uint8 slot, IAgateIndex.Reader memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(READER_SWAP_TAG, GPU, slot, keccak256(abi.encode(r.url, r.parserVersion))));
    }

    function _q(uint8 slot, IAgateIndex.Reader memory r, string memory why) internal returns (uint256 eta) {
        vm.prank(owner);
        ix.queueReaderSwap(GPU, slot, r, why);
        eta = block.timestamp + 2 * uint256(P.day);
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    /// Expiry is not execution: a swap whose window passed unexecuted leaves the slot's reader history untouched, and
    /// a re-queue after expiry carries the later execution day as fromDay.
    function test_expiryLeavesNoReader_requeueUsesLaterDay() public {
        IAgateIndex.Reader memory r = _rd(URL, PV);
        uint256 eta = _q(3, r, "first attempt");
        bytes32 id = _id(3, r);

        // the exact deadline second still shows the entry; one second past it, queuedEta is 0 and execute is refused
        vm.warp(eta + _w());
        assertEq(ix.queuedEta(id), eta, "live on the deadline second");
        vm.warp(eta + _w() + 1);
        assertEq(ix.queuedEta(id), 0, "dead one second past the window");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, id, uint64(eta + _w())));
        ix.executeReaderSwap(GPU, 3, r);

        // the expiry left no reader: history empty, readerAt false for every day
        assertEq(ix.readerHistory(GPU, 3).length, 0, "no reader from an expired swap");
        (bool sw,) = ix.readerAt(GPU, 3, type(uint32).max);
        assertFalse(sw, "readerAt empty after expiry");

        // re-queue well after expiry and execute: exactly one entry, fromDay = the execution day + 1 (not the first
        // queue's), strictly after the first queue's would-be day
        uint256 eta2 = _q(3, r, "second attempt");
        assertGt(eta2, eta + _w(), "the re-queue is a fresh 48 h timelock, long after the old window");
        vm.warp(eta2);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 3, r);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 3);
        assertEq(h.length, 1, "one entry");
        assertEq(h[0].fromDay, ix.dayId(uint64(eta2 + ix.clocks().slice)) + 1, "fromDay is the execution day's next start");
        assertEq(h[0].reason, "second attempt", "the executed swap's reason, not the expired one's");
        assertGt(uint256(h[0].fromDay), ix.dayId(uint64(eta)), "later than the first queue's day");
    }

    /// The same reader may be re-applied to a slot later: executing frees the id, so queueing it again and executing
    /// on a later day adds a second history entry with the identical readerHash and a greater fromDay.
    function test_sameReaderSwappedTwice() public {
        IAgateIndex.Reader memory r = _rd(URL, PV);
        bytes32 hash = keccak256(abi.encode(r.url, r.parserVersion));

        uint256 eta1 = _q(2, r, "apply v2");
        vm.warp(eta1);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 2, r);
        uint32 f1 = ix.readerHistory(GPU, 2)[0].fromDay;

        // the id is free again (queuedEta 0, no AlreadyQueued); queue and execute the SAME reader on a later day
        assertEq(ix.queuedEta(_id(2, r)), 0, "the executed id is free");
        vm.warp(dStart(f1) + 7);
        uint256 eta2 = _q(2, r, "re-apply v2 after a page revert");
        vm.warp(eta2);
        vm.prank(owner);
        ix.executeReaderSwap(GPU, 2, r);

        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 2);
        assertEq(h.length, 2, "two entries for the same reader over time");
        assertEq(h[0].readerHash, hash);
        assertEq(h[1].readerHash, hash, "identical readerHash");
        assertGt(uint256(h[1].fromDay), uint256(h[0].fromDay), "strictly increasing fromDay");
        assertEq(h[1].reason, "re-apply v2 after a page revert");
        // readerAt resolves to the newest entry at or before a day
        (bool sw, IAgateIndex.ReaderVersion memory v) = ix.readerAt(GPU, 2, h[1].fromDay);
        assertTrue(sw);
        assertEq(v.reason, "re-apply v2 after a page revert");
        (, v) = ix.readerAt(GPU, 2, h[1].fromDay - 1);
        assertEq(v.reason, "apply v2", "the day before the second swap still reads the first");
    }
}
