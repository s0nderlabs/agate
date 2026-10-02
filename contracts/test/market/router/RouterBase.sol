// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Flow, Permit} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {MockKuruRouter} from "../mocks/MockKuruRouter.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";

interface IMintableDollar {
    function mint(address to, uint256 amount) external;
}

/// The router's test world, the model's november_world (test_market_model.py): a production-clock MockIndex with
/// anchors Sep 26 to 30 at 3.60 (F 1.80, C 7.20, RULE), October at 3.60, November 1 to 10 at 3.60 and 11 to 30 at
/// 4.20, every record final T_PEND after its day; November listed on Oct 31 07:00 with its Kuru market created
/// through the factory on a MockKuruRouter. H200 carries the same records (listed only where a test needs it).
abstract contract RouterBase is Test {
    bytes32 internal constant H100 = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant H200 = keccak256("H200-SXM/on-demand-list/neocloud/v1");
    uint32 internal constant OCT1 = 20_727; // 2026-10-01
    uint32 internal constant NOV1 = 20_758; // 2026-11-01
    uint32 internal constant NOV = 2026 * 12 + 10;
    uint32 internal constant REF = 3_600_000; // $3.60
    uint32 internal constant STEP = 4_200_000; // $4.20
    uint32 internal constant F = 1_800_000;
    uint32 internal constant C = 7_200_000;
    uint64 internal constant DAY = 86_400;
    uint64 internal constant T_PEND = 21_600;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant ROUTED_SIG =
        keccak256("Routed(address,address,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256[])");

    MockIndex internal index;
    address internal dollarAddr;
    IERC20 internal dollar;
    MockKuruRouter internal kuru;
    IAgateFactory internal factory;
    IAgateRouter internal router;
    IAgateSeries internal s;
    IERC20 internal token;
    MockKuruOrderBook internal m;
    uint256 internal tList;

    address internal admin = makeAddr("marketAdmin");
    address internal mm = makeAddr("mm");
    address internal payer = makeAddr("payer");

    /// One routed click, as the Routed event reports it.
    struct R {
        address user;
        address series;
        Flow flow;
        uint256 tokens;
        uint256 dollarsIn;
        uint256 dollarsOut;
        uint256 refund;
        uint256 tokensIn;
        uint256 tokensOut;
        uint256[] ids;
    }

    // ------------------------------------------------------------------ the world

    /// The default world: our test dollar (with permit), no Kuru fees.
    function _world() internal {
        _world(address(new AgateDollar(address(this), 10_000 * U, 86_400)), 0, 0);
    }

    function _world(address dollar_, uint256 takerFeeBps, uint256 makerFeeBps) internal {
        dollarAddr = dollar_;
        dollar = IERC20(dollar_);
        index = new MockIndex(uint32(DAY), 0, 0);
        index.register(H100, keccak256("recipe/H100"));
        index.register(H200, keccak256("recipe/H200"));
        kuru = new MockKuruRouter();
        bytes32[] memory gpus = new bytes32[](2);
        gpus[0] = H100;
        gpus[1] = H200;
        string[] memory labels = new string[](2);
        labels[0] = "H100";
        labels[1] = "H200";
        factory = IAgateFactory(
            address(
                new AgateFactory(
                    address(index), dollar_, address(kuru), gpus, labels, admin, "", takerFeeBps, makerFeeBps
                )
            )
        );
        router = IAgateRouter(factory.router());
        for (uint32 d = OCT1 - 5; d < NOV1 + 30; ++d) {
            uint32 v = d < NOV1 + 10 ? REF : STEP;
            _put(H100, d, v);
            _put(H200, d, v);
        }
        tList = _dayStart(NOV1 - 1) + 7 hours;
        vm.warp(tList);
        s = IAgateSeries(factory.list(H100, NOV));
        factory.createMarket(address(s));
        (address mk,) = factory.marketOf(address(s));
        m = MockKuruOrderBook(mk);
        token = IERC20(s.token());
    }

    function _put(bytes32 gpu, uint32 d, uint32 v) internal {
        index.put(gpu, d, v, uint64(_dayStart(d + 1) + T_PEND), IAgateIndex.Status.FULL, 5, false, false);
    }

    function _dayStart(uint32 d) internal pure returns (uint256) {
        return uint256(d) * DAY;
    }

    /// A moment at which November day k's record is final.
    function _afterDay(uint256 k) internal pure returns (uint256) {
        return _dayStart(uint32(NOV1 + k)) + T_PEND + 1;
    }

    // ------------------------------------------------------------------ money and the book

    function _give(address who, uint256 amt) internal {
        IMintableDollar(dollarAddr).mint(who, amt);
    }

    /// The market maker: a large float, standing approvals to the market and the series, `tokens` minted.
    function _maker(uint256 tokens) internal {
        _give(mm, 1e15);
        vm.startPrank(mm);
        dollar.approve(address(m), type(uint256).max);
        dollar.approve(address(s), type(uint256).max);
        token.approve(address(m), type(uint256).max);
        if (tokens > 0) s.mint(tokens, mm);
        vm.stopPrank();
    }

    function _ask(uint32 price, uint256 tokens) internal {
        vm.prank(mm);
        m.addSellOrder(price, uint96(tokens / LOT), false);
    }

    function _bid(uint32 price, uint256 tokens) internal {
        vm.prank(mm);
        m.addBuyOrder(price, uint96(tokens / LOT), false);
    }

    /// The model's book_world: asks 5,000 at 3.64, bids 5,000 at 3.60, a 50,000-token inventory.
    function _bookWorld() internal {
        _world();
        _maker(50_000 * U);
        _ask(3_640_000, 5_000 * U);
        _bid(3_600_000, 5_000 * U);
    }

    /// A user with dollars and standing (unlimited) allowances to the router for the dollar and the token.
    function _user(string memory name, uint256 dollars) internal returns (address u) {
        u = makeAddr(name);
        _give(u, dollars);
        vm.startPrank(u);
        dollar.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ permits

    function _none() internal pure returns (Permit memory p) {}

    function _sign(address asset, uint256 key, uint256 value, uint256 deadline)
        internal
        view
        returns (Permit memory p)
    {
        address owner = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, address(router), value, IERC20Permit(asset).nonces(owner), deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC20Permit(asset).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(key, digest);
        p = Permit(value, deadline, v, r, ss);
    }

    // ------------------------------------------------------------------ router flows as a user (no permit)

    function _long(address u, uint256 dollarsIn, uint256 minOut) internal returns (uint256) {
        vm.prank(u);
        return router.openLong(address(s), dollarsIn, minOut, _none());
    }

    function _longDaily(address u, uint256 dollarsIn, uint256 minOut, uint256 parts, address payee)
        internal
        returns (uint256[] memory)
    {
        vm.prank(u);
        return router.openLongDaily(address(s), dollarsIn, minOut, parts, payee, _none());
    }

    function _short(address u, uint256 q, uint256 minOut, uint256 parts, address payee, bool daily)
        internal
        returns (uint256[] memory ids, uint256 cost, uint256 out)
    {
        vm.prank(u);
        return router.openShort(address(s), q, minOut, parts, payee, daily, _none());
    }

    function _closeLong(address u, uint256 q, uint256 minOut) internal returns (uint256) {
        vm.prank(u);
        return router.closeLong(address(s), q, minOut, _none());
    }

    function _closeShort(address u, uint256[] memory ids, uint256 dollarsIn)
        internal
        returns (uint256 paid, uint256 surplus, uint256 refund)
    {
        vm.prank(u);
        return router.closeShort(address(s), ids, dollarsIn, _none());
    }

    function _closeLongDaily(address u, uint256[] memory ids, uint256 minOut)
        internal
        returns (uint256 cost, uint256 out, uint256 paid)
    {
        vm.prank(u);
        return router.closeLongDaily(address(s), ids, minOut, _none());
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    // ------------------------------------------------------------------ checks

    /// I25: the router holds what it held before (donations only), no short, and no allowance to anything.
    function _holdsNothing(uint256 donatedDollars, uint256 donatedTokens) internal view {
        assertEq(dollar.balanceOf(address(router)), donatedDollars, "I25 router dollars");
        assertEq(token.balanceOf(address(router)), donatedTokens, "I25 router tokens");
        assertEq(s.shortOf(address(router)), 0, "I25 router short");
        assertEq(dollar.allowance(address(router), address(m)), 0, "I25 dollar allowance to the market");
        assertEq(token.allowance(address(router), address(m)), 0, "I25 token allowance to the market");
        assertEq(dollar.allowance(address(router), address(s)), 0, "I25 dollar allowance to the series");
        assertEq(token.allowance(address(router), address(s)), 0, "I25 token allowance to the series");
    }

    function _ledger() internal view returns (uint256 ledger) {
        (,,,,, uint128 l,,) = s.state();
        ledger = l;
    }

    function _k() internal view returns (uint256 k) {
        (uint8 k_,,,,,,,) = s.state();
        k = k_;
    }

    function _shortSupply() internal view returns (uint256 sh) {
        (,,,,,,, sh) = s.state();
    }

    /// The last Routed event in the recorded logs.
    function _routed(Vm.Log[] memory logs) internal view returns (R memory r) {
        bool found;
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != address(router) || l.topics.length != 4 || l.topics[0] != ROUTED_SIG) continue;
            r.user = address(uint160(uint256(l.topics[1])));
            r.series = address(uint160(uint256(l.topics[2])));
            r.flow = Flow(uint8(uint256(l.topics[3])));
            (r.tokens, r.dollarsIn, r.dollarsOut, r.refund, r.tokensIn, r.tokensOut, r.ids) =
                abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256[]));
            found = true;
            break;
        }
        assertTrue(found, "no Routed event");
    }

    /// I37: the caller's dollar and token balances moved exactly as the Routed event says.
    function _assertRoutedTruth(R memory r, address u, uint256 d0, uint256 t0) internal view {
        assertEq(r.user, u, "I37 user");
        assertEq(int256(dollar.balanceOf(u)) - int256(d0), int256(r.dollarsOut) - int256(r.dollarsIn), "I37 dollars");
        assertEq(int256(token.balanceOf(u)) - int256(t0), int256(r.tokensOut) - int256(r.tokensIn), "I37 tokens");
        assertLe(r.refund, r.dollarsOut, "I37 refund is part of dollarsOut");
    }
}
