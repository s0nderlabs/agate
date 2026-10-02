// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AgateToken} from "../../../src/market/AgateToken.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";

/// BUILD-SPEC 4.3: OpenZeppelin ERC20 + ERC20Permit, 6 decimals, minted and burned only by its series.
contract SeriesTokenTest is Test {
    AgateToken internal t;
    uint256 internal ownerKey = 0xA11CE;
    address internal owner;
    address internal spender = makeAddr("spender");

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        t = new AgateToken("agate H100 Nov 2026", "H100-NOV26"); // this test is its series
        owner = vm.addr(ownerKey);
    }

    function test_metadata() public view {
        assertEq(t.name(), "agate H100 Nov 2026");
        assertEq(t.symbol(), "H100-NOV26");
        assertEq(t.decimals(), 6);
        assertEq(t.series(), address(this));
    }

    function test_onlySeriesMintsAndBurns() public {
        t.mint(owner, 100);
        vm.prank(owner);
        vm.expectRevert(IAgateToken.OnlySeries.selector);
        t.mint(owner, 1);
        vm.prank(owner);
        vm.expectRevert(IAgateToken.OnlySeries.selector);
        t.burn(owner, 1);
        t.burn(owner, 40); // the series needs no allowance
        assertEq(t.balanceOf(owner), 60);
        assertEq(t.totalSupply(), 60);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, owner, 60, 61));
        t.burn(owner, 61);
    }

    function _sign(uint256 key, address o, address sp, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, o, sp, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }

    function test_domainIsNameAndVersionOne() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("agate H100 Nov 2026")),
                keccak256(bytes("1")),
                block.chainid,
                address(t)
            )
        );
        assertEq(t.DOMAIN_SEPARATOR(), expected);
    }

    function test_permitSetsAllowanceAndBumpsNonce() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerKey, owner, spender, type(uint256).max, 0, block.timestamp + 1);
        t.permit(owner, spender, type(uint256).max, block.timestamp + 1, v, r, s);
        assertEq(t.allowance(owner, spender), type(uint256).max);
        assertEq(t.nonces(owner), 1);
        // a replay of the same signature fails (the nonce moved on)
        vm.expectRevert();
        t.permit(owner, spender, type(uint256).max, block.timestamp + 1, v, r, s);
    }

    function test_permitExpiredOrBadSignatureFails() public {
        vm.warp(1_000);
        (uint8 v, bytes32 r, bytes32 s) = _sign(ownerKey, owner, spender, 5, 0, 999);
        vm.expectRevert(abi.encodeWithSelector(ERC20Permit.ERC2612ExpiredSignature.selector, 999));
        t.permit(owner, spender, 5, 999, v, r, s);
        (v, r, s) = _sign(0xB0B, owner, spender, 5, 0, 2_000); // signed by someone else
        vm.expectRevert();
        t.permit(owner, spender, 5, 2_000, v, r, s);
        assertEq(t.allowance(owner, spender), 0);
        assertEq(t.nonces(owner), 0);
    }

    function test_transfersFreely() public {
        t.mint(owner, 10);
        vm.prank(owner);
        t.transfer(spender, 4);
        assertEq(t.balanceOf(spender), 4);
    }
}
