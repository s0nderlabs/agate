// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IKuruOrderBook} from "../../../src/market/interfaces/IKuruOrderBook.sol";
import {
    Venue,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    KURU_AMM_SPREAD
} from "../../../src/market/MarketTypes.sol";
import {KuruRouterStub} from "../mocks/KuruRouterStub.sol";
import {KuruRouterBase} from "../mocks/KuruRouterBase.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract SomeVenue {
    function ping() external pure returns (uint256) {
        return 1;
    }
}

/// I24, the market record (BUILD-SPEC 3.4): createMarket records the same address whoever calls; a front-run with
/// our parameters is recorded, other parameters are ignored; on a factory with a Kuru router the first market
/// comes from createMarket or from the admin attaching a market Kuru's Router made for this token and dollar (v3,
/// RC4); the admin replaces a recorded market only while the router cannot use it (v2, M3).
contract MarketsTest is FactoryBase {
    address internal series;
    address internal token;
    address internal anyone = makeAddr("anyone");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        _prodWorld();
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        series = f.list(H100, NOV);
        token = IAgateSeries(series).token();
    }

    function _deployKuru(address by, address base, address quote, uint256 tf, uint256 mf, uint96 spread)
        internal
        returns (address)
    {
        vm.prank(by);
        return kuru.deployProxy(
            0, base, quote, KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, tf, mf, spread
        );
    }

    function _ours(uint256 tf, uint256 mf) internal view returns (address) {
        return kuru.computeAddress(
            token,
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            tf,
            mf,
            KURU_AMM_SPREAD,
            address(0),
            false
        );
    }

    function _market(address s) internal view returns (address m, Venue v) {
        return f.marketOf(s);
    }

    // ------------------------------------------------------------------ createMarket

    function test_I24_createMarket() public {
        address expected = _ours(0, 0);
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.MarketRecorded(series, expected, Venue.KURU_V1, true, anyone, address(0));
        vm.prank(anyone);
        address m = f.createMarket(series);
        assertEq(m, expected);
        (address rec, Venue v) = _market(series);
        assertEq(rec, m);
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        assertTrue(f.routerCanUse(series));
        (uint32 pp, uint96 sp, address base, uint256 bd, address quote, uint256 qd, uint32 tick,,,,) =
            kuru.verifiedMarket(m);
        assertEq(pp, KURU_PRICE_PRECISION);
        assertEq(sp, KURU_SIZE_PRECISION);
        assertEq(base, token);
        assertEq(bd, 6);
        assertEq(quote, address(usd));
        assertEq(qd, 6);
        assertEq(tick, KURU_TICK_SIZE);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, m));
        f.createMarket(series);
    }

    /// Model test_create_market_same_address_any_caller.
    function testFuzz_I24_sameAddressWhoeverCalls(address a, address b) public {
        uint256 snap = vm.snapshotState();
        vm.prank(a);
        address ma = f.createMarket(series);
        vm.revertToState(snap);
        vm.prank(b);
        address mb = f.createMarket(series);
        assertEq(ma, mb);
        assertEq(ma, _ours(0, 0));
    }

    /// Model test_front_run_with_same_params_is_recorded: Kuru's salt hashes only the market parameters, so a
    /// front-run with ours is the same market (recorded, created = false); other parameters, another address.
    function test_I24_frontRun() public {
        address front = _deployKuru(attacker, token, address(usd), 0, 0, KURU_AMM_SPREAD);
        address odd = _deployKuru(attacker, token, address(usd), 0, 0, 40);
        assertTrue(front != odd);
        uint256 deploys = kuru.deploys();
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.MarketRecorded(series, front, Venue.KURU_V1, false, anyone, address(0));
        vm.prank(anyone);
        assertEq(f.createMarket(series), front);
        assertEq(kuru.deploys(), deploys, "no second deployProxy");
    }

    function test_I24_errors() public {
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NotSeries.selector, address(this)));
        f.createMarket(address(this));
        AgateFactory pilot = _factory("pilot", address(0), 0, 0);
        address ps = pilot.list(H100, NOV);
        vm.expectRevert(IAgateFactory.NoKuruRouter.selector);
        pilot.createMarket(ps);
        // a series of another factory is not ours
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NotSeries.selector, ps));
        f.createMarket(ps);
    }

    /// computeAddress and deployProxy disagree (Kuru upgraded its implementation between the two): the whole
    /// call reverts, nothing is recorded.
    function test_I24_addressMismatch() public {
        kuru.setSkewDeploy(true);
        address expected = _ours(0, 0);
        vm.expectRevert(); // MarketAddressMismatch(expected, got), got unknown before the call
        f.createMarket(series);
        (address m,) = _market(series);
        assertEq(m, address(0));
        assertEq(expected.code.length, 0);
    }

    function test_I24_addressMismatchSelector() public {
        kuru.setSkewDeploy(true);
        try f.createMarket(series) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), IAgateFactory.MarketAddressMismatch.selector);
            (address e, address g) = abi.decode(_args(err), (address, address));
            assertEq(e, _ours(0, 0));
            assertTrue(g != e && g.code.length == 0, "the skewed market was rolled back with the call");
        }
    }

    function test_I24_paramsMismatch() public {
        kuru.setLie(true);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        f.createMarket(series);
    }

    /// The fees are factory arguments and decide the market's address (model test_fees_are_factory_arguments).
    function test_I24_feesDecideTheMarket() public {
        AgateFactory g = _factory("fee", address(kuru), 30, 10);
        address gs = g.list(H100, NOV);
        address m = g.createMarket(gs);
        (,,,,,,,,, uint256 tf, uint256 mf) = kuru.verifiedMarket(m);
        assertEq(tf, 30);
        assertEq(mf, 10);
        address tok = IAgateSeries(gs).token();
        address zeroFee = kuru.computeAddress(
            tok, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, KURU_AMM_SPREAD, address(0), false
        );
        assertTrue(zeroFee != m);
    }

    // ------------------------------------------------------------------ attachMarket on a V1 factory

    /// Model test_v1_factory_admin_cannot_preempt_create_market.
    function test_I24_adminCannotPreempt() public {
        address venue = address(new SomeVenue());
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, venue, Venue.OTHER);
        // a Kuru market of another token is not this series' market
        address otherTok = address(new AgateDollar(minter, 1, 1));
        address wrong = _deployKuru(anyone, otherTok, address(usd), 0, 0, KURU_AMM_SPREAD);
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, wrong, Venue.KURU_V1);
        // a look-alike from another router (Kuru never listed it)
        KuruRouterStub fake = new KuruRouterStub();
        address lookalike = fake.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, KURU_AMM_SPREAD
        );
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, lookalike, Venue.KURU_V1);
        // an EOA, and the venue NONE
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, makeAddr("eoa"), Venue.KURU_V1);
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, lookalike, Venue.NONE);
        address m = f.createMarket(series);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, m));
        f.attachMarket(series, venue, Venue.OTHER); // usable: no override
        (address rec,) = _market(series);
        assertEq(rec, m);
    }

    function test_I24_onlyAdmin() public {
        address m = _deployKuru(anyone, token, address(usd), 0, 0, KURU_AMM_SPREAD);
        vm.prank(anyone);
        vm.expectRevert(IAgateFactory.NotMarketAdmin.selector);
        f.attachMarket(series, m, Venue.KURU_V1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NotSeries.selector, address(this)));
        f.attachMarket(address(this), m, Venue.KURU_V1);
        // no admin at all: nobody, not even the zero address
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        AgateFactory g = new AgateFactory(address(ix), address(usd), address(kuru), ids, labels, address(0), "x", 0, 0);
        vm.prank(address(0));
        vm.expectRevert(IAgateFactory.NotMarketAdmin.selector);
        g.attachMarket(series, m, Venue.KURU_V1);
    }

    /// Model test_kuru_closes_deploy_proxy_admin_attaches_a_kuru_made_market (v3, RC4).
    function test_I24_kuruClosesDeployProxy() public {
        kuru.setPermissionless(false);
        vm.prank(anyone);
        vm.expectRevert(KuruRouterBase.Unauthorized.selector);
        f.createMarket(series);
        // Kuru makes our market with its own fees and sizes
        vm.prank(address(this)); // the stub's owner is Kuru
        address kuruMade = kuru.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, 1, 10 ** 12, 25, 10, KURU_AMM_SPREAD
        );
        vm.prank(anyone);
        vm.expectRevert(IAgateFactory.NotMarketAdmin.selector);
        f.attachMarket(series, kuruMade, Venue.KURU_V1);
        kuru.setMarketState(kuruMade, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketNotActive.selector, kuruMade));
        f.attachMarket(series, kuruMade, Venue.KURU_V1);
        kuru.setMarketState(kuruMade, 0);
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.MarketRecorded(series, kuruMade, Venue.KURU_V1, false, admin, address(0));
        vm.prank(admin);
        f.attachMarket(series, kuruMade, Venue.KURU_V1);
        (address rec, Venue v) = _market(series);
        assertEq(rec, kuruMade);
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        assertTrue(f.routerCanUse(series));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, kuruMade));
        f.attachMarket(series, kuruMade, Venue.KURU_V1);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, kuruMade));
        f.createMarket(series);
    }

    /// Residual (1) of 3.4, stated in the spec: while deployProxy is open, the admin may record first a
    /// Kuru-verified market of our token with other fees or sizes. Pinned so a change is noticed.
    function test_I24_residual_adminMayPickAKuruMadeMarketFirst() public {
        address otherFees = _deployKuru(anyone, token, address(usd), 20, 10, 40);
        vm.prank(admin);
        f.attachMarket(series, otherFees, Venue.KURU_V1);
        (address rec,) = _market(series);
        assertEq(rec, otherFees);
    }

    /// A Kuru-made market with another price precision or tick is refused at the common checks.
    function test_I24_firstAttachStillNeedsOurPrecisions() public {
        vm.prank(anyone);
        address badTick = kuru.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, 1_000, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, KURU_AMM_SPREAD
        );
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        f.attachMarket(series, badTick, Venue.KURU_V1);
        vm.prank(anyone);
        address badPrice = kuru.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, 100_000, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, KURU_AMM_SPREAD
        );
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        f.attachMarket(series, badPrice, Venue.KURU_V1);
    }

    /// Model test_paused_market_can_be_replaced_by_the_admin_only (v2, M3).
    function test_I24_replacement() public {
        address m = f.createMarket(series);
        address alt = _deployKuru(anyone, token, address(usd), 0, 0, 40); // same token, other spread
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, m));
        f.attachMarket(series, alt, Venue.KURU_V1); // the recorded market is ACTIVE
        kuru.setMarketState(m, 1); // Kuru pauses it
        assertFalse(f.routerCanUse(series));
        vm.prank(anyone);
        vm.expectRevert(IAgateFactory.NotMarketAdmin.selector);
        f.attachMarket(series, alt, Venue.KURU_V1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, m));
        f.attachMarket(series, m, Venue.KURU_V1); // the same market again
        kuru.setMarketState(alt, 2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketNotActive.selector, alt));
        f.attachMarket(series, alt, Venue.KURU_V1);
        kuru.setMarketState(alt, 0);
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.MarketRecorded(series, alt, Venue.KURU_V1, false, admin, m);
        vm.prank(admin);
        f.attachMarket(series, alt, Venue.KURU_V1);
        assertTrue(f.routerCanUse(series));

        // alt paused too: the admin may record an OTHER venue, which the router cannot use
        kuru.setMarketState(alt, 1);
        address venue = address(new SomeVenue());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NoCode.selector, makeAddr("eoa")));
        f.attachMarket(series, makeAddr("eoa"), Venue.OTHER);
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.BadVenue.selector);
        f.attachMarket(series, venue, Venue.NONE);
        vm.prank(admin);
        f.attachMarket(series, venue, Venue.OTHER);
        assertFalse(f.routerCanUse(series));
        // an OTHER venue is never usable, so an ACTIVE Kuru market may replace it
        kuru.setMarketState(m, 0);
        vm.prank(admin);
        f.attachMarket(series, m, Venue.KURU_V1);
        (address rec, Venue v) = _market(series);
        assertEq(rec, m);
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        assertTrue(f.routerCanUse(series));
    }

    /// Model test_replacement_on_a_v1_factory_must_be_kuru_made (v3.2, audit M1): on a factory with a Kuru router a
    /// replacement recorded as KURU_V1 must be one Kuru's Router lists for this token and dollar, like a first attach;
    /// a look-alike that passes getMarketParams and marketState is refused; an OTHER venue may still replace.
    function test_I24_replacementMustBeKuruMade() public {
        address m = f.createMarket(series);
        KuruRouterStub fake = new KuruRouterStub();
        address lookalike = fake.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, 40
        );
        (,, address vBase,,,,,,,,) = kuru.verifiedMarket(lookalike);
        assertEq(vBase, address(0), "Kuru's Router never made it");
        kuru.setMarketState(m, 1); // Kuru pauses the recorded market
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, lookalike, Venue.KURU_V1);
        // an OTHER venue may replace an unusable market; the router refuses it
        address venue = address(new SomeVenue());
        vm.prank(admin);
        f.attachMarket(series, venue, Venue.OTHER);
        assertFalse(f.routerCanUse(series));
        // replacing the OTHER venue: still only a Kuru-made market
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, lookalike, Venue.KURU_V1);
        address alt = _deployKuru(anyone, token, address(usd), 0, 0, 40);
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.MarketRecorded(series, alt, Venue.KURU_V1, false, admin, venue);
        vm.prank(admin);
        f.attachMarket(series, alt, Venue.KURU_V1);
        assertTrue(f.routerCanUse(series));
    }

    // ------------------------------------------------------------------ the V2 pilot shape (kuruRouter = 0)

    /// Model test_attach_admin_only_once_and_params: on a factory without a Kuru router the first attach is free.
    function test_I24_pilot() public {
        AgateFactory pilot = _factory("pilot", address(0), 0, 0);
        address ps = pilot.list(H100, NOV);
        address ptok = IAgateSeries(ps).token();
        KuruRouterStub v2 = new KuruRouterStub();
        address good = v2.deployProxy(
            0, ptok, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 20, 10, 30
        );
        address bad = v2.deployProxy(
            0, ptok, address(usd), KURU_SIZE_PRECISION, 100_000, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, 30
        );
        address wrongToken = v2.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, 30
        );
        vm.prank(anyone);
        vm.expectRevert(IAgateFactory.NotMarketAdmin.selector);
        pilot.attachMarket(ps, good, Venue.KURU_V1);
        vm.startPrank(admin);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        pilot.attachMarket(ps, bad, Venue.KURU_V1);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        pilot.attachMarket(ps, wrongToken, Venue.KURU_V1);
        vm.expectRevert(IAgateFactory.BadVenue.selector);
        pilot.attachMarket(ps, good, Venue.NONE);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NoCode.selector, makeAddr("eoa")));
        pilot.attachMarket(ps, makeAddr("eoa"), Venue.KURU_V1);
        pilot.attachMarket(ps, good, Venue.KURU_V1);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, good));
        pilot.attachMarket(ps, good, Venue.KURU_V1); // once while it is usable
        vm.stopPrank();
        assertTrue(pilot.routerCanUse(ps));
        vm.expectRevert(IAgateFactory.NoKuruRouter.selector);
        pilot.createMarket(ps);
    }

    function test_I24_pilotOtherVenueFirst() public {
        AgateFactory pilot = _factory("pilot", address(0), 0, 0);
        address ps = pilot.list(H100, NOV);
        address venue = address(new SomeVenue());
        vm.prank(admin);
        pilot.attachMarket(ps, venue, Venue.OTHER);
        (address rec, Venue v) = pilot.marketOf(ps);
        assertEq(rec, venue);
        assertEq(uint8(v), uint8(Venue.OTHER));
        assertFalse(pilot.routerCanUse(ps), "the router refuses an OTHER venue");
    }

    /// Model test_pilot_other_then_kuru_v1_same_address (v3.3, review): Kuru's V2 market recorded as OTHER while
    /// its ABI is unverified is re-recorded as KURU_V1 at the same address in one call; address and venue both
    /// unchanged, or a usable record, is still refused.
    function test_I24_pilotOtherThenKuruV1SameAddress() public {
        AgateFactory pilot = _factory("pilot", address(0), 0, 0);
        address ps = pilot.list(H100, NOV);
        KuruRouterStub v2 = new KuruRouterStub();
        address good = v2.deployProxy(
            0,
            IAgateSeries(ps).token(),
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            20,
            10,
            30
        );
        vm.startPrank(admin);
        pilot.attachMarket(ps, good, Venue.OTHER);
        assertFalse(pilot.routerCanUse(ps));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, good));
        pilot.attachMarket(ps, good, Venue.OTHER); // same address, same venue
        vm.expectEmit(true, true, true, true, address(pilot));
        emit IAgateFactory.MarketRecorded(ps, good, Venue.KURU_V1, false, admin, good);
        pilot.attachMarket(ps, good, Venue.KURU_V1);
        (address rec, Venue v) = pilot.marketOf(ps);
        assertEq(rec, good);
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        assertTrue(pilot.routerCanUse(ps));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, good));
        pilot.attachMarket(ps, good, Venue.OTHER); // usable: nothing replaces it
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, good));
        pilot.attachMarket(ps, good, Venue.KURU_V1);
        vm.stopPrank();
    }

    /// v3.3: on a V1 factory the same-address step gives the admin no new power: a look-alike recorded as OTHER still
    /// needs Kuru's verifiedMarket to become KURU_V1.
    function test_I24_sameAddressStillNeedsKuruOnV1() public {
        address m = f.createMarket(series);
        KuruRouterStub fake = new KuruRouterStub();
        address lookalike = fake.deployProxy(
            0, token, address(usd), KURU_SIZE_PRECISION, KURU_PRICE_PRECISION, KURU_TICK_SIZE, KURU_MIN_SIZE, KURU_MAX_SIZE, 0, 0, 40
        );
        kuru.setMarketState(m, 1);
        vm.startPrank(admin);
        f.attachMarket(series, lookalike, Venue.OTHER);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, lookalike, Venue.KURU_V1);
        vm.stopPrank();
        (address rec, Venue v) = _market(series);
        assertEq(rec, lookalike);
        assertEq(uint8(v), uint8(Venue.OTHER));
    }

    /// Model test_zero_market_replacement_reverts_like_solidity (v3.3): a zero market passes the MarketAlreadySet
    /// step and reverts later, UseCreateMarket for KURU_V1 on a factory with a Kuru router, NoCode otherwise.
    function test_I24_zeroMarketReplacement() public {
        address m = f.createMarket(series);
        kuru.setMarketState(m, 1);
        vm.startPrank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        f.attachMarket(series, address(0), Venue.KURU_V1);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.NoCode.selector, address(0)));
        f.attachMarket(series, address(0), Venue.OTHER);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ odd markets never jam a view

    /// routerCanUse treats a reverting or malformed marketState() as not usable (no revert).
    function test_I24_routerCanUse_oddMarketState() public {
        address m = f.createMarket(series);
        assertTrue(f.routerCanUse(series));
        vm.mockCallRevert(m, abi.encodeCall(IKuruOrderBook.marketState, ()), "paused hard");
        assertFalse(f.routerCanUse(series));
        vm.clearMockedCalls();
        vm.mockCall(m, abi.encodeCall(IKuruOrderBook.marketState, ()), hex"00");
        assertFalse(f.routerCanUse(series), "short return data");
        vm.clearMockedCalls();
        vm.mockCall(m, abi.encodeCall(IKuruOrderBook.marketState, ()), abi.encode(uint256(256)));
        assertFalse(f.routerCanUse(series), "not ACTIVE");
        vm.clearMockedCalls();
        assertTrue(f.routerCanUse(series));
    }

    /// A market whose getMarketParams answers short or reverts is a mismatch, never a decoding revert.
    function test_I24_attach_oddMarketParams() public {
        address m = _deployKuru(anyone, token, address(usd), 0, 0, KURU_AMM_SPREAD);
        vm.mockCall(m, abi.encodeCall(IKuruOrderBook.getMarketParams, ()), abi.encode(uint256(1)));
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        f.attachMarket(series, m, Venue.KURU_V1);
        vm.mockCallRevert(m, abi.encodeCall(IKuruOrderBook.getMarketParams, ()), "");
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.MarketParamsMismatch.selector);
        f.attachMarket(series, m, Venue.KURU_V1);
        vm.clearMockedCalls();
        vm.prank(admin);
        f.attachMarket(series, m, Venue.KURU_V1);
    }

    function _args(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = err[i + 4];
        }
    }
}
