// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Permit, Side, U} from "../../../src/market/MarketTypes.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {MarketWorld} from "./MarketWorld.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// The negative controls of BUILD-SPEC 11: each harness (Harness.sol), deployed through the test factory, is driven
/// by the same handler as the invariant suites, one seeded random action at a time, in runs of 128 calls from a fresh
/// world (the default invariant depth), and must be caught by the invariant named in section 11 within the default
/// budget of 256 runs. The same driver on the correct contracts finds nothing, and every action succeeds somewhere (a
/// suite that cannot fail, or never runs an action, proves nothing). Each run is its own call frame, so memory starts
/// empty every run; a test's gas limit (2^30) bounds how many runs one test can drive.
contract NegativeControlsTest is MarketWorld {
    uint256 internal constant RUNS = 256;
    uint256 internal constant DEPTH = 128;
    string internal constant ROUTER = "AgateRouter.sol:AgateRouter";
    string internal constant SERIES = "AgateSeries.sol:AgateSeries";

    /// One run of DEPTH calls from the current state; the first call at which `inv` fires (0: none). Rolls back.
    function huntRun(string calldata inv, uint256 run) external returns (uint256) {
        uint256 snap = vm.snapshotState();
        for (uint256 depth = 1; depth <= DEPTH; ++depth) {
            try handler.step(uint256(keccak256(abi.encode(inv, run, depth)))) {} catch {}
            if (handler.violated(inv)) return depth;
        }
        vm.revertToStateAndDelete(snap);
        return 0;
    }

    function _caught(string memory inv) internal {
        for (uint256 run = 1; run <= RUNS; ++run) {
            uint256 depth = this.huntRun(inv, run);
            if (depth == 0) continue;
            emit log_named_string("caught", handler.check(inv));
            emit log_named_uint("run", run);
            emit log_named_uint("call", depth);
            return;
        }
        fail();
    }

    function test_NC_complement_caughtByI1b() public {
        _ncWorld("Harness.sol:SeriesComplement", ROUTER, false);
        _caught("I1b");
    }

    function test_NC_floorMint_caughtByI1() public {
        _ncWorld("Harness.sol:SeriesFloorMint", ROUTER, false);
        _caught("I1");
    }

    function test_NC_unstreamShort_caughtByI1() public {
        _ncWorld("Harness.sol:SeriesUnstreamShort", ROUTER, false);
        _caught("I1");
    }

    function test_NC_uncheckedTop_caughtByI1() public {
        _ncWorld("Harness.sol:SeriesUncheckedTop", ROUTER, true);
        _caught("I1");
    }

    function test_NC_operatorSelf_caughtByI30() public {
        _ncWorld("Harness.sol:SeriesOperatorSelf", ROUTER, false);
        _caught("I30");
    }

    function test_NC_noGasReserve_caughtByI26() public {
        _ncWorld("Harness.sol:SeriesNoGasReserve", ROUTER, false);
        _caught("I26");
    }

    function test_NC_keepSurplus_caughtByI25() public {
        _ncWorld(SERIES, "Harness.sol:RouterKeepSurplus", false);
        _caught("I25");
    }

    function test_NC_anyOwner_caughtByI33() public {
        _ncWorld(SERIES, "Harness.sol:RouterAnyOwner", false);
        _caught("I33");
    }

    /// any_owner with only the router's owner check removed: the router still names its caller as the recipient,
    /// and the series refuses an operator close that does not pay the owner (the series does not rely on the router).
    function test_NC_ownerCheckOnly_refusedByTheSeries() public {
        _ncWorld(SERIES, "Harness.sol:RouterOwnerCheckOnly", false);
        handler.requote(1); // starts the run: picks a series
        IAgateSeries s = handler.s();
        Permit memory none;
        vm.prank(actors[0]);
        (uint256[] memory ids,,) = IAgateRouter(routerAddr).openShort(address(s), 100 * U, 1, 1, actors[0], true, none);
        assertEq(s.position(ids[0]).operator, routerAddr);
        vm.prank(actors[1]);
        vm.expectRevert(IAgateSeries.OperatorMustPayOwner.selector);
        IAgateRouter(routerAddr).closeShort(address(s), ids, 1_000 * U, none);
        assertEq(s.position(ids[0]).owner, actors[0]);
        assertEq(uint8(s.position(ids[0]).side), uint8(Side.SHORT));
    }

    // ------------------------------------------------------------------ the positive control

    string[15] internal invs =
        ["I1", "I1b", "I2", "I3", "I4", "I5", "I12", "I25", "I26", "I29", "I30", "I31", "I33", "I36", "I37"];

    /// One clean run: every invariant after every call, then everyone exits. Returns each action's successes.
    function cleanRun(uint256 run) external returns (uint256[24] memory ok, uint256 dust, uint256 paths) {
        uint256 snap = vm.snapshotState();
        for (uint256 depth = 1; depth <= DEPTH; ++depth) {
            try handler.step(uint256(keccak256(abi.encode("clean", run, depth)))) {} catch {}
            for (uint256 i; i < invs.length; ++i) {
                if (handler.violated(invs[i])) revert(handler.check(invs[i]));
            }
        }
        for (uint256 j = 1; j < 24; ++j) {
            ok[j] = handler.okCount(j);
        }
        (string memory why, MarketHandler.Exit memory e) = handler.exitAll();
        require(bytes(why).length == 0, why);
        (dust, paths) = (e.dust, e.paths);
        vm.revertToStateAndDelete(snap);
    }

    /// The same driver on the correct contracts finds nothing, the exit holds every run, and every action succeeds.
    function test_NC_correctContractsAreClean() public {
        _prodWorld();
        uint256[24] memory total;
        uint256 maxDust;
        for (uint256 run = 1; run <= 6; ++run) {
            (uint256[24] memory ok, uint256 dust, uint256 paths) = this.cleanRun(run);
            assertLe(dust, paths);
            if (dust > maxDust) maxDust = dust;
            for (uint256 j = 1; j < 24; ++j) {
                total[j] += ok[j];
            }
        }
        for (uint256 j = 1; j < 24; ++j) {
            if (j == 16) continue; // topUp exists only on the unchecked_top harness
            assertGt(total[j], 0, string.concat("action never succeeded: ", vm.toString(j)));
        }
        emit log_named_uint("largest dust after everyone left, u", maxDust);
    }
}
