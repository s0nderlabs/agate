// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER} from "../../src/interfaces/IAgateIndex.sol";

contract OwnerTest is IndexBase {
    function setUp() public {
        Profile memory p = TEST_P();
        p.epochDay = OCT1 + 20; // Oct 21: a 1st of a month is near
        deploy(p, 0);
    }

    function _a(IAgateIndex.ActionKind k, uint8 slot, address addr) internal pure returns (IAgateIndex.Action memory a) {
        a.kind = k;
        a.slot = slot;
        a.addr = addr;
    }

    function _slotA(IAgateIndex.ActionKind k, uint8 slot, uint32 day) internal pure returns (IAgateIndex.Action memory a) {
        a.kind = k;
        a.gpuId = GPU;
        a.slot = slot;
        a.day = day;
    }

    function _queue(IAgateIndex.Action memory a) internal returns (bytes32 id) {
        vm.prank(owner);
        id = ix.queue(a);
    }

    function _exec(IAgateIndex.Action memory a) internal {
        vm.prank(owner);
        ix.execute(a);
    }

    function _queueExec(IAgateIndex.Action memory a) internal {
        _queue(a);
        vm.warp(block.timestamp + 2 * P.day);
        _exec(a);
    }

    function _execReverts(IAgateIndex.Action memory a, bytes memory err) internal {
        _queue(a);
        vm.warp(block.timestamp + 2 * P.day);
        vm.prank(owner);
        vm.expectRevert(err);
        ix.execute(a);
        vm.prank(owner);
        ix.cancel(a);
    }

    function _queueReverts(IAgateIndex.Action memory a, bytes memory err) internal {
        vm.prank(owner);
        vm.expectRevert(err);
        ix.queue(a);
    }

    // ------------------------------------------------------------------ registerGpu

    function _reg(bytes32 id, uint8[] memory fam, uint8[] memory q, uint32 first, uint32 mask) internal {
        vm.prank(owner);
        ix.registerGpu(id, keccak256("r"), fam, q, first, mask);
    }

    function _regReverts(bytes32 id, uint8[] memory fam, uint8[] memory q, uint32 first, uint32 mask, bytes memory e)
        internal
    {
        vm.prank(owner);
        vm.expectRevert(e);
        ix.registerGpu(id, keccak256("r"), fam, q, first, mask);
    }

    function _seq(uint256 n) internal pure returns (uint8[] memory f) {
        f = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            f[i] = uint8(i);
        }
    }

    function _ones(uint256 n) internal pure returns (uint8[] memory q) {
        q = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            q[i] = 1;
        }
    }

    function test_register_checks() public {
        uint32 t = today();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, stranger));
        ix.registerGpu(GPU, 0, _seq(3), _ones(3), t, 7);
        _regReverts(bytes32(0), _seq(3), _ones(3), t, 7, abi.encodeWithSelector(IAgateIndex.GpuExists.selector, bytes32(0)));
        _regReverts(GPU, _seq(0), _ones(1), t, 1, abi.encodeWithSelector(IAgateIndex.BadSlots.selector));
        _regReverts(GPU, _seq(16), _ones(16), t, 1, abi.encodeWithSelector(IAgateIndex.BadSlots.selector));
        _regReverts(GPU, _seq(3), _ones(3), t, 8, abi.encodeWithSelector(IAgateIndex.BadSlots.selector));
        _regReverts(GPU, _seq(3), _ones(0), t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector));
        _regReverts(GPU, _seq(3), _ones(2), t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector)); // family 2
        _regReverts(GPU, _seq(3), _ones(4), t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector)); // empty family
        uint8[] memory twoFam = new uint8[](3);
        twoFam[2] = 1;
        _regReverts(GPU, twoFam, _ones(2), t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector)); // 2 < Q_MIN 3
        uint8[] memory q0 = _ones(3);
        q0[1] = 0;
        _regReverts(GPU, _seq(3), q0, t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector));
        uint8[] memory q2 = _ones(3);
        q2[1] = 2; // famQ above the family's slot count
        _regReverts(GPU, _seq(3), q2, t, 7, abi.encodeWithSelector(IAgateIndex.BadFamilies.selector));
        _regReverts(GPU, _seq(3), _ones(3), t + 32, 7, abi.encodeWithSelector(IAgateIndex.FirstDayOutOfRange.selector, t + 32));
        _regReverts(GPU, _seq(3), _ones(3), t - 1, 7, abi.encodeWithSelector(IAgateIndex.FirstDayOutOfRange.selector, t - 1)); // before EPOCH_DAY
        _regReverts(GPU, _seq(3), _ones(3), t, 0, abi.encodeWithSelector(IAgateIndex.NothingLive.selector));
        // 15 slots, a 3-slot tracker family with famQ 3, edge of the range
        uint8[] memory f15 = new uint8[](15);
        for (uint256 i; i < 15; ++i) {
            f15[i] = i < 3 ? 0 : uint8(i - 2);
        }
        uint8[] memory q13 = _ones(13);
        q13[0] = 3;
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.GpuRegistered(GPU, keccak256("r"), t + 31, f15, q13, 0x7fff);
        _reg(GPU, f15, q13, t + 31, 0x7fff);
        IAgateIndex.GpuConfig memory c = ix.gpu(GPU);
        assertEq(c.nSlots, 15);
        assertEq(c.nFamilies, 13);
        assertEq(c.firstDay, t + 31);
        assertEq(c.head, t + 31);
        assertEq(c.registeredAt, block.timestamp);
        assertEq(c.lastCarryAt, block.timestamp);
        (uint8 fam, uint8 fq) = ix.familyOf(GPU, 1);
        assertEq(fam, 0);
        assertEq(fq, 3);
        (uint32 lf, uint32 lu) = ix.slotWindow(GPU, 14);
        assertEq(lf, t + 31);
        assertEq(lu, NEVER);
        (IAgateIndex.SlotState[] memory b, IAgateIndex.SlotState[] memory l) = ix.slotStates(GPU);
        assertEq(b.length, 15);
        assertEq(l[14].miss, 6);
        assertFalse(l[14].inMedian || l[14].wasIn);
        _regReverts(GPU, _seq(3), _ones(3), t, 7, abi.encodeWithSelector(IAgateIndex.GpuExists.selector, GPU));
    }

    function test_register_firstDayWindow_past() public {
        // 40 days later: firstDay may be up to 31 days in the past
        vm.warp(block.timestamp + 40 * uint256(P.day));
        uint32 t = today();
        _regReverts(GPU, _seq(3), _ones(3), t - 32, 7, abi.encodeWithSelector(IAgateIndex.FirstDayOutOfRange.selector, t - 32));
        _reg(GPU, _seq(3), _ones(3), t - 31, 5);
        (uint32 lf,) = ix.slotWindow(GPU, 1);
        assertEq(lf, NEVER, "reserved");
    }

    // ------------------------------------------------------------------ the queue

    function test_queue_timelock_cancel_events() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.ATTESTER, 0, keeper);
        bytes32 id = keccak256(abi.encode(a));
        assertEq(ix.actionId(a), id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, stranger));
        ix.queue(a);
        uint64 eta = uint64(block.timestamp + 2 * P.day);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ActionQueued(id, a, eta);
        assertEq(_queue(a), id);
        assertEq(ix.queuedEta(id), eta);
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, id));
        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, eta));
        ix.execute(a);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, stranger));
        ix.execute(a);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, stranger));
        ix.cancel(a);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ActionCancelled(id);
        vm.prank(owner);
        ix.cancel(a);
        assertEq(ix.queuedEta(id), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, id));
        ix.cancel(a);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, id));
        ix.execute(a);
        // queue again, execute exactly at eta
        _queue(a);
        eta = uint64(block.timestamp + 2 * P.day);
        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ActionExecuted(id, a);
        _exec(a);
        assertEq(ix.attester(), keeper);
        assertEq(ix.queuedEta(id), 0, "cleared");
    }

    function test_badAction_unusedFields() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.ATTESTER, 1, keeper);
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.BadAction.selector));
        a = _a(IAgateIndex.ActionKind.OWNER, 0, keeper);
        a.day = 1;
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.BadAction.selector));
        a = _a(IAgateIndex.ActionKind.WRITER, 0, keeper);
        a.mode = IAgateIndex.WriterMode.WORKFLOW_OWNER;
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.BadAction.selector));
        a = _slotA(IAgateIndex.ActionKind.LIVE_FROM, 0, NOV1);
        a.addr = keeper;
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.BadAction.selector));
        a = _a(IAgateIndex.ActionKind.FORWARDER, 1, keeper);
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.BadAction.selector));
    }

    function test_writer_checksAndApply() public {
        _queueReverts(_a(IAgateIndex.ActionKind.WRITER, 2, keeper), abi.encodeWithSelector(IAgateIndex.BadSlot.selector, 2));
        _execReverts(_a(IAgateIndex.ActionKind.WRITER, 1, att), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, att));
        _execReverts(_a(IAgateIndex.ActionKind.WRITER, 1, w1), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, w1));
        _execReverts(_a(IAgateIndex.ActionKind.WRITER, 1, owner), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, owner));
        _execReverts(_a(IAgateIndex.ActionKind.WRITER, 1, g2), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, g2));
        vm.etch(keeper, abi.encodePacked(hex"ef0100", address(0xdead)));
        _execReverts(_a(IAgateIndex.ActionKind.WRITER, 1, keeper), abi.encodeWithSelector(IAgateIndex.HasCode.selector, keeper));
        vm.etch(keeper, "");
        // re-appointing a suspended writer to its own seat clears the suspension (R6 prefers a new address)
        vm.prank(g1);
        ix.suspend(w2);
        _queueExec(_a(IAgateIndex.ActionKind.WRITER, 1, w2));
        assertFalse(ix.isSuspended(w2));
        // a new standby
        vm.prank(g1);
        ix.suspend(w2);
        _queueExec(_a(IAgateIndex.ActionKind.WRITER, 1, keeper));
        assertEq(ix.writers()[1], keeper);
        // removal
        _queueExec(_a(IAgateIndex.ActionKind.WRITER, 1, address(0)));
        assertEq(ix.writers()[1], address(0));
        vm.prank(g1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAWriter.selector, keeper));
        ix.suspend(keeper);
    }

    function test_attesterAndGuardian_apply() public {
        _execReverts(_a(IAgateIndex.ActionKind.ATTESTER, 0, g1), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, g1));
        _queueReverts(_a(IAgateIndex.ActionKind.GUARDIAN, 3, keeper), abi.encodeWithSelector(IAgateIndex.BadSlot.selector, 3));
        _execReverts(_a(IAgateIndex.ActionKind.GUARDIAN, 1, w2), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, w2));
        _execReverts(_a(IAgateIndex.ActionKind.GUARDIAN, 0, g2), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, g2));
        _queueExec(_a(IAgateIndex.ActionKind.GUARDIAN, 1, keeper));
        assertEq(ix.guardians()[1], keeper);
        vm.prank(keeper);
        ix.suspend(w2);
        vm.prank(g2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, g2));
        ix.suspend(w2);
        _queueExec(_a(IAgateIndex.ActionKind.ATTESTER, 0, address(0)));
        assertEq(ix.attester(), address(0));
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAttesterOrGuardian.selector, address(0)));
        ix.attest(GPU, 0, w1, 0);
    }

    function test_forwarder_apply() public {
        IAgateIndex.Action memory a = _a(IAgateIndex.ActionKind.FORWARDER, 0, keeper);
        a.mode = IAgateIndex.WriterMode.WORKFLOW_OWNER;
        _queueExec(a);
        (address f, IAgateIndex.WriterMode m) = ix.forwarder();
        assertEq(f, keeper);
        assertEq(uint8(m), 1);
    }

    function test_owner_rotation() public {
        _queueReverts(_a(IAgateIndex.ActionKind.OWNER, 0, address(0)), abi.encodeWithSelector(IAgateIndex.ZeroAddress.selector));
        _queueReverts(_a(IAgateIndex.ActionKind.OWNER, 0, att), abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, att));
        address newOwner = makeAddr("newOwner");
        // a role taken between queue and execute is caught at execute
        _queue(_a(IAgateIndex.ActionKind.OWNER, 0, newOwner));
        _queue(_a(IAgateIndex.ActionKind.ATTESTER, 0, newOwner));
        vm.warp(block.timestamp + 2 * P.day);
        _exec(_a(IAgateIndex.ActionKind.ATTESTER, 0, newOwner));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.RoleTaken.selector, newOwner));
        ix.execute(_a(IAgateIndex.ActionKind.OWNER, 0, newOwner));
        address other = makeAddr("other");
        _queueExec(_a(IAgateIndex.ActionKind.OWNER, 0, other));
        assertEq(ix.owner(), other);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, owner));
        ix.queue(_a(IAgateIndex.ActionKind.ATTESTER, 0, keeper));
        // the owner may be a contract
        vm.etch(other, hex"00");
        vm.prank(other);
        ix.queue(_a(IAgateIndex.ActionKind.ATTESTER, 0, keeper));
    }

    function test_liveFrom_checks() public {
        uint32 t = today(); // Oct 21
        _reg(GPU, _seq(4), _ones(4), t, 0x7); // slot 3 reserved
        IAgateIndex.Action memory a = _slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, DEC1);
        a.gpuId = GPU2;
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, GPU2));
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_FROM, 4, DEC1), abi.encodeWithSelector(IAgateIndex.BadSlot.selector, 4));
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_FROM, 0, DEC1), abi.encodeWithSelector(IAgateIndex.SlotAlreadyStarted.selector, 0));
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, DEC1 + 1), abi.encodeWithSelector(IAgateIndex.LiveFromNotFirstOfMonth.selector, DEC1 + 1));
        // Nov 1 needs queueing before Oct 1: too late
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, NOV1), abi.encodeWithSelector(IAgateIndex.LiveFromTooLate.selector, NOV1));
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, 0), abi.encodeWithSelector(IAgateIndex.LiveFromTooLate.selector, 0));
        // Dec 1 queued on Oct 21 (before Nov 1): fine
        IAgateIndex.Action memory ok = _slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, DEC1);
        _queue(ok);
        // the last second of Oct 31 still queues Dec 1; Nov 1 does not
        vm.prank(owner);
        ix.cancel(ok);
        vm.warp(dStart(NOV1) - 1);
        _queue(ok);
        vm.prank(owner);
        ix.cancel(ok);
        vm.warp(dStart(NOV1));
        _queueReverts(ok, abi.encodeWithSelector(IAgateIndex.LiveFromTooLate.selector, DEC1));
    }

    function test_liveFrom_executeDayBegunAndApply() public {
        uint32 t = today();
        _reg(GPU, _seq(4), _ones(4), t, 0x7);
        IAgateIndex.Action memory a = _slotA(IAgateIndex.ActionKind.LIVE_FROM, 3, DEC1);
        _queue(a);
        // executed late: Dec 1 has begun
        vm.warp(dStart(DEC1));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.DayBegun.selector, DEC1));
        ix.execute(a);
        vm.warp(dStart(DEC1) - 1);
        _exec(a);
        (uint32 lf, uint32 lu) = ix.slotWindow(GPU, 3);
        assertEq(lf, DEC1);
        assertEq(lu, NEVER);
        // a second LIVE_FROM for the same slot is refused (validated again at execute too)
        _queueReverts(a, abi.encodeWithSelector(IAgateIndex.SlotAlreadyStarted.selector, 3));
    }

    function test_liveUntil_checks() public {
        uint32 t = today();
        _reg(GPU, _seq(4), _ones(4), t, 0x7);
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 3, t + 10), abi.encodeWithSelector(IAgateIndex.SlotWindowNotOpen.selector, 3));
        uint32 earliest = ix.dayId(uint64(block.timestamp + 2 * P.day)) + 1;
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 1, earliest - 1), abi.encodeWithSelector(IAgateIndex.LiveUntilTooEarly.selector, earliest - 1));
        IAgateIndex.Action memory a = _slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 1, earliest);
        _queue(a);
        vm.warp(block.timestamp + 2 * P.day);
        _exec(a);
        (, uint32 lu) = ix.slotWindow(GPU, 1);
        assertEq(lu, earliest);
        _queueReverts(_slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 1, earliest + 5), abi.encodeWithSelector(IAgateIndex.SlotWindowNotOpen.selector, 1));
        // DayBegun at execute
        IAgateIndex.Action memory b = _slotA(IAgateIndex.ActionKind.LIVE_UNTIL, 2, today() + 3);
        _queue(b);
        vm.warp(dStart(today() + 3));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.DayBegun.selector, b.day));
        ix.execute(b);
    }

    function test_ownerCannotTouchFixes() public {
        uint32 t = today();
        registerSimple(GPU, 5, t);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotAttesterOrGuardian.selector, owner));
        ix.attest(GPU, t, w1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotGuardian.selector, owner));
        ix.veto(GPU, t, w1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, owner));
        ix.postReport("");
        vm.stopPrank();
    }
}
