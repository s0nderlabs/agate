// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {U, Side} from "../../../src/market/MarketTypes.sol";
import {SeriesBase} from "./SeriesBase.sol";

/// I15: every term never changes; no owner, proxy, pause, selfdestruct or delegatecall in the series, its token, the
/// factory or the factory's router.
contract SeriesImmutabilityTest is SeriesBase {
    function test_I15_termsNeverChange() public {
        bytes memory t0 = abi.encode(s.terms());
        address token0 = s.token();
        _mint(a, 40 * U);
        (uint256 id,) = _stream(a, Side.SHORT, 10 * U, a, a, true);
        vm.warp(_afterDay(12));
        s.claim(id);
        vm.warp(_deadline(30) + 1);
        index.setRevertFrom(GPU, 0);
        vm.prank(a);
        s.settle(Side.LONG, 40 * U, a);
        assertEq(abi.encode(s.terms()), t0);
        assertEq(s.token(), token0);
        assertEq(tok.series(), address(s));
    }

    /// A real factory over this test's index and dollar (the series above stand alone, with placeholder router and
    /// factory addresses), so the walk and the probes cover the factory and the router it deploys.
    function _factory() internal returns (AgateFactory f) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = GPU;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        f = new AgateFactory(address(index), address(dollar), address(0), ids, labels, a, "", 0, 0);
    }

    /// Walks every reachable byte of the runtime code (BUILD-SPEC 11, I15 as revised in v3.2) for DELEGATECALL,
    /// CALLCODE and SELFDESTRUCT: PUSH data is skipped, the CBOR metadata is cut off, and after a halting opcode (STOP,
    /// JUMP, RETURN, REVERT, INVALID) nothing runs until the next JUMPDEST. via_ir puts 32-byte constants after the
    /// final INVALID as data (the router's Routed topic holds an 0xff byte), which a plain walk misreads. The linear
    /// scan with PUSH skipping finds exactly the JUMPDESTs the EVM accepts, so no reachable byte is skipped.
    function _assertNoForbiddenOpcode(address target) internal view returns (uint256 seen) {
        bytes memory code = target.code;
        uint256 end = code.length;
        if (end >= 2) {
            uint256 meta = (uint256(uint8(code[end - 2])) << 8) | uint8(code[end - 1]);
            if (meta + 2 <= end) end -= meta + 2;
        }
        bool live = true;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op == 0x5b) live = true;
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            if (!live) continue;
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            ++seen;
            if (op == 0x00 || op == 0x56 || op == 0xf3 || op == 0xfd || op == 0xfe) live = false;
        }
        assertGt(seen, 100);
    }

    function test_I15_noDelegatecallCallcodeOrSelfdestruct() public {
        _assertNoForbiddenOpcode(address(s));
        _assertNoForbiddenOpcode(address(tok));
        AgateFactory f = _factory();
        assertGt(_assertNoForbiddenOpcode(address(f)), 1_000);
        assertGt(_assertNoForbiddenOpcode(f.router()), 1_000);
    }

    /// The walk is not vacuous: a plain walk (PUSH data skipped, nothing else) of the router meets an 0xff byte
    /// that is data after the final INVALID, which the reachable walk above rightly ignores.
    function test_I15_plainWalkMisreadsTheRoutersData() public {
        bytes memory code = _factory().router().code;
        uint256 end = code.length - 2 - ((uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]));
        bool ffSeen;
        for (uint256 i; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f;
                continue;
            }
            if (op == 0xff) ffSeen = true;
        }
        assertTrue(ffSeen);
    }

    function _adminCalls() internal view returns (bytes[8] memory calls) {
        calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("unpause()"),
            abi.encodeWithSignature("transferOwnership(address)", a),
            abi.encodeWithSignature("renounceOwnership()"),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", a, ""),
            abi.encodeWithSignature("implementation()"),
            abi.encodeWithSignature("setTerms(bytes)", "")
        ];
    }

    function test_I15_noAdminSurface() public {
        AgateFactory f = _factory();
        address[4] memory targets = [address(s), address(tok), address(f), f.router()];
        bytes[8] memory calls = _adminCalls();
        for (uint256 t; t < targets.length; ++t) {
            for (uint256 i; i < calls.length; ++i) {
                (bool ok,) = targets[t].call(calls[i]);
                assertFalse(ok);
            }
        }
        vm.deal(a, 1 ether);
        for (uint256 t; t < targets.length; ++t) {
            vm.prank(a);
            (bool sent,) = targets[t].call{value: 1}("");
            assertFalse(sent, "no contract of the market takes ether");
        }
    }
}
