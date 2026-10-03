// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgateIndex} from "../../src/AgateIndex.sol";
import {IAgateIndex} from "../../src/interfaces/IAgateIndex.sol";

/// The index's digestOf against the TypeScript vector (report_example.json, written by the report package), the
/// counterpart of the ReportVector test.
contract DigestVectorTest is Test {
    function test_digestOfMatchesTypeScript() public {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/report_example.json"));
        IAgateIndex.InitParams memory ip;
        ip.day = 86_400;
        ip.slices = 24;
        ip.minReadings = 12;
        ip.qMin = 3;
        ip.owner = address(1);
        ip.writers = [address(2), address(0)];
        ip.attester = address(3);
        ip.guardians = [address(4), address(0)];
        AgateIndex ix = new AgateIndex(ip);
        uint256[] memory pRaw = vm.parseJsonUintArray(json, ".p");
        uint256[] memory kRaw = vm.parseJsonUintArray(json, ".kinds");
        uint256[] memory cRaw = vm.parseJsonUintArray(json, ".counts");
        uint256[] memory eRaw = vm.parseJsonUintArray(json, ".postE");
        uint256[] memory mRaw = vm.parseJsonUintArray(json, ".postMiss");
        bool[] memory inM = vm.parseJsonBoolArray(json, ".postIn");
        bool[] memory was = vm.parseJsonBoolArray(json, ".postWas");
        uint256 n = pRaw.length;
        uint32[] memory p = new uint32[](n);
        IAgateIndex.Kind[] memory kinds = new IAgateIndex.Kind[](n);
        uint8[] memory counts = new uint8[](n);
        IAgateIndex.SlotState[] memory post = new IAgateIndex.SlotState[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = uint32(pRaw[i]);
            kinds[i] = IAgateIndex.Kind(kRaw[i]);
            counts[i] = uint8(cRaw[i]);
            post[i] = IAgateIndex.SlotState(uint32(eRaw[i]), uint8(mRaw[i]), inM[i], was[i]);
        }
        bytes32 d = ix.digestOf(
            vm.parseJsonBytes32(json, ".gpuIdH100"),
            uint32(vm.parseJsonUint(json, ".day")),
            vm.parseJsonAddress(json, ".source"),
            p,
            kinds,
            counts,
            post,
            uint32(vm.parseJsonUint(json, ".value"))
        );
        assertEq(d, vm.parseJsonBytes32(json, ".digest"));
    }
}
