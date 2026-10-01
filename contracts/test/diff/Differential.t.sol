// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";

/// Replays the reference model's traces (test/vectors/diff_*.json, written by gen_vectors.py from the model patched
/// to v4.3) call by call: every call must succeed or revert as in the model, and after every successful state
/// change the head, the newest record (every field, its digest recomputed here from the model's fields) and the
/// post-state must equal the model's. Trace 0 is the brief's worked example; traces 1 to 4 are the B1 world S7.
contract DifferentialTest is Test {
    bytes32 internal constant GPU = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant OTHER_GPU = keccak256("NOPE");
    uint64 internal constant CHAIN = 10_143;
    address internal constant FWD = address(0xF0F0);

    address[8] internal roles;

    struct Cur {
        uint256[] o;
        uint256 k;
        uint256 n; // slots
        uint256 mode; // 0 direct path, 1 onReport through the forwarder
        uint256 trace;
        uint256 op;
        AgateIndex ix;
    }

    function setUp() public {
        roles = [
            makeAddr("w1"),
            makeAddr("w2"),
            makeAddr("att"),
            makeAddr("g1"),
            makeAddr("g2"),
            makeAddr("owner"),
            makeAddr("other"),
            address(0)
        ];
    }

    function _next(Cur memory c) internal pure returns (uint256 v) {
        v = c.o[c.k];
        ++c.k;
    }

    function _ctx(Cur memory c, string memory what) internal pure returns (string memory) {
        return string.concat("trace ", vm.toString(c.trace), " op ", vm.toString(c.op), ": ", what);
    }

    function _eq(Cur memory c, uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(_ctx(c, what), ": ", vm.toString(a), " != ", vm.toString(b)));
    }

    function _eq(Cur memory c, bool a, bool b, string memory what) internal pure {
        if (a != b) revert(_ctx(c, what));
    }

    function _eq(Cur memory c, address a, address b, string memory what) internal pure {
        if (a != b) revert(string.concat(_ctx(c, what), ": ", vm.toString(a), " != ", vm.toString(b)));
    }

    function _eq(Cur memory c, bytes32 a, bytes32 b, string memory what) internal pure {
        if (a != b) revert(string.concat(_ctx(c, what), ": ", vm.toString(a), " != ", vm.toString(b)));
    }

    function _file(uint256 f) internal view returns (string memory) {
        string memory num = vm.toString(f);
        if (f < 10) num = string.concat("00", num);
        else if (f < 100) num = string.concat("0", num);
        return vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/diff_", num, ".json"));
    }

    function _replayFile(uint256 f) internal returns (uint256 calls) {
        string memory json = _file(f);
        return _replayRange(json, f, 0, vm.parseJsonUint(json, ".count"));
    }

    function _replayRange(string memory json, uint256 f, uint256 from, uint256 to) internal returns (uint256 calls) {
        for (uint256 i = from; i < to; ++i) {
            (uint256 k,) = _replayTrace(json, i, f * 10 + i);
            calls += k;
        }
    }

    function _deploy(uint256[] memory h, uint256 t) internal returns (AgateIndex) {
        IAgateIndex.InitParams memory ip;
        ip.day = uint32(h[0]);
        ip.slices = uint8(h[1]);
        ip.minReadings = uint8(h[2]);
        ip.qMin = uint8(h[3]);
        ip.demoLabel = h[4] == 1;
        ip.signAll = h[5] == 1;
        ip.epochTs = uint64(h[6]);
        ip.epochDay = uint32(h[7]);
        ip.chainSelector = CHAIN;
        ip.owner = roles[5];
        ip.writers = [roles[0], h[8] > 1 ? roles[1] : address(0)];
        ip.attester = roles[2];
        ip.guardians = [roles[3], h[9] > 1 ? roles[4] : address(0)];
        ip.forwarder = FWD;
        vm.warp(t);
        return new AgateIndex(ip);
    }

    function _replayTrace(string memory json, uint256 i, uint256 traceNo) internal returns (uint256, AgateIndex) {
        string memory base = string.concat(".traces[", vm.toString(i), "]");
        uint256[] memory h = vm.parseJsonUintArray(json, string.concat(base, ".header"));
        Cur memory c;
        c.o = vm.parseJsonUintArray(json, string.concat(base, ".ops"));
        c.mode = h[10];
        c.trace = traceNo;
        c.ix = _deploy(h, c.o[1]);
        uint256 nOps = vm.parseJsonUint(json, string.concat(base, ".nOps"));
        for (c.op = 0; c.op < nOps; ++c.op) {
            _step(c);
        }
        _eq(c, c.k, c.o.length, "all of the trace consumed");
        return (nOps, c.ix);
    }

    function _step(Cur memory c) internal {
        uint256 code = _next(c);
        uint256 t = _next(c);
        address caller = roles[_next(c)];
        bool ok = _next(c) == 1;
        vm.warp(t);
        if (code == 1) _post(c, caller, ok);
        else if (code == 2) _close(c, caller, ok);
        else if (code == 3) _carry(c, caller, ok);
        else if (code == 4) _attest(c, caller, ok);
        else if (code == 5) _veto(c, caller, ok);
        else if (code == 6) _suspend(c, caller, ok);
        else if (code == 7) _register(c, caller, ok);
        else if (code == 8 || code == 9) _owner(c, caller, ok, code == 8);
        else revert(_ctx(c, "unknown op"));
    }

    function _expect(Cur memory c, bool ok, bool success, bytes memory err) internal pure {
        if (ok != success) {
            revert(string.concat(_ctx(c, ok ? "the model succeeded, the contract reverted: " : "the contract succeeded, the model reverted"), ok ? vm.toString(err) : ""));
        }
    }

    // ------------------------------------------------------------------ reports

    function _entryAt(Cur memory c) internal pure returns (IAgateIndex.Entry memory en) {
        en.gpuId = _next(c) == 1 ? GPU : OTHER_GPU;
        en.dayId = uint32(_next(c));
        en.slice = uint8(_next(c));
        en.readAt = uint64(_next(c));
        uint256 nv = _next(c);
        en.values = new uint32[](nv);
        for (uint256 j; j < nv; ++j) {
            en.values[j] = uint32(_next(c));
        }
    }

    function _post(Cur memory c, address origin, bool ok) internal {
        uint256 flags = _next(c);
        uint256 nE = _next(c);
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](nE);
        for (uint256 e; e < nE; ++e) {
            es[e] = _entryAt(c);
        }
        bytes memory report = abi.encode(
            uint8(flags & 1 == 1 ? 2 : 1),
            flags & 2 == 2 ? CHAIN + 1 : CHAIN,
            flags & 4 == 4 ? address(0xBEEF) : address(c.ix),
            es
        );
        bool success;
        bytes memory err;
        if (c.mode == 0) {
            vm.prank(origin);
            (success, err) = address(c.ix).call(abi.encodeCall(IAgateIndex.postReport, (report)));
        } else {
            vm.prank(FWD, origin);
            (success, err) = address(c.ix).call(abi.encodeCall(IReceiver.onReport, ("", report)));
        }
        _expect(c, ok, success, err);
        uint256 nAcc = _next(c);
        for (uint256 a; a < nAcc; ++a) {
            _checkAcc(c, origin);
        }
    }

    function _checkAcc(Cur memory c, address origin) internal view {
        uint32 d = uint32(_next(c));
        IAgateIndex.Readings memory r = c.ix.readings(GPU, d, origin);
        _eq(c, r.sliceBits, _next(c), "slice bits");
        for (uint256 j; j < c.n; ++j) {
            _eq(c, r.sums[j], _next(c), "sum");
        }
        for (uint256 j; j < c.n; ++j) {
            _eq(c, r.counts[j], _next(c), "count");
        }
    }

    // ------------------------------------------------------------------ days and keys

    function _close(Cur memory c, address caller, bool ok) internal {
        vm.prank(caller);
        (bool success, bytes memory err) = address(c.ix).call(abi.encodeCall(IAgateIndex.closeDay, (GPU)));
        _expect(c, ok, success, err);
        if (ok) _snapshot(c);
    }

    function _carry(Cur memory c, address caller, bool ok) internal {
        uint256 cc = _next(c);
        vm.prank(caller);
        (bool success, bytes memory ret) = address(c.ix).call(abi.encodeCall(IAgateIndex.carryDay, (GPU)));
        _expect(c, ok, success, ret);
        if (ok) {
            _eq(c, abi.decode(ret, (uint8)), cc, "carry case");
            _snapshot(c);
        }
    }

    /// Reads [source, value, p, kinds, counts, e, miss, inMedian, wasIn] and returns (source, Solidity digest).
    function _digestFields(Cur memory c, uint32 d) internal view returns (address src, bytes32 dg) {
        src = roles[_next(c)];
        uint32 value = uint32(_next(c));
        uint256 n = c.n;
        uint32[] memory p = new uint32[](n);
        IAgateIndex.Kind[] memory kinds = new IAgateIndex.Kind[](n);
        uint8[] memory counts = new uint8[](n);
        IAgateIndex.SlotState[] memory post = new IAgateIndex.SlotState[](n);
        for (uint256 j; j < n; ++j) {
            p[j] = uint32(_next(c));
        }
        for (uint256 j; j < n; ++j) {
            kinds[j] = IAgateIndex.Kind(_next(c));
        }
        for (uint256 j; j < n; ++j) {
            counts[j] = uint8(_next(c));
        }
        for (uint256 j; j < n; ++j) {
            post[j].e = uint32(_next(c));
        }
        for (uint256 j; j < n; ++j) {
            post[j].miss = uint8(_next(c));
        }
        for (uint256 j; j < n; ++j) {
            post[j].inMedian = _next(c) == 1;
        }
        for (uint256 j; j < n; ++j) {
            post[j].wasIn = _next(c) == 1;
        }
        dg = c.ix.digestOf(GPU, d, src, p, kinds, counts, post, value);
    }

    function _attest(Cur memory c, address caller, bool ok) internal {
        uint32 d = uint32(_next(c));
        address writer = roles[_next(c)];
        bytes32 dg = keccak256("a digest no record has");
        if (_next(c) == 1) (, dg) = _digestFields(c, d);
        vm.prank(caller);
        (bool success, bytes memory err) = address(c.ix).call(abi.encodeCall(IAgateIndex.attest, (GPU, d, writer, dg)));
        _expect(c, ok, success, err);
        if (ok) _snapshot(c);
    }

    function _veto(Cur memory c, address caller, bool ok) internal {
        uint32 d = uint32(_next(c));
        address src;
        bytes32 dg = keccak256("a digest no record has");
        if (_next(c) == 1) (src, dg) = _digestFields(c, d);
        vm.prank(caller);
        (bool success, bytes memory err) = address(c.ix).call(abi.encodeCall(IAgateIndex.veto, (GPU, d, src, dg)));
        _expect(c, ok, success, err);
        if (ok) _snapshot(c);
    }

    function _suspend(Cur memory c, address caller, bool ok) internal {
        address w = roles[_next(c)];
        vm.prank(caller);
        (bool success, bytes memory err) = address(c.ix).call(abi.encodeCall(IAgateIndex.suspend, (w)));
        _expect(c, ok, success, err);
    }

    function _register(Cur memory c, address caller, bool ok) internal {
        uint256 n = _next(c);
        uint256 nF = _next(c);
        uint8[] memory fam = new uint8[](n);
        uint8[] memory q = new uint8[](nF);
        for (uint256 j; j < n; ++j) {
            fam[j] = uint8(_next(c));
        }
        for (uint256 j; j < nF; ++j) {
            q[j] = uint8(_next(c));
        }
        uint32 first = uint32(_next(c));
        uint32 mask = uint32(_next(c));
        vm.prank(caller);
        (bool success, bytes memory err) =
            address(c.ix).call(abi.encodeCall(IAgateIndex.registerGpu, (GPU, bytes32("recipe"), fam, q, first, mask)));
        _expect(c, ok, success, err);
        if (ok) c.n = n;
    }

    function _owner(Cur memory c, address caller, bool ok, bool isQueue) internal {
        IAgateIndex.Action memory a;
        uint256 kind = _next(c);
        a.kind = IAgateIndex.ActionKind(kind);
        a.slot = uint8(_next(c));
        address addr = roles[_next(c)];
        uint32 day = uint32(_next(c));
        if (kind == 4 || kind == 5) {
            a.gpuId = GPU;
            a.day = day;
        } else {
            a.addr = addr;
        }
        vm.prank(caller);
        (bool success, bytes memory err) = isQueue
            ? address(c.ix).call(abi.encodeCall(IAgateIndex.queue, (a)))
            : address(c.ix).call(abi.encodeCall(IAgateIndex.execute, (a)));
        _expect(c, ok, success, err);
    }

    // ------------------------------------------------------------------ the state after a successful change

    function _snapshot(Cur memory c) internal view {
        AgateIndex ix = c.ix;
        uint32 h = uint32(_next(c));
        _eq(c, ix.head(GPU), h, "head");
        (bool fe, uint32 fd) = ix.firstRecordDay(GPU);
        _eq(c, fe, _next(c) == 1, "firstRecordDay exists");
        _eq(c, fd, _next(c), "firstRecordDay");
        (bool e,, IAgateIndex.Record memory r) = ix.record(GPU, h - 1);
        _eq(c, e, _next(c) == 1, "newest record exists");
        if (e) _compareRecord(c, r, h - 1);
        (, IAgateIndex.SlotState[] memory last) = ix.slotStates(GPU);
        for (uint256 j; j < c.n; ++j) {
            _eq(c, last[j].e, _next(c), "last.e");
        }
        for (uint256 j; j < c.n; ++j) {
            _eq(c, last[j].miss, _next(c), "last.miss");
        }
        for (uint256 j; j < c.n; ++j) {
            _eq(c, last[j].inMedian, _next(c) == 1, "last.inMedian");
        }
        for (uint256 j; j < c.n; ++j) {
            _eq(c, last[j].wasIn, _next(c) == 1, "last.wasIn");
        }
    }

    function _compareRecord(Cur memory c, IAgateIndex.Record memory r, uint32 d) internal view {
        _eq(c, r.value, _next(c), "value");
        _eq(c, uint8(r.status), _next(c), "status");
        _eq(c, r.source, roles[_next(c)], "source");
        _eq(c, r.postedAt, _next(c), "postedAt");
        _eq(c, r.finalAt, _next(c), "finalAt");
        _eq(c, r.attestedAt, _next(c), "attestedAt");
        _eq(c, r.attestedBy, roles[_next(c)], "attestedBy");
        _eq(c, r.changed, _next(c) == 1, "changed");
        _eq(c, r.needsSign, _next(c) == 1, "needsSign");
        _eq(c, r.dropped, _next(c) == 1, "dropped");
        _eq(c, r.fresh, _next(c), "fresh");
        _eq(c, r.quorum, _next(c), "quorum");
        _eq(c, r.held, _next(c), "held");
        _eq(c, r.freshMedian, _next(c), "freshMedian");
        _eq(c, r.late, _next(c) == 1, "late");
        _eq(c, r.incomplete, _next(c) == 1, "incomplete");
        bool carried = _next(c) == 1;
        _eq(c, r.status == IAgateIndex.Status.CARRIED, carried, "carried");
        if (!carried) {
            (address src, bytes32 dg) = _digestFields(c, d);
            _eq(c, src, r.source, "digest source");
            _eq(c, r.digest, dg, "digest");
        }
    }

    // ------------------------------------------------------------------ the tests

    function test_diff_file000_workedExample_B1() public {
        assertGt(_replayRange(_file(0), 0, 0, 5), 5_000);
    }

    function test_diff_file000_freeze() public {
        assertGt(_replayRange(_file(0), 0, 5, 7), 3_000);
    }

    function test_diff_file000_random() public {
        _replayRange(_file(0), 0, 7, 10);
    }

    /// The brief's worked example on its own, with the printed fixes: 3.60 to Nov 10, 4.20 from Nov 11 (changed,
    /// countersigned), unchanged after.
    function test_diff_workedExampleFixes() public {
        (, AgateIndex ix) = _replayTrace(_file(0), 0, 0);
        uint32 nov1 = 20_758;
        for (uint32 k = 1; k <= 14; ++k) {
            (bool ok, uint32 v,,,,) = ix.finalFix(GPU, nov1 + k - 1);
            assertTrue(ok);
            assertEq(v, k < 11 ? 3_600_000 : 4_200_000);
            (,, IAgateIndex.Record memory r) = ix.record(GPU, nov1 + k - 1);
            assertEq(r.changed, k == 1 || k == 11, "the first record and the step are the changed ones");
            assertEq(r.attestedAt != 0, k == 1 || k == 11, "countersigned exactly when changed");
            assertLe(r.finalAt, ix.dayStart(nov1 + k) + 2 days, "final within LAG_MAX");
        }
    }

    function test_diff_file001() public { _replayFile(1); }
    function test_diff_file002() public { _replayFile(2); }
    function test_diff_file003() public { _replayFile(3); }
    function test_diff_file004() public { _replayFile(4); }
    function test_diff_file005() public { _replayFile(5); }
    function test_diff_file006() public { _replayFile(6); }
    function test_diff_file007() public { _replayFile(7); }
    function test_diff_file008() public { _replayFile(8); }
    function test_diff_file009() public { _replayFile(9); }
    function test_diff_file010() public { _replayFile(10); }
}
