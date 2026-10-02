// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MarketWorld} from "./MarketWorld.sol";

/// The router's invariants of BUILD-SPEC 11 over the same random sequences (MarketHandler): I25 after every call
/// (balances back to donations, no short, no allowance), I33 and I37 on every router flow's logs.
contract RouterInvariantTest is MarketWorld {
    function setUp() public {
        _prodWorld();
        targetContract(address(handler));
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: _actions()}));
    }

    function invariant_I25_holdsNothing() public view {
        assertEq(handler.checkI25(), "");
    }

    function invariant_I33_routerActsForItsCaller() public view {
        assertEq(handler.check("I33"), "");
    }

    function invariant_I37_routedTruth() public view {
        assertEq(handler.check("I37"), "");
    }
}
