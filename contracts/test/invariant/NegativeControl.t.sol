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
