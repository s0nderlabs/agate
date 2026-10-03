// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER, ACTION_WINDOW_DAYS} from "../../src/interfaces/IAgateIndex.sol";

/// BUILD-SPEC 4.11 (Oct 3, locked Oct 2 14:04): a queued owner action is executable from eta to
/// eta + ACTION_WINDOW_DAYS * DAY, then dead; no queue wipe on an OWNER rotation. Ported from the p3 prototype
/// (window only). TEST clock unless stated.
contract QueueWindowTest is IndexBase {
    function setUp() public {
        Profile memory p = TEST_P();
        p.epochDay = OCT1 + 20; // Oct 21: Dec 1 can still be queued
        deploy(p, 0);
    }

    function _a(IAgateIndex.ActionKind k, uint8 slot, address addr)
        internal
        pure
        returns (IAgateIndex.Action memory a)
    {
        a.kind = k;
        a.slot = slot;
        a.addr = addr;
    }

    function _slotA(IAgateIndex.ActionKind k, uint8 slot, uint32 day)
        internal
        pure
        returns (IAgateIndex.Action memory a)
    {
        a.kind = k;
        a.gpuId = GPU;
        a.slot = slot;
        a.day = day;
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    function _id(IAgateIndex.Action memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(a));
    }

    function _q(address who, IAgateIndex.Action memory a) internal returns (uint256 eta) {
        vm.prank(who);
        ix.queue(a);
        eta = block.timestamp + 2 * uint256(P.day);
    }

    function _x(address who, IAgateIndex.Action memory a) internal {
        vm.prank(who);
        ix.execute(a);
    }

    // ------------------------------------------------------------------ the window

    function test_window_boundaries() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.ATTESTER, 0, keeper);
        uint256 eta = _q(owner, a);
        assertEq(ix.queuedEta(_id(a)), eta);
        // inside the window a second queue is refused
        vm.warp(eta + _w());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, _id(a)));
        ix.queue(a);
        assertEq(ix.queuedEta(_id(a)), eta, "still live at the last second");
        // one second past the window: expired, the view shows nothing live
        vm.warp(eta + _w() + 1);
        assertEq(ix.queuedEta(_id(a)), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(a), uint64(eta + _w())));
        ix.execute(a);
        // an expired entry may be queued afresh: a new eta and a new 48 h of notice
        uint256 eta2 = _q(owner, a);
        assertEq(ix.queuedEta(_id(a)), eta2);
        vm.warp(eta2 - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, uint64(eta2)));
        ix.execute(a);
        vm.warp(eta2);
        _x(owner, a);
        assertEq(ix.attester(), keeper);
    }

    function test_window_lastSecondExecutes() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.WRITER, 1, keeper);
        uint256 eta = _q(owner, a);
        vm.warp(eta + _w());
        _x(owner, a);
        assertEq(ix.writers()[1], keeper);
    }

    function test_expiredEntryCanBeCancelled() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.GUARDIAN, 1, keeper);
        uint256 eta = _q(owner, a);
        vm.warp(eta + _w() + 1);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ActionCancelled(_id(a));
        vm.prank(owner);
        ix.cancel(a);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, _id(a)));
        ix.cancel(a);
    }

    /// Fuzz: an action executes if and only if eta <= now <= eta + window.
    function testFuzz_executeIffInsideWindow(uint32 after_) public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.ATTESTER, 0, keeper);
        uint256 eta = _q(owner, a);
        uint256 t = eta + bound(uint256(after_), 0, 3 * _w());
        vm.warp(t);
        vm.prank(owner);
        if (t <= eta + _w()) {
            ix.execute(a);
            assertEq(ix.attester(), keeper);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(a), uint64(eta + _w())));
            ix.execute(a);
        }
    }

    // ------------------------------------------------------------------ the stale-action attack, with and without

    /// A spare guardian queued months ago and never used: the old rule let an owner-key thief execute it at once (no
    /// fresh ActionQueued, no 48 h of notice). Now it has expired: the thief must queue again, which the watcher
    /// alerts on, and wait 48 h.
    function test_staleGuardianSwap_needsFreshNotice() public {
        address spare = makeAddr("spareGuardian");
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.GUARDIAN, 0, spare); // replaces the operator's guardian
        uint256 eta = _q(owner, a);
        vm.warp(eta + 30 * uint256(P.day)); // a month later the owner key is stolen
        address thief = owner; // the thief signs with the owner key
        vm.prank(thief);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(a), uint64(eta + _w())));
        ix.execute(a);
        assertEq(ix.guardians()[0], g1, "the operator's guardian stays");
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ActionQueued(_id(a), a, uint64(block.timestamp + 2 * P.day));
        uint256 eta2 = _q(thief, a);
        // the operator (same key) cancels inside the fresh 48 h
        vm.warp(eta2 - 1);
        vm.prank(owner);
        ix.cancel(a);
        assertEq(ix.queuedEta(_id(a)), 0);
    }

    /// A stale WRITER re-appointment un-suspends a key the guardian suspended after the queue. With the window it
    /// cannot be fired a month later.
    function test_staleReappointCannotUndoSuspension() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.WRITER, 1, w2);
        uint256 eta = _q(owner, a);
        vm.warp(eta + 20 * uint256(P.day));
        vm.prank(g1);
        ix.suspend(w2);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(a), uint64(eta + _w())));
        ix.execute(a);
        assertTrue(ix.isSuspended(w2));
    }

    // ------------------------------------------------------------------ rotation (no queue wipe)

    /// An action the old owner queued survives the rotation for the rest of its window, then dies. The
    /// old owner (or its thief) cannot execute or cancel it; the new owner can do either inside the window.
    function test_rotation_oldQueueLivesOnlyInsideWindow() public {
        IAgateIndex.Action memory att2 = _a(IAgateIndex.ActionKind.ATTESTER, 0, keeper);
        uint256 etaA = _q(owner, att2);
        address owner2 = makeAddr("owner2");
        IAgateIndex.Action memory ro = _a(IAgateIndex.ActionKind.OWNER, 0, owner2);
        vm.warp(_q(owner, ro));
        _x(owner, ro);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, owner));
        ix.execute(att2);
        assertEq(ix.queuedEta(_id(att2)), etaA, "inherited, still live");
        vm.warp(etaA + _w() + 1);
        assertEq(ix.queuedEta(_id(att2)), 0, "dead after its window");
        vm.prank(owner2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(att2), uint64(etaA + _w())));
        ix.execute(att2);
    }

    // ------------------------------------------------------------------ things that must still execute

    /// Removal on request: stop reading at once, LIVE_UNTIL at the earliest day after the 48 h. The window never binds
    /// first: DayBegun closes the earliest removal about one DAY after eta, long before eta + window.
    function test_removalOnRequest_unaffected() public {
        uint32 t = today();
        registerSimple(GPU, 5, t);
        uint32 earliest = ix.dayId(uint64(block.timestamp + 2 * P.day)) + 1;
        IAgateIndex.Action memory a = _slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 2, earliest);
        uint256 eta = _q(owner, a);
        assertLe(dStart(earliest), eta + _w(), "the day starts before the window ends");
        vm.warp(dStart(earliest) - 1); // the last second it can still land
        _x(owner, a);
        (, uint32 until) = ix.slotWindow(GPU, 2);
        assertEq(until, earliest);
    }

    /// The rotation itself obeys the window: missed, it is queued again (48 h more), never stuck.
    function test_rotation_missedWindow_requeues() public {
        address owner2 = makeAddr("owner2");
        IAgateIndex.Action memory ro = _a(IAgateIndex.ActionKind.OWNER, 0, owner2);
        uint256 eta = _q(owner, ro);
        vm.warp(eta + _w() + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(ro), uint64(eta + _w())));
        ix.execute(ro);
        vm.warp(_q(owner, ro));
        _x(owner, ro);
        assertEq(ix.owner(), owner2);
    }

    /// The window on the demo clocks (DAY 600 s and 24 s): what a person has to execute in.
    function test_windowOnDemoClocks() public {
        uint256[3] memory days_ = [uint256(86_400), 600, 24];
        for (uint256 i; i < 3; ++i) {
            emit log_named_uint("DAY", days_[i]);
            emit log_named_uint("  window seconds (eta .. eta + window)", ACTION_WINDOW_DAYS * days_[i]);
        }
        Profile memory f = FAST_P();
        deploy(f, 0);
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.ATTESTER, 0, keeper);
        uint256 eta = _q(owner, a);
        vm.warp(eta + ACTION_WINDOW_DAYS * uint256(f.day));
        _x(owner, a);
        assertEq(ix.attester(), keeper);
    }
}
