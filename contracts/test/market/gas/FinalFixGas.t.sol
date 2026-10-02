// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IndexBase} from "../../Base.t.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {FIX_CALL_GAS} from "../../../src/market/MarketTypes.sol";

/// BUILD-SPEC 12.4 item 6 (and 4.6, finding L4): FIX_CALL_GAS must be at least 3 x the cold finalFix of the real
/// AgateIndex measured in Foundry. Two numbers per record, every storage slot cold: the callee's execution gas
/// (vm.lastCallGas) and the smallest gas a staticcall needs to return the right answer (binary search: what
/// FIX_CALL_GAS must cover). The cold account access (2,600) is the caller's, paid by the series out of
/// SYNC_ROUND_GAS. On the production clock with 15 slots and on the demo clock with 3; a final record and a day with
/// no record. Correct with or without --isolate (an isolated call also pays 21,000 and its calldata, taken out here).
contract FinalFixGasTest is IndexBase {
    struct G {
        uint256 callee;
        uint256 minimum;
    }

    function _lastUsed() internal view returns (uint256) {
        (bool ok, bytes memory gr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && gr.length >= 160, "lastCallGas"); // forge 1.3.5: five fields (forge-std 1.17 declares six)
        (, uint64 used,,,) = abi.decode(gr, (uint64, uint64, uint64, int64, uint64));
        return used;
    }

    function _measure(string memory what, uint32 d, bool wantOk) internal returns (G memory g) {
        bytes memory data = abi.encodeCall(IAgateIndex.finalFix, (GPU, d));
        uint256 cd;
        for (uint256 i; i < data.length; ++i) {
            cd += data[i] == 0 ? 4 : 16;
        }
        vm.cool(address(ix));
        (bool ok, bytes memory ret) = address(ix).staticcall(data);
        uint256 used = _lastUsed();
        assertTrue(ok);
        (bool fixOk,,,,,) = abi.decode(ret, (bool, uint32, IAgateIndex.Status, uint8, bool, bool));
        assertEq(fixOk, wantOk);
        bool iso = used >= 21_000;
        g.callee = iso ? used - 21_000 - cd : used;
        uint256 lo = 0;
        uint256 hi = 200_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            vm.cool(address(ix));
            (bool okM, bytes memory r) = address(ix).staticcall{gas: mid}(data);
            bool good = okM && r.length == 192;
            if (good) {
                (bool f,,,,,) = abi.decode(r, (bool, uint32, IAgateIndex.Status, uint8, bool, bool));
                good = f == wantOk;
            }
            if (good) hi = mid;
            else lo = mid;
        }
        g.minimum = iso ? hi - cd : hi;
        console2.log(
            string.concat(
                "GAS | finalFix ",
                what,
                " | callee ",
                vm.toString(g.callee),
                " | minimum ",
                vm.toString(g.minimum),
                " | with the cold account access ",
                vm.toString(g.minimum + 2_600)
            )
        );
        assertGe(FIX_CALL_GAS, 3 * g.callee, "FIX_CALL_GAS < 3 x the callee's gas");
        assertGe(FIX_CALL_GAS, 3 * g.minimum, "FIX_CALL_GAS < 3 x the smallest gas finalFix needs");
    }

    function test_gas_finalFix_production15Slots() public {
        deploy(PROD_P(), NOV1);
        registerSimple(GPU, 15, NOV1);
        uint32[] memory v = new uint32[](15);
        for (uint256 i; i < 15; ++i) {
            v[i] = uint32(3_000_000 + i * 50_000);
        }
        bootDay(NOV1, v, none());
        warpTo(rec(NOV1).finalAt);
        _measure("production, 15 slots, final record", NOV1, true);
        _measure("production, no record", NOV1 + 5, false);
    }

    function test_gas_finalFix_demo3Slots() public {
        deploy(Profile(600, 4, 2, 1, true, false, false, OCT1), OCT1);
        registerSimple(GPU, 3, OCT1);
        bootDay(OCT1, fill(3, 3_600_000), none());
        feedDay(OCT1 + 1, fill(3, 3_600_000), none());
        closeEarliest(w1, OCT1 + 1);
        warpTo(rec(OCT1 + 1).finalAt);
        _measure("demo, 3 slots, final record (countersigned)", OCT1, true);
        _measure("demo, 3 slots, final record (unchanged)", OCT1 + 1, true);
        _measure("demo, no record", OCT1 + 9, false);
    }
}
