// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase, ReenterDollar} from "./SeriesBase.sol";

/// Every state-changing function is nonReentrant (BUILD-SPEC 4.4): a dollar that calls back into the series during
/// a transfer makes the whole outer call revert.
contract SeriesGuardTest is SeriesBase {
    ReenterDollar internal rd;
    AgateSeries internal x;

    function setUp() public override {
        super.setUp();
        rd = new ReenterDollar();
        x = _deploy(address(rd), FLOOR, CAP, REF);
        rd.mint(a, 1_000_000 * U);
        vm.prank(a);
        rd.approve(address(x), type(uint256).max);
    }

    function _expectGuard(bytes memory outer, bytes memory inner) internal {
        rd.arm(address(x), inner);
        vm.prank(a);
        (bool ok, bytes memory ret) = address(x).call(outer);
        assertFalse(ok);
        assertEq(_sel(ret), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        rd.arm(address(0), "");
    }

    function test_reentryDuringAPullOrAPayIsRefused() public {
        vm.prank(a);
        x.mint(100 * U, a);
        bytes[4] memory inner = [
            abi.encodeCall(IAgateSeries.redeem, (U, a)),
            abi.encodeCall(IAgateSeries.mint, (U, a)),
            abi.encodeCall(IAgateSeries.sync, (1)),
            abi.encodeCall(IAgateSeries.claim, (1))
        ];
        for (uint256 i; i < 4; ++i) {
            _expectGuard(abi.encodeCall(IAgateSeries.mint, (U, a)), inner[i]); // during the pull
            _expectGuard(abi.encodeCall(IAgateSeries.redeem, (U, a)), inner[i]); // during the pay
        }
        // a LONG stream pays the floor: reentry during that pay
        _expectGuard(abi.encodeCall(IAgateSeries.streamOut, (Side.LONG, U, a, a, a, true)), inner[0]);
        // nothing changed
        (,,,,, uint128 led,,) = x.state();
        assertEq(led, 100 * uint256(CAP));
        // unarmed, the same calls work
        vm.prank(a);
        x.redeem(U, a);
    }
}
