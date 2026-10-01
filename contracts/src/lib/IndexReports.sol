// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex, TICK, P_MIN, P_MAX, REPORT_VERSION} from "../interfaces/IAgateIndex.sol";
import {Store, GpuS, AccS, Prof} from "./IndexTypes.sol";
import {IndexMath} from "./IndexFormula.sol";
import {IndexLib} from "./IndexLib.sol";

/// @title IndexReports: a writer's report, checks A3 and E1..E9 (BUILD-SPEC 4.5). A linked library.
library IndexReports {
    // ------------------------------------------------------------------ readings (4.5, A3 and E1..E9)

    function ingest(Store storage s, Prof memory pf, address w, bytes calldata report) external {
        (uint8 v, uint64 cs, address ix, IAgateIndex.Entry[] memory es) =
            abi.decode(report, (uint8, uint64, address, IAgateIndex.Entry[]));
        if (v != REPORT_VERSION || cs != pf.chainSelector || ix != address(this)) {
            revert IAgateIndex.A3_BadHeader(v, cs, ix);
        }
        for (uint256 k; k < es.length; ++k) {
            _entry(s, pf, w, es[k]);
        }
    }

    function _entry(Store storage s, Prof memory pf, address w, IAgateIndex.Entry memory e) private {
        bytes32 id = e.gpuId;
        GpuS storage g = s.gpus[id];
        uint256 n = g.nSlots;
        uint32 d = e.dayId;
        IAgateIndex.Skip sk;
        uint256 ss;
        if (n == 0 || e.values.length != n) {
            sk = IAgateIndex.Skip.E1_GPU_OR_LENGTH;
        } else if (e.slice >= pf.slices) {
            sk = IAgateIndex.Skip.E2_SLICE;
        } else if (d < g.firstDay || d < g.head) {
            sk = IAgateIndex.Skip.E3_DAY_CLOSED;
        } else if (s.voided[id][d][w]) {
            sk = IAgateIndex.Skip.E4_VOIDED;
        } else {
            ss = IndexLib.dayStart(pf, d) + uint256(e.slice) * pf.slice;
            if (e.readAt < ss || e.readAt >= ss + pf.slice) sk = IAgateIndex.Skip.E5_READ_AT_OUTSIDE_SLICE;
            else if (e.readAt > block.timestamp) sk = IAgateIndex.Skip.E6_READ_AT_FUTURE;
        }
        AccS storage a = s.accs[id][d][w];
        uint256 bit = uint256(1) << e.slice;
        if (sk == IAgateIndex.Skip.NONE && a.sliceBits & bit != 0) sk = IAgateIndex.Skip.E7_DUPLICATE;
        if (sk != IAgateIndex.Skip.NONE) {
            emit IAgateIndex.EntrySkipped(id, d, w, e.slice, sk);
            return;
        }
        a.sliceBits |= bit;
        uint256[3] memory pk = a.packed;
        uint32 mask;
        for (uint256 i; i < n; ++i) {
            uint256 v = e.values[i];
            if (v == 0) continue;
            if (v < P_MIN || v > P_MAX || v % TICK != 0) {
                emit IAgateIndex.BadValue(id, d, w, e.slice, uint8(i), uint32(v));
                continue;
            }
            if (!IndexMath.readable(g, i, d)) continue;
            // the sum stays below 2^40 and the count below 2^8: one reading per slice, SLICES <= 255, each <= P_MAX
            pk[i / 5] += (v | (uint256(1) << 40)) << (48 * (i % 5));
            mask |= uint32(1) << uint32(i);
        }
        if (mask != 0) {
            if (mask & 0x1f != 0) a.packed[0] = pk[0];
            if (mask & 0x3e0 != 0) a.packed[1] = pk[1];
            if (mask & 0x7c00 != 0) a.packed[2] = pk[2];
            a.anyValid = true;
        }
        bool late = block.timestamp >= ss + 2 * pf.slice;
        if (late) a.late = true;
        a.lastPostAt = uint64(block.timestamp);
        emit IAgateIndex.ReadingsPosted(id, d, w, e.slice, e.readAt, e.values, mask, late);
    }
}
