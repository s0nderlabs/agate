// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAgateIndex} from "../src/interfaces/IAgateIndex.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";

/// Pins the wire format shared with wall/packages/report (vector written by its scripts/gen-example.ts).
/// The index builder adds: assertEq(index.digestOf(...), v.digest) once AgateIndex exists.
contract ReportVectorTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/report_example.json"));
    }

    function test_reportDecodes() public view {
        bytes memory report = vm.parseJsonBytes(json, ".reportHex");
        (uint8 version, uint64 chainSelector, address index, IAgateIndex.Entry[] memory entries) =
            abi.decode(report, (uint8, uint64, address, IAgateIndex.Entry[]));
        assertEq(version, 1);
        assertEq(chainSelector, uint64(vm.parseJsonUint(json, ".chainSelector")));
        assertEq(index, vm.parseJsonAddress(json, ".index"));
        assertEq(entries.length, 2);
        assertEq(entries[0].gpuId, vm.parseJsonBytes32(json, ".gpuIdH100"));
        assertEq(entries[0].dayId, vm.parseJsonUint(json, ".day"));
        assertEq(entries[0].slice, vm.parseJsonUint(json, ".slice"));
        assertEq(entries[0].readAt, vm.parseJsonUint(json, ".readAt"));
        uint256[] memory v = vm.parseJsonUintArray(json, ".valuesH100");
        assertEq(entries[0].values.length, v.length);
        for (uint256 i; i < v.length; ++i) {
            assertEq(entries[0].values[i], v[i]);
        }
        assertEq(entries[1].values.length, 4);
    }

    function test_digestMatchesTypeScript() public view {
        uint256[] memory pRaw = vm.parseJsonUintArray(json, ".p");
        uint256[] memory kRaw = vm.parseJsonUintArray(json, ".kinds");
        uint256[] memory cRaw = vm.parseJsonUintArray(json, ".counts");
        uint256[] memory mRaw = vm.parseJsonUintArray(json, ".postMiss");
        bool[] memory inMedian = vm.parseJsonBoolArray(json, ".postIn");
        bool[] memory wasIn = vm.parseJsonBoolArray(json, ".postWas");
        uint256 n = pRaw.length;
        uint32[] memory p = new uint32[](n);
        IAgateIndex.Kind[] memory kinds = new IAgateIndex.Kind[](n);
        uint8[] memory counts = new uint8[](n);
        uint8[] memory miss = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = uint32(pRaw[i]);
            kinds[i] = IAgateIndex.Kind(kRaw[i]);
            counts[i] = uint8(cRaw[i]);
            miss[i] = uint8(mRaw[i]);
        }
        bytes32 d = keccak256(
            abi.encode(
                vm.parseJsonBytes32(json, ".gpuIdH100"),
                uint32(vm.parseJsonUint(json, ".day")),
                vm.parseJsonAddress(json, ".source"),
                p,
                kinds,
                counts,
                inMedian,
                miss,
                wasIn,
                uint32(vm.parseJsonUint(json, ".value"))
            )
        );
        assertEq(d, vm.parseJsonBytes32(json, ".digest"));
    }

    function test_receiverInterfaceId() public pure {
        assertEq(type(IReceiver).interfaceId, bytes4(keccak256("onReport(bytes,bytes)")));
    }
}
