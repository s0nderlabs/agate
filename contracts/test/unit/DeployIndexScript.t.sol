// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {DeployIndex} from "../../script/DeployIndex.s.sol";

/// DeployIndex with its key under another variable name: tests share one process environment, so only
/// test_deployIndex_signsWithTheOwnerKey touches AGATE_OWNER_KEY itself.
contract DeployIndexHarness is DeployIndex {
    string internal keyVar;

    constructor(string memory k) {
        keyVar = k;
    }

    function _ownerKeyVar() internal view override returns (string memory) {
        return keyVar;
    }
}

/// BUILD-SPEC 13.3 (H, Oct 3): DeployIndex reads the owner key with the fail-closed EnvKey loader and checks the
/// broadcaster with readCallers. In-process runs of the script on the local test chain only (Anvil account 0's
/// public test key; never a real key, never a public network).
contract DeployIndexScriptTest is Test {
    /// Anvil's (and Hardhat's) published default account 0: a public test key, local chains only.
    uint256 internal constant ANVIL0_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    bytes32 internal constant H100 = 0x12aa97fa8c2e1cc1914a2e4d86b36c7b36fdccec7c4caacb5f202ccc6d9be955;
    bytes32 internal constant B200 = 0x0a5bf357b491308f9e8b00f22d9d58b1c984046be5b4a94a21a59038b996dd27;

    function setUp() public {
        vm.warp(1_800_000_000);
    }

    function _json() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/script/config/local-demo.json"));
    }

    function _nGpus() internal view returns (uint64 n) {
        string memory json = _json();
        while (vm.keyExistsJson(json, string.concat(".gpus[", vm.toString(n), "]"))) ++n;
    }

    function _checkDeployed(AgateIndex ix, address owner_) internal view {
        assertEq(ix.owner(), owner_);
        assertEq(ix.gpu(H100).nSlots, 5);
        assertEq(ix.gpu(B200).nSlots, 4);
        assertEq(ix.clocks().day, 600);
        (address f,) = ix.forwarder();
        assertTrue(f.code.length != 0, "the mock forwarder was deployed");
    }

    /// run() with AGATE_OWNER_KEY: a set but bad value stops it before any transaction; Anvil account 0's key signs.
    function test_deployIndex_signsWithTheOwnerKey() public {
        assertEq(vm.addr(ANVIL0_KEY), ANVIL0);
        DeployIndex di = new DeployIndex();
        vm.setEnv("AGATE_OWNER_KEY", "");
        vm.expectRevert(bytes("AGATE_OWNER_KEY is set but is not a nonzero 0x-prefixed hex key"));
        di.run();
        vm.setEnv("AGATE_OWNER_KEY", vm.toString(bytes32(ANVIL0_KEY)));
        uint64 n0 = vm.getNonce(ANVIL0);
        AgateIndex ix = di.run();
        _checkDeployed(ix, ANVIL0);
        assertGt(vm.getNonce(ANVIL0), n0, "the key's account sent the transactions");
        // the index is the transaction before the config's registerGpu calls (one per GPU)
        assertEq(vm.computeCreateAddress(ANVIL0, vm.getNonce(ANVIL0) - 1 - _nGpus()), address(ix), "created by the key's account");
    }

    /// Empty (a failed Keychain read), no 0x, "0x" alone, zero, too long, not hex: each stops the run.
    function test_deployIndex_failsClosedOnABadKey() public {
        string memory hexKey = vm.toString(bytes32(ANVIL0_KEY));
        string[6] memory bad = [
            "",
            vm.replace(hexKey, "0x", ""),
            "0x",
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            string.concat(hexKey, "00"),
            "0xzz"
        ];
        for (uint256 i; i < bad.length; ++i) {
            string memory name = string.concat("AGATE_TEST_DEPLOY_KEY_BAD_", vm.toString(i));
            DeployIndexHarness h = new DeployIndexHarness(name);
            vm.setEnv(name, bad[i]);
            vm.expectRevert(bytes(string.concat(name, " is set but is not a nonzero 0x-prefixed hex key")));
            h.run();
        }
    }

    function test_deployIndex_refusesANonOwnerKey() public {
        DeployIndex di = new DeployIndex();
        vm.expectRevert(bytes("broadcast with the owner key"));
        di.deployWithKey(_json(), uint256(keccak256("not the owner")));
        vm.expectRevert(bytes("broadcast with the owner key"));
        di.deploy(_json(), makeAddr("not the owner either"));
        // through run() as well
        DeployIndexHarness h = new DeployIndexHarness("AGATE_TEST_DEPLOY_KEY_STRANGER");
        vm.setEnv("AGATE_TEST_DEPLOY_KEY_STRANGER", vm.toString(bytes32(uint256(keccak256("not the owner")))));
        vm.expectRevert(bytes("broadcast with the owner key"));
        h.run();
    }

    /// Unset, the key falls back to the script's sender (forge's --sender / --unlocked; here the test's default
    /// sender), never to another key: the config's owner must be that sender.
    function test_deployIndex_unsetKeyUsesSender() public {
        DeployIndexHarness h = new DeployIndexHarness("AGATE_TEST_DEPLOY_KEY_UNSET_7d2e");
        assertEq(h.envKey("AGATE_TEST_DEPLOY_KEY_UNSET_7d2e"), 0);
        // local-demo's owner is Anvil account 0, not the default sender: refused
        vm.expectRevert(bytes("broadcast with the owner key"));
        h.run();
        // with the default sender as owner it deploys, as that sender
        string memory json = vm.replace(_json(), vm.toString(ANVIL0), vm.toString(DEFAULT_SENDER));
        AgateIndex ix = h.deployWithKey(json, 0);
        _checkDeployed(ix, DEFAULT_SENDER);
        // the explicit --sender path of the local anvil runbook
        _checkDeployed(h.deploy(_json(), ANVIL0), ANVIL0);
    }
}
