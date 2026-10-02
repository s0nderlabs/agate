// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {World} from "../../scenarios/World.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {DateLib} from "../../../src/lib/DateLib.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {BandLib} from "../../../src/market/lib/BandLib.sol";
import {SeriesTerms, Listing, BandGrade} from "../../../src/market/MarketTypes.sol";
import {FactoryBase} from "./FactoryBase.sol";

/// I23 on a MockIndex: at most one series per (gpuId, month); the band of 3.1 and 3.2 (RULE, STALE, SEEDED);
/// independent of caller and time; only the current or the next month; the five errors; month, N and startDay
/// from DateLib on every clock; predictSeries and predictToken (BUILD-SPEC 3.3, v2 finding M2).
contract ListTest is FactoryBase {
    uint256 internal constant SIXTY_DAYS = 60 * 86_400;
    uint256 internal constant THREE_DAYS = 3 * 86_400;

    function setUp() public {
        _prodWorld();
    }

    // ------------------------------------------------------------------ grades

    function test_I23_rule() public {
        _post(H100, SEP1 + 19, NOV1 + 2, REF); // Sep 20 .. Nov 2
        _at(_finalTime(OCT1 - 1) - 1);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, NOV);
        _at(_finalTime(OCT1 - 1));
        assertEq(f.currentMonth(), OCT);
        address s = f.list(H100, NOV);
        SeriesTerms memory t = _terms(s);
        assertEq(t.floor, 1_800_000);
        assertEq(t.cap, 7_200_000);
        assertEq(t.x0, REF);
        assertEq(uint8(t.bandGrade), uint8(BandGrade.RULE));
        assertEq(t.anchorCarried, 0);
        assertEq(t.anchorMinFresh, 5);
        assertFalse(t.anchorLate);
        assertEq(t.index, address(ix));
        assertEq(t.dollar, address(usd));
        assertEq(t.factory, address(f));
        assertEq(t.router, f.router(), "the factory's router is written into the terms");
        assertEq(t.gpuId, H100);
        assertEq(t.recipeHash, RECIPE);
        assertEq(t.month, NOV);
        assertEq(t.startDay, NOV1);
        assertEq(t.n, 30);
        assertEq(t.startTs, uint64(NOV1) * 86_400);
        assertEq(t.day, 86_400);
        assertEq(t.lastResort, SIXTY_DAYS);
        assertEq(f.seriesOf(H100, NOV), s);
        assertTrue(f.isSeries(s));
        IAgateToken tok = IAgateToken(IAgateSeries(s).token());
        assertEq(tok.name(), "agate H100 Nov 2026");
        assertEq(tok.symbol(), "H100-NOV26");
        assertEq(tok.decimals(), 6);
        assertEq(tok.series(), s);
    }

    /// Model TestI23Listing.test_rule_stale_seeded, first half: two CARRIED anchors make the band STALE.
    function test_I23_stale() public {
        _post(H100, SEP1 + 19, NOV1 + 3, REF);
        _putFinal(SEP1 + 26, REF, IAgateIndex.Status.CARRIED, 0, false, false); // Sep 27
        _putFinal(SEP1 + 28, REF, IAgateIndex.Status.CARRIED, 0, false, false); // Sep 29
        _at(ix.dayStart(OCT1 + 1));
        SeriesTerms memory t = _terms(f.list(H100, NOV));
        assertEq(uint8(t.bandGrade), uint8(BandGrade.STALE));
        assertEq(t.anchorCarried, 2);
        assertEq(t.floor, 1_800_000);
        assertEq(t.cap, 7_200_000);
    }

    /// minFresh and late come from the non-CARRIED anchors only; x0 is day A-1 whatever its status.
    function test_I23_anchorFields() public {
        _post(H100, SEP1, SEP1 + 25, REF); // Sep 1 .. Sep 25
        _putFinal(SEP1 + 25, 3_500_000, IAgateIndex.Status.FULL, 5, false, false); // Sep 26
        _putFinal(SEP1 + 26, 3_400_000, IAgateIndex.Status.CARRIED, 0, true, true); // Sep 27, flags ignored
        _putFinal(SEP1 + 27, 3_300_000, IAgateIndex.Status.DEGRADED, 3, false, true); // Sep 28, incomplete
        _putFinal(SEP1 + 28, 3_900_000, IAgateIndex.Status.FULL, 4, false, false); // Sep 29
        _putFinal(SEP1 + 29, 3_700_000, IAgateIndex.Status.CARRIED, 0, false, false); // Sep 30
        _at(_finalTime(OCT1 - 1));
        Listing memory l = f.previewListing(H100, NOV);
        assertEq(l.sum5, 3_500_000 + 3_400_000 + 3_300_000 + 3_900_000 + 3_700_000);
        assertEq(uint8(l.bandGrade), uint8(BandGrade.STALE));
        assertEq(l.anchorCarried, 2);
        assertEq(l.anchorMinFresh, 3);
        assertTrue(l.anchorLate, "the incomplete DEGRADED day counts");
        assertEq(l.x0, 3_700_000, "x0 is the last anchor even when CARRIED");
        (uint32 fl, uint32 cp) = BandLib.band(l.sum5);
        assertEq(l.floor, fl);
        assertEq(l.cap, cp);

        // a late flag on a CARRIED day alone does not make the anchors late
        _putFinal(SEP1 + 27, 3_300_000, IAgateIndex.Status.DEGRADED, 3, false, false);
        assertFalse(f.previewListing(H100, NOV).anchorLate);
        // a late non-CARRIED day does
        _putFinal(SEP1 + 28, 3_900_000, IAgateIndex.Status.FULL, 4, true, false);
        assertTrue(f.previewListing(H100, NOV).anchorLate);
    }

    function test_I23_allFiveCarried() public {
        _post(H100, SEP1, SEP1 + 25, REF);
        for (uint32 d = SEP1 + 25; d < OCT1; ++d) {
            _putFinal(d, REF, IAgateIndex.Status.CARRIED, 0, true, false);
        }
        _at(_finalTime(OCT1 - 1));
        Listing memory l = f.previewListing(H100, NOV);
        assertEq(uint8(l.bandGrade), uint8(BandGrade.STALE));
        assertEq(l.anchorCarried, 5);
        assertEq(l.anchorMinFresh, 0);
        assertFalse(l.anchorLate);
    }

    /// Model test_rule_stale_seeded, second half: an index started Sep 28 seeds November from its first record.
    function test_I23_seeded() public {
        _putFinal(SEP1 + 27, 3_000_000, IAgateIndex.Status.DEGRADED, 4, true, false); // Sep 28, the first record
        _post(H100, SEP1 + 28, NOV1 + 3, 3_200_000);
        _at(ix.dayStart(OCT1 + 1));
        SeriesTerms memory t = _terms(f.list(H100, NOV));
        assertEq(uint8(t.bandGrade), uint8(BandGrade.SEEDED));
        assertEq(t.floor, 1_500_000);
        assertEq(t.cap, 6_000_000);
        assertEq(t.x0, 3_000_000);
        assertEq(t.anchorCarried, 0);
        assertEq(t.anchorMinFresh, 4);
        assertTrue(t.anchorLate);
    }

    /// The first record on A-5 gives RULE; on A-4, SEEDED.
    function test_I23_seededBoundary() public {
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        assertEq(uint8(f.previewListing(H100, NOV).bandGrade), uint8(BandGrade.RULE));
        ix.del(H100, OCT1 - 5);
        assertEq(uint8(f.previewListing(H100, NOV).bandGrade), uint8(BandGrade.SEEDED));
        assertEq(f.previewListing(H100, NOV).sum5, 5 * uint256(REF));
    }

    // ------------------------------------------------------------------ the errors

    function test_I23_notReady() public {
        _at(ix.dayStart(OCT1 + 1));
        vm.expectRevert(IAgateFactory.NotReady.selector); // no record at all
        f.list(H100, NOV);

        ix.put(H100, OCT1 - 5, REF, 0, IAgateIndex.Status.FULL, 5, false, false); // the first record never final
        _post(H100, OCT1 - 4, OCT1, REF);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, NOV);

        _post(H100, OCT1 - 20, OCT1 - 5, REF); // an earlier first record, final; Sep 26 still pending
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.previewListing(H100, NOV);

        _post(H100, OCT1 - 5, OCT1 - 4, REF);
        ix.del(H100, OCT1 - 3); // a gap among the anchors
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.predictSeries(H100, NOV);

        ix.put(H100, OCT1 - 3, REF, uint64(block.timestamp + 1), IAgateIndex.Status.FULL, 5, false, false);
        vm.expectRevert(IAgateFactory.NotReady.selector); // pending one more second
        f.predictToken(H100, NOV);
        skip(1);
        f.list(H100, NOV);
    }

    /// Model test_index_starting_after_the_month: permanent for October, November lists SEEDED.
    function test_I23_indexStartsAfterMonth() public {
        _post(H100, OCT1 + 5, OCT1 + 20, REF); // Oct 6 .. Oct 20
        _at(ix.dayStart(OCT1 + 14));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.IndexStartsAfterMonth.selector, OCT1 + 5, OCT1));
        f.list(H100, OCT);
        address s = f.list(H100, NOV);
        assertEq(uint8(_terms(s).bandGrade), uint8(BandGrade.SEEDED));
    }

    /// NotReady comes before IndexStartsAfterMonth (the first record must be final first, as in 3.1).
    function test_I23_indexStartsAfterMonth_needsFinalFirst() public {
        ix.put(H100, OCT1 + 5, REF, 0, IAgateIndex.Status.FULL, 5, false, false);
        _at(ix.dayStart(OCT1 + 14));
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, OCT);
    }

    function test_I23_firstRecordOnTheFirst() public {
        _post(H100, OCT1, OCT1 + 3, REF);
        _at(_finalTime(OCT1));
        SeriesTerms memory t = _terms(f.list(H100, OCT));
        assertEq(uint8(t.bandGrade), uint8(BandGrade.SEEDED));
        assertEq(t.startDay, OCT1);
        assertEq(t.n, 31);
    }

    function test_I23_monthNotOpen_unknownGpu_alreadyListed() public {
        _post(H100, SEP1, NOV1, REF);
        _at(_finalTime(OCT1 - 1));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, DEC, OCT));
        f.list(H100, DEC);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, SEP, OCT));
        f.list(H100, SEP);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, type(uint32).max, OCT));
        f.previewListing(H100, type(uint32).max);
        bytes32 other = keccak256("other");
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.UnknownGpu.selector, other));
        f.list(other, NOV);
        address s = f.list(H100, NOV);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.AlreadyListed.selector, s));
        f.list(H100, NOV);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.AlreadyListed.selector, s));
        f.previewListing(H100, NOV);
        // other GPUs and the current month are independent
        _post(H200, SEP1, NOV1, REF);
        f.list(H200, NOV);
        f.list(H100, OCT);
        // two months later November is closed for listing but its address stays known
        _at(ix.dayStart(DEC1 + 1));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, OCT, DEC));
        f.list(H100, OCT);
        assertEq(f.predictSeries(H100, NOV), s);
    }

    /// The MockIndex knows a GPU the factory does not label: UnknownGpu; the factory's label table is the gate.
    function test_I23_unknownGpuEvenWithRecords() public {
        bytes32 g = keccak256("X100");
        ix.register(g, bytes32(0));
        _post(g, SEP1, NOV1, REF);
        _at(_finalTime(OCT1 - 1));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.UnknownGpu.selector, g));
        f.list(g, NOV);
    }

    // ------------------------------------------------------------------ caller and time

    /// Model test_band_independent_of_caller_and_time: whoever lists, whenever in Oct or Nov, the same terms
    /// and the same address.
    function testFuzz_I23_independentOfCallerAndTime(address caller, uint256 dt) public {
        _post(H100, SEP1 + 19, DEC1, REF);
        for (uint32 d = OCT1 - 5; d < OCT1; ++d) {
            _putFinal(d, REF + (d % 7) * 10_000, IAgateIndex.Status.FULL, 5, false, false);
        }
        uint256 t0 = _finalTime(OCT1 - 1);
        _at(t0);
        address expected = f.predictSeries(H100, NOV);
        uint256 sum5;
        for (uint32 d = OCT1 - 5; d < OCT1; ++d) {
            sum5 += REF + (d % 7) * 10_000;
        }
        (uint32 fl, uint32 cp) = BandLib.band(sum5);

        dt = bound(dt, 0, ix.dayStart(DEC1) - 1 - t0); // any second while November can still be listed
        _at(t0 + dt);
        vm.assume(caller != address(0));
        vm.prank(caller);
        address s = f.list(H100, NOV);
        assertEq(s, expected);
        SeriesTerms memory t = _terms(s);
        assertEq(t.floor, fl);
        assertEq(t.cap, cp);
        assertEq(t.x0, REF + ((OCT1 - 1) % 7) * 10_000);
        assertEq(uint8(t.bandGrade), uint8(BandGrade.RULE));
        assertEq(t.startDay, NOV1);
        assertEq(t.n, 30);
        assertEq(t.startTs, uint64(NOV1) * 86_400);
    }

    // ------------------------------------------------------------------ every clock

    function test_I23_productionClock() public {
        _checkMonths(86_400, 0, 0, SIXTY_DAYS);
    }

    function test_I23_demoClock() public {
        _checkMonths(600, T0, OCT1, THREE_DAYS);
    }

    function test_I23_fastClock() public {
        _checkMonths(24, T0, OCT1, THREE_DAYS);
    }

    /// December 2026 (31), February 2027 (28), April 2027 (30), February 2028 (29): month, N and startDay from
    /// DateLib, startTs from the index, DAY and the last resort from its clock.
    function _checkMonths(uint32 day_, uint64 epochTs, uint32 epochDay, uint256 lastResort) internal {
        _world(day_, epochTs, epochDay, day_ / 2, "", address(0));
        uint32[4] memory months = [DEC, 2027 * 12 + 1, 2027 * 12 + 3, 2028 * 12 + 1];
        uint8[4] memory lens = [31, 28, 30, 29];
        for (uint256 i; i < 4; ++i) {
            uint32 m = months[i];
            uint32 a = uint32(DateLib.firstDayOf(m - 1));
            _post(H100, a - 5, a, REF);
            uint256 t = _finalTime(a - 1);
            if (t < ix.dayStart(a)) t = ix.dayStart(a);
            _at(t);
            assertEq(f.currentMonth(), m - 1);
            SeriesTerms memory st = _terms(f.list(H100, m));
            assertEq(st.month, m);
            assertEq(st.startDay, DateLib.firstDayOf(m));
            assertEq(st.n, lens[i]);
            assertEq(st.startTs, uint64(epochTs + uint256(st.startDay - epochDay) * day_));
            assertEq(st.startTs, ix.dayStart(st.startDay));
            assertEq(st.day, day_);
            assertEq(st.lastResort, lastResort);
            assertEq(uint8(st.bandGrade), uint8(BandGrade.RULE));
        }
    }

    /// Model TestF4DemoSchedule: the demo index starts 2026-10-01; October and November list SEEDED once Oct 1 is
    /// final, November then trades 17,640 s before it pays; December lists RULE once Oct 31 is final.
    function test_F4_demoSchedule() public {
        _demoWorld();
        _post(H100, OCT1, 20_828, REF); // Oct 1 2026 .. Jan 9 2027
        uint256 tFirst = T0 + 600 + 360;
        _at(tFirst - 1);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, NOV);
        _at(tFirst);
        address oct = f.list(H100, OCT);
        address nov = f.list(H100, NOV);
        assertEq(uint8(_terms(oct).bandGrade), uint8(BandGrade.SEEDED));
        assertEq(uint8(_terms(nov).bandGrade), uint8(BandGrade.SEEDED));
        assertEq(_terms(nov).startTs - tFirst, 31 * 600 - 600 - 360);
        assertEq(IAgateToken(IAgateSeries(nov).token()).symbol(), "dH100-NOV26");
        assertEq(IAgateToken(IAgateSeries(nov).token()).name(), "agate H100 Nov 2026 demo");
        _at(ix.dayStart(NOV1) + 360 - 1);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, DEC);
        _at(ix.dayStart(NOV1) + 360);
        assertEq(uint8(_terms(f.list(H100, DEC)).bandGrade), uint8(BandGrade.RULE));
    }

    // ------------------------------------------------------------------ addresses, names, events

    /// Model TestM2PredictAddresses: the predicted pair equals the listed pair and waits for the band.
    function test_I23_predictMatchesListAndWaitsForTheBand() public {
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_dayEnd(OCT1 - 1) + 1);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.predictSeries(H100, NOV);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.predictToken(H100, NOV);
        _at(_finalTime(OCT1 - 1));
        address ps = f.predictSeries(H100, NOV);
        address pt = f.predictToken(H100, NOV);
        address s = f.list(H100, NOV);
        assertEq(s, ps);
        assertEq(IAgateSeries(s).token(), pt);
        _at(ix.dayStart(NOV1 + 40));
        assertEq(f.predictSeries(H100, NOV), s, "once listed: seriesOf");
        assertEq(f.predictToken(H100, NOV), pt);
    }

    /// The CREATE2 address hashes the terms: other anchors, another address (never the creation code alone).
    function test_I23_addressDependsOnTheTerms() public {
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        uint256 snap = vm.snapshotState();
        address a = f.list(H100, NOV);
        vm.revertToState(snap);
        _post(H100, OCT1 - 5, OCT1, REF + 10_000);
        address b = f.list(H100, NOV);
        assertTrue(a != b);
        bytes32 bare = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(f),
                keccak256(abi.encode(H100, NOV)),
                keccak256(vm.getCode("AgateSeries.sol:AgateSeries"))
            )
        );
        assertTrue(address(uint160(uint256(bare))) != b);
    }

    /// One factory per (index, dollar): two factories over one index list different series (CREATE2 namespaces).
    function test_I23_factoriesDoNotCollide() public {
        AgateFactory pilot = _factory("pilot", address(0), 0, 0);
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        address a = f.list(H100, NOV);
        address b = pilot.list(H100, NOV);
        assertTrue(a != b);
        assertEq(IAgateToken(IAgateSeries(a).token()).symbol(), "H100-NOV26");
        assertEq(IAgateToken(IAgateSeries(b).token()).symbol(), "pH100-NOV26");
        assertEq(IAgateToken(IAgateSeries(b).token()).name(), "agate H100 Nov 2026 pilot");
        assertEq(_terms(b).router, pilot.router());
        assertTrue(pilot.router() != f.router());
    }

    function test_I23_previewEqualsList() public {
        _post(H100, SEP1, NOV1, REF);
        _putFinal(OCT1 - 2, 3_450_000, IAgateIndex.Status.DEGRADED, 3, true, false);
        _at(_finalTime(OCT1 - 1));
        Listing memory l = f.previewListing(H100, NOV);
        SeriesTerms memory t = _terms(f.list(H100, NOV));
        assertEq(l.sum5, 4 * uint256(REF) + 3_450_000);
        assertEq(uint8(l.bandGrade), uint8(t.bandGrade));
        assertEq(l.anchorCarried, t.anchorCarried);
        assertEq(l.anchorMinFresh, t.anchorMinFresh);
        assertEq(l.anchorLate, t.anchorLate);
        assertEq(l.x0, t.x0);
        assertEq(l.floor, t.floor);
        assertEq(l.cap, t.cap);
    }

    function test_I23_seriesListedEvent() public {
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        address ps = f.predictSeries(H100, NOV);
        address pt = f.predictToken(H100, NOV);
        vm.expectEmit(true, true, true, true, address(f));
        emit IAgateFactory.SeriesListed(
            ps,
            H100,
            NOV,
            pt,
            NOV1,
            30,
            uint64(NOV1) * 86_400,
            86_400,
            uint64(SIXTY_DAYS),
            1_800_000,
            7_200_000,
            REF,
            BandGrade.RULE,
            0,
            5,
            false,
            "agate H100 Nov 2026",
            "H100-NOV26"
        );
        f.list(H100, NOV);
    }

    /// list makes no call to Kuru (a try/catch inside it would let the caller starve the market deployment).
    function test_I23_listMakesNoKuruCall() public {
        _post(H100, OCT1 - 5, OCT1, REF);
        _at(_finalTime(OCT1 - 1));
        vm.expectCall(address(kuru), bytes(""), 0);
        f.list(H100, NOV);
    }

    /// The series reads no clock after listing: the terms carry DAY and startTs (BUILD-SPEC 2).
    function test_I23_termsMatchTheIndex() public {
        _demoWorld();
        _post(H100, OCT1, NOV1 + 2, REF);
        _at(_finalTime(NOV1 - 1));
        SeriesTerms memory t = _terms(f.list(H100, DEC));
        assertEq(t.day, ix.clocks().day);
        assertEq(t.startTs, ix.dayStart(DEC1));
        assertEq(t.lastResort, THREE_DAYS);
        assertEq(t.recipeHash, RECIPE);
    }
}

/// I23 once against the real AgateIndex, driven by the wall's World helpers: the demo index of the market spec
/// (600-second day, epochDay = firstDay = 2026-10-01, section 2), three single-slot families at 3.50 / 3.60 / 3.70
/// (fix 3.60), both writers posting every slice, every record closed at the earliest second and countersigned when
/// it needs it. October and November list SEEDED once Oct 1 is final; December lists from Oct 27 to 31: RULE, or
/// STALE when one of those days is carried (no data).
contract ListRealIndexTest is World {
    AgateDollar internal usd;
    AgateFactory internal f;
    uint32 internal skipDay = type(uint32).max; // a day nobody posts (carried)

    uint32 internal constant OCT = 2026 * 12 + 9;
    uint32 internal constant NOV = 2026 * 12 + 10;
    uint32 internal constant DEC = 2026 * 12 + 11;
    uint32 internal constant FIX = 3_600_000;

    function setUp() public {
        deploy(Profile(600, 4, 2, 1, true, false, false, OCT1), 0);
        nSlots = 3;
        registerSimple(GPU, 3, OCT1);
        usd = new AgateDollar(makeAddr("minter"), 10_000e6, 1 days);
        bytes32[] memory ids = new bytes32[](1);
        string[] memory labels = new string[](1);
        ids[0] = GPU;
        labels[0] = "H100";
        f = new AgateFactory(address(ix), address(usd), address(0), ids, labels, address(0), "demo", 0, 0);
    }

    function page(uint256 i, uint32, uint8) internal pure override returns (uint32) {
        return [uint32(3_500_000), 3_600_000, 3_700_000][i];
    }

    function posts(address w, uint32 d, uint8 h) internal view override returns (bool) {
        return d != skipDay && super.posts(w, d, h);
    }

    /// Post day d, make d - 1 final (carrying it if nobody posted it), close d and countersign it if needed.
    function _step(uint32 d) internal {
        postDay(d);
        if (d > OCT1) settle(d - 1);
        if (d == skipDay) return;
        closeEarliest(w1, d);
        IAgateIndex.Record memory r = rec(d);
        if (r.needsSign && r.finalAt == 0) sign(att, d);
    }

    function _driveOctober() internal {
        _step(OCT1);
        // Oct 1 closed, not final yet
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(GPU, NOV);
        settle(OCT1);
        assertEq(f.currentMonth(), OCT);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, DEC, OCT));
        f.list(GPU, DEC);

        (,, IAgateIndex.Record memory first) = ix.record(GPU, OCT1);
        assertEq(first.value, FIX);
        address oct = f.list(GPU, OCT);
        address nov = f.list(GPU, NOV);
        for (uint256 i; i < 2; ++i) {
            SeriesTerms memory t = IAgateSeries(i == 0 ? oct : nov).terms();
            assertEq(uint8(t.bandGrade), uint8(BandGrade.SEEDED));
            assertEq(t.x0, FIX);
            assertEq(t.floor, 1_800_000);
            assertEq(t.cap, 7_200_000);
            assertEq(t.anchorMinFresh, first.fresh);
            assertEq(t.anchorLate, first.late || first.incomplete);
            assertEq(t.day, 600);
            assertEq(t.lastResort, 3 days);
            assertEq(t.startTs, ix.dayStart(t.startDay));
            assertEq(t.recipeHash, keccak256("recipe"));
        }
        assertEq(IAgateSeries(nov).terms().startDay, NOV1);
        assertEq(IAgateSeries(nov).terms().startTs, T0 + 31 * 600);
        assertEq(IAgateToken(IAgateSeries(nov).token()).symbol(), "dH100-NOV26");

        for (uint32 d = OCT1 + 1; d <= OCT1 + 30; ++d) {
            _step(d);
        }
        // Oct 31 closed early on Nov 1: December is open but its last anchor is not final yet
        assertEq(f.currentMonth(), NOV);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.predictSeries(GPU, DEC);
        settle(OCT1 + 30);
    }

    /// The factory's anchors equal the index's own records of Oct 27 to 31.
    function _assertDecemberAnchors(Listing memory l) internal view {
        uint256 sum5;
        uint8 carried;
        for (uint32 d = OCT1 + 26; d <= OCT1 + 30; ++d) {
            (bool ex, bool fin, IAgateIndex.Record memory r) = ix.record(GPU, d);
            assertTrue(ex && fin);
            sum5 += r.value;
            if (r.status == IAgateIndex.Status.CARRIED) ++carried;
        }
        assertEq(l.sum5, sum5);
        assertEq(l.anchorCarried, carried);
        (, , IAgateIndex.Record memory last) = ix.record(GPU, OCT1 + 30);
        assertEq(l.x0, last.value);
        (uint32 fl, uint32 cp) = BandLib.band(sum5);
        assertEq(l.floor, fl);
        assertEq(l.cap, cp);
    }

    function test_I23_realIndex_seededThenRule() public {
        _driveOctober();
        Listing memory l = f.previewListing(GPU, DEC);
        _assertDecemberAnchors(l);
        assertEq(uint8(l.bandGrade), uint8(BandGrade.RULE));
        assertEq(l.sum5, 5 * uint256(FIX));
        assertEq(l.anchorMinFresh, 3);
        assertFalse(l.anchorLate);
        address ps = f.predictSeries(GPU, DEC);
        address pt = f.predictToken(GPU, DEC);
        address s = f.list(GPU, DEC);
        assertEq(s, ps);
        assertEq(IAgateSeries(s).token(), pt);
        SeriesTerms memory t = IAgateSeries(s).terms();
        assertEq(uint8(t.bandGrade), uint8(BandGrade.RULE));
        assertEq(t.startDay, DEC1);
        assertEq(t.n, 31);
        assertEq(t.startTs, T0 + uint64(DEC1 - OCT1) * 600);
        assertEq(IAgateToken(IAgateSeries(s).token()).name(), "agate H100 Dec 2026 demo");
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.AlreadyListed.selector, s));
        f.list(GPU, DEC);
    }

    function test_I23_realIndex_carriedAnchorIsStale() public {
        skipDay = OCT1 + 28; // Oct 29: nobody posts, the index carries it
        _driveOctober();
        (,, IAgateIndex.Record memory carried) = ix.record(GPU, skipDay);
        assertEq(uint8(carried.status), uint8(IAgateIndex.Status.CARRIED));
        Listing memory l = f.previewListing(GPU, DEC);
        _assertDecemberAnchors(l);
        assertEq(uint8(l.bandGrade), uint8(BandGrade.STALE));
        assertEq(l.anchorCarried, 1);
        assertEq(l.anchorMinFresh, 3);
        SeriesTerms memory t = IAgateSeries(f.list(GPU, DEC)).terms();
        assertEq(uint8(t.bandGrade), uint8(BandGrade.STALE));
        assertEq(t.anchorCarried, 1);
    }
}
