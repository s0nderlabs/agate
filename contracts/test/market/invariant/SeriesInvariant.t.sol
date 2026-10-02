// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MarketWorld} from "./MarketWorld.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// The series invariants of BUILD-SPEC 11 over random sequences of every series function and every router flow
/// (MarketHandler): I1, I1b, I2 to I5 from the state after every call; I12, I26, I29, I30, I31 and I36 from the
/// ghosts the handler keeps on each call's logs; I9 in afterInvariant, where everyone exits and a revert fails the
/// run. Default profile 256 runs x 128 calls; `FOUNDRY_PROFILE=ci` 1,024 x 256.
contract SeriesInvariantTest is MarketWorld {
    function setUp() public {
        _prodWorld();
        targetContract(address(handler));
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: _actions()}));
    }

    function invariant_I1_solvency() public view {
        assertEq(handler.checkI1(), "");
    }

    function invariant_I1b_noOverpay() public view {
        assertEq(handler.checkI1b(), "");
    }

    function invariant_I2_ledgerIdentity() public view {
        assertEq(handler.checkI2(), "");
    }

    function invariant_I3_pairConservation() public view {
        assertEq(handler.checkI3(), "");
    }

    function invariant_I4_money() public view {
        assertEq(handler.checkI4(), "");
    }

    function invariant_I5_vesting() public view {
        assertEq(handler.checkI5(), "");
    }

    /// The running half of I9 (dollars out never exceed dollars in); the exit half is afterInvariant.
    function invariant_I9_dust() public view {
        assertLe(handler.gOut(), handler.gIn(), "I9 dollars out exceed dollars in");
    }

    function invariant_I12_burnsFromTheCaller() public view {
        assertEq(handler.check("I12"), "");
    }

    function invariant_I26_noForcedFinalDay() public view {
        assertEq(handler.check("I26"), "");
    }

    function invariant_I29_shortsNeverMove() public view {
        assertEq(handler.checkI29(), "");
    }

    function invariant_I30_operatorPaysOwner() public view {
        assertEq(handler.check("I30"), "");
    }

    function invariant_I31_positionIntegrity() public view {
        assertEq(handler.checkI31(), "");
    }

    function invariant_I36_claimableIsTheClaim() public view {
        assertEq(handler.check("I36"), "");
    }

    /// I9 (v3, finding RC1): everyone exits after the month with assertions, so a revert here fails the run.
    function afterInvariant() public {
        (string memory why,) = handler.exitAll();
        assertEq(why, "");
    }
}
