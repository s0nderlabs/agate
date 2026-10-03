// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex, NEVER, ACTION_WINDOW_DAYS, READER_SWAP_TAG} from "../../src/interfaces/IAgateIndex.sol";

/// BUILD-SPEC 4.15 (Oct 3, locked Oct 2 13:46): the timelocked reader swap of one slot. Public at queue (url,
/// parserVersion, reason), executable from eta to eta + 14 DAY, effective from fromDay = dayId(now + slice) + 1,
/// recorded days untouched, history onchain. TEST clock (DAY 2,400 s, 12 slices of 200 s) unless stated.
contract ReaderSwapTest is IndexBase {
    string internal constant URL = "https://lambda.ai/service/gpu-cloud";
    string internal constant PV = "lambda/2";
    string internal constant WHY = "pricing page redesigned Oct 9; v1 reads no row since 06 UTC";

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
    }

    // ------------------------------------------------------------------ helpers

    function _rd(string memory url, string memory pv) internal pure returns (IAgateIndex.Reader memory r) {
        r.url = url;
        r.parserVersion = pv;
    }

    function _rd() internal pure returns (IAgateIndex.Reader memory) {
        return _rd(URL, PV);
    }

    function _hash(IAgateIndex.Reader memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(r.url, r.parserVersion));
    }

    function _id(uint8 slot, IAgateIndex.Reader memory r) internal pure returns (bytes32) {
        return keccak256(abi.encode(READER_SWAP_TAG, GPU, slot, _hash(r)));
    }

    function _q(uint8 slot, IAgateIndex.Reader memory r, string memory why) internal returns (uint256 eta) {
        vm.prank(owner);
        ix.queueReaderSwap(GPU, slot, r, why);
        eta = block.timestamp + 2 * uint256(P.day);
    }

    function _x(uint8 slot, IAgateIndex.Reader memory r) internal {
        vm.prank(owner);
        ix.executeReaderSwap(GPU, slot, r);
    }

    function _w() internal view returns (uint256) {
        return ACTION_WINDOW_DAYS * uint256(P.day);
    }

    function _from(uint256 t) internal view returns (uint32) {
        return ix.dayId(uint64(t + slice())) + 1;
    }

    function _bytes(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "a";
        }
        return string(b);
    }

    function _url(uint256 n) internal pure returns (string memory) {
        return string.concat("https://", _bytes(n - 8));
    }

    function _qReverts(bytes32 gpuId, uint8 slot, IAgateIndex.Reader memory r, string memory why, bytes memory err)
        internal
    {
        vm.prank(owner);
        vm.expectRevert(err);
        ix.queueReaderSwap(gpuId, slot, r, why);
    }

    // ------------------------------------------------------------------ queue, execute, cancel

    function test_readerSwap_queueEmitsReaderAndReason() public {
        vm.warp(T0 + 100);
        IAgateIndex.Reader memory r = _rd();
        uint64 eta = uint64(block.timestamp + 2 * uint256(P.day));
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapQueued(_id(3, r), GPU, 3, URL, PV, WHY, eta);
        vm.prank(owner);
        bytes32 id = ix.queueReaderSwap(GPU, 3, r, WHY);
        assertEq(id, _id(3, r));
        assertEq(ix.queuedEta(id), eta);
        assertEq(ix.clocks().timelock, 2 * P.day);
        // nothing applies before the execute
        assertEq(ix.readerHistory(GPU, 3).length, 0);
        (bool sw,) = ix.readerAt(GPU, 3, type(uint32).max);
        assertFalse(sw);
    }

    function test_readerSwap_executeAfterTimelock_effectiveNextDay() public {
        vm.warp(T0 + 100);
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(3, r, WHY);
        vm.warp(eta);
        uint32 d = today();
        assertEq(d, OCT1 + 2);
        assertLt(block.timestamp, dEnd(d) - slice(), "not in the last slice");
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapped(_id(3, r), GPU, 3, d + 1, _hash(r), URL, PV, WHY);
        _x(3, r);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 3);
        assertEq(h.length, 1);
        assertEq(h[0].fromDay, d + 1);
        assertEq(h[0].executedAt, uint64(eta));
        assertEq(h[0].readerHash, _hash(r));
        assertEq(h[0].url, URL);
        assertEq(h[0].parserVersion, PV);
        assertEq(h[0].reason, WHY);
        assertEq(ix.queuedEta(_id(3, r)), 0, "cleared");
        (bool sw,) = ix.readerAt(GPU, 3, d);
        assertFalse(sw, "never mid-day: today keeps the old reader");
        (bool sw2, IAgateIndex.ReaderVersion memory v) = ix.readerAt(GPU, 3, d + 1);
        assertTrue(sw2);
        assertEq(v.url, URL);
        // executed once: a second execute finds nothing queued
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, _id(3, r)));
        ix.executeReaderSwap(GPU, 3, r);
    }

    /// fromDay = dayId(now + slice) + 1: a second before the day's last slice, the next day; inside it, the day after.
    function test_readerSwap_lastSlice_effectiveDayAfter() public {
        vm.warp(T0 + 100);
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(0, r, WHY);
        _q(1, r, WHY);
        uint32 d = ix.dayId(uint64(eta));
        vm.warp(dEnd(d) - slice() - 1);
        _x(0, r);
        assertEq(ix.readerHistory(GPU, 0)[0].fromDay, d + 1);
        vm.warp(dEnd(d) - slice());
        _x(1, r);
        assertEq(ix.readerHistory(GPU, 1)[0].fromDay, d + 2);
    }

    /// Fuzz: executable iff eta <= now <= eta + window; fromDay starts after today, at least one slice after now.
    function testFuzz_readerSwap_windowAndFromDay(uint32 after_, uint16 start) public {
        vm.warp(T0 + bound(uint256(start), 0, P.day - 1));
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(2, r, WHY);
        uint256 t = eta + bound(uint256(after_), 0, 2 * _w());
        vm.warp(t);
        vm.prank(owner);
        if (t > eta + _w()) {
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(2, r), uint64(eta + _w())));
            ix.executeReaderSwap(GPU, 2, r);
            return;
        }
        ix.executeReaderSwap(GPU, 2, r);
        uint32 f = ix.readerHistory(GPU, 2)[0].fromDay;
        assertEq(f, _from(t));
        assertGt(f, today());
        assertGe(dStart(f), t + slice() + 1, "a full slice of notice");
        assertLe(dStart(f), t + slice() + P.day);
    }

    function test_readerSwap_timelockActive_reverts() public {
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(3, r, WHY);
        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, uint64(eta)));
        ix.executeReaderSwap(GPU, 3, r);
        vm.warp(eta);
        _x(3, r);
        assertEq(ix.readerHistory(GPU, 3).length, 1);
    }

    function test_readerSwap_expires_andRequeues() public {
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(3, r, WHY);
        bytes32 id = _id(3, r);
        // the deadline second itself still executes
        uint256 snap = vm.snapshotState();
        vm.warp(eta + _w());
        assertEq(ix.queuedEta(id), eta);
        _x(3, r);
        vm.revertToState(snap);
        // one second later it is dead
        vm.warp(eta + _w() + 1);
        assertEq(ix.queuedEta(id), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, id, uint64(eta + _w())));
        ix.executeReaderSwap(GPU, 3, r);
        // queued afresh: a new eta, a new 48 h of notice, the new reason
        uint64 eta2 = uint64(block.timestamp + 2 * uint256(P.day));
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapQueued(id, GPU, 3, URL, PV, "second try", eta2);
        _q(3, r, "second try");
        assertEq(ix.queuedEta(id), eta2);
        vm.warp(eta2 - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, eta2));
        ix.executeReaderSwap(GPU, 3, r);
        vm.warp(eta2);
        _x(3, r);
        assertEq(ix.readerHistory(GPU, 3)[0].reason, "second try");
    }

    function test_readerSwap_cancel_liveAndExpired() public {
        IAgateIndex.Reader memory r = _rd();
        bytes32 id = _id(3, r);
        // live
        _q(3, r, WHY);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapCancelled(id, GPU, 3);
        vm.prank(owner);
        ix.cancelReaderSwap(GPU, 3, r);
        assertEq(ix.queuedEta(id), 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, id));
        ix.cancelReaderSwap(GPU, 3, r);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, id));
        ix.executeReaderSwap(GPU, 3, r);
        // expired
        uint256 eta = _q(3, r, "again");
        vm.warp(eta + _w() + 1);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReaderSwapCancelled(id, GPU, 3);
        vm.prank(owner);
        ix.cancelReaderSwap(GPU, 3, r);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, id));
        ix.cancelReaderSwap(GPU, 3, r);
        // the cancelled reason never reaches a later swap of the same id
        eta = _q(3, r, "third");
        vm.warp(eta);
        _x(3, r);
        assertEq(ix.readerHistory(GPU, 3)[0].reason, "third");
        assertEq(ix.readerHistory(GPU, 3).length, 1);
    }

    function test_readerSwap_onlyOwner() public {
        IAgateIndex.Reader memory r = _rd();
        address[6] memory who = [stranger, w1, w2, att, g1, keeper];
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, who[i]));
            ix.queueReaderSwap(GPU, 3, r, WHY);
            vm.stopPrank();
        }
        uint256 eta = _q(3, r, WHY);
        vm.warp(eta);
        for (uint256 i; i < who.length; ++i) {
            vm.startPrank(who[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, who[i]));
            ix.executeReaderSwap(GPU, 3, r);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, who[i]));
            ix.cancelReaderSwap(GPU, 3, r);
            vm.stopPrank();
        }
        assertEq(ix.queuedEta(_id(3, r)), eta);
    }

    function test_readerSwap_badInputs() public {
        bytes memory bad = abi.encodeWithSelector(IAgateIndex.BadReader.selector);
        bytes32 unknown = keccak256("A100-SXM/on-demand-list/neocloud/v1");
        _qReverts(unknown, 0, _rd(), WHY, abi.encodeWithSelector(IAgateIndex.UnknownGpu.selector, unknown));
        _qReverts(GPU, 5, _rd(), WHY, abi.encodeWithSelector(IAgateIndex.BadSlot.selector, uint8(5)));
        _qReverts(GPU, 255, _rd(), WHY, abi.encodeWithSelector(IAgateIndex.BadSlot.selector, uint8(255)));
        // url: empty, "https://" alone (8 bytes), 257 bytes, not https, scheme case
        _qReverts(GPU, 0, _rd("", PV), WHY, bad);
        _qReverts(GPU, 0, _rd("https://", PV), WHY, bad);
        _qReverts(GPU, 0, _rd(_url(257), PV), WHY, bad);
        _qReverts(GPU, 0, _rd("http://lambda.ai/service/gpu-cloud", PV), WHY, bad);
        _qReverts(GPU, 0, _rd("HTTPS://lambda.ai/service/gpu-cloud", PV), WHY, bad);
        _qReverts(GPU, 0, _rd("ftp://lambda.ai/x", PV), WHY, bad);
        // parserVersion: empty, 33 bytes
        _qReverts(GPU, 0, _rd(URL, ""), WHY, bad);
        _qReverts(GPU, 0, _rd(URL, _bytes(33)), WHY, bad);
        // reason: empty, 281 bytes
        _qReverts(GPU, 0, _rd(), "", bad);
        _qReverts(GPU, 0, _rd(), _bytes(281), bad);
        // the boundaries themselves are accepted
        _q(0, _rd("https://a", PV), WHY);
        _q(0, _rd(_url(256), PV), WHY);
        _q(0, _rd(URL, "x"), WHY);
        _q(0, _rd(URL, _bytes(32)), WHY);
        _q(1, _rd(), "y");
        _q(2, _rd(), _bytes(280));
        assertEq(ix.queuedEta(_id(0, _rd(_url(256), PV))), block.timestamp + 2 * uint256(P.day));
    }

    /// Fix round (audit M1): url and parserVersion bytes in 0x21..0x7e, reason bytes in 0x20..0x7e, so no terminal
    /// escape, C1 control, DEL or non-ASCII byte reaches `guardian status` or a repair prompt.
    function test_readerSwap_controlCharacters() public {
        bytes memory bad = abi.encodeWithSelector(IAgateIndex.BadReader.selector);
        string memory esc = string(abi.encodePacked(bytes1(0x1b), "[2J"));
        // url: ESC, space, tab, DEL, a C1 byte (0x9b), a UTF-8 letter
        _qReverts(GPU, 0, _rd(string.concat(URL, esc), PV), WHY, bad);
        _qReverts(GPU, 0, _rd(string.concat(URL, " x"), PV), WHY, bad);
        _qReverts(GPU, 0, _rd(string.concat(URL, "\t"), PV), WHY, bad);
        _qReverts(GPU, 0, _rd(string(abi.encodePacked(URL, bytes1(0x7f))), PV), WHY, bad);
        _qReverts(GPU, 0, _rd(string(abi.encodePacked(URL, bytes1(0x9b))), PV), WHY, bad);
        _qReverts(GPU, 0, _rd(string.concat(URL, unicode"é"), PV), WHY, bad);
        // parserVersion: ESC, space, newline
        _qReverts(GPU, 0, _rd(URL, string.concat("lambda/2", esc)), WHY, bad);
        _qReverts(GPU, 0, _rd(URL, "lambda 2"), WHY, bad);
        _qReverts(GPU, 0, _rd(URL, "lambda/2\n"), WHY, bad);
        // reason: ESC, OSC 52, newline, DEL, a C1 byte; a space is fine
        _qReverts(GPU, 0, _rd(), string.concat("ok ", esc), bad);
        _qReverts(GPU, 0, _rd(), string(abi.encodePacked(bytes1(0x1b), "]52;c;aGk=", bytes1(0x07))), bad);
        _qReverts(GPU, 0, _rd(), "two\nlines", bad);
        _qReverts(GPU, 0, _rd(), string(abi.encodePacked("x", bytes1(0x7f))), bad);
        _qReverts(GPU, 0, _rd(), string(abi.encodePacked("x", bytes1(0x85))), bad);
        // the edges of the printable range are accepted
        _q(0, _rd("https://!~", PV), "a reason with spaces ~ and ! inside");
        _q(1, _rd(URL, "~!/2"), " ");
    }

    function test_readerSwap_alreadyQueued() public {
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(3, r, WHY);
        bytes32 id = _id(3, r);
        // the reason is not part of the id: a second queue with another reason is the same entry
        _qReverts(GPU, 3, r, "another reason", abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, id));
        vm.warp(eta + _w());
        _qReverts(GPU, 3, r, WHY, abi.encodeWithSelector(IAgateIndex.AlreadyQueued.selector, id));
        vm.warp(eta + _w() + 1);
        _q(3, r, WHY);
        // another slot, or another reader of the same slot, is another entry
        _q(4, r, WHY);
        _q(3, _rd(URL, "lambda/3"), WHY);
    }

    /// One swap per slot per fromDay: the history's fromDay strictly increases.
    function test_readerSwap_twoSwapsSameFromDay_reverts() public {
        IAgateIndex.Reader memory a = _rd();
        IAgateIndex.Reader memory b = _rd("https://lambda.ai/pricing", "lambda/3");
        uint256 eta = _q(3, a, WHY);
        _q(3, b, WHY);
        _q(4, b, WHY);
        vm.warp(eta);
        _x(3, a);
        uint32 f = ix.readerHistory(GPU, 3)[0].fromDay;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ReaderSwapPending.selector, GPU, uint8(3), f));
        ix.executeReaderSwap(GPU, 3, b);
        // another slot the same day is fine
        _x(4, b);
        // the same slot from the next day start (a slice before it) gets the next fromDay
        vm.warp(dStart(f) - slice());
        _x(3, b);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 3);
        assertEq(h.length, 2);
        assertEq(h[1].fromDay, f + 1);
        assertEq(h[1].parserVersion, "lambda/3");
    }

    function test_readerSwap_historyAndReaderAt() public {
        IAgateIndex.Reader[3] memory rs =
            [_rd(), _rd("https://lambda.ai/pricing", "lambda/3"), _rd("https://lambda.ai/pricing/v2", "lambda/4")];
        uint32[3] memory f;
        for (uint256 k; k < 3; ++k) {
            uint256 eta = _q(1, rs[k], string.concat("swap ", vm.toString(k)));
            vm.warp(eta);
            _x(1, rs[k]);
            f[k] = ix.readerHistory(GPU, 1)[k].fromDay;
            vm.warp(dStart(f[k]) + 7);
        }
        assertLt(f[0], f[1]);
        assertLt(f[1], f[2]);
        IAgateIndex.ReaderVersion[] memory h = ix.readerHistory(GPU, 1);
        assertEq(h.length, 3);
        for (uint256 k; k < 3; ++k) {
            assertEq(h[k].url, rs[k].url);
            assertEq(h[k].parserVersion, rs[k].parserVersion);
            assertEq(h[k].reason, string.concat("swap ", vm.toString(k)));
            assertEq(h[k].readerHash, _hash(rs[k]));
        }
        // before any swap: the registered recipe's reader
        (bool sw,) = ix.readerAt(GPU, 1, OCT1);
        assertFalse(sw);
        (sw,) = ix.readerAt(GPU, 1, f[0] - 1);
        assertFalse(sw);
        IAgateIndex.ReaderVersion memory v;
        (sw, v) = ix.readerAt(GPU, 1, f[0]);
        assertTrue(sw);
        assertEq(v.parserVersion, "lambda/2");
        (sw, v) = ix.readerAt(GPU, 1, f[1] - 1);
        assertEq(v.parserVersion, "lambda/2");
        (sw, v) = ix.readerAt(GPU, 1, f[1]);
        assertEq(v.parserVersion, "lambda/3");
        (sw, v) = ix.readerAt(GPU, 1, f[2] - 1);
        assertEq(v.parserVersion, "lambda/3");
        (sw, v) = ix.readerAt(GPU, 1, f[2]);
        assertEq(v.parserVersion, "lambda/4");
        (sw, v) = ix.readerAt(GPU, 1, type(uint32).max);
        assertEq(v.parserVersion, "lambda/4");
        // other slots, unknown gpus and slots: empty, never a revert
        (sw,) = ix.readerAt(GPU, 0, type(uint32).max);
        assertFalse(sw);
        (sw,) = ix.readerAt(GPU2, 1, type(uint32).max);
        assertFalse(sw);
        (sw,) = ix.readerAt(GPU, 200, 0);
        assertFalse(sw);
        assertEq(ix.readerHistory(GPU2, 1).length, 0);
        assertEq(ix.readerHistory(GPU, 200).length, 0);
    }

    function test_readerSwap_idIsNotAnActionId() public {
        IAgateIndex.Reader memory r = _rd();
        bytes32 id = ix.readerSwapId(GPU, 3, r);
        assertEq(id, _id(3, r));
        assertTrue(id != ix.readerSwapId(GPU, 4, r), "per slot");
        assertTrue(id != ix.readerSwapId(GPU2, 3, r), "per gpu");
        assertTrue(id != ix.readerSwapId(GPU, 3, _rd(URL, "lambda/3")), "per reader");
        // an Action with the swap's fields hashes elsewhere, and no action reaches the swap's entry
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.LIVE_FROM;
        a.gpuId = GPU;
        a.slot = 3;
        assertTrue(ix.actionId(a) != id);
        uint256 eta = _q(3, r, WHY);
        assertEq(ix.queuedEta(id), eta, "queuedEta serves swap ids");
        bytes32 actId = ix.actionId(a);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotQueued.selector, actId));
        ix.cancel(a);
        // an action queued beside it keeps its own entry
        IAgateIndex.Action memory att2;
        att2.kind = IAgateIndex.ActionKind.ATTESTER;
        att2.addr = keeper;
        vm.prank(owner);
        bytes32 aid = ix.queue(att2);
        assertEq(ix.queuedEta(aid), eta);
        vm.warp(eta);
        _x(3, r);
        assertEq(ix.queuedEta(aid), eta, "the action is untouched by the swap's execute");
        assertEq(ix.queuedEta(id), 0);
    }

    function test_readerSwap_survivesOwnerRotation_untilWindowEnds() public {
        IAgateIndex.Reader memory r = _rd();
        uint256 eta = _q(3, r, WHY);
        address owner2 = makeAddr("owner2");
        IAgateIndex.Action memory ro;
        ro.kind = IAgateIndex.ActionKind.OWNER;
        ro.addr = owner2;
        vm.prank(owner);
        ix.queue(ro);
        vm.warp(eta);
        vm.prank(owner);
        ix.execute(ro);
        assertEq(ix.owner(), owner2);
        // the old owner (or its thief) can neither execute nor cancel it; the new owner can, inside the window
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.NotOwner.selector, owner));
        ix.executeReaderSwap(GPU, 3, r);
        uint256 snap = vm.snapshotState();
        vm.warp(eta + _w());
        vm.prank(owner2);
        ix.executeReaderSwap(GPU, 3, r);
        assertEq(ix.readerHistory(GPU, 3).length, 1);
        vm.revertToState(snap);
        vm.warp(eta + _w() + 1);
        assertEq(ix.queuedEta(_id(3, r)), 0, "dead after its window");
        vm.prank(owner2);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(3, r), uint64(eta + _w())));
        ix.executeReaderSwap(GPU, 3, r);
    }

    /// DEMO clock: TIMELOCK 1,200 s (20 min), window 8,400 s (2.33 h), fromDay the next demo day.
    function test_readerSwap_demoClock() public {
        deploy(DEMO_P(), 0);
        registerSimple(GPU, 5, NOV1);
        IAgateIndex.Clocks memory c = ix.clocks();
        assertEq(c.timelock, 1_200);
        assertEq(ACTION_WINDOW_DAYS * uint256(c.day), 8_400);
        vm.warp(T0 + 10);
        IAgateIndex.Reader memory r = _rd();
        vm.prank(owner);
        ix.queueReaderSwap(GPU, 3, r, WHY);
        uint256 eta = T0 + 10 + 1_200;
        assertEq(ix.queuedEta(_id(3, r)), eta);
        vm.warp(eta - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.TimelockActive.selector, uint64(eta)));
        ix.executeReaderSwap(GPU, 3, r);
        uint256 snap = vm.snapshotState();
        vm.warp(eta + 8_400 + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.ActionExpired.selector, _id(3, r), uint64(eta + 8_400)));
        ix.executeReaderSwap(GPU, 3, r);
        vm.revertToState(snap);
        vm.warp(eta);
        assertEq(today(), NOV1 + 2);
        _x(3, r);
        assertEq(ix.readerHistory(GPU, 3)[0].fromDay, NOV1 + 3);
    }

    /// A reserved slot (liveFrom NEVER) and a removed one (liveUntil set) may be swapped; nothing else of theirs moves.
    function test_readerSwap_reserveSlot() public {
        uint8[] memory fam = new uint8[](5);
        uint8[] memory q = new uint8[](5);
        for (uint256 i; i < 5; ++i) {
            fam[i] = uint8(i);
            q[i] = 1;
        }
        registerWith(GPU2, fam, q, OCT1, 0x0f); // slot 4 reserved
        IAgateIndex.Action memory lu;
        lu.kind = IAgateIndex.ActionKind.LIVE_UNTIL;
        lu.gpuId = GPU2;
        lu.slot = 3;
        lu.day = ix.dayId(uint64(block.timestamp + 2 * uint256(P.day))) + 1;
        vm.prank(owner);
        ix.queue(lu);
        IAgateIndex.Reader memory r = _rd();
        vm.prank(owner);
        ix.queueReaderSwap(GPU2, 4, r, WHY);
        uint256 eta = block.timestamp + 2 * uint256(P.day);
        vm.warp(eta);
        vm.prank(owner);
        ix.execute(lu);
        vm.prank(owner);
        ix.queueReaderSwap(GPU2, 3, r, "removed slot, reader fixed for the record");
        vm.prank(owner);
        ix.executeReaderSwap(GPU2, 4, r);
        (uint32 lf, uint32 lu4) = ix.slotWindow(GPU2, 4);
        assertEq(lf, NEVER, "still reserved");
        assertEq(lu4, NEVER);
        assertEq(ix.readerHistory(GPU2, 4).length, 1);
        vm.warp(block.timestamp + 2 * uint256(P.day));
        vm.prank(owner);
        ix.executeReaderSwap(GPU2, 3, r);
        (, uint32 until3) = ix.slotWindow(GPU2, 3);
        assertEq(until3, lu.day, "still removed");
        assertEq(ix.readerHistory(GPU2, 3).length, 1);
    }

    // ------------------------------------------------------------------ nothing recorded moves (I31)

    /// The whole observable state of GPU (records, finalFix, accumulators of both writers, slot states, windows,
    /// families, config, clocks) over the days from the first to two past the head.
    function _world() internal view returns (bytes32 w) {
        uint32 hd = ix.head(GPU);
        (bool fe, uint32 fd) = ix.firstRecordDay(GPU);
        w = keccak256(abi.encode(ix.gpu(GPU), ix.clocks(), fe, fd));
        for (uint32 d = OCT1; d <= hd + 2; ++d) {
            (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, d);
            (bool ok, uint32 v, IAgateIndex.Status st, uint8 fr, bool late, bool inc) = ix.finalFix(GPU, d);
            w = keccak256(
                abi.encode(
                    w,
                    e,
                    f,
                    r,
                    abi.encode(ok, v, st, fr, late, inc),
                    ix.readings(GPU, d, w1),
                    ix.readings(GPU, d, w2),
                    ix.isVoided(GPU, d, w1),
                    ix.reopenedAt(GPU, d)
                )
            );
        }
        (IAgateIndex.SlotState[] memory b, IAgateIndex.SlotState[] memory l) = ix.slotStates(GPU);
        w = keccak256(abi.encode(w, b, l));
        for (uint8 i; i < 5; ++i) {
            (uint32 lf, uint32 lu) = ix.slotWindow(GPU, i);
            (uint8 fam, uint8 q) = ix.familyOf(GPU, i);
            w = keccak256(abi.encode(w, lf, lu, fam, q, ix.slotState(GPU, i)));
        }
    }

    /// The same days run twice from one snapshot, once with a swap queued on day 2 and executed on day 4 (mid-day,
    /// while that day's readings are open), once without: every checkpoint of the world is identical.
    function test_readerSwap_recordedDaysUntouched() public {
        uint32[] memory V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        uint32[] memory V2 = arr(3_010_000, 3_190_000, 3_400_000, 3_600_000, 3_800_000);
        bootDay(OCT1, V, V2);
        uint256 snap = vm.snapshotState();
        bytes32[5] memory a = _run(false, V, V2);
        vm.revertToState(snap);
        bytes32[5] memory b = _run(true, V, V2);
        for (uint256 k; k < 5; ++k) {
            assertEq(a[k], b[k], string.concat("checkpoint ", vm.toString(k)));
        }
        // the hash sees the days move (it is not blind): posts, closes and signs change it, the execute alone does not
        assertTrue(a[0] != a[1] && a[2] != a[3] && a[3] != a[4]);
        assertEq(a[1], a[2]);
    }

    function _run(bool swap, uint32[] memory V, uint32[] memory V2) internal returns (bytes32[5] memory cp) {
        IAgateIndex.Reader memory r = _rd();
        uint32 d1 = OCT1 + 1;
        postRange(w1, d1, 0, 6, V);
        postRange(w2, d1, 0, 6, V2);
        if (swap) _q(2, r, WHY);
        cp[0] = _world();
        postRange(w1, d1, 6, 12, V);
        postRange(w2, d1, 6, 12, V2);
        closeEarliest(w1, d1);
        sign(att, d1);
        bootDay(d1 + 1, V, withV(V2, 2, 3_410_000));
        // day 3: half posted, then the execute (fromDay = day 4)
        uint32 d3 = d1 + 2;
        postRange(w1, d3, 0, 6, V);
        postRange(w2, d3, 0, 6, V2);
        warpTo(dStart(OCT1 + 1) + 6 * slice() + slice() / 6 + 2 * uint256(P.day));
        assertEq(today(), d3);
        cp[1] = _world();
        if (swap) {
            _x(2, r);
            assertEq(ix.readerHistory(GPU, 2)[0].fromDay, d3 + 1);
        }
        cp[2] = _world();
        postRange(w1, d3, 6, 12, V);
        postRange(w2, d3, 6, 12, V2);
        closeEarliest(w1, d3);
        sign(att, d3);
        cp[3] = _world();
        bootDay(d3 + 1, withV(V, 2, 3_500_000), V2);
        cp[4] = _world();
    }
}
