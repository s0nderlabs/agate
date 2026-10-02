// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {FLAG_FORCED} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I26, the gas half: a sync-bearing call either gives every ended-day index call its full FIX_CALL_GAS or reverts
/// as a whole. Every day here is past its last resort, so a starved index call read as "no fix" would force it: sync
/// at every gas limit from 21,000 to 2,000,000 must revert or apply, and never force while finalFix is ok.
contract SeriesGasStarveTest is SeriesBase {
    bytes32 internal constant FIX_APPLIED = keccak256("FixApplied(uint8,uint32,uint32,uint32,uint8,uint8,uint64)");

    struct Probe {
        bool ok;
        bytes4 sel;
        uint256 applied;
        uint256 forced;
    }

    struct Sweep {
        uint256 ok;
        uint256 reverted;
        uint256 minOk;
    }

    /// One probe in its own call frame, so the recorded logs never pile up in the sweep's memory.
    function probe(bytes calldata data, uint256 g) external returns (Probe memory p) {
        vm.cool(address(s));
        vm.cool(address(index));
        vm.recordLogs();
        bytes memory ret;
        (p.ok, ret) = address(s).call{gas: g}(data);
        p.sel = _sel(ret);
        if (!p.ok && ret.length == 0) p.sel = bytes4(0xffffffff); // out of gas
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(s) || logs[i].topics[0] != FIX_APPLIED) continue;
            ++p.applied;
            (,,, uint8 fl,) = abi.decode(logs[i].data, (uint32, uint32, uint8, uint8, uint64));
            if (fl & FLAG_FORCED != 0) ++p.forced;
        }
    }

    function _next(uint256 g) internal pure returns (uint256) {
        return g + (g < 400_000 ? 1_000 : 2_500);
    }

    /// Sweeps sync(maxDays); every success must apply exactly `want` days, none forced, with S as expected.
    function _sweepFinal(uint256 maxDays, uint256 want, uint256 wantS) internal returns (Sweep memory r) {
        bytes memory data = abi.encodeCall(IAgateSeries.sync, (maxDays));
        for (uint256 g = 21_000; g <= 2_000_000; g = _next(g)) {
            uint256 snap = vm.snapshotState();
            Probe memory p = this.probe(data, g);
            if (p.ok) {
                assertEq(p.forced, 0, "forced a day whose fix was final");
                assertEq(p.applied, want, "a success applied every pending day");
                assertEq(_k(), want);
                assertEq(_S(), wantS);
                ++r.ok;
                if (r.minOk == 0) r.minOk = g;
            } else {
                assertTrue(p.sel == bytes4(0xffffffff) || p.sel == IAgateSeries.SyncGasLow.selector, "bad revert");
                assertEq(_k(), 0);
                assertEq(r.ok, 0, "success is monotone in gas");
                ++r.reverted;
            }
            vm.revertToStateAndDelete(snap);
        }
    }

    function test_I26_gasSweepNeverForcesAFinalDay() public {
        index.setBurn(90_000); // finalFix needs nearly all of FIX_CALL_GAS: a starved call would fail
        vm.warp(_deadline(30) + 1);
        Sweep memory one = _sweepFinal(1, 1, REF);
        Sweep memory five = _sweepFinal(5, 5, 5 * uint256(REF));
        assertGt(one.ok, 0);
        assertGt(one.reverted, 0);
        assertGt(five.ok, 0);
        assertGe(one.minOk, RESERVE, "one round needs the reserve");
        emit log_named_uint("sync(1) smallest gas", one.minOk);
        emit log_named_uint("sync(5) smallest gas", five.minOk);
    }

    function test_I26_gasSweepWholeMonth() public {
        index.setBurn(20_000);
        vm.warp(_deadline(30) + 1);
        Sweep memory all = _sweepFinal(type(uint256).max, 30, 120_000_000);
        assertGt(all.ok, 0);
        assertGt(all.reverted, 0);
        emit log_named_uint("sync(all) of 30 days smallest gas", all.minOk);
    }

    /// The walk: the index is dead from the 1st and only Oct 5 has a final record, so the walk needs 27 calls. A
    /// starved walk stopped half way would fall back to x0 (3.60); every success must find Oct 5's 4.44.
    function test_I26_gasSweepWalk() public {
        index.setBurn(20_000);
        index.setRevertFrom(GPU, NOV1);
        for (uint32 d = OCT1 - 5; d < NOV1; ++d) {
            index.del(GPU, d);
        }
        _post(OCT1 + 4, 4_440_000);
        vm.warp(_deadline(1));
        bytes memory data = abi.encodeCall(IAgateSeries.sync, (1));
        uint256 oks;
        for (uint256 g = 21_000; g <= 2_000_000; g = _next(g)) {
            uint256 snap = vm.snapshotState();
            Probe memory p = this.probe(data, g);
            if (p.ok) {
                assertEq(_k(), 1);
                assertTrue(_walked());
                assertEq(_lastX(), 4_440_000, "a walk cut short");
                assertEq(_S(), 4_440_000);
                ++oks;
            } else {
                assertTrue(p.sel == bytes4(0xffffffff) || p.sel == IAgateSeries.SyncGasLow.selector, "bad revert");
                assertFalse(_walked());
                assertEq(oks, 0, "success is monotone in gas");
            }
            vm.revertToStateAndDelete(snap);
        }
        assertGt(oks, 0);
    }
}
