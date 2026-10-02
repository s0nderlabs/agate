// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IKuruOrderBook} from "../../../src/market/interfaces/IKuruOrderBook.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side, Venue, Flow, Permit, Position} from "../../../src/market/MarketTypes.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {RouterBase} from "./RouterBase.sol";

/// Every router flow of BUILD-SPEC 6.3 with exact money checks, the worked examples of 12.1 through the router, the
/// exact-depth close (F3), and every refusal (NotSeries, NoMarket, VenueUnsupported, BadPayee, BadParts, BadAmount,
/// BadLimits, NotYourPosition, WrongSide, SafeCast, BadSize).
contract RouterFlowsTest is RouterBase {
    // ------------------------------------------------------------------ BUILD-SPEC 12.1 example 1, through the router

    /// A GPU owner shorts 8 GPUs with pay me daily, a renter goes long 8 GPUs with pay me daily, the maker sits at
    /// 3.60 / 3.64; the daily payer claims every day. Every number of the worked example, to the u.
    function test_workedExample1_november() public {
        _world();
        uint256 q = router.sizeFor(8, 30);
        assertEq(q, 5_760 * U);
        _maker(0);
        address owner = _user("owner", 41_472 * U);
        address renter = _user("renter", 20_966_400_000);
        _bid(REF, q);
        vm.warp(tList + 60);
        (uint256[] memory ownerIds, uint256 cost, uint256 proceeds) = _short(owner, q, 20_736 * U, 8, owner, true);
        assertEq(cost, 41_472 * U); // 5,760 x 7.20
        assertEq(proceeds, 20_736 * U); // sold at 3.60
        assertEq(dollar.balanceOf(owner), 20_736 * U);
        assertEq(token.balanceOf(mm), q);
        vm.prank(mm);
        m.addSellOrder(3_640_000, uint96(q / LOT), false);
        vm.warp(tList + 120);
        uint256[] memory renterIds = _longDaily(renter, 20_966_400_000, q, 8, renter);
        assertEq(dollar.balanceOf(renter), 10_368 * U); // the floor 5,760 x 1.80 at once
        assertEq(ownerIds.length, 8);
        assertEq(renterIds.length, 8);
        for (uint256 i; i < 8; ++i) {
            Position memory p = s.position(ownerIds[i]);
            assertEq(p.owner, owner);
            assertEq(p.operator, address(router));
            assertEq(uint256(p.q), 720 * U);
            assertEq(uint8(p.side), uint8(Side.SHORT));
            p = s.position(renterIds[i]);
            assertEq(p.owner, renter);
            assertEq(p.operator, address(router));
            assertEq(uint256(p.q), 720 * U);
            assertEq(uint8(p.side), uint8(Side.LONG));
        }
        _holdsNothing(0, 0);

        uint256[] memory all = new uint256[](16);
        for (uint256 i; i < 8; ++i) {
            all[i] = ownerIds[i];
            all[8 + i] = renterIds[i];
        }
        uint256 ownerStreams;
        uint256 renterStreams;
        for (uint256 k = 1; k <= 30; ++k) {
            vm.warp(_afterDay(k));
            uint256 o0 = dollar.balanceOf(owner);
            uint256 r0 = dollar.balanceOf(renter);
            vm.prank(payer);
            s.claimMany(all);
            uint256 od = dollar.balanceOf(owner) - o0;
            uint256 rd = dollar.balanceOf(renter) - r0;
            assertEq(od, k <= 10 ? 691_200_000 : 576 * U, "owner stream");
            assertEq(rd, k <= 10 ? 345_600_000 : 460_800_000, "renter stream");
            assertEq(192 * (k <= 10 ? REF : STEP) + od, 1_382_400_000); // rent + stream = 192 C every day
            assertEq(192 * (k <= 10 ? REF : STEP) - rd, 345_600_000); // bill - stream = 192 F every day
            ownerStreams += od;
            renterStreams += rd;
        }
        assertEq(ownerStreams, 18_432 * U); // 5,760 x 3.20
        assertEq(renterStreams + 10_368 * U, 23_040 * U); // 5,760 x 4.00
        // all-in: the owner earns 3.60 per GPU-hour, the renter pays 3.64
        assertEq(23_040 * U + ownerStreams - (cost - proceeds), 5_760 * uint256(REF));
        assertEq(23_040 * U - renterStreams + (20_966_400_000 - 10_368 * U), 5_760 * 3_640_000);
        // the pot is empty, every position gone, both supplies 0; the maker made the spread
        assertEq(_k(), 30);
        assertEq(_ledger(), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(_shortSupply(), 0);
        for (uint256 i; i < 16; ++i) {
            assertEq(s.position(all[i]).owner, address(0));
        }
        assertEq(dollar.balanceOf(mm), 1e15 + 230_400_000);
        assertEq(token.balanceOf(mm), 0);
        _holdsNothing(0, 0);
    }

    // ------------------------------------------------------------------ BUILD-SPEC 12.1 example 2: exits after 20 fixes

    uint256 internal longId;
    uint256 internal shortId;
    address internal owner2;
    address internal renter2;

    function _exitsWorld() internal {
        _world();
        _maker(2_000 * U);
        uint256 q = 720 * U;
        owner2 = _user("owner", 10_000 * U);
        renter2 = _user("renter", 10_000 * U);
        _bid(REF, q);
        vm.warp(tList + 1);
        (uint256[] memory ids,,) = _short(owner2, q, 2_592 * U, 1, owner2, true);
        shortId = ids[0];
        _ask(3_640_000, q);
        vm.warp(tList + 2);
        longId = _longDaily(renter2, 2_620_800_000, q, 1, renter2)[0];
        vm.warp(_afterDay(20));
        s.sync(20);
        assertEq(_k(), 20);
        vm.startPrank(payer);
        s.claim(longId);
        s.claim(shortId);
        vm.stopPrank();
        assertEq(uint256(s.position(longId).paid), 2_304 * U); // floor 1,296 + streams 1,008
        assertEq(uint256(s.position(shortId).paid), 1_584 * U); // 720 x (20 x 7.20 - 78) / 30
    }

    function test_example2_closeLongDaily() public {
        _exitsWorld();
        _bid(3_980_000, 720 * U);
        uint256 before = dollar.balanceOf(renter2);
        (uint256 cost, uint256 out, uint256 paid) = _closeLongDaily(renter2, _ids(longId), 2_865_600_000);
        assertEq(cost, 5_184 * U); // 720 pairs
        assertEq(out, 2_865_600_000); // 720 at 3.98
        assertEq(paid, 2_880 * U); // 720 x 7.20 - 2,304
        assertEq(dollar.balanceOf(renter2) - before, 561_600_000); // 720 x (3.98 - 3.20)
        assertEq(s.position(longId).owner, address(0));
        _holdsNothing(0, 0);
    }

    /// The same exit without the router's close: unstream (pays back 2,304) then closeLong: the same 561.60.
    function test_example2_unstreamThenCloseLong() public {
        _exitsWorld();
        _bid(3_980_000, 720 * U);
        uint256 before = dollar.balanceOf(renter2);
        vm.startPrank(renter2);
        dollar.approve(address(s), 2_304 * U);
        s.unstream(longId, renter2);
        vm.stopPrank();
        uint256 out = _closeLong(renter2, 720 * U, 2_865_600_000);
        assertEq(out, 2_865_600_000);
        assertEq(dollar.balanceOf(renter2) - before, 561_600_000);
        _holdsNothing(0, 0);
    }

    function test_example2_closeShort_exact() public {
        _exitsWorld();
        _ask(4_010_000, 720 * U);
        (uint256 sim,) = m.simulateBuy(2_887_200_000);
        assertEq(sim, 720 * U);
        uint256 before = dollar.balanceOf(owner2);
        (uint256 paid, uint256 surplus, uint256 refund) = _closeShort(owner2, _ids(shortId), 2_887_200_000);
        assertEq(paid, 3_600 * U); // 720 x 7.20 - 1,584
        assertEq(surplus, 0);
        assertEq(refund, 0);
        assertEq(dollar.balanceOf(owner2) - before, 712_800_000);
        assertEq(s.position(shortId).owner, address(0));
        _holdsNothing(0, 0);
    }

    function test_example2_closeShort_headroomReturnsSurplusTokens() public {
        _exitsWorld();
        _ask(4_010_000, 1_000 * U);
        (uint256 paid, uint256 surplus, uint256 refund) = _closeShort(owner2, _ids(shortId), 2_887_200_000 + 4_010_000);
        assertEq(paid, 3_600 * U);
        assertEq(surplus, U); // one token of headroom on a deeper book comes back as a token
        assertEq(refund, 0);
        assertEq(token.balanceOf(owner2), U);
        _holdsNothing(0, 0);
    }

    // ------------------------------------------------------------------ BUILD-SPEC 6.5 and F3: the exact-depth close

    uint256[] internal f3Ids;
    address internal o3;

    function _f3World() internal {
        _world();
        _maker(50_000 * U);
        _bid(REF, 2_000 * U);
        o3 = _user("o", 100_000 * U);
        (f3Ids,,) = _short(o3, 1_100 * U, U, 2, o3, true); // two parts of 550
        _ask(3_640_000, 1_000 * U);
        _ask(3_650_000, 100 * U);
    }

    /// The book holds exactly q = 1,100 tokens over two levels; exact cost plus $10, not fill-or-kill, closes both
    /// positions and returns 9,999,540 u (460 u of Kuru dust), the number of the fork test on Kuru's deployed code.
    function test_exactDepth_closeShort_refunds_9999540() public {
        _f3World();
        uint256 exact = 1_000 * 3_640_000 + 100 * 3_650_000;
        uint256 o0 = dollar.balanceOf(o3);
        (uint256 paid, uint256 surplus, uint256 refund) = _closeShort(o3, f3Ids, exact + 10 * U);
        assertEq(surplus, 0);
        assertEq(refund, 9_999_540);
        assertEq(paid, 1_100 * uint256(C)); // k = 0: nothing paid yet
        assertEq(dollar.balanceOf(o3) - o0, paid + refund - exact - 10 * U);
        assertEq(s.position(f3Ids[0]).owner, address(0));
        assertEq(s.position(f3Ids[1]).owner, address(0));
        _holdsNothing(0, 0);
    }

    function test_exactDepth_exactCostAloneIsOneUnitShort() public {
        _f3World();
        vm.expectRevert(MockKuruOrderBook.SlippageExceeded.selector);
        _closeShort(o3, f3Ids, 1_000 * 3_640_000 + 100 * 3_650_000);
    }

    function test_closeShort_duplicateIdRevertsWhole() public {
        _f3World();
        _ask(3_700_000, 5_000 * U);
        uint256 o0 = dollar.balanceOf(o3);
        vm.expectRevert(abi.encodeWithSelector(IAgateSeries.NoPosition.selector, f3Ids[0]));
        _closeShort(o3, _ids(f3Ids[0], f3Ids[0]), 5_000 * U);
        assertEq(s.position(f3Ids[0]).owner, o3);
        assertEq(s.position(f3Ids[1]).owner, o3);
        assertEq(dollar.balanceOf(o3), o0);
    }

    // ------------------------------------------------------------------ each flow, exact money

    function test_openLong_exactAndRouted() public {
        _bookWorld();
        address u = _user("u", 1_000 * U);
        uint256[] memory none_;
        vm.expectEmit(address(router));
        emit IAgateRouter.Routed(u, address(s), Flow.OPEN_LONG, 100 * U, 364 * U, 0, 0, 0, 100 * U, none_);
        uint256 got = _long(u, 364 * U, 100 * U);
        assertEq(got, 100 * U);
        assertEq(token.balanceOf(u), 100 * U);
        assertEq(dollar.balanceOf(u), 636 * U);
        _holdsNothing(0, 0);
    }

    /// Not fill-or-kill: a book shallower than the quote fills what it can and the unused quote comes back.
    function test_openLong_unusedQuoteComesBack() public {
        _world();
        _maker(1_000 * U);
        _ask(3_640_000, 50 * U);
        address u = _user("u", 1_000 * U);
        uint256 got = _long(u, 364 * U, 50 * U);
        assertEq(got, 50 * U);
        assertEq(dollar.balanceOf(u), 1_000 * U - 182 * U);
        _holdsNothing(0, 0);
    }

    function test_openLongDaily_floorAtOnceAndRemainder() public {
        _bookWorld();
        address u = _user("u", 1_000 * U);
        address treasury = makeAddr("treasury");
        // 364.0364 buys 100.0100 tokens: three parts of 33.3366, remainder 0.0002 back as tokens
        vm.recordLogs();
        uint256[] memory ids = _longDaily(u, 364_036_400, 100_010_000, 3, treasury);
        R memory r = _routed(vm.getRecordedLogs());
        assertEq(ids.length, 3);
        uint256 per = 33_336_600;
        for (uint256 i; i < 3; ++i) {
            Position memory p = s.position(ids[i]);
            assertEq(uint256(p.q), per);
            assertEq(p.owner, u);
            assertEq(p.payee, treasury);
            assertEq(p.operator, address(router));
            assertTrue(p.daily);
        }
        uint256 floorPaid = 3 * (per * F / U);
        assertEq(token.balanceOf(u), 100_010_000 - 3 * per);
        assertEq(dollar.balanceOf(u), 1_000 * U - 364_036_400 + floorPaid);
        assertEq(r.tokens, 100_010_000);
        assertEq(r.dollarsOut, floorPaid);
        assertEq(r.tokensOut, 200);
        assertEq(r.ids.length, 3);
        _holdsNothing(0, 0);
    }

    function test_openShort_exactAndPositions() public {
        _bookWorld();
        address u = _user("u", 1_000 * U);
        address treasury = makeAddr("treasury");
        (uint256[] memory ids, uint256 cost, uint256 out) = _short(u, 100 * U, 360 * U, 2, treasury, false);
        assertEq(cost, 720 * U);
        assertEq(out, 360 * U);
        assertEq(dollar.balanceOf(u), 1_000 * U - 720 * U + 360 * U);
        assertEq(token.balanceOf(u), 0);
        assertEq(s.shortOf(u), 0); // a router short is a position, never a fungible balance
        for (uint256 i; i < 2; ++i) {
            Position memory p = s.position(ids[i]);
            assertEq(p.owner, u);
            assertEq(p.operator, address(router));
            assertEq(p.payee, treasury);
            assertEq(uint256(p.q), 50 * U);
            assertEq(uint8(p.side), uint8(Side.SHORT));
            assertFalse(p.daily);
            assertEq(uint256(p.paid), 0);
        }
        _holdsNothing(0, 0);
    }

    /// Mid-month (example 3): after 15 fixes a SHORT position is paid what has vested at once.
    function test_openShort_midMonthPaysVestedAtOnce() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        vm.warp(_afterDay(15));
        uint256 d0 = dollar.balanceOf(u);
        vm.recordLogs();
        (uint256[] memory ids, uint256 cost, uint256 out) = _short(u, 100 * U, 360 * U, 1, u, true);
        R memory r = _routed(vm.getRecordedLogs());
        assertEq(_k(), 15);
        // S = 10 x 3.60 + 5 x 4.20 = 57.00; vested short = 100 x (15 x 7.20 - 57.00) / 30 = 170.00
        uint256 vested = 170 * U;
        assertEq(uint256(s.position(ids[0]).paid), vested);
        assertEq(dollar.balanceOf(u) + cost - d0, out + vested);
        assertEq(r.dollarsOut, out + vested);
        _holdsNothing(0, 0);
    }

    function test_closeLong_exact() public {
        _bookWorld();
        address u = _user("u", 1_000 * U);
        _long(u, 364 * U, 100 * U);
        uint256 out = _closeLong(u, 100 * U, 360 * U);
        assertEq(out, 360 * U);
        assertEq(token.balanceOf(u), 0);
        assertEq(dollar.balanceOf(u), 1_000 * U - 4 * U);
        _holdsNothing(0, 0);
    }

    function test_closeShort_paysOwnerFullPairMinusPaid() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        (uint256[] memory ids,,) = _short(u, 100 * U, U, 1, u, true);
        vm.warp(_afterDay(12));
        vm.prank(payer);
        s.claim(ids[0]);
        uint256 paidSoFar = s.position(ids[0]).paid;
        assertGt(paidSoFar, 0);
        (uint256 paid,,) = _closeShort(u, ids, 365 * U);
        assertEq(paid, 100 * uint256(C) - paidSoFar);
        _holdsNothing(0, 0);
    }

    function test_closeLongDaily_netsLikeUnstreamPlusCloseLong() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        uint256[] memory ids = _longDaily(u, 364 * U, 100 * U, 1, u);
        vm.warp(_afterDay(5));
        vm.prank(payer);
        s.claim(ids[0]);
        uint256 paidSoFar = s.position(ids[0]).paid;
        uint256 d0 = dollar.balanceOf(u);
        (uint256 cost, uint256 out, uint256 paid) = _closeLongDaily(u, ids, U);
        assertEq(cost, 720 * U);
        assertEq(out, 360 * U);
        assertEq(paid, 720 * U - paidSoFar);
        assertEq(dollar.balanceOf(u), d0 - cost + out + paid);
        _holdsNothing(0, 0);
    }

    // ------------------------------------------------------------------ refusals

    function test_notSeries_noMarket_venueUnsupported() public {
        _bookWorld();
        address u = _user("u", 1_000 * U);
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotSeries.selector, address(m)));
        router.openLong(address(m), 364 * U, U, _none());
        // H200 November listed but no market recorded
        address s200 = factory.list(H200, NOV);
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NoMarket.selector, s200));
        router.openLong(s200, 364 * U, U, _none());
        // Kuru pauses its market: the router's order reverts in the market; the admin replaces it with an OTHER venue
        factory.createMarket(s200);
        (address m200,) = factory.marketOf(s200);
        kuru.setMarketState(m200, 1);
        assertFalse(factory.routerCanUse(s200));
        vm.prank(u);
        vm.expectRevert(MockKuruOrderBook.MarketStateError.selector);
        router.openLong(s200, 364 * U, U, _none());
        vm.prank(admin);
        factory.attachMarket(s200, address(index), Venue.OTHER); // any contract: a venue whose ABI we did not verify
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.VenueUnsupported.selector, s200));
        router.openLong(s200, 364 * U, U, _none());
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.VenueUnsupported.selector, s200));
        router.openShort(s200, 100 * U, U, 1, u, true, _none());
        assertEq(dollar.balanceOf(u), 1_000 * U);
    }

    function test_badPayee_everySystemContract() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        address[6] memory bad = [address(0), address(router), address(s), address(token), address(m), address(factory)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(u);
            vm.expectRevert(abi.encodeWithSelector(IAgateRouter.BadPayee.selector, bad[i]));
            router.openShort(address(s), 100 * U, U, 1, bad[i], true, _none());
            vm.prank(u);
            vm.expectRevert(abi.encodeWithSelector(IAgateRouter.BadPayee.selector, bad[i]));
            router.openLongDaily(address(s), 364 * U, 100 * U, 1, bad[i], _none());
        }
        assertEq(dollar.balanceOf(u), 10_000 * U);
        _holdsNothing(0, 0);
    }

    function test_badParts() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        vm.startPrank(u);
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openShort(address(s), 10 * U + LOT, U, 3, u, true, _none()); // does not divide
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openShort(address(s), 3 * LOT + 3, U, 3, u, true, _none()); // parts not on the lot grid
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openShort(address(s), 0, U, 1, u, true, _none());
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openShort(address(s), 100 * U, U, 0, u, true, _none());
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openLongDaily(address(s), 364 * U, 100 * U, 0, u, _none());
        // 0.0003 token bought for 3 parts... of 0.0001 each is fine; for 4 parts each would be below one lot
        vm.expectRevert(IAgateRouter.BadParts.selector);
        router.openLongDaily(address(s), 1_092, 3 * LOT, 4, u, _none());
        vm.stopPrank();
        uint256[] memory ids = _longDaily(u, 1_092, 3 * LOT, 3, u);
        assertEq(ids.length, 3);
        assertEq(uint256(s.position(ids[2]).q), LOT);
    }

    function test_zeroMinimumsAndLimitsRefused() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        uint256[] memory ids = _longDaily(u, 364 * U, 100 * U, 1, u);
        (uint256[] memory sids,,) = _short(u, 100 * U, U, 1, u, true);
        _long(u, 364 * U, 100 * U);
        vm.startPrank(u);
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.openLong(address(s), 364 * U, 0, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.openLong(address(s), 0, U, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.openLongDaily(address(s), 364 * U, 0, 1, u, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.openShort(address(s), 10 * U, 0, 1, u, true, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.closeLong(address(s), U, 0, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.closeShort(address(s), sids, 0, _none());
        vm.expectRevert(IAgateRouter.BadLimits.selector);
        router.closeLongDaily(address(s), ids, 0, _none());
        // amounts
        vm.expectRevert(IAgateRouter.BadAmount.selector);
        router.closeLong(address(s), 0, U, _none());
        vm.expectRevert(IAgateRouter.BadAmount.selector);
        router.closeLong(address(s), U + 1, U, _none());
        vm.expectRevert(IAgateRouter.BadAmount.selector);
        router.closeShort(address(s), new uint256[](0), U, _none());
        vm.expectRevert(IAgateRouter.BadAmount.selector);
        router.closeLongDaily(address(s), new uint256[](0), U, _none());
        vm.stopPrank();
    }

    function test_notYourPosition_wrongSide() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        address x = _user("x", 10_000 * U);
        uint256 lid = _longDaily(u, 364 * U, 100 * U, 1, u)[0];
        (uint256[] memory sids,,) = _short(u, 100 * U, U, 1, u, true);
        vm.startPrank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.WrongSide.selector, lid));
        router.closeShort(address(s), _ids(lid), 400 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.WrongSide.selector, sids[0]));
        router.closeLongDaily(address(s), sids, U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, 999));
        router.closeShort(address(s), _ids(999), 400 * U, _none()); // no such position: owner 0
        vm.stopPrank();
        vm.startPrank(x);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, sids[0]));
        router.closeShort(address(s), sids, 400 * U, _none());
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.NotYourPosition.selector, lid));
        router.closeLongDaily(address(s), _ids(lid), U, _none());
        vm.stopPrank();
    }

    /// Narrowing to Kuru's uint96 goes through SafeCast (finding L3): a quote above 2^96 - 1 reverts, never truncates.
    function test_safeCast_quoteAboveUint96() public {
        _bookWorld();
        uint256 big = uint256(type(uint96).max) + 1;
        address u = _user("u", big);
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 96, big));
        router.openLong(address(s), big, U, _none());
    }

    function test_sizeFor() public {
        _world();
        assertEq(router.sizeFor(8, 30), 5_760 * U);
        assertEq(router.sizeFor(1, 1), 24 * U);
        vm.expectRevert(IAgateRouter.BadSize.selector);
        router.sizeFor(0, 30);
        vm.expectRevert(IAgateRouter.BadSize.selector);
        router.sizeFor(8, 0);
        assertEq(router.factory(), address(factory));
    }

    /// A paused market stops router trades but no series function: a router short still exits without the router.
    function test_pausedMarket_seriesStillWorks() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        (uint256[] memory ids,,) = _short(u, 100 * U, U, 1, u, true);
        kuru.setMarketState(address(m), 1);
        vm.prank(u);
        vm.expectRevert(MockKuruOrderBook.MarketStateError.selector);
        router.closeShort(address(s), ids, 400 * U, _none());
        // the owner buys tokens elsewhere (here: mints a pair) and closes the position itself
        vm.startPrank(u);
        dollar.approve(address(s), type(uint256).max);
        s.mint(100 * U, u);
        uint256 paid = s.closeWithToken(ids[0], u);
        vm.stopPrank();
        assertEq(paid, 100 * uint256(C));
        assertEq(s.shortOf(u), 100 * U); // the minted pair's short stays a plain balance
    }
    // ------------------------------------------------------------------ the exact Kuru V1 calls (6.2, 6.3)

    /// Buys: exact approval to the market, placeAndExecuteMarketBuy(quote, nonzero minOut, isMargin false,
    /// isFillOrKill false), approval reset to 0. Sells: approval of exactly q tokens, placeAndExecuteMarketSell(q / LOT,
    /// nonzero minOut, false, true), reset. Mints: exact approval to the series, reset.
    function test_I25_exactKuruCallsAndApprovals() public {
        _bookWorld();
        address u = _user("u", 10_000 * U);
        vm.expectCall(address(dollar), abi.encodeCall(IERC20.approve, (address(m), 364 * U)));
        vm.expectCall(
            address(m),
            abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketBuy, (uint96(364 * U), 100 * U, false, false))
        );
        vm.expectCall(address(dollar), abi.encodeCall(IERC20.approve, (address(m), 0)));
        _long(u, 364 * U, 100 * U);
        vm.expectCall(address(token), abi.encodeCall(IERC20.approve, (address(m), 100 * U)));
        vm.expectCall(
            address(m),
            abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketSell, (uint96(100 * U / LOT), 360 * U, false, true))
        );
        vm.expectCall(address(token), abi.encodeCall(IERC20.approve, (address(m), 0)));
        _closeLong(u, 100 * U, 360 * U);
        vm.expectCall(address(dollar), abi.encodeCall(IERC20.approve, (address(s), 720 * U)));
        vm.expectCall(address(s), abi.encodeCall(IAgateSeries.mint, (100 * U, address(router))));
        vm.expectCall(address(dollar), abi.encodeCall(IERC20.approve, (address(s), 0)));
        vm.expectCall(
            address(m),
            abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketSell, (uint96(100 * U / LOT), 1, false, true))
        );
        vm.expectCall(address(s), abi.encodeCall(IAgateSeries.streamOut, (Side.SHORT, 50 * U, u, u, u, false)), 2);
        (uint256[] memory ids,,) = _short(u, 100 * U, 1, 2, u, false);
        // closeShort: the minimum out is the positions' summed q, the buy is not fill-or-kill
        vm.expectCall(
            address(m),
            abi.encodeCall(IKuruOrderBook.placeAndExecuteMarketBuy, (uint96(400 * U), 100 * U, false, false))
        );
        vm.expectCall(address(s), abi.encodeCall(IAgateSeries.closeWithToken, (ids[0], u)));
        vm.expectCall(address(s), abi.encodeCall(IAgateSeries.closeWithToken, (ids[1], u)));
        _closeShort(u, ids, 400 * U);
        _holdsNothing(0, 0);
    }

    /// nonReentrant on every flow: a hostile market (recorded by the admin on a factory without a Kuru router, the
    /// pilot shape) re-enters the router from inside the order; the guard refuses it and the whole call reverts.
    function test_nonReentrant_everyFlow() public {
        _world();
        bytes32[] memory gpus = new bytes32[](1);
        gpus[0] = H100;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        IAgateFactory pilot = IAgateFactory(
            address(new AgateFactory(address(index), address(dollar), address(0), gpus, labels, admin, "pilot", 0, 0))
        );
        IAgateSeries s2 = IAgateSeries(pilot.list(H100, NOV));
        IAgateRouter r2 = IAgateRouter(pilot.router());
        ReenteringBook evil = new ReenteringBook(r2, address(s2), s2.token(), address(dollar));
        vm.prank(admin);
        pilot.attachMarket(address(s2), address(evil), Venue.KURU_V1);
        address u = makeAddr("u");
        _give(u, 10_000 * U);
        vm.startPrank(u);
        dollar.approve(address(r2), type(uint256).max);
        dollar.approve(address(s2), type(uint256).max);
        IERC20(s2.token()).approve(address(r2), type(uint256).max);
        s2.mint(100 * U, u);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r2.openLong(address(s2), 364 * U, U, _none());
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r2.openLongDaily(address(s2), 364 * U, U, 1, u, _none());
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r2.openShort(address(s2), 10 * U, U, 1, u, true, _none());
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        r2.closeLong(address(s2), 10 * U, U, _none());
        vm.stopPrank();
        assertEq(evil.calls(), 0); // every attempt was rolled back
        assertEq(dollar.balanceOf(address(r2)), 0);
    }
}

/// A market that answers the factory's KURU_V1 checks and re-enters the router from inside every order.
contract ReenteringBook {
    IAgateRouter internal immutable router;
    address internal immutable series;
    address internal immutable token;
    address internal immutable dollar;
    uint256 public calls;

    constructor(IAgateRouter router_, address series_, address token_, address dollar_) {
        router = router_;
        series = series_;
        token = token_;
        dollar = dollar_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (1e6, 1e4, token, 6, dollar, 6, 1e4, 1e4, 1e10, 0, 0);
    }

    function marketState() external pure returns (uint8) {
        return 0;
    }

    function placeAndExecuteMarketBuy(uint96, uint256, bool, bool) external payable returns (uint256) {
        _reenter();
        return 0;
    }

    function placeAndExecuteMarketSell(uint96, uint256, bool, bool) external payable returns (uint256) {
        _reenter();
        return 0;
    }

    function _reenter() internal {
        ++calls;
        Permit memory none;
        (bool ok, bytes memory err) = address(router).call(abi.encodeCall(IAgateRouter.openLong, (series, 1, 1, none)));
        if (!ok) {
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
    }
}
