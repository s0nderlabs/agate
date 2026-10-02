// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, GRID} from "../../../src/market/MarketTypes.sol";
import {SeriesBase, FeeDollar} from "./SeriesBase.sol";

/// I8 (exact in, exact out) and the unit behaviour of mint, redeem, mintCost and redeemValue (BUILD-SPEC 4.5).
contract SeriesMintTest is SeriesBase {
    /// For q a multiple of LOT, the cost and the redeem value are q C / U with no remainder, on any band.
    function test_I8_mintRedeemExact(uint256 capSteps, uint256 lots) public {
        capSteps = bound(capSteps, 2, 40_000); // C from $0.10 to $2,000
        lots = bound(lots, 1, 1e9);
        uint32 cap = uint32(capSteps * GRID);
        AgateSeries x = _deploy(address(dollar), uint32(GRID), cap, REF);
        uint256 q = lots * LOT;
        assertEq(q * cap % U, 0, "the lot rule makes q C a multiple of U");
        dollar.mint(a, q * cap / U);
        vm.startPrank(a);
        dollar.approve(address(x), type(uint256).max);
        assertEq(x.mintCost(q), q * cap / U);
        uint256 cost = x.mint(q, a);
        assertEq(cost, q * cap / U, "mint cost");
        assertEq(x.redeemValue(q), cost);
        assertEq(x.redeem(q, a), cost, "redeem pays back exactly the cost");
        vm.stopPrank();
        (,,,,, uint128 led,,) = x.state();
        assertEq(led, 0);
        assertEq(dollar.balanceOf(a), cost);
    }

    function test_I8_nonLotMintAndRedeemRevert() public {
        _give(a, 1_000 * U);
        uint256[5] memory bad = [uint256(0), 1, 99, 101, LOT + 1];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(a);
            vm.expectRevert(IAgateSeries.BadAmount.selector);
            s.mint(bad[i], a);
        }
        _mint(a, 10 * U);
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(a);
            vm.expectRevert(IAgateSeries.BadAmount.selector);
            s.redeem(bad[i], a);
        }
    }

    function test_I8_worked() public {
        _give(a, 50_000 * U);
        assertEq(s.mintCost(5_760 * U), 41_472 * U); // 5,760 x 7.20
        assertEq(s.mintCost(LOT), 720); // 0.0001 token: 720 u
        assertEq(s.redeemValue(LOT), 720);
        vm.prank(a);
        assertEq(s.mint(5_760 * U, a), 41_472 * U);
    }

    function test_mintCreditsThePayerAndSendsTheTokenToTo() public {
        _give(a, 1_000 * U);
        uint256 q = 12_345 * LOT;
        uint256 cost = q * CAP / U;
        vm.expectEmit(address(s));
        emit IAgateSeries.ShortCredited(a, q, q);
        vm.expectEmit(address(s));
        emit IAgateSeries.Minted(a, b, q, cost);
        vm.expectEmit(address(dollar));
        emit IERC20.Transfer(a, address(s), cost);
        vm.expectEmit(address(tok));
        emit IERC20.Transfer(address(0), b, q);
        vm.prank(a);
        assertEq(s.mint(q, b), cost);
        assertEq(tok.balanceOf(b), q);
        assertEq(tok.balanceOf(a), 0);
        assertEq(s.shortOf(a), q);
        assertEq(s.shortOf(b), 0);
        assertEq(_ledger(), cost);
        assertEq(_shortSupply(), q);
        assertEq(dollar.balanceOf(address(s)), cost);
        _check();
    }

    function test_mintBadRecipient() public {
        _give(a, 1_000 * U);
        address[3] memory bad = [address(0), address(s), address(tok)];
        for (uint256 i; i < 3; ++i) {
            vm.prank(a);
            vm.expectRevert(IAgateSeries.BadRecipient.selector);
            s.mint(U, bad[i]);
        }
    }

    function test_mintNeedsTheDollar() public {
        dollar.mint(a, 7 * U);
        vm.prank(a);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(s), 0, 7_200_000)
        );
        s.mint(U, a);
        vm.prank(a);
        dollar.approve(address(s), type(uint256).max);
        vm.prank(a);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, a, 7 * U, 7_200_000)
        );
        s.mint(U, a);
    }

    function test_feeOnTransferDollarIsRefused() public {
        FeeDollar fee = new FeeDollar();
        AgateSeries x = _deploy(address(fee), FLOOR, CAP, REF);
        fee.mint(a, 100 * U);
        vm.startPrank(a);
        fee.approve(address(x), type(uint256).max);
        vm.expectRevert(IAgateSeries.DollarInexact.selector);
        x.mint(U, a);
        vm.stopPrank();
    }

    function test_redeemPaysToAndEmits() public {
        _mint(a, 10 * U);
        uint256 before = dollar.balanceOf(c);
        vm.expectEmit(address(s));
        emit IAgateSeries.ShortDebited(a, 4 * U, 6 * U);
        vm.expectEmit(address(s));
        emit IAgateSeries.Redeemed(a, c, 4 * U, 28_800_000);
        vm.expectEmit(address(tok));
        emit IERC20.Transfer(a, address(0), 4 * U);
        vm.prank(a);
        assertEq(s.redeem(4 * U, c), 28_800_000);
        assertEq(dollar.balanceOf(c) - before, 28_800_000);
        assertEq(tok.balanceOf(a), 6 * U);
        assertEq(s.shortOf(a), 6 * U);
        _check();
    }

    function test_redeemNeedsBothSides() public {
        _mint(a, 10 * U);
        vm.prank(a);
        tok.transfer(b, 5 * U);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.TokenBalance.selector);
        s.redeem(6 * U, a);
        vm.prank(b); // b holds tokens but no short
        vm.expectRevert(IAgateSeries.ShortBalance.selector);
        s.redeem(U, b);
        vm.prank(a);
        vm.expectRevert(IAgateSeries.BadRecipient.selector);
        s.redeem(U, address(tok));
        vm.prank(a);
        s.redeem(5 * U, a);
        _check();
    }

    function test_mintAndRedeemReadNoTimeOrState() public {
        _give(a, 10_000 * U);
        vm.warp(_afterDay(30) + 3_650 days); // years after the month, never synced
        vm.prank(a);
        uint256 cost = s.mint(100 * U, a);
        vm.prank(a);
        assertEq(s.redeem(100 * U, a), cost);
        assertEq(_k(), 0); // neither synced
    }
}
