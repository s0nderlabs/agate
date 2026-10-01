// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../src/AgateIndex.sol";
import {IAgateIndex} from "../src/interfaces/IAgateIndex.sol";
import {MockForwarder} from "./mocks/MockForwarder.sol";

/// Shared harness: profiles, roles, a GPU, posting and closing helpers. Every helper warps time forward only.
abstract contract IndexBase is Test {
    AgateIndex internal ix;
    MockForwarder internal fwd;

    address internal owner = makeAddr("owner");
    address internal w1 = makeAddr("primary");
    address internal w2 = makeAddr("standby");
    address internal att = makeAddr("attester");
    address internal g1 = makeAddr("guardian1");
    address internal g2 = makeAddr("guardian2");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant GPU = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant GPU2 = keccak256("H200-SXM/on-demand-list/neocloud/v1");
    uint64 internal constant CHAIN = 2_183_018_362_218_727_504;
    uint32 internal constant OCT1 = 20_727; // 2026-10-01
    uint32 internal constant NOV1 = 20_758; // 2026-11-01
    uint32 internal constant DEC1 = 20_788; // 2026-12-01
    uint64 internal constant T0 = 1_800_000_000; // epoch second of the short profiles

    struct Profile {
        uint32 day;
        uint8 slices;
        uint8 minReadings;
        uint8 qMin;
        bool demo;
        bool signAll;
        bool calendar; // epoch 0 / day 0 (PRODUCTION); otherwise epoch T0 at epochDay
        uint32 epochDay;
    }

    function TEST_P() internal pure returns (Profile memory) {
        return Profile(2_400, 12, 6, 3, false, false, false, OCT1);
    }

    function PROD_P() internal pure returns (Profile memory) {
        return Profile(86_400, 24, 12, 3, false, false, true, 0);
    }

    function DEMO_P() internal pure returns (Profile memory) {
        return Profile(600, 4, 2, 1, true, false, false, NOV1);
    }

    function FAST_P() internal pure returns (Profile memory) {
        return Profile(24, 2, 1, 1, true, true, false, NOV1);
    }

    Profile internal P;

    function initParams(Profile memory p) internal view returns (IAgateIndex.InitParams memory ip) {
        ip.day = p.day;
        ip.slices = p.slices;
        ip.minReadings = p.minReadings;
        ip.qMin = p.qMin;
        ip.demoLabel = p.demo;
        ip.signAll = p.signAll;
        ip.epochTs = p.calendar ? 0 : T0;
        ip.epochDay = p.calendar ? 0 : p.epochDay;
        ip.chainSelector = CHAIN;
        ip.owner = owner;
        ip.writers = [w1, w2];
        ip.attester = att;
        ip.guardians = [g1, g2];
        ip.forwarder = address(fwd);
        ip.writerMode = IAgateIndex.WriterMode.TX_ORIGIN;
    }

    /// Deploys at the start of `startDay` minus 10 s (calendar profile) or at T0 (short profiles).
    function deploy(Profile memory p, uint32 startDay) internal {
        P = p;
        fwd = new MockForwarder();
        if (p.calendar) vm.warp(uint256(startDay) * p.day - 10);
        else vm.warp(T0);
        ix = new AgateIndex(initParams(p));
    }

    /// n single-slot families, famQ 1, all live from today's day (or `first`).
    function registerSimple(bytes32 gpuId, uint256 n, uint32 first) internal {
        uint8[] memory fam = new uint8[](n);
        uint8[] memory q = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            fam[i] = uint8(i);
            q[i] = 1;
        }
        vm.prank(owner);
        ix.registerGpu(gpuId, keccak256("recipe"), fam, q, first, uint32((1 << n) - 1));
    }

    function registerWith(bytes32 gpuId, uint8[] memory fam, uint8[] memory q, uint32 first, uint32 mask) internal {
        vm.prank(owner);
        ix.registerGpu(gpuId, keccak256("recipe"), fam, q, first, mask);
    }

    // ------------------------------------------------------------------ clock

    function slice() internal view returns (uint256) {
        return uint256(P.day) / P.slices;
    }

    function dStart(uint32 d) internal view returns (uint256) {
        return ix.dayStart(d);
    }

    function dEnd(uint32 d) internal view returns (uint256) {
        return ix.dayStart(d) + P.day;
    }

    function today() internal view returns (uint32) {
        return ix.dayId(uint64(block.timestamp));
    }

    function warpTo(uint256 t) internal {
        if (block.timestamp < t) vm.warp(t);
    }

    function tPend() internal view returns (uint256) {
        return ix.clocks().tPend;
    }

    // ------------------------------------------------------------------ values

    function arr(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e) internal pure returns (uint32[] memory v) {
        v = new uint32[](5);
        (v[0], v[1], v[2], v[3], v[4]) = (uint32(a), uint32(b), uint32(c), uint32(d), uint32(e));
    }

    function fill(uint256 n, uint256 x) internal pure returns (uint32[] memory v) {
        v = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            v[i] = uint32(x);
        }
    }

    function copyArr(uint32[] memory a) internal pure returns (uint32[] memory b) {
        b = new uint32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
    }

    function withV(uint32[] memory a, uint256 i, uint256 v) internal pure returns (uint32[] memory b) {
        b = copyArr(a);
        b[i] = uint32(v);
    }

    // ------------------------------------------------------------------ reports

    function entry(bytes32 gpuId, uint32 d, uint8 h, uint64 readAt, uint32[] memory vals)
        internal
        pure
        returns (IAgateIndex.Entry memory e)
    {
        e = IAgateIndex.Entry(gpuId, d, h, readAt, vals);
    }

    function rpt(IAgateIndex.Entry memory e) internal view returns (bytes memory) {
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](1);
        es[0] = e;
        return abi.encode(uint8(1), CHAIN, address(ix), es);
    }

    function rptN(IAgateIndex.Entry[] memory es) internal view returns (bytes memory) {
        return abi.encode(uint8(1), CHAIN, address(ix), es);
    }

    function readAtOf(uint32 d, uint8 h) internal view returns (uint64) {
        return uint64(dStart(d) + uint256(h) * slice() + slice() / 6);
    }

    /// One slice for one writer on the direct path, at its read time (warping forward to it if needed).
    function post1(address w, bytes32 gpuId, uint32 d, uint8 h, uint32[] memory vals) internal {
        uint64 ra = readAtOf(d, h);
        warpTo(ra);
        vm.prank(w);
        ix.postReport(rpt(entry(gpuId, d, h, ra, vals)));
    }

    function postRange(address w, uint32 d, uint8 from, uint8 to, uint32[] memory vals) internal {
        for (uint8 h = from; h < to; ++h) {
            post1(w, GPU, d, h, vals);
        }
    }

    /// Every slice of day d, both writers per slice in time order (v2 empty: the primary only).
    function feedDay(uint32 d, uint32[] memory v1, uint32[] memory v2) internal {
        for (uint8 h; h < P.slices; ++h) {
            if (v1.length != 0) post1(w1, GPU, d, h, v1);
            if (v2.length != 0) post1(w2, GPU, d, h, v2);
        }
    }

    function none() internal pure returns (uint32[] memory) {
        return new uint32[](0);
    }

    // ------------------------------------------------------------------ closes and signatures

    function closeAt(address who, uint256 t) internal returns (uint32 d) {
        warpTo(t);
        vm.prank(who);
        d = ix.closeDay(GPU);
    }

    /// Close day d at the earliest legal second (dayEnd + CLOSE_GRACE).
    function closeEarliest(address who, uint32 d) internal returns (uint32) {
        return closeAt(who, dEnd(d) + slice());
    }

    function rec(uint32 d) internal view returns (IAgateIndex.Record memory r) {
        (,, r) = ix.record(GPU, d);
    }

    function sign(address who, uint32 d) internal {
        IAgateIndex.Record memory r = rec(d);
        vm.prank(who);
        ix.attest(GPU, d, r.source, r.digest);
    }

    function selectW(address who, uint32 d, address writer) internal {
        (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, writer);
        require(ok, "preview not ok");
        vm.prank(who);
        ix.attest(GPU, d, writer, det.rec.digest);
    }

    function isFinal(uint32 d) internal view returns (bool f) {
        (, f,) = ix.record(GPU, d);
    }

    function exists(uint32 d) internal view returns (bool e) {
        (e,,) = ix.record(GPU, d);
    }

    function lastState(uint256 i) internal view returns (IAgateIndex.SlotState memory) {
        (, IAgateIndex.SlotState[] memory l) = ix.slotStates(GPU);
        return l[i];
    }

    function baseState(uint256 i) internal view returns (IAgateIndex.SlotState memory) {
        (IAgateIndex.SlotState[] memory b,) = ix.slotStates(GPU);
        return b[i];
    }

    /// A standard first day: d posted by w1 (and w2 if given), closed by w1 at the earliest second, countersigned.
    function bootDay(uint32 d, uint32[] memory v1, uint32[] memory v2) internal {
        feedDay(d, v1, v2);
        closeEarliest(w1, d);
        sign(att, d);
    }
}
