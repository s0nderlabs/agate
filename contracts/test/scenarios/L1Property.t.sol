// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {World} from "./World.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// L1 on the contract, as a property over random worlds (TEST clock, 5 single-cloud families, Q_MIN 3): random
/// pages (steps, whole-day darkness, transient loss), one writer possibly stolen with a random strategy, the attester
/// up or down, and the scripted guardian following 6.6's procedure within GUARD_ACT. Every day must be final by
/// dayEnd + LAG_MAX (2 DAY), and every final computed record must be the honest writer's.
contract L1PropertyTest is World {
    uint256 internal seed;
    address internal thief; // zero: none
    uint8 internal strategy; // 1 freeze, 2 inflate, 3 plant, 4 withhold slot 2, 5 garbage, 6 silent
    bool internal attUp;
    uint32 internal first;
    uint256 internal interventions; // selects and vetoes of a thief's record

    function setUp() public {
        deploy(TEST_P(), 0);
        nSlots = 5;
        first = OCT1;
        registerSimple(GPU, 5, first);
    }

    function _h(uint256 a, uint256 b, uint256 c) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(seed, a, b, c)));
    }

    function page(uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        uint32 k = d - first;
        if (k > 0 && _h(1, i, k) % 9 == 0) return 0; // dark all day for everyone
        uint256 v = 3_000_000 + (_h(2, i, 0) % 100) * 10_000;
        if (k >= 2 + _h(3, i, 0) % 8) v = v * (90 + _h(4, i, 0) % 25) / 100; // one step per page
        if (h >= 6 && k == _h(5, i, 0) % 10) v += 20_000; // an intraday move
        return uint32((v + 5_000) / 10_000 * 10_000);
    }

    function posted(address w, uint256 i, uint32 d, uint8 h) internal view override returns (uint32) {
        uint32 v = page(i, d, h);
        if (w != thief || d == first) return v;
        if (strategy == 1) return page(i, first + 1, h);
        if (strategy == 2) return v == 0 ? 0 : uint32((uint256(v) * 11 / 10 + 5_000) / 10_000 * 10_000);
        if (strategy == 3) return i == 0 && v != 0 ? 3_400_000 : v;
        if (strategy == 4) return i == 2 ? 0 : v;
        if (strategy == 5) return v == 0 ? 0 : uint32(uint256(v) * 3 / 2 / 10_000 * 10_000);
        return v;
    }

    function posts(address w, uint32 d, uint8 h) internal view override returns (bool) {
        if (w == address(0) || ix.isSuspended(w)) return false;
        if (w == thief && strategy == 6 && d > first) return false;
        return _h(6, uint160(w), uint256(d) * 256 + h) % 25 != 0; // transient loss, 4%
    }

    function _honest() internal view returns (address) {
        return thief == w1 ? w2 : w1;
    }

    /// 6.6's procedure for the pending record of day d (the attester first, then the guardian within GUARD_ACT).
    /// Returns false if the day has to wait for a carry.
    function _secondKeys(uint32 d) internal returns (bool) {
        IAgateIndex.Record memory r = rec(d);
        address hw = _honest();
        if (r.source == hw) {
            if (r.needsSign) {
                warpTo(r.postedAt + (attUp ? slice() : uint256(P.day) / 4));
                sign(attUp ? att : g1, d);
            }
            return true;
        }
        ++interventions;
        (bool okH, IAgateIndex.RecordDetail memory hd) = ix.previewRecord(GPU, d, hw);
        if (attUp && okH && !hd.rec.incomplete) {
            warpTo(r.postedAt + slice());
            selectW(att, d, hw);
            return true;
        }
        warpTo(r.postedAt + uint256(P.day) / 8); // inside GUARD_ACT and before an unchanged record's finality
        if (okH) {
            selectW(g1, d, hw); // R11: a guardian may select an incomplete honest record
            return true;
        }
        vm.prank(g1);
        ix.veto(GPU, d, r.source, r.digest); // R3
        return false;
    }

    function _day(uint32 d) internal {
        postDay(d);
        if (d > first) settle(d - 1);
        // the honest writer closes at the earliest second, or from T_PEND; the thief at the earliest second
        warpTo(dEnd(d) + slice());
        if (thief != address(0) && !ix.isSuspended(thief)) {
            vm.prank(thief);
            try ix.closeDay(GPU) {} catch {}
        }
        if (ix.head(GPU) == d) {
            vm.prank(_honest());
            try ix.closeDay(GPU) {} catch {}
        }
        if (ix.head(GPU) == d) {
            warpTo(dEnd(d) + tPend());
            vm.prank(_honest());
            try ix.closeDay(GPU) {} catch {}
        }
        if (ix.head(GPU) != d + 1) return; // nobody quorate: the day is carried at GRACE
        if (_secondKeys(d)) return;
        // vetoed: the next candidate closes now if it can, and gets the procedure in turn; else a carry at GRACE
        vm.prank(_honest());
        try ix.closeDay(GPU) {} catch {}
        if (ix.head(GPU) == d + 1) _secondKeys(d);
    }

    /// forge-config: default.fuzz.runs = 48
    function testFuzz_L1_everyDayFinalWithinLagMax(uint256 s, uint8 who, uint8 strat, bool up) public {
        seed = s;
        who = who % 3;
        thief = who == 0 ? address(0) : (who == 1 ? w1 : w2);
        strategy = 1 + strat % 6;
        attUp = up;
        uint32 last = first + 11;
        for (uint32 d = first; d <= last; ++d) {
            _day(d);
        }
        settle(last);
        if (thief == w1 && (strategy == 2 || strategy == 5)) assertGt(interventions, 0, "the thief was the source");
        for (uint32 d = first; d <= last; ++d) {
            IAgateIndex.Record memory r = rec(d);
            assertTrue(isFinal(d));
            assertLe(r.finalAt, dEnd(d) + 2 * uint256(P.day), "L1: final by dayEnd + LAG_MAX");
            if (r.status != IAgateIndex.Status.CARRIED && thief != address(0)) {
                assertEq(r.source, _honest(), "every final computed record is the honest writer's");
            }
        }
    }
}
