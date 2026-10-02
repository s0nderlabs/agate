// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {
    U,
    LOT,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    Venue
} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "./RouterBase.sol";

/// A KURU_V1-shaped venue that fills without reverting but delivers one base unit less than the minimum it was
/// given, on a buy (tokens) and on a sell (dollars): only the router's own measured check can stop it (MockKuruOrderBook
/// enforces minAmountOut itself, so the router's check is otherwise never reached).
contract UnderDeliveringMarket {
    address internal immutable TOKEN;
    address internal immutable DOLLAR;

    constructor(address token_, address dollar_) {
        TOKEN = token_;
        DOLLAR = dollar_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (
            KURU_PRICE_PRECISION,
            KURU_SIZE_PRECISION,
            TOKEN,
            6,
            DOLLAR,
            6,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0
        );
    }

    function marketState() external pure returns (uint8) {
        return 0;
    }

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool, bool)
        external
        payable
        returns (uint256)
    {
        IERC20(DOLLAR).transferFrom(msg.sender, address(this), quoteSize);
        IERC20(TOKEN).transfer(msg.sender, minAmountOut - 1);
        return minAmountOut - 1;
    }

    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool, bool)
        external
        payable
        returns (uint256)
    {
        IERC20(TOKEN).transferFrom(msg.sender, address(this), uint256(size) * LOT);
        IERC20(DOLLAR).transfer(msg.sender, minAmountOut - 1);
        return minAmountOut - 1;
    }
}

/// BUILD-SPEC 6.3: buy() takes got = the token balance change (>= minOut, else SlippageExceeded) and sell() the dollar
/// balance change (>= minOut). The venue is recorded on a factory without a Kuru router (the V2 pilot shape, where
/// the admin's first attach is free), since a factory with one records only markets Kuru's Router made (3.4, v3.2).
/// Conformance audit L2.
contract RouterSlippageTest is RouterBase {
    AgateFactory internal pilot;
    IAgateSeries internal ps;
    IAgateRouter internal pr;
    IERC20 internal ptok;
    address internal u = makeAddr("slippage-user");

    function setUp() public {
        _world();
        bytes32[] memory gpus = new bytes32[](1);
        gpus[0] = H100;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        pilot = new AgateFactory(address(index), dollarAddr, address(0), gpus, labels, admin, "pilot", 0, 0);
        ps = IAgateSeries(pilot.list(H100, NOV));
        pr = IAgateRouter(pilot.router());
        ptok = IERC20(ps.token());
        UnderDeliveringMarket bad = new UnderDeliveringMarket(address(ptok), dollarAddr);
        vm.prank(admin);
        pilot.attachMarket(address(ps), address(bad), Venue.KURU_V1);
        assertTrue(pilot.routerCanUse(address(ps)));
        // the venue's inventory: tokens to sell, dollars to pay
        _give(address(this), 1_000 * U);
        dollar.approve(address(ps), type(uint256).max);
        ps.mint(100 * U, address(bad));
        _give(address(bad), 1_000 * U);
        // the user: dollars, 10 tokens of its own, standing allowances to the router
        _give(u, 1_000 * U);
        vm.startPrank(u);
        dollar.approve(address(ps), type(uint256).max);
        ps.mint(10 * U, u);
        dollar.approve(address(pr), type(uint256).max);
        ptok.approve(address(pr), type(uint256).max);
        vm.stopPrank();
    }

    function test_router_slippageCheckedOnEveryBuy() public {
        vm.startPrank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.SlippageExceeded.selector, 10 * U - 1, 10 * U));
        pr.openLong(address(ps), 40 * U, 10 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.SlippageExceeded.selector, 10 * U - 1, 10 * U));
        pr.openLongDaily(address(ps), 40 * U, 10 * U, 1, u, _none());
        vm.stopPrank();
    }

    function test_router_slippageCheckedOnEverySell() public {
        uint256 d0 = dollar.balanceOf(u);
        uint256 t0 = ptok.balanceOf(u);
        vm.startPrank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.SlippageExceeded.selector, 30 * U - 1, 30 * U));
        pr.closeLong(address(ps), 10 * U, 30 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.SlippageExceeded.selector, 30 * U - 1, 30 * U));
        pr.openShort(address(ps), 10 * U, 30 * U, 1, u, true, _none());
        vm.stopPrank();
        assertEq(dollar.balanceOf(u), d0);
        assertEq(ptok.balanceOf(u), t0);
        assertEq(ps.shortOf(address(pr)), 0);
    }
}
