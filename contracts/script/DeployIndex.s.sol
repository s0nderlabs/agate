// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {AgateIndex} from "../src/AgateIndex.sol";
import {IAgateIndex} from "../src/interfaces/IAgateIndex.sol";
import {MockForwarder} from "../test/mocks/MockForwarder.sol";

/// Deploys AgateIndex from a JSON config (script/config/<name>.json) and registers its GPUs (BUILD-SPEC 13.3).
///
///   anvil --code-size-limit 131072
///   AGATE_CONFIG=local-demo forge script script/DeployIndex.s.sol --rpc-url anvil --broadcast \
///     --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   (anvil account 0, the owner)
///
/// The broadcasting key must be the config's owner (registerGpu is the owner's). Local anvil only: Anvil's
/// default accounts carry a 7702 sweeper on Monad testnet and must never be funded there.
contract DeployIndex is Script {
    function run() external returns (AgateIndex ix) {
        string memory name = vm.envOr("AGATE_CONFIG", string("local-demo"));
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/script/config/", name, ".json"));

        IAgateIndex.InitParams memory p;
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

        vm.startBroadcast();
        require(msg.sender == p.owner, "broadcast with the owner key");
        if (p.forwarder == address(0) && vm.parseJsonBool(json, ".deployMockForwarder")) {
            p.forwarder = address(new MockForwarder());
        }
        ix = new AgateIndex(p);
        uint32 firstDay = uint32(vm.parseJsonUint(json, ".profile.firstDay"));
        if (firstDay == 0) firstDay = ix.dayId(uint64(block.timestamp));
        for (uint256 g; ; ++g) {
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
            ix.registerGpu(
                id,
                vm.parseJsonBytes32(json, string.concat(k, ".recipeHash")),
                fam8,
                q8,
                firstDay,
                mask
            );
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
