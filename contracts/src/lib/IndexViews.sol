// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, RecS, Calc, Prof} from "./IndexTypes.sol";
import {IndexLib} from "./IndexLib.sol";

/// @title IndexViews: previewRecord and previewFix (BUILD-SPEC 4.12). A linked library.
library IndexViews {
    using IndexLib for Store;
    using IndexLib for RecS;

    // ------------------------------------------------------------------ previews (4.12)

    function previewRecord(Store storage s, Prof memory pf, bytes32 id, uint32 d, address w)
        external
        view
        returns (bool ok, IAgateIndex.RecordDetail memory det)
    {
        GpuS storage g = s.gpus[id];
        if (g.nSlots == 0) return (false, det);
        bool fromBase;
        uint64 t;
        RecS storage r = s.recs[id][d];
        if (g.head > 0 && d == g.head - 1 && r.exists() && r.status != IAgateIndex.Status.CARRIED && !r.isFinal()) {
            fromBase = true;
            t = r.postedAt;
        } else if (d == g.head) {
            t = uint64(block.timestamp);
        } else {
            return (false, det);
        }
        if (!s.eligible(id, d, w)) return (false, det);
        Calc memory c = s.calc(pf, id, d, w, fromBase);
        if (c.quorum < pf.qMin) return (false, det);
        // the pending record's own source: what is stored (needsSign and finalAt as at its close or countersign, I19)
        if (fromBase && w == r.source) {
            det = _detail(pf, c, w, t, r.needsSign);
            det.rec.finalAt = r.finalAt;
            return (true, det);
        }
        return (true, _detail(pf, c, w, t, s.needsSign(pf, id, d, w, c)));
    }

    function previewFix(Store storage s, Prof memory pf, bytes32 id)
        external
        view
        returns (bool ok, IAgateIndex.RecordDetail memory det)
    {
        GpuS storage g = s.gpus[id];
        if (g.nSlots == 0) return (false, det);
        uint32 d = g.head;
        (address src, address fw, Calc memory c) = s.pick(pf, id, d, IndexLib.dayStart(pf, d) + pf.day);
        if (src == address(0)) return (false, det);
        return (true, _detail(pf, c, src, uint64(block.timestamp), c.changed || pf.signAll || src != fw));
    }

    function _detail(Prof memory pf, Calc memory c, address w, uint64 t, bool ns)
        private
        pure
        returns (IAgateIndex.RecordDetail memory det)
    {
        det.rec.value = c.value;
        det.rec.status = c.status;
        det.rec.fresh = c.fresh;
        det.rec.quorum = c.quorum;
        det.rec.held = c.held;
        det.rec.freshMedian = c.freshMedian;
        det.rec.late = c.late;
        det.rec.incomplete = !c.complete;
        det.rec.changed = c.changed;
        det.rec.needsSign = ns;
        det.rec.source = w;
        det.rec.postedAt = t;
        det.rec.finalAt = ns ? 0 : uint64(t + pf.tPend);
        det.rec.digest = c.digest;
        det.p = c.p;
        det.kinds = c.kinds;
        det.counts = c.counts;
        det.post = c.post;
    }
}
