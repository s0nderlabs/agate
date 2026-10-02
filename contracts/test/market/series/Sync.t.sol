// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {
    U,
    Side,
    FLAG_LATE,
    FLAG_INCOMPLETE,
    FLAG_FORCED,
    FLAG_BELOW_FLOOR,
    FLAG_ABOVE_CAP,
    FLAG_CARRIED
} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I5 (monotone vesting, fix discipline) and the unit behaviour of sync, previewSync and claimable (BUILD-SPEC 4.6).
contract SeriesSyncTest is SeriesBase {
    bytes32 internal constant FIX_APPLIED = keccak256("FixApplied(uint8,uint32,uint32,uint32,uint8,uint8,uint64)");

    struct Fix {
        uint256 k;
        uint256 day;
        uint256 x;
        uint256 c;
        uint256 status;
        uint256 flags;
        uint256 sumAfter;
    }

    function _fixes(Vm.Log[] memory logs) internal view returns (Fix[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(s) && logs[i].topics[0] == FIX_APPLIED) ++n;
        }
        out = new Fix[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s) || logs[i].topics[0] != FIX_APPLIED) continue;
            (uint32 x, uint32 cl, uint8 st, uint8 fl, uint64 sumAfter) =
                abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            out[n++] = Fix(uint256(logs[i].topics[1]), uint256(logs[i].topics[2]), x, cl, st, fl, sumAfter);
        }
    }

    /// Every day from a random index (a quarter outside the band), synced one day at a time.
    function test_I5_vestingAndFixDiscipline(uint256 seed) public {
        uint32[30] memory v;
        for (uint32 i; i < 30; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            v[i] = uint32(100_000 + (r % 1_500) * 10_000);
            _post(NOV1 + i, v[i]);
        }
        uint256 gL;
        uint256 gS;
        for (uint256 kk = 1; kk <= 30; ++kk) {
            vm.warp(_afterDay(kk));
            vm.recordLogs();
            assertEq(s.sync(type(uint256).max), 1, "one day per final day");
            Fix[] memory f = _fixes(vm.getRecordedLogs());
            assertEq(f.length, 1);
            uint256 x = v[kk - 1];
            uint256 cl = x < FLOOR ? FLOOR : (x > CAP ? CAP : x);
            assertEq(f[0].k, kk);
            assertEq(f[0].day, NOV1 + kk - 1);
            assertEq(f[0].x, x, "a non-forced day equals the index's final value");
            assertEq(f[0].c, cl);
            assertGe(f[0].c, FLOOR);
            assertLe(f[0].c, CAP);
            assertEq(f[0].flags, (x < FLOOR ? FLAG_BELOW_FLOOR : 0) | (x > CAP ? FLAG_ABOVE_CAP : 0));
            assertEq(f[0].sumAfter, _S());
            assertEq(_k(), kk);
            assertEq(_lastX(), x);
            uint256 sum = _S();
            assertGe(sum, kk * FLOOR);
            assertLe(sum - kk * FLOOR, kk * (uint256(CAP) - FLOOR));
            uint256 nl = _G(Side.LONG, kk, sum);
            uint256 ns = _G(Side.SHORT, kk, sum);
            assertGe(nl, gL, "G_LONG never falls");
            assertGe(ns, gS, "G_SHORT never falls");
            assertEq(nl + ns, kk * uint256(CAP) + (30 - kk) * uint256(FLOOR));
            (gL, gS) = (nl, ns);
        }
    }

    function test_I5_flags() public {
        index.put(GPU, NOV1, 4_000_000, uint64(_dayEnd(NOV1) + tPend), IAgateIndex.Status.DEGRADED, 3, true, false);
        index.put(GPU, NOV1 + 1, 9_000_000, uint64(_dayEnd(NOV1 + 1) + tPend), IAgateIndex.Status.FULL, 5, false, true);
        index.put(GPU, NOV1 + 2, 1_000_000, uint64(_dayEnd(NOV1 + 2) + tPend), IAgateIndex.Status.CARRIED, 0, true, true);
        vm.warp(_afterDay(3));
        vm.recordLogs();
        s.sync(type(uint256).max);
        Fix[] memory f = _fixes(vm.getRecordedLogs());
        assertEq(f.length, 3);
        assertEq(f[0].flags, FLAG_LATE);
        assertEq(f[0].status, uint256(IAgateIndex.Status.DEGRADED));
        assertEq(f[1].flags, FLAG_INCOMPLETE | FLAG_ABOVE_CAP);
        assertEq(f[1].c, CAP);
        assertEq(f[2].flags, FLAG_LATE | FLAG_INCOMPLETE | FLAG_BELOW_FLOOR | FLAG_CARRIED);
        assertEq(f[2].c, FLOOR);
        assertEq(f[2].status, uint256(IAgateIndex.Status.CARRIED));
        assertEq(f[2].sumAfter, 4_000_000 + CAP + FLOOR);
        assertEq(f[0].flags & FLAG_FORCED, 0);
    }

    function test_workedExampleDay11() public {
        vm.warp(_afterDay(11));
        vm.expectEmit(address(s));
        emit IAgateSeries.FixApplied(11, NOV1 + 10, STEP, STEP, IAgateIndex.Status.FULL, 0, 40_200_000);
        s.sync(type(uint256).max);
        assertEq(_S(), 40_200_000);
        assertEq(s.owed(Side.LONG, U), 2_480_000); // G_LONG / N at k = 11
        assertEq(s.owed(Side.SHORT, U), 1_300_000);
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        assertEq(_S(), 120_000_000);
        assertEq(s.owed(Side.LONG, U), 4_000_000);
        assertEq(s.owed(Side.SHORT, U), 3_200_000);
    }

    /// Example 4: the price leaves the band for days 21 to 25.
    function test_workedExampleOutOfBand() public {
        for (uint32 d = NOV1 + 10; d < DEC1; ++d) {
            _post(d, REF);
        }
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 2; ++i) {
            vm.revertToState(snap);
            uint32 v = i == 0 ? 8_500_000 : 1_500_000;
            for (uint32 d = NOV1 + 20; d < NOV1 + 25; ++d) {
                _post(d, v);
            }
            _mint(a, U);
            vm.warp(_afterDay(30));
            vm.recordLogs();
            s.sync(type(uint256).max);
            Fix[] memory f = _fixes(vm.getRecordedLogs());
            uint256 flagged;
            for (uint256 j; j < f.length; ++j) {
                if (f[j].flags & (i == 0 ? FLAG_ABOVE_CAP : FLAG_BELOW_FLOOR) != 0) ++flagged;
            }
            assertEq(flagged, 5);
            assertEq(_S(), i == 0 ? 126_000_000 : 99_000_000);
            vm.startPrank(a);
            assertEq(s.settle(Side.LONG, U, a), i == 0 ? 4_200_000 : 3_300_000);
            assertEq(s.settle(Side.SHORT, U, a), i == 0 ? 3_000_000 : 3_900_000);
            vm.stopPrank();
        }
    }

    function test_syncMaxDaysAndReturn() public {
        vm.warp(_afterDay(10));
        assertEq(s.sync(0), 0);
        assertEq(s.sync(1), 1);
        assertEq(_k(), 1);
        assertEq(s.sync(3), 3);
        assertEq(_k(), 4);
        assertEq(s.sync(type(uint256).max), 6);
        assertEq(s.sync(type(uint256).max), 0);
        assertEq(_k(), 10);
    }

    function test_syncBeforeTheMonthAppliesNothing() public {
        assertEq(s.sync(type(uint256).max), 0);
        (uint8 k, uint64 sum) = s.previewSync();
        assertEq(k, 0);
        assertEq(sum, 0);
    }

    function test_syncWaitsForAPendingFix() public {
        index.put(GPU, NOV1 + 3, 5_000_000, 0, IAgateIndex.Status.FULL, 5, false, false); // never final yet
        vm.warp(_afterDay(10));
        assertEq(s.sync(type(uint256).max), 3);
        assertEq(s.sync(type(uint256).max), 0);
        index.put(GPU, NOV1 + 3, 5_000_000, uint64(block.timestamp), IAgateIndex.Status.FULL, 5, false, false);
        assertEq(s.sync(type(uint256).max), 7);
        assertEq(_lastX(), REF);
    }

    /// previewSync and claimable run the same step function as sync: they equal what the next call does.
    function testFuzz_previewAndClaimableMatchTheNextCall(uint256 dt1, uint256 dt2, bool short) public {
        _mint(a, 10 * U);
        (uint256 id,) = _stream(a, short ? Side.SHORT : Side.LONG, 10 * U, a, b, true);
        uint256 t = tList + bound(dt1, 0, 70 days);
        for (uint256 i; i < 2; ++i) {
            vm.warp(t);
            (uint8 pk, uint64 ps) = s.previewSync();
            uint256 want = s.position(id).owner == address(0) ? 0 : s.claimable(id);
            if (s.position(id).owner != address(0)) assertEq(s.claim(id), want);
            else s.sync(type(uint256).max);
            assertEq(_k(), pk);
            assertEq(_S(), ps);
            t += bound(dt2, 0, 40 days);
        }
        _check();
    }

    /// The index is late: the month is over by the clock but day 30 is not final, so k lags at 29 and streamOut is
    /// still open; the position then pays exactly what settling would.
    function test_laggingKThenStreamOutPaysTheSame() public {
        for (uint256 side; side < 2; ++side) {
            uint256 snap = vm.snapshotState();
            uint256 q = 720 * U;
            _mint(a, q);
            vm.warp(_dayEnd(DEC1 - 1) + 1);
            vm.prank(a);
            (bool ok, bytes memory ret) = address(s).call{gas: RESERVE + 100_000}(
                abi.encodeCall(IAgateSeries.streamOut, (Side(side), q, a, a, a, true))
            );
            assertFalse(ok, "29 ended days need more than one round's reserve");
            assertEq(_sel(ret), IAgateSeries.SyncGasLow.selector);
            (uint256 id, uint256 nowPaid) = _stream(a, Side(side), q, a, a, true);
            assertEq(_k(), 29);
            vm.warp(_afterDay(30));
            uint256 later = s.claim(id);
            assertEq(_k(), 30);
            uint256 g = side == 0 ? 120_000_000 : 30 * uint256(CAP) - 120_000_000;
            assertEq(nowPaid + later, q * g / (30 * U));
            _check();
            vm.revertToState(snap);
        }
    }
}
