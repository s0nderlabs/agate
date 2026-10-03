// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexBase} from "../Base.t.sol";
import {IndexHandler} from "./IndexHandler.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// I16's negative control (BUILD-SPEC 12.1): a harness whose attest skips the digest check must fail the I16 check;
/// the honest flow on the same state passes it.
contract I16NegativeControlTest is IndexBase {
    IndexHandler internal h;
    uint32[] internal V;

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
        h = new IndexHandler(ix, [w1, w2, att, g1, keeper, owner], OCT1, 5);
        V = arr(3_000_000, 3_200_000, 3_400_000, 3_600_000, 3_800_000);
        feedDay(OCT1, V, none());
        closeEarliest(w1, OCT1);
    }

    function test_mutantAttestWithoutDigestCheckIsCaught() public {
        assertEq(h.checkRecords(), "", "the honest state passes");
        h.mutantAttest(OCT1, keccak256("a digest that is not the record's"));
        IAgateIndex.Record memory r = rec(OCT1);
        assertTrue(r.needsSign && r.attestedAt != 0 && r.finalAt != 0, "the mutant made it final");
        warpTo(r.finalAt);
        assertEq(h.checkRecords(), "I16: a needsSign record final without a countersign on its exact digest");
    }

    function test_mutantFinalWithoutAnyAttestIsCaught() public {
        bytes32 slot = keccak256(abi.encode(uint256(OCT1), keccak256(abi.encode(GPU, uint256(10)))));
        IAgateIndex.Record memory r = rec(OCT1);
        vm.store(address(ix), bytes32(uint256(slot) + 2), bytes32(uint256(r.postedAt + tPend())));
        warpTo(r.postedAt + tPend());
        assertTrue(isFinal(OCT1));
        assertEq(h.checkRecords(), "I16: a needsSign record final without a countersign on its exact digest");
    }
}

/// I31 and I32's negative controls (BUILD-SPEC 12.1, Oct 3): the handler's checks are not blind. A queued eta that
/// disagrees with the ghost fails checkQueue; a moved slot state changes the world hash the swap actions compare.
contract I31I32NegativeControlTest is IndexBase {
    IndexHandler internal h;

    function setUp() public {
        deploy(TEST_P(), 0);
        registerSimple(GPU, 5, OCT1);
        h = new IndexHandler(ix, [w1, w2, att, g1, keeper, owner], OCT1, 5);
    }

    function test_queuedEtaOffTheGhostIsCaught() public {
        vm.warp(T0 + 100);
        h.queueSwap(3 | (1 << 8)); // slot 259 % 6 = 1, reader 1
        assertEq(h.violation(), "");
        assertEq(h.checkQueue(), "", "the honest state passes");
        bytes32 id = h.ids(0);
        uint256 eta = h.ghostEta(id);
        assertEq(ix.queuedEta(id), eta);
        // Store.queued is the mapping at slot 8 of AgateIndex's storage
        vm.store(address(ix), keccak256(abi.encode(id, uint256(8))), bytes32(eta + 1));
        assertEq(h.checkQueue(), "I32: queuedEta disagrees with the live window");
        // past the window an honest index shows 0 whatever the raw entry holds
        vm.store(address(ix), keccak256(abi.encode(id, uint256(8))), bytes32(eta));
        vm.warp(eta + 14 * uint256(P.day) + 1);
        assertEq(ix.queuedEta(id), 0);
        assertEq(h.checkQueue(), "");
    }

    function test_movedSlotStateChangesTheWorld() public {
        bytes32 w0 = h.world();
        // Store.gpus is the mapping at slot 9; GpuS.last (uint64[15]) starts 12 words into the struct
        bytes32 g = bytes32(uint256(keccak256(abi.encode(GPU, uint256(9)))) + 12);
        bytes32 orig = vm.load(address(ix), g);
        vm.store(address(ix), g, bytes32(uint256(orig) ^ 1));
        assertTrue(h.world() != w0, "the world hash sees a moved slot state");
        // and a swap's queue and execute leave an honest world unchanged
        vm.store(address(ix), g, orig);
        assertEq(h.world(), w0);
        w0 = h.world();
        h.queueSwap(2);
        vm.warp(h.ghostEta(h.ids(0)));
        h.executeSwap(0);
        assertEq(h.violation(), "");
        assertEq(ix.readerHistory(GPU, 2).length, 1);
        assertEq(h.world(), w0);
    }
}
