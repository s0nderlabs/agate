// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, RecS, Calc, Prof} from "./IndexTypes.sol";
import {IndexMath, IndexFormula} from "./IndexFormula.sol";

/// @title IndexLib: shared internal helpers over the index's Store (roles, eligibility, clocks, the formula call)
library IndexLib {
    function isFinal(RecS storage r) internal view returns (bool) {
        uint256 f = r.finalAt;
        return f != 0 && block.timestamp >= f;
    }

    function exists(RecS storage r) internal view returns (bool) {
        return r.status != IAgateIndex.Status.NONE;
    }

    function isWriter(Store storage s, address w) internal view returns (bool) {
        return w != address(0) && (w == s.writers[0] || w == s.writers[1]);
    }

    /// A2 and the C4 caller test: a writer slot address, not suspended, without code.
    function activeWriter(Store storage s, address w) internal view returns (bool) {
        return isWriter(s, w) && !s.suspended[w] && w.code.length == 0;
    }

    function isGuardian(Store storage s, address a) internal view returns (bool) {
        return a != address(0) && (a == s.guardians[0] || a == s.guardians[1]);
    }

    /// C3 eligibility: a writer slot address, nonzero, not suspended, not voided for d, with readings.
    function eligible(Store storage s, bytes32 id, uint32 d, address w) internal view returns (bool) {
        return isWriter(s, w) && !s.suspended[w] && !s.voided[id][d][w] && s.accs[id][d][w].sliceBits != 0;
    }

    /// The day's first writer: the first eligible writer in slot order with a valid value (C3).
    function firstWriter(Store storage s, bytes32 id, uint32 d) internal view returns (address) {
        for (uint256 k; k < 2; ++k) {
            address w = s.writers[k];
            if (eligible(s, id, d, w) && s.accs[id][d][w].anyValid) return w;
        }
        return address(0);
    }

    function dayId(Prof memory pf, uint256 t) internal pure returns (uint256) {
        return t < pf.epochTs ? pf.epochDay : pf.epochDay + (t - pf.epochTs) / pf.day;
    }

    function dayStart(Prof memory pf, uint256 d) internal pure returns (uint256) {
        return pf.epochTs + (d - pf.epochDay) * pf.day;
    }

    function graceStart(Prof memory pf, GpuS storage g, uint256 d) internal view returns (uint256) {
        uint256 end = dayStart(pf, d) + pf.day;
        return end > g.registeredAt ? end : g.registeredAt;
    }

    /// 4.6 for writer w on day d, with pre = base (fromBase, the pending day) or last (the head day).
    function calc(Store storage s, Prof memory pf, bytes32 id, uint32 d, address w, bool fromBase)
        internal
        view
        returns (Calc memory)
    {
        bool prevExists;
        uint32 prevValue;
        if (d > 0) {
            RecS storage prev = s.recs[id][d - 1];
            prevExists = exists(prev);
            prevValue = prev.value;
        }
        return IndexFormula.compute(
            s.gpus[id], s.accs[id][d][w], IndexFormula.In(id, d, w, fromBase, prevExists, prevValue), pf
        );
    }

    function needsSign(Store storage s, Prof memory pf, bytes32 id, uint32 d, address w, Calc memory c)
        internal
        view
        returns (bool)
    {
        return c.changed || pf.signAll || w != firstWriter(s, id, d);
    }

    function setLast(GpuS storage g, Calc memory c) internal {
        uint64[15] memory l;
        for (uint256 i; i < c.post.length; ++i) {
            l[i] = IndexMath.pack(c.post[i]);
        }
        g.last = l;
    }

    function max3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
        m = a > b ? a : b;
        if (c > m) m = c;
    }

    /// C3 for the head day d at now: (source or zero, the day's first writer, the source's formula).
    function pick(Store storage s, Prof memory pf, bytes32 id, uint32 d, uint256 end)
        internal
        view
        returns (address src, address fw, Calc memory c)
    {
        address[2] memory ws = s.writers;
        bool[2] memory el;
        uint256 kf = 2;
        for (uint256 k; k < 2; ++k) {
            el[k] = eligible(s, id, d, ws[k]);
            if (kf == 2 && el[k] && s.accs[id][d][ws[k]].anyValid) kf = k;
        }
        Calc[2] memory cs;
        bool[2] memory done;
        if (kf < 2) {
            fw = ws[kf];
            cs[kf] = calc(s, pf, id, d, fw, false);
            done[kf] = true;
            if (cs[kf].quorum >= pf.qMin) return (fw, fw, cs[kf]);
        }
        if (block.timestamp < end + pf.tPend) return (address(0), fw, c);
        for (uint256 k; k < 2; ++k) {
            if (!el[k]) continue;
            if (!done[k]) cs[k] = calc(s, pf, id, d, ws[k], false);
            if (cs[k].complete && cs[k].quorum >= pf.qMin) return (ws[k], fw, cs[k]);
        }
        for (uint256 k; k < 2; ++k) {
            if (el[k] && cs[k].quorum >= pf.qMin) return (ws[k], fw, cs[k]);
        }
    }
}
