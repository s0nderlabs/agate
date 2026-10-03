// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {AgateIndex} from "../src/AgateIndex.sol";
import {IAgateIndex} from "../src/interfaces/IAgateIndex.sol";
import {MockForwarder} from "../test/mocks/MockForwarder.sol";
import {EnvKey} from "./EnvKey.sol";

/// Deploys AgateIndex from a JSON config (script/config/<name>.json) and registers its GPUs (BUILD-SPEC 13.3).
///
///   anvil --code-size-limit 131072
///   AGATE_CONFIG=local-demo forge script script/DeployIndex.s.sol --rpc-url anvil --broadcast \
///     --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   (anvil account 0, the owner)
///
/// The broadcaster must be the config's owner (registerGpu is the owner's); the script checks it with readCallers.
/// Local anvil only with --sender: Anvil's default accounts carry a 7702 sweeper on Monad testnet and must never be
/// funded there.
///
/// With the owner key (phase 4, the operator's command; the key never on a command line or in a file, and the
/// key-free public RPC on forge's command line):
///
///   AGATE_OWNER_KEY="$(security find-generic-password -s agate.wall.owner -a private-key -w)" \
///   AGATE_CONFIG=<testnet config> forge script script/DeployIndex.s.sol --rpc-url https://testnet-rpc.monad.xyz \
///     --broadcast --slow
///
/// A set AGATE_OWNER_KEY must hold a nonzero 0x-prefixed hex key, or the run stops before any transaction (EnvKey);
/// only an unset one falls back to --sender / --unlocked.
contract DeployIndex is EnvKey {
    function run() external returns (AgateIndex ix) {
        ix = deployWithKey(config(), envKey(_ownerKeyVar()));
    }

    /// AGATE_OWNER_KEY. A test harness overrides it: tests share one process environment.
    function _ownerKeyVar() internal view virtual returns (string memory) {
        return "AGATE_OWNER_KEY";
    }

    /// The JSON of script/config/<AGATE_CONFIG>.json (default local-demo).
    function config() public view returns (string memory) {
        string memory name = vm.envOr("AGATE_CONFIG", string("local-demo"));
        return vm.readFile(string.concat(vm.projectRoot(), "/script/config/", name, ".json"));
    }

    /// as_ zero: the script's sender (--sender / --unlocked); tests pass an address.
    function deploy(string memory json, address as_) public returns (AgateIndex) {
        return _deploy(json, as_, 0);
    }

    /// key nonzero: every transaction is signed with it (13.3, H); zero: as deploy with the script's sender.
    function deployWithKey(string memory json, uint256 key) public returns (AgateIndex) {
        return _deploy(json, address(0), key);
    }

    function _params(string memory json) internal view returns (IAgateIndex.InitParams memory p) {
        p.day = uint32(vm.parseJsonUint(json, ".profile.day"));
        p.slices = uint8(vm.parseJsonUint(json, ".profile.slices"));
        p.minReadings = uint8(vm.parseJsonUint(json, ".profile.minReadings"));
        p.qMin = uint8(vm.parseJsonUint(json, ".profile.qMin"));
        p.demoLabel = vm.parseJsonBool(json, ".profile.demoLabel");
        p.signAll = vm.parseJsonBool(json, ".profile.signAll");
        p.epochDay = uint32(vm.parseJsonUint(json, ".profile.epochDay"));
        // demo profiles: the epoch is the latest block's second minus a few seconds, so day 1 starts now
        if (vm.parseJsonBool(json, ".profile.epochFromBlock")) p.epochTs = uint64(block.timestamp - 5);
        p.chainSelector = uint64(vm.parseJsonUint(json, ".chainSelector"));
        p.owner = vm.parseJsonAddress(json, ".roles.owner");
        p.writers = [vm.parseJsonAddress(json, ".roles.primary"), vm.parseJsonAddress(json, ".roles.standby")];
        p.attester = vm.parseJsonAddress(json, ".roles.attester");
        p.guardians = [vm.parseJsonAddress(json, ".roles.guardian0"), vm.parseJsonAddress(json, ".roles.guardian1")];
        p.forwarder = vm.parseJsonAddress(json, ".forwarder");
        p.writerMode = IAgateIndex.WriterMode(vm.parseJsonUint(json, ".writerMode"));
    }

    function _deploy(string memory json, address as_, uint256 key) internal returns (AgateIndex ix) {
        IAgateIndex.InitParams memory p = _params(json);

        if (key != 0) vm.startBroadcast(key);
        else if (as_ == address(0)) vm.startBroadcast();
        else vm.startBroadcast(as_);
        // msg.sender is not the broadcaster under a key: ask forge who signs
        (, address sender,) = vm.readCallers();
        if (sender != p.owner) {
            vm.stopBroadcast(); // a revert leaves forge's broadcast on in a test; nothing was sent either way
            revert("broadcast with the owner key");
        }
        if (p.forwarder == address(0) && vm.parseJsonBool(json, ".deployMockForwarder")) {
            p.forwarder = address(new MockForwarder());
        }
        ix = new AgateIndex(p);
        uint32 firstDay = uint32(vm.parseJsonUint(json, ".profile.firstDay"));
        if (firstDay == 0) firstDay = ix.dayId(uint64(block.timestamp));
        for (uint256 g;; ++g) {
            string memory k = string.concat(".gpus[", vm.toString(g), "]");
            if (!vm.keyExistsJson(json, k)) break;
            bytes32 id = vm.parseJsonBytes32(json, string.concat(k, ".gpuId"));
            string memory spec = vm.parseJsonString(json, string.concat(k, ".spec"));
            require(id == keccak256(bytes(spec)), "gpuId != keccak256(spec)");
            uint256[] memory fam = vm.parseJsonUintArray(json, string.concat(k, ".family"));
            uint256[] memory q = vm.parseJsonUintArray(json, string.concat(k, ".famQ"));
            uint8[] memory fam8 = new uint8[](fam.length);
            uint8[] memory q8 = new uint8[](q.length);
            for (uint256 i; i < fam.length; ++i) {
                fam8[i] = uint8(fam[i]);
            }
            for (uint256 i; i < q.length; ++i) {
                q8[i] = uint8(q[i]);
            }
            uint32 mask = uint32(vm.parseJsonUint(json, string.concat(k, ".liveAtStartMask")));
            // 7.2 / 13.3: an odd number of live families, so no single held slot moves the median by half a gap (LV-6)
            if (!vm.envOr("AGATE_ALLOW_EVEN_LIVE", false)) {
                require(liveFamilies(fam8, mask) % 2 == 1, "even live family count (set AGATE_ALLOW_EVEN_LIVE=true)");
            }
            ix.registerGpu(id, vm.parseJsonBytes32(json, string.concat(k, ".recipeHash")), fam8, q8, firstDay, mask);
            console2.log("registered", spec);
        }
        vm.stopBroadcast();

        IAgateIndex.Clocks memory c = ix.clocks();
        console2.log("AgateIndex", address(ix));
        console2.log("forwarder", p.forwarder);
        console2.log("firstDay", firstDay);
        console2.log("day, slices, tPend", c.day, c.slices, c.tPend);
    }

    function liveFamilies(uint8[] memory fam, uint32 mask) internal pure returns (uint256 n) {
        uint256 seen;
        for (uint256 i; i < fam.length; ++i) {
            if (mask >> i & 1 == 1 && seen >> fam[i] & 1 == 0) {
                seen |= uint256(1) << fam[i];
                ++n;
            }
        }
    }
}
