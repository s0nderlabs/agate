// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// The call shapes of BUILD-SPEC 4.14 at their worst case: 3 GPUs of 15 slots in 15 families, production clock,
/// two writers. Each test measures one call with gasleft() and logs it (run with -vv); `forge test --gas-report`
/// gives the same calls per function. MEASURED for 13.4 is the logged figure.
contract GasTest is IndexBase {
    bytes32 internal constant GPU3 = keccak256("B200-SXM/on-demand-list/neocloud/v1");
    uint32 internal D;
    uint32[] internal V;
    uint32[] internal V2;

    /// Budget for onReport / postReport with 3 entries of 15 slots on the first (cold) slice of a day.
    uint256 internal constant POST_BUDGET = 600_000;

    function setUp() public {
        deploy(PROD_P(), NOV1);
        D = NOV1;
        bytes32[3] memory ids = [GPU, GPU2, GPU3];
        for (uint256 k; k < 3; ++k) {
            registerSimple(ids[k], 15, D);
        }
        V = new uint32[](15);
        V2 = new uint32[](15);
        for (uint256 i; i < 15; ++i) {
            V[i] = uint32(3_000_000 + i * 50_000);
            V2[i] = uint32(3_010_000 + i * 50_000);
        }
    }

    function _report(uint32 d, uint8 h, uint32[] memory v) internal view returns (bytes memory) {
        IAgateIndex.Entry[] memory es = new IAgateIndex.Entry[](3);
        uint64 ra = readAtOf(d, h);
        es[0] = entry(GPU, d, h, ra, v);
        es[1] = entry(GPU2, d, h, ra, v);
        es[2] = entry(GPU3, d, h, ra, v);
        return rptN(es);
    }

    function _postAll(address w, uint32 d, uint8 from, uint8 to, uint32[] memory v) internal {
        for (uint8 h = from; h < to; ++h) {
            bytes memory r = _report(d, h, v);
            warpTo(readAtOf(d, h));
            vm.prank(w);
            ix.postReport(r);
        }
    }

    function _measure(string memory what, address who, bytes memory data) internal returns (uint256 used) {
        vm.prank(who, who);
        uint256 g0 = gasleft();
        (bool ok, bytes memory err) = address(ix).call(data);
        used = g0 - gasleft();
        if (!ok) revert(string.concat(what, " reverted: ", vm.toString(err)));
        console2.log(what, used);
    }

    function test_gas_postReport_3x15() public {
        bytes memory r = _report(D, 0, V);
        warpTo(readAtOf(D, 0));
        uint256 cold = _measure("postReport 3x15 cold (first slice of the day)", w1, abi.encodeCall(IAgateIndex.postReport, (r)));
        assertLt(cold, POST_BUDGET);
        bytes memory r2 = _report(D, 1, V);
        warpTo(readAtOf(D, 1));
        _measure("postReport 3x15 warm", w1, abi.encodeCall(IAgateIndex.postReport, (r2)));
    }

    function test_gas_onReport_3x15() public {
        bytes memory r = _report(D, 0, V);
        warpTo(readAtOf(D, 0));
        vm.prank(address(fwd), w1);
        uint256 g0 = gasleft();
        ix.onReport("", r);
        uint256 cold = g0 - gasleft();
        console2.log("onReport 3x15 cold (first slice of the day)", cold);
        assertLt(cold, POST_BUDGET);
        bytes memory r2 = _report(D, 1, V);
        warpTo(readAtOf(D, 1));
        vm.prank(address(fwd), w1);
        g0 = gasleft();
        ix.onReport("", r2);
        console2.log("onReport 3x15 warm", g0 - gasleft());
    }

    function _bootDay() internal {
        _postAll(w1, D, 0, 24, V);
        _postAll(w2, D, 0, 24, V2);
        closeEarliest(w1, D);
        sign(att, D);
    }

    function test_gas_closeDay_15slots() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 24, V);
        _postAll(w2, d, 0, 24, V2);
        warpTo(rec(D).finalAt);
        warpTo(dEnd(d) + slice());
        _measure("closeDay 15 slots (first writer quorate)", w1, abi.encodeCall(IAgateIndex.closeDay, (GPU)));
    }

    function test_gas_closeDay_15slots_worst_twoWriters() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 3, V); // the first writer below quorum: C3 computes both writers
        _postAll(w2, d, 0, 24, V2);
        warpTo(dEnd(d) + tPend());
        _measure("closeDay 15 slots worst (two formulas)", keeper, abi.encodeCall(IAgateIndex.closeDay, (GPU)));
    }

    function test_gas_attest_countersign() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 24, V2);
        warpTo(rec(D).finalAt);
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        _measure("attest (countersign)", att, abi.encodeCall(IAgateIndex.attest, (GPU, d, w1, r.digest)));
    }

    function test_gas_select_15slots() public {
        _bootDay();
        uint32 d = D + 1;
        uint32[] memory fake = fill(15, 4_000_000);
        _postAll(w1, d, 0, 24, fake);
        _postAll(w2, d, 0, 24, V2);
        warpTo(rec(D).finalAt);
        closeEarliest(w1, d);
        (, IAgateIndex.RecordDetail memory det) = ix.previewRecord(GPU, d, w2);
        _measure("attest (select) 15 slots", att, abi.encodeCall(IAgateIndex.attest, (GPU, d, w2, det.rec.digest)));
    }

    function test_gas_veto() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 24, V2);
        warpTo(rec(D).finalAt);
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        _measure("veto", g1, abi.encodeCall(IAgateIndex.veto, (GPU, d, w1, r.digest)));
    }

    /// Case 2 with the miss advance over 15 slots and 2 eligible writers, and a successful chained close.
    function test_gas_carryDay_case2_advance_chainedClose() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 3, V); // eligible, below MIN_READINGS everywhere
        _postAll(w2, d, 0, 3, V2);
        _postAll(w1, d + 1, 0, 24, V); // the next day complete: the chained close lands
        warpTo(dEnd(d + 1) + slice());
        warpTo(dEnd(d) + P.day);
        uint256 used = _measure("carryDay case 2 + advance 15x2 + chained close", keeper, abi.encodeCall(IAgateIndex.carryDay, (GPU)));
        assertTrue(exists(d + 1));
        used;
    }

    function test_gas_carryDay_case2_advance_noClose() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 3, V);
        _postAll(w2, d, 0, 3, V2);
        warpTo(dEnd(d) + P.day);
        _measure("carryDay case 2 + advance 15x2, no chained close", keeper, abi.encodeCall(IAgateIndex.carryDay, (GPU)));
    }

    /// Case 1 (drop) with the advance over 15 slots and 2 writers, and a successful chained close.
    function test_gas_carryDay_case1_drop_advance_chainedClose() public {
        _bootDay();
        uint32 d = D + 1;
        uint32[] memory a = fill(15, 4_000_000);
        for (uint256 i = 8; i < 15; ++i) {
            a[i] = 0; // slots 8..14: no eligible writer reads them, the drop's carry advances them
        }
        uint32[] memory b = fill(15, 0);
        _postAll(w1, d, 0, 24, a);
        _postAll(w2, d, 0, 24, b);
        _postAll(w1, d + 1, 0, 24, V);
        warpTo(rec(D).finalAt);
        closeEarliest(w1, d);
        warpTo(dEnd(d) + 7 * uint256(P.day));
        _measure("carryDay case 1 (drop) + chained close", keeper, abi.encodeCall(IAgateIndex.carryDay, (GPU)));
        assertTrue(rec(d).dropped);
        assertTrue(exists(d + 1));
    }

    /// The worst carryDay: the quorum check computes both writers, then the chained close computes both again (the
    /// next day's first writer below quorum, the second complete, past T_PEND).
    function test_gas_carryDay_case2_worst_fourFormulas() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 3, V);
        _postAll(w2, d, 0, 3, V2);
        _postAll(w1, d + 1, 0, 3, V);
        _postAll(w2, d + 1, 0, 24, V2);
        warpTo(dEnd(d + 1) + tPend());
        _measure("carryDay case 2 worst (four formulas)", keeper, abi.encodeCall(IAgateIndex.carryDay, (GPU)));
        assertEq(rec(d + 1).source, w2);
    }

    // ------------------------------------------------------------------ owner calls (4.11, 4.15; forge scripts only)

    function _b(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(uint8(97 + (i % 26)));
        }
        return string(b);
    }

    /// 4.14: queueReaderSwap and executeReaderSwap with a 100-byte URL and a 100-byte reason (parser "lambda/2").
    function test_gas_readerSwap_100B() public {
        IAgateIndex.Reader memory r;
        r.url = string.concat("https://", _b(92));
        r.parserVersion = "lambda/2";
        string memory why = _b(100);
        assertEq(bytes(r.url).length, 100);
        _measure("queueReaderSwap (100-byte url and reason)", owner, abi.encodeCall(IAgateIndex.queueReaderSwap, (GPU, 7, r, why)));
        warpTo(block.timestamp + 2 * uint256(P.day));
        _measure("executeReaderSwap (100-byte url and reason)", owner, abi.encodeCall(IAgateIndex.executeReaderSwap, (GPU, 7, r)));
        _measure("queueReaderSwap again (another slot)", owner, abi.encodeCall(IAgateIndex.queueReaderSwap, (GPU, 8, r, why)));
        _measure("cancelReaderSwap", owner, abi.encodeCall(IAgateIndex.cancelReaderSwap, (GPU, 8, r)));
    }

    /// The owner queue with the 14 DAY window: queue, execute and cancel of an action.
    function test_gas_ownerQueue_window() public {
        IAgateIndex.Action memory a;
        a.kind = IAgateIndex.ActionKind.ATTESTER;
        a.addr = keeper;
        _measure("queue (ATTESTER)", owner, abi.encodeCall(IAgateIndex.queue, (a)));
        warpTo(block.timestamp + 2 * uint256(P.day));
        _measure("execute (ATTESTER)", owner, abi.encodeCall(IAgateIndex.execute, (a)));
        a.addr = stranger;
        _measure("queue (ATTESTER, second)", owner, abi.encodeCall(IAgateIndex.queue, (a)));
        _measure("cancel (ATTESTER)", owner, abi.encodeCall(IAgateIndex.cancel, (a)));
    }
}
