// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// A small day driver for scenario tests: each writer's values per (day, slice) come from virtual hooks; a day is
/// posted slice by slice, closed, then handled by the test's second-key policy.
abstract contract World is IndexBase {
    uint256 internal nSlots;

    /// The value writer w posts for slot i on slice h of day d (0 = no reading). Default: the page.
    function page(uint256 i, uint32 d, uint8 h) internal view virtual returns (uint32);

    function posted(address, uint256 i, uint32 d, uint8 h) internal view virtual returns (uint32) {
        return page(i, d, h);
    }

    /// Whether writer w posts slice h of day d at all.
    function posts(address w, uint32, uint8) internal view virtual returns (bool) {
        return w != address(0) && !ix.isSuspended(w);
    }

    function standby() internal view virtual returns (address) {
        return w2;
    }

    function values(address w, uint32 d, uint8 h) internal view returns (uint32[] memory v) {
        v = new uint32[](nSlots);
        for (uint256 i; i < nSlots; ++i) {
            v[i] = posted(w, i, d, h);
        }
    }

    function postDay(uint32 d) internal {
        for (uint8 h; h < P.slices; ++h) {
            if (posts(w1, d, h)) post1(w1, GPU, d, h, values(w1, d, h));
            address sb = standby();
            if (sb != address(0) && posts(sb, d, h)) post1(sb, GPU, d, h, values(sb, d, h));
        }
    }

    /// Makes the head day final or carried in the cheapest honest way: waits for an unchanged record's finality,
    /// or drives carryDay through its waits. Returns the second at which day d became final.
    function settle(uint32 d) internal returns (uint256 at) {
        for (uint256 guard; guard < 64; ++guard) {
            if (exists(d)) {
                IAgateIndex.Record memory r = rec(d);
                if (r.finalAt != 0) {
                    warpTo(r.finalAt);
                    return r.finalAt;
                }
            }
            // nothing final: let carryDay run at its next allowed second
            uint256 t = _nextCarry(d);
            warpTo(t);
            ix.carryDay(GPU);
        }
        revert("settle: no progress");
    }

    function _nextCarry(uint32 d) internal view returns (uint256 t) {
        uint256 step = uint256(ix.gpu(GPU).lastCarryAt) + P.day / 6;
        if (exists(d)) {
            IAgateIndex.Record memory r = rec(d);
            t = dEnd(d) + 7 * uint256(P.day);
            uint256 m = r.postedAt + 3 * uint256(P.day) / 4;
            if (m > t) t = m;
        } else {
            t = dEnd(d) + P.day;
            uint256 ro = ix.reopenedAt(GPU, d);
            if (ro != 0 && ro + P.day / 4 > t) t = ro + P.day / 4;
        }
        if (step > t) t = step;
    }
}
