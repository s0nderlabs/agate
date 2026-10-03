// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";
import {DeployIndex} from "../../script/DeployIndex.s.sol";

/// BUILD-SPEC 18.4: the local and fork deploy configs carry six GPUs (H100, H200 and B200 unchanged, then the price-only
/// B300, A100 and L40S), and DeployIndex registers every entry with its own recipeHash, families, famQ and live mask.
/// In-process runs on the local test chain only (Anvil account 0 as the configs' owner; never a public network).
contract DeployIndexSixGpusTest is Test {
    address internal constant ANVIL0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    uint32 internal constant NEVER = type(uint32).max;

    function setUp() public {
        vm.warp(1_800_000_000);
    }

    function _config(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/script/config/", name, ".json"));
    }

    function _count(string memory json) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".gpus[", vm.toString(n), "]"))) ++n;
    }

    /// Every entry of `json` is registered on `ix` exactly as the config says.
    function _checkAll(AgateIndex ix, string memory json) internal view {
        uint256 n = _count(json);
        for (uint256 g; g < n; ++g) {
            string memory k = string.concat(".gpus[", vm.toString(g), "]");
            string memory spec = vm.parseJsonString(json, string.concat(k, ".spec"));
            bytes32 id = vm.parseJsonBytes32(json, string.concat(k, ".gpuId"));
            assertEq(id, keccak256(bytes(spec)), spec);
            IAgateIndex.GpuConfig memory c = ix.gpu(id);
            uint256[] memory fam = vm.parseJsonUintArray(json, string.concat(k, ".family"));
            uint256[] memory q = vm.parseJsonUintArray(json, string.concat(k, ".famQ"));
            uint256 mask = vm.parseJsonUint(json, string.concat(k, ".liveAtStartMask"));
            assertEq(c.recipeHash, vm.parseJsonBytes32(json, string.concat(k, ".recipeHash")), spec);
            assertEq(c.nSlots, fam.length, spec);
            assertEq(c.nFamilies, q.length, spec);
            assertEq(c.head, c.firstDay, spec);
            for (uint256 i; i < fam.length; ++i) {
                (uint8 f, uint8 fq) = ix.familyOf(id, uint8(i));
                assertEq(f, fam[i], spec);
                assertEq(fq, q[fam[i]], spec);
                (uint32 liveFrom, uint32 liveUntil) = ix.slotWindow(id, uint8(i));
                // a live slot from the first day on; a reserve slot never until the owner's timelocked setLiveFrom
                if (mask >> i & 1 == 1) assertEq(liveFrom, c.firstDay, spec);
                else assertEq(liveFrom, NEVER, spec);
                assertEq(liveUntil, NEVER, spec);
            }
        }
    }

    function test_deployIndex_registersSixGpusFromTheLocalConfig() public {
        string memory json = _config("local-demo");
        assertEq(_count(json), 6);
        uint64 n0 = vm.getNonce(ANVIL0);
        AgateIndex ix = new DeployIndex().deploy(json, ANVIL0);
        _checkAll(ix, json);
        // forwarder, index, then one registerGpu per GPU
        assertEq(vm.getNonce(ANVIL0), n0 + 2 + 6);
        // the three registered GPUs keep their gpuIds and slot counts; the price-only ones have their own spec form
        assertEq(ix.gpu(0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955).nSlots, 5); // H100
        assertEq(ix.gpu(0xf7b3c4797305bd1433be196119ae5d6df4a433cffbf8d02c22048cc3a487b30d).nSlots, 4); // H200
        assertEq(ix.gpu(0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27).nSlots, 4); // B200
        assertEq(ix.gpu(keccak256("B300-SXM/on-demand-list/neocloud/v1")).nSlots, 4);
        assertEq(ix.gpu(keccak256("A100-SXM/on-demand-list/neocloud/v1")).nSlots, 3);
        assertEq(ix.gpu(keccak256("L40S-PCIe/on-demand-list/neocloud/v1")).nSlots, 2);
        assertEq(ix.gpu(keccak256("L40S-SXM/on-demand-list/neocloud/v1")).nSlots, 0);
    }

    /// Every local profile and the fork rehearsal's config deploy with six GPUs (each profile's own clock).
    function test_deployIndex_everyLocalAndForkConfigRegistersSix() public {
        string[5] memory names = ["local-demo", "local-fast", "local-test", "local-production", "fork-demo"];
        for (uint256 i; i < names.length; ++i) {
            string memory json = _config(names[i]);
            assertEq(_count(json), 6, names[i]);
            address owner = vm.parseJsonAddress(json, ".roles.owner");
            AgateIndex ix = new DeployIndex().deploy(json, owner);
            _checkAll(ix, json);
        }
    }

    /// An entry among the six with an even live count (here L40S, the sixth) is refused like any other (the odd rule
    /// of 7.2 applies per GPU).
    function test_deployIndex_refusesAnEvenLiveEntryAmongSix() public {
        string memory json = _config("local-demo");
        // the L40S entry made even: Verda and Civo both live
        string memory even = vm.replace(
            json,
            string.concat(
                '"recipeHash": "0x0eb6eb135826c62e0b94d2fc451f2ad54e8e5275e1683cda343330d862c932c2",\n',
                '   "family": [\n    0,\n    1\n   ],\n   "famQ": [\n    1,\n    1\n   ],\n   "liveAtStartMask": 1'
            ),
            string.concat(
                '"recipeHash": "0x0eb6eb135826c62e0b94d2fc451f2ad54e8e5275e1683cda343330d862c932c2",\n',
                '   "family": [\n    0,\n    1\n   ],\n   "famQ": [\n    1,\n    1\n   ],\n   "liveAtStartMask": 3'
            )
        );
        assertTrue(keccak256(bytes(even)) != keccak256(bytes(json)), "the L40S entry was edited");
        DeployIndex di = new DeployIndex();
        vm.expectRevert(bytes("even live family count (set AGATE_ALLOW_EVEN_LIVE=true)"));
        di.deploy(even, ANVIL0);
    }
}
