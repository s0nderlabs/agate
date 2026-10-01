// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {SpikeMarket} from "../src/SpikeMarket.sol";

contract SpikeMarketTest is Test {
    TestUSD usd;
    SpikeMarket market;
    uint256 userKey = 0xA11CE;
    address user;
    address agent = address(0xA6E7);

    function setUp() public {
        usd = new TestUSD();
        market = new SpikeMarket(usd);
        user = vm.addr(userKey);
        usd.faucet(user);
    }

    function test_buyUp() public {
        vm.startPrank(user);
        usd.approve(address(market), 100e6);
        market.buyUp(100e6);
        vm.stopPrank();
        assertEq(market.up().balanceOf(user), 100e6);
        assertEq(usd.balanceOf(user), 9_900e6);
    }

    function test_buyUpWithPermit() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                user, address(market), 50e6, usd.nonces(user), deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(userKey, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(user);
        market.buyUpWithPermit(50e6, deadline, v, r, s);
        assertEq(market.up().balanceOf(user), 50e6);
    }

    function test_agentWithinCap() public {
        vm.startPrank(user);
        usd.approve(address(market), type(uint256).max);
        market.approveAgent(agent, 200e6, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        vm.prank(agent);
        market.buyUpFor(user, 150e6);
        assertEq(market.up().balanceOf(user), 150e6);
        vm.prank(agent);
        vm.expectRevert(SpikeMarket.AgentNotAllowed.selector);
        market.buyUpFor(user, 51e6);
    }

    function test_agentExpired() public {
        vm.startPrank(user);
        usd.approve(address(market), type(uint256).max);
        market.approveAgent(agent, 200e6, uint64(block.timestamp + 1));
        vm.stopPrank();
        vm.warp(block.timestamp + 2);
        vm.prank(agent);
        vm.expectRevert(SpikeMarket.AgentNotAllowed.selector);
        market.buyUpFor(user, 1e6);
    }

    function test_strangerCannotBuyForUser() public {
        vm.prank(user);
        usd.approve(address(market), type(uint256).max);
        vm.prank(agent);
        vm.expectRevert(SpikeMarket.AgentNotAllowed.selector);
        market.buyUpFor(user, 1e6);
    }
}
