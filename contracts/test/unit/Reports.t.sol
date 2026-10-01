// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IndexBase} from "../Base.t.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex, P_MIN, P_MAX, NEVER} from "../../src/interfaces/IAgateIndex.sol";

contract ReportsTest is IndexBase {
    uint32 internal D;
    uint32[] internal V;

    function setUp() public {
        deploy(TEST_P(), 0);
        D = OCT1;
        registerSimple(GPU, 5, D);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
    }

    function _expectSkip(address w, IAgateIndex.Entry memory e, IAgateIndex.Skip reason) internal {
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.EntrySkipped(e.gpuId, e.dayId, w, e.slice, reason);
        vm.prank(w);
        ix.postReport(rpt(e));
    }

    // ------------------------------------------------------------------ A1..A3

    function test_A1_notForwarder() public {
        bytes memory r = rpt(entry(GPU, D, 0, readAtOf(D, 0), V));
        warpTo(readAtOf(D, 0));
        vm.prank(w1, w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A1_NotForwarder.selector, w1));
        ix.onReport("", r);
    }

    function test_A1_zeroForwarderDisablesCrePath() public {
        // queue FORWARDER = 0 and execute after the timelock
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.FORWARDER;
        vm.prank(owner);
        ix.queue(a);
        vm.warp(block.timestamp + 2 * P.day);
        vm.prank(owner);
        ix.execute(a);
        uint32 d = today();
        bytes memory r = rpt(entry(GPU, d, 0, readAtOf(d, 0), V));
        warpTo(readAtOf(d, 0));
        vm.prank(address(0), w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A1_NotForwarder.selector, address(0)));
        ix.onReport("", r);
    }

    function test_A2_txOriginMode_throughMockForwarder() public {
        bytes memory r = rpt(entry(GPU, D, 0, readAtOf(D, 0), V));
        warpTo(readAtOf(D, 0));
        vm.prank(stranger, w1);
        assertTrue(fwd.forward(address(ix), "", r));
        assertEq(ix.readings(GPU, D, w1).sliceBits, 1);
        // a stranger as tx.origin: the forwarder swallows the revert, nothing stored
        bytes memory r2 = rpt(entry(GPU, D, 1, readAtOf(D, 1), V));
        warpTo(readAtOf(D, 1));
        vm.prank(stranger, stranger);
        assertFalse(fwd.forward(address(ix), "", r2));
        assertEq(ix.readings(GPU, D, stranger).sliceBits, 0);
        // direct call from the forwarder with tx.origin a stranger: A2 with the stranger
        vm.prank(address(fwd), stranger);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, stranger));
        ix.onReport("", r2);
    }

    function _setMode(IAgateIndex.WriterMode m) internal {
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.FORWARDER;
        a.addr = address(fwd);
        a.mode = m;
        vm.prank(owner);
        ix.queue(a);
        vm.warp(block.timestamp + 2 * P.day);
        vm.prank(owner);
        ix.execute(a);
    }

    function test_A2_workflowOwnerMode_62and64ByteMetadata() public {
        _setMode(IAgateIndex.WriterMode.WORKFLOW_OWNER);
        uint32 d = today();
        bytes memory meta62 = abi.encodePacked(bytes32(uint256(1)), bytes10("agate"), w2);
        bytes memory meta64 = abi.encodePacked(meta62, bytes2(0xbeef));
        assertEq(meta62.length, 62);
        warpTo(readAtOf(d, 0));
        bytes memory r0 = rpt(entry(GPU, d, 0, readAtOf(d, 0), V));
        vm.prank(address(fwd), stranger); // tx.origin is ignored in this mode
        ix.onReport(meta62, r0);
        assertEq(ix.readings(GPU, d, w2).sliceBits, 1);
        warpTo(readAtOf(d, 1));
        bytes memory r1 = rpt(entry(GPU, d, 1, readAtOf(d, 1), V));
        vm.prank(address(fwd));
        ix.onReport(meta64, r1);
        assertEq(ix.readings(GPU, d, w2).sliceBits, 3);
        // metadata naming a non-writer
        bytes memory metaBad = abi.encodePacked(bytes32(uint256(1)), bytes10("agate"), stranger);
        bytes memory r2 = rpt(entry(GPU, d, 2, readAtOf(d, 1), V));
        vm.prank(address(fwd));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, stranger));
        ix.onReport(metaBad, r2);
        // metadata shorter than 62 bytes
        vm.prank(address(fwd));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, address(0)));
        ix.onReport(new bytes(61), r2);
    }

    function test_A2_directPath() public {
        bytes memory r = rpt(entry(GPU, D, 0, readAtOf(D, 0), V));
        warpTo(readAtOf(D, 0));
        address[5] memory nope = [stranger, att, g1, owner, keeper];
        for (uint256 i; i < nope.length; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, nope[i]));
            ix.postReport(r);
        }
        vm.prank(w2);
        ix.postReport(r);
    }

    function test_A2_suspendedWriter() public {
        vm.prank(g1);
        ix.suspend(w1);
        bytes memory r = rpt(entry(GPU, D, 0, readAtOf(D, 0), V));
        warpTo(readAtOf(D, 0));
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, w1));
        ix.postReport(r);
        vm.prank(address(fwd), w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, w1));
        ix.onReport("", r);
    }

    function test_A2_writerWithCode_7702() public {
        vm.etch(w1, abi.encodePacked(hex"ef0100", address(0xdead)));
        bytes memory r = rpt(entry(GPU, D, 0, readAtOf(D, 0), V));
        warpTo(readAtOf(D, 0));
        vm.prank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, w1));
        ix.postReport(r);
        vm.prank(address(fwd), w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A2_NotActiveWriter.selector, w1));
        ix.onReport("", r);
    }

    function test_A3_badHeader() public {
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](1);
        es[0] = entry(GPU, D, 0, readAtOf(D, 0), V);
        warpTo(readAtOf(D, 0));
        vm.startPrank(w1);
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A3_BadHeader.selector, uint8(2), CHAIN, address(ix)));
        ix.postReport(abi.encode(uint8(2), CHAIN, address(ix), es));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A3_BadHeader.selector, uint8(1), CHAIN + 1, address(ix)));
        ix.postReport(abi.encode(uint8(1), CHAIN + 1, address(ix), es));
        vm.expectRevert(abi.encodeWithSelector(IAgateIndex.A3_BadHeader.selector, uint8(1), CHAIN, stranger));
        ix.postReport(abi.encode(uint8(1), CHAIN, stranger, es));
        vm.expectRevert();
        ix.postReport(hex"0001");
        vm.expectRevert(); // version above uint8: the decoder refuses it
        ix.postReport(abi.encode(uint256(257), CHAIN, address(ix), es));
        vm.stopPrank();
        assertEq(ix.readings(GPU, D, w1).sliceBits, 0);
    }

    // ------------------------------------------------------------------ E1..E9

    function test_E1_unknownGpuOrLength() public {
        warpTo(readAtOf(D, 0));
        _expectSkip(w1, entry(GPU2, D, 0, readAtOf(D, 0), V), IAgateIndex.Skip.E1_GPU_OR_LENGTH);
        _expectSkip(w1, entry(GPU, D, 0, readAtOf(D, 0), fill(4, 3_000_000)), IAgateIndex.Skip.E1_GPU_OR_LENGTH);
        _expectSkip(w1, entry(GPU, D, 0, readAtOf(D, 0), fill(6, 3_000_000)), IAgateIndex.Skip.E1_GPU_OR_LENGTH);
    }

    function test_E2_slice() public {
        warpTo(readAtOf(D, 0));
        _expectSkip(w1, entry(GPU, D, 12, readAtOf(D, 0), V), IAgateIndex.Skip.E2_SLICE);
        _expectSkip(w1, entry(GPU, D, 255, readAtOf(D, 0), V), IAgateIndex.Skip.E2_SLICE);
    }

    function test_E3_dayClosedOrBeforeFirstDay() public {
        warpTo(readAtOf(D, 0));
        _expectSkip(w1, entry(GPU, D - 1, 0, readAtOf(D, 0), V), IAgateIndex.Skip.E3_DAY_CLOSED);
        feedDay(D, V, none());
        closeEarliest(w1, D);
        _expectSkip(w1, entry(GPU, D, 11, readAtOf(D, 11), V), IAgateIndex.Skip.E3_DAY_CLOSED);
    }

    function test_E4_voided() public {
        bootDay(D, V, none());
        uint32 d = D + 1;
        feedDay(d, V, none());
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        vm.prank(g1);
        ix.veto(GPU, d, w1, r.digest);
        _expectSkip(w1, entry(GPU, d, 3, readAtOf(d, 3), V), IAgateIndex.Skip.E4_VOIDED);
        // the other writer may still post for d
        bytes memory r3 = rpt(entry(GPU, d, 3, readAtOf(d, 3), V));
        vm.prank(w2);
        ix.postReport(r3);
        assertEq(ix.readings(GPU, d, w2).sliceBits, 1 << 3);
    }

    function test_E5_readAtOutsideSlice() public {
        warpTo(readAtOf(D, 2));
        uint64 s0 = uint64(dStart(D));
        _expectSkip(w1, entry(GPU, D, 1, s0 + uint64(slice()) - 1 + uint64(slice()) + 1, V), IAgateIndex.Skip.E5_READ_AT_OUTSIDE_SLICE);
        _expectSkip(w1, entry(GPU, D, 1, s0 + uint64(slice()) - 1, V), IAgateIndex.Skip.E5_READ_AT_OUTSIDE_SLICE);
        // the boundaries: sliceStart accepted, sliceStart + slice - 1 accepted
        vm.prank(w1);
        ix.postReport(rpt(entry(GPU, D, 1, s0 + uint64(slice()), V)));
        vm.prank(w2);
        ix.postReport(rpt(entry(GPU, D, 1, s0 + 2 * uint64(slice()) - 1, V)));
        assertEq(ix.readings(GPU, D, w1).sliceBits, 2);
        assertEq(ix.readings(GPU, D, w2).sliceBits, 2);
    }

    function test_E6_readAtFuture() public {
        uint64 ra = readAtOf(D, 0);
        warpTo(ra);
        _expectSkip(w1, entry(GPU, D, 0, ra + 1, V), IAgateIndex.Skip.E6_READ_AT_FUTURE);
        vm.prank(w1);
        ix.postReport(rpt(entry(GPU, D, 0, ra, V)));
    }

    function test_E7_duplicate() public {
        post1(w1, GPU, D, 0, V);
        _expectSkip(w1, entry(GPU, D, 0, readAtOf(D, 0), V), IAgateIndex.Skip.E7_DUPLICATE);
        IAgateIndex.Readings memory rd = ix.readings(GPU, D, w1);
        assertEq(rd.counts[0], 1, "duplicate added nothing");
    }

    function test_E8_badValues() public {
        uint32[] memory v = arr(P_MIN - 1, P_MAX + 10_000, 3_000_001, 0, P_MIN);
        uint64 ra = readAtOf(D, 0);
        warpTo(ra);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.BadValue(GPU, D, w1, 0, 0, P_MIN - 1);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.BadValue(GPU, D, w1, 0, 1, P_MAX + 10_000);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.BadValue(GPU, D, w1, 0, 2, 3_000_001);
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReadingsPosted(GPU, D, w1, 0, ra, v, 1 << 4, false);
        vm.prank(w1);
        ix.postReport(rpt(entry(GPU, D, 0, ra, v)));
        IAgateIndex.Readings memory rd = ix.readings(GPU, D, w1);
        assertEq(rd.counts[0] + rd.counts[1] + rd.counts[2] + rd.counts[3], 0);
        assertEq(rd.counts[4], 1);
        assertEq(rd.sums[4], P_MIN);
        assertTrue(rd.anyValid);
        // P_MAX itself is valid
        post1(w1, GPU, D, 1, arr(P_MAX, 0, 0, 0, 0));
        assertEq(ix.readings(GPU, D, w1).sums[0], P_MAX);
    }

    function test_E8b_unreadableSlotSilent_E9_bitsEvenWithNoValue() public {
        bytes32 g = GPU2;
        uint8[] memory fam = new uint8[](3);
        uint8[] memory q = new uint8[](3);
        (fam[1], fam[2], q[0], q[1], q[2]) = (1, 2, 1, 1, 1);
        registerWith(g, fam, q, D, 0x3); // slot 2 reserved
        uint64 ra = readAtOf(D, 0);
        warpTo(ra);
        uint32[] memory v = new uint32[](3);
        (v[0], v[1], v[2]) = (3_000_000, 0, 3_500_000);
        vm.recordLogs();
        vm.prank(w1);
        ix.postReport(rpt(entry(g, D, 0, ra, v)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IAgateIndex.BadValue.selector, "E8b emits nothing");
        }
        IAgateIndex.Readings memory rd = ix.readings(g, D, w1);
        assertEq(rd.counts[2], 0);
        assertEq(rd.counts[0], 1);
        // all-zero values: the slice bit is set, anyValid stays false
        post1(w2, g, D, 1, new uint32[](3));
        rd = ix.readings(g, D, w2);
        assertEq(rd.sliceBits, 2);
        assertFalse(rd.anyValid);
    }

    function test_E9_accumulateLateAndEvent() public {
        uint64 ra = readAtOf(D, 0);
        // posted two slices after the slice began: late
        warpTo(dStart(D) + 2 * slice());
        vm.expectEmit(true, true, true, true, address(ix));
        emit IAgateIndex.ReadingsPosted(GPU, D, w1, 0, ra, V, 0x1f, true);
        vm.prank(w1);
        ix.postReport(rpt(entry(GPU, D, 0, ra, V)));
        IAgateIndex.Readings memory rd = ix.readings(GPU, D, w1);
        assertTrue(rd.late);
        assertEq(rd.lastPostAt, block.timestamp);
        // one second before two slices: not late
        warpTo(dStart(D) + 3 * slice() - 1);
        bytes memory r1 = rpt(entry(GPU, D, 1, readAtOf(D, 1), V));
        vm.prank(w2);
        ix.postReport(r1);
        assertFalse(ix.readings(GPU, D, w2).late);
        for (uint8 h = 1; h < 12; ++h) {
            post1(w1, GPU, D, h, V);
        }
        rd = ix.readings(GPU, D, w1);
        assertEq(rd.sliceBits, (1 << 12) - 1);
        for (uint256 i; i < 5; ++i) {
            assertEq(rd.counts[i], 12);
            assertEq(rd.sums[i], uint40(12) * V[i]);
        }
        // one writer's readings never enter another's sums
        assertEq(ix.readings(GPU, D, w2).counts[0], 1);
    }

    function test_multiEntryReport_skipsOnlyBadEntry() public {
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](3);
        uint64 ra = readAtOf(D, 0);
        es[0] = entry(GPU, D, 0, ra, V);
        es[1] = entry(GPU, D, 0, ra, V); // duplicate inside the same report
        es[2] = entry(GPU2, D, 0, ra, V); // unknown gpu
        warpTo(ra);
        vm.prank(w1);
        ix.postReport(rptN(es));
        assertEq(ix.readings(GPU, D, w1).counts[0], 1);
    }

    function test_reportNeverClosesADay() public {
        feedDay(D, V, none());
        warpTo(dEnd(D) + 2 * slice());
        bytes memory r = rpt(entry(GPU, D + 1, 0, readAtOf(D + 1, 0), V));
        vm.prank(w1);
        ix.postReport(r);
        assertEq(ix.head(GPU), D);
        assertFalse(exists(D));
    }

    function test_maxSumNoOverflow() public {
        // 255 slices of P_MAX fit the uint40 sum and the uint8 count
        IAgateIndex.InitParams memory ip = initParams(TEST_P());
        ip.day = 255 * 12 * 4; // 12240: divisible by 255 and 12
        ip.slices = 255;
        ip.minReadings = 128;
        ip.qMin = 1;
        ip.demoLabel = true;
        vm.warp(T0);
        AgateIndex big = new AgateIndex(ip);
        uint8[] memory fam = new uint8[](1);
        uint8[] memory q = new uint8[](1);
        q[0] = 1;
        vm.prank(owner);
        big.registerGpu(GPU, bytes32(0), fam, q, OCT1, 1);
        uint32[] memory v = fill(1, P_MAX);
        uint256 sl = ip.day / 255;
        for (uint256 h; h < 255; ++h) {
            uint64 ra = uint64(T0 + h * sl);
            warpTo(ra);
            IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](1);
            es[0] = entry(GPU, OCT1, uint8(h), ra, v);
            vm.prank(w1);
            big.postReport(abi.encode(uint8(1), CHAIN, address(big), es));
        }
        IAgateIndex.Readings memory rd = big.readings(GPU, OCT1, w1);
        assertEq(rd.counts[0], 255);
        assertEq(rd.sums[0], uint40(255) * P_MAX);
        assertEq(rd.sliceBits, type(uint256).max >> 1);
    }
}
