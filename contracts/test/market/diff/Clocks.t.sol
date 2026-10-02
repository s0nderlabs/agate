// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SeriesReplay} from "./SeriesReplay.sol";

/// I35, clock independence: while the index is alive, the same fixes pay exactly the same amounts on the production,
/// demo and FAST clocks. One flow (example 1: eight shorts, eight longs, thirty daily claims) runs on three MockIndex
/// clocks (86,400 s, 600 s and 24 s days); every call's result, the state after it and the end match the model on
/// each clock, and the three clock-free digests of the results are equal.
contract SeriesClocksTest is SeriesReplay {
    function test_I35_sameFixesPayTheSameOnEveryClock() public {
        (bytes32 prod, uint256 n1) = this.replay("ex7_clock_production");
        (bytes32 demo, uint256 n2) = this.replay("ex7_clock_demo");
        (bytes32 fast, uint256 n3) = this.replay("ex7_clock_fast");
        assertEq(n1, n2);
        assertEq(n1, n3);
        assertEq(demo, prod, "the demo clock pays what the production clock pays");
        assertEq(fast, prod, "the FAST clock pays what the production clock pays");
    }

    function test_I35_theClocksReallyDiffer() public view {
        uint256[] memory a = vm.parseJsonUintArray(vm.readFile(_path("ex7_clock_production")), ".clock");
        uint256[] memory b = vm.parseJsonUintArray(vm.readFile(_path("ex7_clock_demo")), ".clock");
        uint256[] memory c = vm.parseJsonUintArray(vm.readFile(_path("ex7_clock_fast")), ".clock");
        assertEq(a[0], 86_400);
        assertEq(b[0], 600);
        assertEq(c[0], 24);
        uint256[] memory ta = vm.parseJsonUintArray(vm.readFile(_path("ex7_clock_production")), ".terms");
        uint256[] memory tb = vm.parseJsonUintArray(vm.readFile(_path("ex7_clock_demo")), ".terms");
        assertEq(ta[5], 60 days); // lastResort
        assertEq(tb[5], 3 days);
        assertTrue(ta[3] != tb[3]); // startTs
    }
}
