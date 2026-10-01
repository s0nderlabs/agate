// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex, TICK, HOLD_DAYS, SHADOW_DAYS, NEVER} from "../interfaces/IAgateIndex.sol";
import {DateLib} from "./DateLib.sol";
import {GpuS, AccS, Calc, Prof} from "./IndexTypes.sol";

/// @title IndexMath: cent rounding, median, slot-state packing
library IndexMath {
    uint256 internal constant SUM_MASK = (1 << 40) - 1;

    /// To the cent, halves up.
    function cent(uint256 v) internal pure returns (uint256) {
        return (v + TICK / 2) / TICK * TICK;
    }

    /// Median of b[0..k) (k >= 1), sorting that prefix in place. Even k: mean of the two middle values.
    function median(uint256[] memory b, uint256 k) internal pure returns (uint256) {
        for (uint256 i = 1; i < k; ++i) {
            uint256 x = b[i];
            uint256 j = i;
            while (j > 0 && b[j - 1] > x) {
                b[j] = b[j - 1];
                --j;
            }
            b[j] = x;
        }
        return k % 2 == 1 ? b[k / 2] : (b[k / 2 - 1] + b[k / 2]) / 2;
    }

    function unpack(uint64 x) internal pure returns (IAgateIndex.SlotState memory s) {
        s.e = uint32(x);
        s.miss = uint8(x >> 32);
        s.inMedian = (x >> 40) & 1 == 1;
        s.wasIn = (x >> 41) & 1 == 1;
    }

    function pack(IAgateIndex.SlotState memory s) internal pure returns (uint64) {
        return uint64(s.e) | (uint64(s.miss) << 32) | (s.inMedian ? uint64(1) << 40 : 0)
            | (s.wasIn ? uint64(1) << 41 : 0);
    }

    function readable(GpuS storage g, uint256 i, uint256 d) internal view returns (bool) {
        uint256 lf = g.liveFrom[i];
        return lf != NEVER && lf <= d + SHADOW_DAYS && d < g.liveUntil[i];
    }

    function count(uint256[3] memory packed, uint256 i) internal pure returns (uint256) {
        return (packed[i / 5] >> (48 * (i % 5) + 40)) & 0xff;
    }

    function sum(uint256[3] memory packed, uint256 i) internal pure returns (uint256) {
        return (packed[i / 5] >> (48 * (i % 5))) & SUM_MASK;
    }

    function digest(
        bytes32 gpuId,
        uint32 day,
        address source,
        uint32[] memory p,
        IAgateIndex.Kind[] memory kinds,
        uint8[] memory counts,
        IAgateIndex.SlotState[] memory post,
        uint32 value
    ) internal pure returns (bytes32) {
        uint256 n = post.length;
        bool[] memory inMedian = new bool[](n);
        uint8[] memory miss = new uint8[](n);
        bool[] memory wasIn = new bool[](n);
        for (uint256 i; i < n; ++i) {
            inMedian[i] = post[i].inMedian;
            miss[i] = post[i].miss;
            wasIn[i] = post[i].wasIn;
        }
        return keccak256(abi.encode(gpuId, day, source, p, kinds, counts, inMedian, miss, wasIn, value));
    }
}

/// @title IndexFormula: the daily formula of BUILD-SPEC 4.6 from one writer's accumulators.
library IndexFormula {
    using IndexMath for uint256;

    struct In {
        bytes32 gpuId;
        uint32 day;
        address writer;
        bool fromBase; // pre = base (the pending day) or last (the head day)
        bool prevExists;
        uint32 prevValue;
    }

    function compute(GpuS storage g, AccS storage a, In memory x, Prof memory pf)
        internal
        view
        returns (Calc memory r)
    {
        uint256 n = g.nSlots;
        r.p = new uint32[](n);
        r.kinds = new IAgateIndex.Kind[](n);
        r.counts = new uint8[](n);
        r.post = new IAgateIndex.SlotState[](n);
        bool moved = _slots(g, a.packed, x, pf.minReadings, r);
        _families(g, r, n);
        r.changed = !x.prevExists || r.value != x.prevValue || moved;
        r.complete = a.sliceBits == pf.fullBits;
        r.late = a.late;
        r.digest = IndexMath.digest(x.gpuId, x.day, x.writer, r.p, r.kinds, r.counts, r.post, r.value);
    }

    /// The per-slot part of 4.6. Returns true if membership changed or an entry day found a live slot out.
    function _slots(GpuS storage g, uint256[3] memory packed, In memory x, uint256 minReadings, Calc memory r)
        private
        view
        returns (bool moved)
    {
        uint256 d = x.day;
        uint64[15] memory pre = x.fromBase ? g.base : g.last;
        uint32[15] memory from = g.liveFrom;
        uint32[15] memory until = g.liveUntil;
        bool entry = DateLib.isFirstOfMonth(d) || !(g.frExists && g.frDay < d);
        for (uint256 i; i < r.post.length; ++i) {
            IAgateIndex.SlotState memory pr = IndexMath.unpack(pre[i]);
            IAgateIndex.SlotState memory po = IndexMath.unpack(pre[i]);
            bool live = from[i] <= d && d < until[i];
            if (!(from[i] != NEVER && from[i] <= d + SHADOW_DAYS && d < until[i])) {
                po.inMedian = false;
                po.miss = HOLD_DAYS + 1;
            } else {
                uint256 c = IndexMath.count(packed, i);
                r.counts[i] = uint8(c);
                if (c >= minReadings) {
                    uint32 v = uint32((IndexMath.sum(packed, i) / c).cent());
                    r.p[i] = v;
                    po.e = v;
                    po.miss = 0;
                } else {
                    po.miss = pr.miss >= HOLD_DAYS ? HOLD_DAYS + 1 : pr.miss + 1;
                }
                po.inMedian = live && po.miss <= HOLD_DAYS && (pr.wasIn || entry);
                if (po.inMedian) {
                    po.wasIn = true;
                    r.kinds[i] = po.miss == 0 ? IAgateIndex.Kind.FRESH : IAgateIndex.Kind.HELD;
                }
            }
            if (po.inMedian != pr.inMedian || (entry && live && !pr.inMedian)) moved = true;
            r.post[i] = po;
        }
    }

    struct Tally {
        uint256 nVals;
        uint256 nMeds;
        uint256 q;
        uint256 freshF;
        uint256 held;
        bool anyFresh;
    }

    function _families(GpuS storage g, Calc memory r, uint256 n) private view {
        uint256 nF = g.nFamilies;
        uint8[15] memory fam = g.family;
        uint8[15] memory famQ = g.famQ;
        uint256[] memory buf = new uint256[](n);
        uint256[] memory famVals = new uint256[](nF);
        uint256[] memory freshMeds = new uint256[](nF);
        Tally memory t;
        for (uint256 f; f < nF; ++f) {
            (uint256 k, uint256 nf) = _collect(r, fam, n, f, buf, false);
            t.held += k - nf;
            if (k > 0) famVals[t.nVals++] = IndexMath.median(buf, k).cent();
            if (nf > 0) t.anyFresh = true;
            if (nf >= famQ[f]) {
                ++t.freshF;
                (uint256 k2,) = _collect(r, fam, n, f, buf, true);
                freshMeds[t.nMeds++] = IndexMath.median(buf, k2).cent();
            }
            if (k >= famQ[f]) ++t.q;
        }
        r.quorum = t.anyFresh ? uint8(t.q) : 0;
        r.value = t.nVals == 0 ? 0 : uint32(IndexMath.median(famVals, t.nVals).cent());
        r.freshMedian = t.nMeds == 0 ? 0 : uint32(IndexMath.median(freshMeds, t.nMeds).cent());
        r.fresh = uint8(t.freshF);
        r.held = uint8(t.held);
        r.status = t.freshF >= 5
            ? IAgateIndex.Status.FULL
            : t.freshF >= 3 ? IAgateIndex.Status.DEGRADED : IAgateIndex.Status.DEMO;
    }

    /// Fills buf with family f's IN slots' held values (or, freshOnly, its FRESH slots' day values).
    /// Returns (values written, FRESH slots of f).
    function _collect(Calc memory r, uint8[15] memory fam, uint256 n, uint256 f, uint256[] memory buf, bool freshOnly)
        private
        pure
        returns (uint256 k, uint256 nf)
    {
        for (uint256 i; i < n; ++i) {
            if (fam[i] != f || r.kinds[i] == IAgateIndex.Kind.OUT) continue;
            bool fresh = r.kinds[i] == IAgateIndex.Kind.FRESH;
            if (fresh) ++nf;
            if (!freshOnly) buf[k++] = r.post[i].e;
            else if (fresh) buf[k++] = r.p[i];
        }
    }
}
