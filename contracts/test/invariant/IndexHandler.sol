// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex, HOLD_DAYS, TICK, P_MIN, P_MAX} from "../../src/interfaces/IAgateIndex.sol";

/// Random writers, closes, carries, attests, selects, vetoes, suspensions and dark slots against one index (TEST
/// clock). Violations found inside an action are recorded (a handler revert is discarded by the fuzzer).
contract IndexHandler is Test {
    AgateIndex public ix;
    bytes32 public constant GPU = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    uint64 public constant CHAIN = 2_183_018_362_218_727_504;
    address public w1;
    address public w2;
    address public att;
    address public g1;
    address public keeper;
    address public owner;
    uint256 public day;
    uint256 public slice;
    uint256 public tPend;
    uint32 public firstDay;
    uint256 public nSlots;

    // ghosts
    string public violation;
    mapping(uint32 => bytes32) public signedDigest; // the digest a successful countersign or select named
    mapping(uint32 => bytes32) public finalHash; // a record's hash once seen final
    mapping(bytes32 => uint256) public calls;
    uint32 public maxDaySeen;

    constructor(AgateIndex ix_, address[6] memory roles, uint32 first, uint256 n) {
        ix = ix_;
        (w1, w2, att, g1, keeper, owner) = (roles[0], roles[1], roles[2], roles[3], roles[4], roles[5]);
        IAgateIndex.Clocks memory c = ix.clocks();
        day = c.day;
        slice = c.slice;
        tPend = c.tPend;
        firstDay = first;
        nSlots = n;
    }

    function _fail(string memory why) internal {
        if (bytes(violation).length == 0) violation = why;
    }

    modifier checked() {
        _;
        _after();
    }

    /// I18: a final record never changes and never disappears.
    function _after() internal {
        uint32 h = ix.head(GPU);
        for (uint32 d = firstDay; d < h; ++d) {
            (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, d);
            bytes32 seen = finalHash[d];
            if (!e) {
                if (seen != bytes32(0)) _fail("I18: a final record vanished");
                continue;
            }
            if (!f) continue;
            bytes32 hh = keccak256(abi.encode(r));
            if (seen == bytes32(0)) finalHash[d] = hh;
            else if (seen != hh) _fail("I18: a final record changed");
        }
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    // ------------------------------------------------------------------ time

    function wait(uint256 dt) external checked {
        vm.warp(_now() + bound(dt, 1, day / 2));
        ++calls["wait"];
    }

    function waitLong(uint256 dt) external checked {
        vm.warp(_now() + bound(dt, day / 2, 3 * day));
        ++calls["waitLong"];
    }

    // ------------------------------------------------------------------ writers

    function _values(uint256 seed, address w) internal view returns (uint32[] memory v) {
        v = new uint32[](nSlots);
        for (uint256 i; i < nSlots; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i))) % 20;
            if (r < 3) continue; // dark
            if (r == 3) {
                v[i] = 3_000_001; // off the cent grid: E8
                continue;
            }
            v[i] = uint32(3_000_000 + (r % 6) * 100_000 + (w == w2 && r % 5 == 0 ? 10_000 : 0));
        }
    }

    function post(uint256 wSeed, uint256 vSeed, uint256 back) external checked {
        address w = wSeed % 2 == 0 ? w1 : w2;
        uint256 t = _now();
        uint256 epochTs = ix.clocks().epochTs;
        if (t < epochTs) return;
        uint32 d = ix.dayId(uint64(t));
        // sometimes a repost into an earlier slice of the day, or into the previous day (allowed while it is open)
        uint256 h = (t - ix.dayStart(d)) / slice;
        uint64 readAt = uint64(t);
        if (back % 4 == 1 && h > 0) {
            h = back % (h + 1);
            readAt = uint64(ix.dayStart(d) + h * slice + (back % slice));
            if (readAt > t) readAt = uint64(t);
        } else if (back % 4 == 2 && d > firstDay) {
            d -= 1;
            h = back % (day / slice);
            readAt = uint64(ix.dayStart(d) + h * slice);
        }
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](1);
        es[0] = IAgateIndex.Entry(GPU, d, uint8(h), readAt, _values(vSeed, w));
        IAgateIndex.Readings memory before = ix.readings(GPU, d, w);
        uint32 headBefore = ix.head(GPU);
        vm.prank(w);
        try ix.postReport(abi.encode(uint8(1), CHAIN, address(ix), es)) {
            IAgateIndex.Readings memory a = ix.readings(GPU, d, w);
            bool accepted = a.sliceBits != before.sliceBits;
            if (accepted && d < headBefore) _fail("I20: readings accepted for a closed day");
            if (accepted && (before.sliceBits >> h) & 1 == 1) _fail("I20: duplicate slice accepted");
            if (ix.head(GPU) != headBefore) _fail("I20: a report closed a day");
            if (d > maxDaySeen) maxDaySeen = d;
            ++calls["post"];
        } catch {
            ++calls["postReverted"];
        }
    }

    /// One report with every slice of the head day (or today) up to now, the same values on each slice.
    function postAll(uint256 wSeed, uint256 vSeed) external checked {
        address w = wSeed % 2 == 0 ? w1 : w2;
        uint256 t = _now();
        uint32 today = ix.dayId(uint64(t));
        uint32 d = ix.head(GPU);
        if (d > today) d = today;
        uint256 start = ix.dayStart(d);
        if (t < start) return;
        uint256 last = (t - start) / slice;
        if (last >= day / slice) last = day / slice - 1;
        uint256 skip = vSeed % 7 == 0 ? (vSeed >> 8) % (last + 1) : type(uint256).max; // sometimes miss one slice
        uint256 n = last + 1 - (skip <= last ? 1 : 0);
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](n);
        uint32[] memory v = _values(vSeed, w);
        uint256 k;
        for (uint256 h; h <= last; ++h) {
            if (h == skip) continue;
            uint256 ra = start + h * slice + 1;
            if (ra > t) ra = t;
            es[k++] = IAgateIndex.Entry(GPU, d, uint8(h), uint64(ra), v);
        }
        uint32 headBefore = ix.head(GPU);
        vm.prank(w);
        try ix.postReport(abi.encode(uint8(1), CHAIN, address(ix), es)) {
            if (ix.head(GPU) != headBefore) _fail("I20: a report closed a day");
            ++calls["post"];
        } catch {
            ++calls["postReverted"];
        }
    }

    // ------------------------------------------------------------------ days

    function _who(uint256 seed) internal view returns (address) {
        uint256 k = seed % 3;
        return k == 0 ? w1 : (k == 1 ? w2 : keeper);
    }

    function close(uint256 seed) external checked {
        uint32 h = ix.head(GPU);
        uint256 at = ix.dayStart(h) + day + slice + (seed >> 8) % (day / 2);
        if (seed % 2 == 0 && _now() < at) vm.warp(at);
        vm.prank(_who(seed));
        try ix.closeDay(GPU) returns (uint32 d) {
            if (d != h || ix.head(GPU) != h + 1) _fail("I18: closeDay closed something other than the head");
            (, , IAgateIndex.Record memory r) = ix.record(GPU, d);
            if (r.postedAt < ix.dayStart(d) + day + slice) _fail("I18: a record before dayEnd + CLOSE_GRACE");
            if (r.changed && !r.needsSign) _fail("I16: a changed record without needsSign");
            ++calls["close"];
        } catch {
            ++calls["closeReverted"];
        }
    }

    function carry(uint256 seed) external checked {
        uint32 h = ix.head(GPU);
        if (seed % 3 == 0) {
            uint256 at = ix.dayStart(h) + 2 * day;
            uint256 st = uint256(ix.gpu(GPU).lastCarryAt) + day / 6;
            if (st > at) at = st;
            if (_now() < at) vm.warp(at);
        }
        (IAgateIndex.SlotState[] memory b0, IAgateIndex.SlotState[] memory l0) = ix.slotStates(GPU);
        vm.prank(_who(seed));
        try ix.carryDay(GPU) returns (uint8 cc) {
            uint32 d = cc == 1 ? h - 1 : h;
            (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, d);
            IAgateIndex.SlotState[] memory pre = cc == 1 ? b0 : l0;
            if (e) {
                if (r.status != IAgateIndex.Status.CARRIED || !f) _fail("I17: carried record not CARRIED and final");
                (,, IAgateIndex.Record memory prev) = ix.record(GPU, d - 1);
                if (r.value != prev.value) _fail("I17: carried value differs from the previous record");
                (IAgateIndex.SlotState[] memory b1, IAgateIndex.SlotState[] memory l1) = ix.slotStates(GPU);
                // when the chained close ran, last moved on; check the carry against base in that case
                IAgateIndex.SlotState[] memory after_ = ix.head(GPU) == d + 1 ? l1 : b1;
                for (uint256 i; i < pre.length; ++i) {
                    if (after_[i].e != pre[i].e || after_[i].inMedian != pre[i].inMedian || after_[i].wasIn != pre[i].wasIn) {
                        _fail("I17: a carry changed e, inMedian or wasIn");
                    }
                    bool same = after_[i].miss == pre[i].miss;
                    bool adv = after_[i].miss == pre[i].miss + 1 && after_[i].miss <= HOLD_DAYS;
                    if (!same && !adv) _fail("I17: a carry moved a counter other than +1 up to HOLD_DAYS");
                }
            }
            ++calls[cc == 1 ? bytes32("drop") : bytes32("carry")];
        } catch {
            ++calls["carryReverted"];
        }
    }

    // ------------------------------------------------------------------ second key

    function attest(uint256 seed, uint256 mode) external checked {
        uint32 h = ix.head(GPU);
        if (h == 0) return;
        uint32 d = h - 1;
        (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, d);
        if (!e || f) return;
        address by = seed % 2 == 0 ? att : g1;
        mode = mode % 20;
        mode = mode < 10 ? 0 : (mode < 13 ? 1 : (mode < 18 ? 2 : 3)); // mostly honest countersigns and selects
        address w = r.source;
        bytes32 dg = r.digest;
        if (mode == 1) dg = keccak256(abi.encode(seed));
        if (mode >= 2) {
            w = r.source == w1 ? w2 : w1;
            (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, w);
            dg = ok && mode == 2 ? det.rec.digest : keccak256(abi.encode(seed, 1));
        }
        vm.prank(by);
        try ix.attest(GPU, d, w, dg) {
            (,, IAgateIndex.Record memory a) = ix.record(GPU, d);
            if (a.digest != dg) _fail("I16: attest landed on a digest it did not name");
            if (a.attestedBy != by) _fail("attestedBy");
            signedDigest[d] = dg;
            ++calls[mode >= 2 ? bytes32("select") : bytes32("attest")];
        } catch {
            ++calls["attestReverted"];
        }
    }

    function veto(uint256 seed) external checked {
        uint32 h = ix.head(GPU);
        if (h == 0) return;
        uint32 d = h - 1;
        (bool e,, IAgateIndex.Record memory r) = ix.record(GPU, d);
        if (!e) return;
        bool stale = seed % 5 == 0;
        vm.prank(g1);
        try ix.veto(GPU, d, stale ? keeper : r.source, r.digest) {
            if (stale) _fail("F2: a stale veto landed");
            if (!ix.isVoided(GPU, d, r.source)) _fail("I21: a veto voided nobody");
            ++calls["veto"];
        } catch {
            ++calls["vetoReverted"];
        }
    }

    /// Rare: the guardian suspends the standby; the owner appoints it again after the timelock.
    function suspendStandby(uint256 seed) external checked {
        if (seed % 6 != 0) return;
        vm.prank(g1);
        ix.suspend(w2);
        ++calls["suspend"];
    }

    function reappointStandby() external checked {
        if (!ix.isSuspended(w2)) return;
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.WRITER;
        a.slot = 1;
        a.addr = w2;
        bytes32 id = ix.actionId(a);
        uint64 eta = ix.queuedEta(id);
        vm.startPrank(owner);
        if (eta == 0) {
            ix.queue(a);
        } else if (_now() >= eta) {
            ix.execute(a);
            ++calls["reappoint"];
        }
        vm.stopPrank();
    }

    /// Negative control only (never a fuzz target): what an attest that skipped the digest check would leave behind:
    /// the record attested and final, the ghost holding the digest the caller named.
    function mutantAttest(uint32 d, bytes32 named) external {
        bytes32 slot = keccak256(abi.encode(uint256(d), keccak256(abi.encode(GPU, uint256(10))))); // Store.recs
        (,, IAgateIndex.Record memory r) = ix.record(GPU, d);
        uint256 word = uint256(r.postedAt + tPend) | (uint256(_now()) << 64);
        vm.store(address(ix), bytes32(uint256(slot) + 2), bytes32(word));
        signedDigest[d] = named;
    }

    // ------------------------------------------------------------------ checks used by the invariants

    /// I18, I16, I17, I19 over every day from the first registered day to the head. Returns "" or the violation.
    function checkRecords() external view returns (string memory) {
        uint32 h = ix.head(GPU);
        (bool fe, uint32 fd) = ix.firstRecordDay(GPU);
        uint256 pending;
        for (uint32 d = firstDay; d <= h; ++d) {
            (bool e, bool f, IAgateIndex.Record memory r) = ix.record(GPU, d);
            if (d == h && e) return "I18: a record at the head";
            if (!e) {
                if (fe && d >= fd && d < h) return "I18: a gap after the first record";
                continue;
            }
            if (fe && d < fd) return "I18: a record before firstRecordDay";
            if (!f) {
                ++pending;
                if (d != h - 1) return "I18: a pending record that is not the newest";
            }
            if (r.status == IAgateIndex.Status.CARRIED) {
                if (!f || r.finalAt != r.postedAt) return "I17: a carried record not final at once";
                if (r.source != address(0) || r.digest != bytes32(0)) return "I17: carried record fields";
            } else {
                if (r.value % TICK != 0 || r.value < P_MIN || r.value > P_MAX) return "I19: value off grid or bounds";
                if (r.quorum < ix.clocks().qMin) return "I19: below quorum";
                if (r.changed && !r.needsSign) return "I16: changed without needsSign";
                if (f && r.finalAt < r.postedAt + tPend) return "I18: final before postedAt + T_PEND";
                if (r.needsSign && r.finalAt != 0 && (r.attestedAt == 0 || signedDigest[d] != r.digest)) {
                    return "I16: a needsSign record final without a countersign on its exact digest";
                }
                if (!f) {
                    (bool ok, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, r.source);
                    if (ok && det.rec.digest != r.digest) return "I19: pending record differs from previewRecord";
                }
            }
        }
        if (pending > 1) return "I18: more than one pending record";
        return "";
    }
}
