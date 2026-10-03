// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IndexBase} from "../Base.t.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// closeDay's worst case on the launch panel (wall spec 18.4): the most slots a launch GPU has is H100's 6, in 6
/// families. The same shapes as GasTest's 15-slot closeDay figures, production clock, two writers; run with -vv. A
/// launch-panel index may take this figure as its AGATE_GAS_CLOSE override instead of the 15-slot MEASURED.
contract LaunchPanelGasTest is IndexBase {
    uint256 internal constant SLOTS = 6;
    uint32 internal D;
    uint32[] internal V;
    uint32[] internal V2;

    function setUp() public {
        deploy(PROD_P(), NOV1);
        D = NOV1;
        registerSimple(GPU, SLOTS, D);
        V = new uint32[](SLOTS);
        V2 = new uint32[](SLOTS);
        for (uint256 i; i < SLOTS; ++i) {
            V[i] = uint32(3_000_000 + i * 50_000);
            V2[i] = uint32(3_010_000 + i * 50_000);
        }
    }

    function _postAll(address w, uint32 d, uint8 from, uint8 to, uint32[] memory v) internal {
        for (uint8 h = from; h < to; ++h) {
            bytes memory r = rpt(entry(GPU, d, h, readAtOf(d, h), v));
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

    function _bootDay() internal {
        _postAll(w1, D, 0, 24, V);
        _postAll(w2, D, 0, 24, V2);
        closeEarliest(w1, D);
        sign(att, D);
    }

    function test_gas_closeDay_6slots() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 24, V);
        _postAll(w2, d, 0, 24, V2);
        warpTo(rec(D).finalAt);
        warpTo(dEnd(d) + slice());
        _measure("closeDay 6 slots (first writer quorate)", w1, abi.encodeCall(IAgateIndex.closeDay, (GPU)));
    }

    function test_gas_closeDay_6slots_worst_twoWriters() public {
        _bootDay();
        uint32 d = D + 1;
        _postAll(w1, d, 0, 3, V); // the first writer below quorum: C3 computes both writers
        _postAll(w2, d, 0, 24, V2);
        warpTo(dEnd(d) + tPend());
        uint256 used =
            _measure("closeDay 6 slots worst (two formulas)", keeper, abi.encodeCall(IAgateIndex.closeDay, (GPU)));
        assertLt(used, 630_218); // under the 15-slot MEASURED
    }
}
