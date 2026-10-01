// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex, HOLD_DAYS} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, RecS, Calc, Prof} from "./IndexTypes.sol";
import {IndexMath} from "./IndexFormula.sol";
import {IndexLib} from "./IndexLib.sol";

/// @title IndexDays: closeDay, carryDay, attest / select and veto (BUILD-SPEC 4.7 to 4.9).
/// A linked library: every function runs in the index's context by DELEGATECALL, events come from the index.
library IndexDays {
    using IndexLib for Store;
    using IndexLib for RecS;

    // ------------------------------------------------------------------ closeDay (4.7)

    function close(Store storage s, Prof memory pf, bytes32 id, address caller) external returns (uint32 d) {
        (, d) = _close(s, pf, id, caller, false);
    }

    /// C1..C7. soft: return false instead of reverting on a C check (carryDay's chained close).
    function _close(Store storage s, Prof memory pf, bytes32 id, address caller, bool soft)
        private
        returns (bool, uint32 d)
    {
        GpuS storage g = s.gpus[id];
        d = g.head;
        uint256 end = IndexLib.dayStart(pf, d) + pf.day;
        if (block.timestamp < end + pf.slice) {
            if (soft) return (false, d);
            revert IAgateIndex.C1_DayNotOver(d, uint64(end + pf.slice));
        }
        if (d > 0) {
            RecS storage prev = s.recs[id][d - 1];
            if (prev.exists() && !prev.isFinal()) {
                if (soft) return (false, d);
                revert IAgateIndex.C2_PreviousNotFinal(d - 1);
            }
        }
        (address src, address fw, Calc memory c) = s.pick(pf, id, d, end);
        if (src == address(0)) {
            if (soft) return (false, d);
            revert IAgateIndex.C3_BelowQuorum(d);
        }
        if (
            (block.timestamp < end + pf.tPend && !c.complete && caller != src)
                || !(s.activeWriter(caller) || c.complete || block.timestamp >= IndexLib.graceStart(pf, g, d) + pf.day)
        ) {
            if (soft) return (false, d);
            revert IAgateIndex.C4_CallerNotAllowed(caller, src);
        }
        bool ns = c.changed || pf.signAll || src != fw;
        RecS storage r = s.recs[id][d];
        _write(r, src, c, uint64(block.timestamp), ns);
        r.finalAt = ns ? 0 : uint64(block.timestamp + pf.tPend);
        g.base = g.last;
        IndexLib.setLast(g, c);
        g.head = d + 1;
        if (!g.frExists) {
            g.frExists = true;
            g.frDay = d;
        }
        emit IAgateIndex.DayClosed(
            id, d, src, c.value, c.status, c.fresh, c.held, c.freshMedian, c.changed, ns, c.late, !c.complete, c.digest
        );
        emit IAgateIndex.RecordSlots(id, d, src, c.digest, c.p, c.kinds, c.counts, c.post);
        return (true, d);
    }

    // ------------------------------------------------------------------ carryDay (4.9)

    function carry(Store storage s, Prof memory pf, bytes32 id, address caller) external returns (uint8 carryCase) {
        GpuS storage g = s.gpus[id];
        uint32 d = g.head;
        bool dropped;
        RecS storage pend = s.recs[id][d > 0 ? d - 1 : 0];
        if (d > 0 && pend.exists() && !pend.isFinal()) {
            d -= 1;
            if (!pend.needsSign || pend.attestedAt != 0 || pend.finalAt != 0) {
                revert IAgateIndex.Carry1_NotDroppable(id, d);
            }
            uint256 at = IndexLib.max3(
                IndexLib.graceStart(pf, g, d) + 7 * pf.day,
                uint256(pend.postedAt) + 3 * pf.day / 4,
                uint256(g.lastCarryAt) + pf.day / 6
            );
            if (block.timestamp < at) revert IAgateIndex.Carry1_TooEarly(uint64(at));
            emit IAgateIndex.FixDropped(id, d, pend.source, pend.value, pend.digest);
            delete s.recs[id][d];
            if (g.frExists && g.frDay == d) {
                g.frExists = false;
                g.frDay = 0;
            }
            g.last = g.base;
            g.head = d;
            dropped = true;
            carryCase = 1;
        } else {
            if (block.timestamp < IndexLib.dayStart(pf, d) + pf.day) revert IAgateIndex.Carry2_DayNotOver(d);
            if (d > 0) {
                RecS storage prev = s.recs[id][d - 1];
                if (prev.exists() && !prev.isFinal()) revert IAgateIndex.Carry2_PreviousNotFinal(d - 1);
            }
            uint256 ro = s.reopenedAt[id][d];
            uint256 at = IndexLib.max3(
                IndexLib.graceStart(pf, g, d) + pf.day, uint256(g.lastCarryAt) + pf.day / 6, ro > 0 ? ro + pf.day / 4 : 0
            );
            if (block.timestamp < at) revert IAgateIndex.Carry2_TooEarly(uint64(at));
            for (uint256 k; k < 2; ++k) {
                address w = s.writers[k];
                if (s.eligible(id, d, w) && s.calc(pf, id, d, w, false).quorum >= pf.qMin) {
                    revert IAgateIndex.Carry2_HasQuorum(w);
                }
            }
            carryCase = 2;
        }
        g.lastCarryAt = uint64(block.timestamp);
        RecS storage before = s.recs[id][d > 0 ? d - 1 : 0];
        if (d > 0 && before.exists()) {
            uint32 mask = _carryPost(s, pf, id, g, d);
            RecS storage r = s.recs[id][d];
            r.value = before.value;
            r.status = IAgateIndex.Status.CARRIED;
            r.postedAt = uint64(block.timestamp);
            r.finalAt = uint64(block.timestamp);
            r.dropped = dropped;
            emit IAgateIndex.DayCarried(id, d, before.value, carryCase, dropped, mask);
        } else {
            emit IAgateIndex.DaySkipped(id, d, carryCase);
        }
        g.head = d + 1;
        _close(s, pf, id, caller, true);
    }

    /// carryPost (4.9): base = last; last = last with the miss counter advanced (never past HOLD_DAYS) of every
    /// readable slot that every eligible writer of d (at least one) read below MIN_READINGS.
    function _carryPost(Store storage s, Prof memory pf, bytes32 id, GpuS storage g, uint32 d)
        private
        returns (uint32 mask)
    {
        uint64[15] memory post = g.last;
        g.base = post;
        uint256[3][2] memory pk;
        bool[2] memory el;
        bool any;
        for (uint256 k; k < 2; ++k) {
            address w = s.writers[k];
            if (s.eligible(id, d, w)) {
                el[k] = true;
                any = true;
                pk[k] = s.accs[id][d][w].packed;
            }
        }
        if (!any) return 0;
        uint256 n = g.nSlots;
        for (uint256 i; i < n; ++i) {
            if (uint8(post[i] >> 32) >= HOLD_DAYS || !IndexMath.readable(g, i, d)) continue;
            bool allLow = true;
            for (uint256 k; k < 2; ++k) {
                if (el[k] && IndexMath.count(pk[k], i) >= pf.minReadings) allLow = false;
            }
            if (allLow) {
                post[i] += uint64(1) << 32;
                mask |= uint32(1) << uint32(i);
            }
        }
        if (mask != 0) g.last = post;
    }

    // ------------------------------------------------------------------ second key (4.8)

    function attest(Store storage s, Prof memory pf, bytes32 id, uint32 d, address writer, bytes32 digest, address by)
        external
    {
        GpuS storage g = s.gpus[id];
        RecS storage r = _pending(s, id, d);
        if (r.attestedAt != 0) revert IAgateIndex.AlreadyAttested(id, d);
        uint256 finalAt = uint256(r.postedAt) + pf.tPend;
        if (finalAt < block.timestamp) finalAt = block.timestamp;
        if (writer == r.source) {
            if (digest != r.digest) revert IAgateIndex.DigestMismatch(r.digest, digest);
            r.attestedAt = uint64(block.timestamp);
            r.attestedBy = by;
            if (r.needsSign) r.finalAt = uint64(finalAt);
            emit IAgateIndex.Attested(id, d, by, writer, digest, r.finalAt);
            return;
        }
        if (!s.eligible(id, d, writer)) revert IAgateIndex.SelectNotEligible(writer);
        if (by == s.attester && s.accs[id][d][writer].sliceBits != pf.fullBits) {
            revert IAgateIndex.SelectIncomplete(writer);
        }
        Calc memory c = s.calc(pf, id, d, writer, true);
        if (c.quorum < pf.qMin) revert IAgateIndex.SelectBelowQuorum(writer);
        if (c.digest != digest) revert IAgateIndex.DigestMismatch(c.digest, digest);
        emit IAgateIndex.RecordReplaced(id, d, by, r.source, writer, r.value, c.value, r.digest, c.digest);
        _write(r, writer, c, r.postedAt, s.needsSign(pf, id, d, writer, c));
        r.finalAt = uint64(finalAt);
        r.attestedAt = uint64(block.timestamp);
        r.attestedBy = by;
        IndexLib.setLast(g, c);
        emit IAgateIndex.RecordSlots(id, d, writer, c.digest, c.p, c.kinds, c.counts, c.post);
        emit IAgateIndex.Attested(id, d, by, writer, c.digest, uint64(finalAt));
    }

    function veto(Store storage s, bytes32 id, uint32 d, address source, bytes32 digest, address by) external {
        GpuS storage g = s.gpus[id];
        RecS storage r = _pending(s, id, d);
        if (r.source != source || r.digest != digest) revert IAgateIndex.VetoStale(r.source, r.digest);
        uint32 value = r.value;
        delete s.recs[id][d];
        g.last = g.base;
        s.voided[id][d][source] = true;
        s.reopenedAt[id][d] = uint64(block.timestamp);
        g.head = d;
        if (g.frExists && g.frDay == d) {
            g.frExists = false;
            g.frDay = 0;
        }
        emit IAgateIndex.Vetoed(id, d, by, source, digest, value);
    }

    /// The pending record: d == head - 1, it exists and is not final (a CARRIED record is final at once).
    function _pending(Store storage s, bytes32 id, uint32 d) private view returns (RecS storage r) {
        uint32 h = s.gpus[id].head;
        r = s.recs[id][d];
        if (h == 0 || d != h - 1 || !r.exists()) revert IAgateIndex.NoPendingRecord(id, d);
        if (r.isFinal()) revert IAgateIndex.AlreadyFinal(id, d);
    }

    // ------------------------------------------------------------------ internals

    function _write(RecS storage r, address src, Calc memory c, uint64 postedAt, bool ns) private {
        r.source = src;
        r.value = c.value;
        r.freshMedian = c.freshMedian;
        r.status = c.status;
        r.fresh = c.fresh;
        r.quorum = c.quorum;
        r.held = c.held;
        r.attestedBy = address(0);
        r.postedAt = postedAt;
        r.late = c.late;
        r.incomplete = !c.complete;
        r.changed = c.changed;
        r.needsSign = ns;
        r.attestedAt = 0;
        r.dropped = false;
        r.digest = c.digest;
    }
}
