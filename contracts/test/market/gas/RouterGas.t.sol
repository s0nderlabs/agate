// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {U, Permit} from "../../../src/market/MarketTypes.sol";
import {GasBase} from "./GasBase.sol";

/// The router shapes of BUILD-SPEC 9.2 against MockKuruOrderBook (its arithmetic, not Kuru's code: the same flows
/// on Kuru's deployed OrderBook are measured in fork/KuruV1.t.sol). December, before its first day (c = 0). The
/// book: 1,000 tokens per order at 3.64, 3.65, 3.66 and bids at 3.60, 3.59, 3.58. A buy across levels carries
/// 1,000 u of headroom for Kuru's per-level dust (BUILD-SPEC 6.5).
contract RouterGasTest is GasBase {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        _world();
    }

    function _r(string memory shape, address u, bytes memory data) internal returns (M memory) {
        return _m(shape, u, address(router), data, address(0), 0);
    }

    function test_gas_open() public {
        address s = address(dec);
        _r(
            "openLong, one maker order crossed",
            alice,
            abi.encodeCall(IAgateRouter.openLong, (s, 364 * U, 100 * U, _none()))
        );
        _r(
            "openLong, two maker orders crossed",
            alice,
            abi.encodeCall(IAgateRouter.openLong, (s, 3_640 * U + 1_825 * U + 1_000, 1_500 * U, _none()))
        );
        _r(
            "openLong, three maker orders crossed",
            alice,
            abi.encodeCall(IAgateRouter.openLong, (s, 3_640 * U + 3_650 * U + 1_830 * U + 1_000, 2_500 * U, _none()))
        );
        _r(
            "openLongDaily, parts 1",
            alice,
            abi.encodeCall(IAgateRouter.openLongDaily, (s, 364 * U, 100 * U, 1, alice, _none()))
        );
        _r(
            "openLongDaily, parts 8",
            alice,
            abi.encodeCall(IAgateRouter.openLongDaily, (s, 2_912 * U, 800 * U, 8, alice, _none()))
        );
        _r(
            "openShort, parts 1",
            alice,
            abi.encodeCall(IAgateRouter.openShort, (s, 100 * U, 1, 1, alice, true, _none()))
        );
        _r(
            "openShort, parts 8",
            alice,
            abi.encodeCall(IAgateRouter.openShort, (s, 800 * U, 1, 8, alice, true, _none()))
        );
    }

    function test_gas_close() public {
        address s = address(dec);
        vm.startPrank(alice);
        dec.mint(100 * U, alice);
        (uint256[] memory sids,,) = router.openShort(s, 200 * U, 1, 2, alice, true, _none());
        uint256[] memory lids = router.openLongDaily(s, 728 * U, 200 * U, 2, alice, _none());
        vm.stopPrank();
        uint256[] memory s1 = new uint256[](1);
        s1[0] = sids[0];
        uint256[] memory l1 = new uint256[](1);
        l1[0] = lids[0];
        _r("closeLong 100 tokens", alice, abi.encodeCall(IAgateRouter.closeLong, (s, 100 * U, 1, _none())));
        _r("closeShort, one id", alice, abi.encodeCall(IAgateRouter.closeShort, (s, s1, 365 * U, _none())));
        _r("closeShort, two ids", alice, abi.encodeCall(IAgateRouter.closeShort, (s, sids, 730 * U, _none())));
        _r("closeLongDaily, one id", alice, abi.encodeCall(IAgateRouter.closeLongDaily, (s, l1, 1, _none())));
        _r("closeLongDaily, two ids", alice, abi.encodeCall(IAgateRouter.closeLongDaily, (s, lids, 1, _none())));
    }

    /// The first click on an asset: a permit for a standing amount instead of a standing allowance.
    function test_gas_permit() public {
        uint256 key = uint256(keccak256("agate gas permit user"));
        address u = vm.addr(key);
        usd.mint(u, 1e12);
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, u, address(router), type(uint256).max, usd.nonces(u), block.timestamp + 1 days)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, digest);
        Permit memory p = Permit(type(uint256).max, block.timestamp + 1 days, v, r, ss);
        _r(
            "openLong with a permit (first click)",
            u,
            abi.encodeCall(IAgateRouter.openLong, (address(dec), 364 * U, 100 * U, p))
        );
    }
}
