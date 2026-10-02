// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SeriesReplay} from "./SeriesReplay.sol";

/// Acceptance 12.4 item 4: the differential vectors (docs/market/model/gen_vectors.py) reproduce the model's worked
/// examples and 50 random months to the u: every call's result or error, the state after it, every FixApplied, and
/// the balances and positions at the end.
contract MarketDifferentialTest is SeriesReplay {
    function _run(string memory name) internal returns (uint256 calls) {
        (, calls) = this.replay(name);
        assertGt(calls, 0);
    }

    function test_index() public view {
        string memory json = vm.readFile(_path("index"));
        assertEq(vm.parseJsonStringArray(json, ".examples").length, 16);
        assertEq(vm.parseJsonUint(json, ".random"), 50);
    }

    function test_ex1_november() public {
        _run("ex1_november");
    }

    function test_ex2a_exits() public {
        _run("ex2a_exits");
    }

    function test_ex2b_closeLongDaily() public {
        _run("ex2b_close_long_daily");
    }

    function test_ex3_midMonth() public {
        _run("ex3_mid_month");
    }

    function test_ex4_outOfBand() public {
        _run("ex4_above_cap");
        _run("ex4_below_floor");
    }

    function test_ex5_lastResort() public {
        _run("ex5a_silent_halt");
        _run("ex5b_walk");
        _run("ex5c_dead_x0");
        _run("ex5d_walk_once");
        _run("ex5e_demo_floor");
        _run("ex5f_late_records");
    }

    function test_ex6_dust() public {
        _run("ex6_dust");
    }

    function test_ex7_clocks() public {
        _run("ex7_clock_production");
        _run("ex7_clock_demo");
        _run("ex7_clock_fast");
    }

    function _random(uint256 from, uint256 to) internal {
        uint256 calls;
        for (uint256 i = from; i < to; ++i) {
            calls += _run(string.concat("random_", i < 10 ? "0" : "", vm.toString(i)));
        }
        emit log_named_uint("calls replayed", calls);
    }

    function test_randomMonths_00_09() public {
        _random(0, 10);
    }

    function test_randomMonths_10_19() public {
        _random(10, 20);
    }

    function test_randomMonths_20_29() public {
        _random(20, 30);
    }

    function test_randomMonths_30_39() public {
        _random(30, 40);
    }

    function test_randomMonths_40_49() public {
        _random(40, 50);
    }
}
