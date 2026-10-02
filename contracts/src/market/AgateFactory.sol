// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IAgateIndex} from "../interfaces/IAgateIndex.sol";
import {DateLib} from "../lib/DateLib.sol";
import {IAgateFactory} from "./interfaces/IAgateFactory.sol";
import {IAgateSeries} from "./interfaces/IAgateSeries.sol";
import {IKuruRouter} from "./interfaces/IKuruRouter.sol";
import {IKuruOrderBook} from "./interfaces/IKuruOrderBook.sol";
import {AgateRouter} from "./AgateRouter.sol";
import {AgateSeries} from "./AgateSeries.sol";
import {BandLib} from "./lib/BandLib.sol";
import {LastResortLib} from "./lib/LastResortLib.sol";
import {NameLib} from "./lib/NameLib.sol";
import {
    KURU_TYPE_ERC20,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    KURU_AMM_SPREAD,
    KURU_MARKET_ACTIVE,
    BandGrade,
    Venue,
    SeriesTerms,
    Listing
} from "./MarketTypes.sol";

/// @title AgateFactory: lists the series of one (index, dollar) and records their markets (BUILD-SPEC 3)
/// @notice No owner. Anyone lists the current or the next month of a known GPU once its anchors are final (3.1),
/// with the 0.5x / 2x band (3.2); anyone creates the Kuru V1 market of a series (3.4). One limited role,
/// marketAdmin: attachMarket, which on a factory with a Kuru router records only Kuru-made markets as KURU_V1 (first
/// or replacing one the router cannot use) and an OTHER venue only as a replacement; a replacement may be the recorded
/// address under another venue (v3.3). The factory deploys its own router (3.5).
contract AgateFactory is IAgateFactory, ReentrancyGuardTransient {
    struct MarketRec {
        address market;
        Venue venue;
    }

    address public immutable override index;
    address public immutable override dollar;
    address public immutable override router;
    address public immutable override kuruRouter;
    address public immutable override marketAdmin;
    uint256 public immutable override takerFeeBps;
    uint256 public immutable override makerFeeBps;
    string public override tag;

    bytes32[] internal gpuList;
    mapping(bytes32 => string) internal labels;
    mapping(bytes32 => mapping(uint32 => address)) public override seriesOf;
    mapping(address => bool) public override isSeries;
    mapping(address => MarketRec) public override marketOf;

    /// BUILD-SPEC 10.2. kuruRouter zero: no createMarket (the V2 pilot); marketAdmin zero: no attachMarket.
    constructor(
        address index_,
        address dollar_,
        address kuruRouter_,
        bytes32[] memory gpuIds_,
        string[] memory labels_,
        address marketAdmin_,
        string memory tag_,
        uint256 takerFeeBps_,
        uint256 makerFeeBps_
    ) {
        if (index_ == address(0) || dollar_ == address(0) || !_sixDecimals(dollar_)) revert BadInit();
        uint256 n = gpuIds_.length;
        if (n == 0 || n > 8 || labels_.length != n) revert BadInit();
        for (uint256 i; i < n; ++i) {
            bytes32 id = gpuIds_[i];
            if (!NameLib.labelOk(labels_[i]) || bytes(labels[id]).length != 0) revert BadInit();
            labels[id] = labels_[i];
            gpuList.push(id);
        }
        if (!NameLib.tagOk(tag_) || makerFeeBps_ > takerFeeBps_ || takerFeeBps_ >= 10_000) revert BadInit();

        index = index_;
        dollar = dollar_;
        kuruRouter = kuruRouter_;
        marketAdmin = marketAdmin_;
        tag = tag_;
        takerFeeBps = takerFeeBps_;
        makerFeeBps = makerFeeBps_;
        router = address(new AgateRouter(IAgateFactory(address(this)), dollar_));
    }

    // ------------------------------------------------------------------ listing (BUILD-SPEC 3.1 to 3.3)

    function list(bytes32 gpuId, uint32 month) external override nonReentrant returns (address series) {
        (SeriesTerms memory t, string memory name, string memory symbol) = _prepare(gpuId, month);
        series = address(new AgateSeries{salt: _salt(gpuId, month)}(t, name, symbol));
        seriesOf[gpuId][month] = series;
        isSeries[series] = true;
        emit SeriesListed(
            series,
            gpuId,
            month,
            IAgateSeries(series).token(),
            t.startDay,
            t.n,
            t.startTs,
            t.day,
            t.lastResort,
            t.floor,
            t.cap,
            t.x0,
            t.bandGrade,
            t.anchorCarried,
            t.anchorMinFresh,
            t.anchorLate,
            name,
            symbol
        );
    }

    /// What list would record now, reverting exactly as list would.
    function previewListing(bytes32 gpuId, uint32 month) external view override returns (Listing memory l) {
        _open(gpuId, month);
        l = _anchors(gpuId, month);
    }

    /// The CREATE2 address hashes the constructor arguments, so it exists only once the band does (v2, finding M2).
    function predictSeries(bytes32 gpuId, uint32 month) public view override returns (address) {
        address s = seriesOf[gpuId][month];
        if (s != address(0)) return s;
        (SeriesTerms memory t, string memory name, string memory symbol) = _prepare(gpuId, month);
        bytes32 initHash = keccak256(abi.encodePacked(type(AgateSeries).creationCode, abi.encode(t, name, symbol)));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(gpuId, month), initHash))))
        );
    }

    /// The series' first CREATE (contract nonces start at 1).
    function predictToken(bytes32 gpuId, uint32 month) external view override returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), predictSeries(gpuId, month), bytes1(0x01)))
                )
            )
        );
    }

    function currentMonth() public view override returns (uint32) {
        return uint32(DateLib.monthOf(IAgateIndex(index).dayId(uint64(block.timestamp))));
    }

    // ------------------------------------------------------------------ markets (BUILD-SPEC 3.4)

    function createMarket(address series) external override nonReentrant returns (address market) {
        address kr = kuruRouter;
        if (kr == address(0)) revert NoKuruRouter();
        if (!isSeries[series]) revert NotSeries(series);
        MarketRec memory cur = marketOf[series];
        if (cur.venue != Venue.NONE) revert MarketAlreadySet(cur.market);
        address token = IAgateSeries(series).token();
        market = IKuruRouter(kr).computeAddress(
            token,
            dollar,
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            takerFeeBps,
            makerFeeBps,
            KURU_AMM_SPREAD,
            address(0),
            false
        );
        // a market someone already deployed with exactly our parameters is the same market (a front-run)
        bool created = market.code.length == 0;
        if (created) {
            address got = IKuruRouter(kr).deployProxy(
                KURU_TYPE_ERC20,
                token,
                dollar,
                KURU_SIZE_PRECISION,
                KURU_PRICE_PRECISION,
                KURU_TICK_SIZE,
                KURU_MIN_SIZE,
                KURU_MAX_SIZE,
                takerFeeBps,
                makerFeeBps,
                KURU_AMM_SPREAD
            );
            if (got != market) revert MarketAddressMismatch(market, got);
        }
        _checkVerified(kr, market, token);
        marketOf[series] = MarketRec(market, Venue.KURU_V1);
        emit MarketRecorded(series, market, Venue.KURU_V1, created, msg.sender, address(0));
    }

    function attachMarket(address series, address market, Venue venue) external override nonReentrant {
        if (marketAdmin == address(0) || msg.sender != marketAdmin) revert NotMarketAdmin();
        if (!isSeries[series]) revert NotSeries(series);
        MarketRec memory cur = marketOf[series];
        address token = IAgateSeries(series).token();
        address kr = kuruRouter;
        if (cur.venue == Venue.NONE) {
            // on a factory with a Kuru router the first market comes from createMarket, or is one Kuru made (v3, RC4)
            if (kr != address(0) && venue != Venue.KURU_V1) revert UseCreateMarket();
        } else if (_usable(cur) || (market == cur.market && venue == cur.venue)) {
            // v3.3: the same address under another venue passes (the pilot's OTHER -> KURU_V1 once its ABI is proven)
            revert MarketAlreadySet(cur.market);
        }
        // every KURU_V1 market on such a factory, first or replacement, is one Kuru's Router made (v3.2, audit M1)
        if (kr != address(0) && venue == Venue.KURU_V1) {
            (,, address base,, address quote,,,,,,) = IKuruRouter(kr).verifiedMarket(market);
            if (base != token || quote != dollar) revert UseCreateMarket();
        }
        if (venue != Venue.KURU_V1 && venue != Venue.OTHER) revert BadVenue();
        if (market.code.length == 0) revert NoCode(market);
        if (venue == Venue.KURU_V1) {
            if (!_paramsMatch(market, token)) revert MarketParamsMismatch();
            if (!_active(market)) revert MarketNotActive(market);
        }
        marketOf[series] = MarketRec(market, venue);
        emit MarketRecorded(series, market, venue, false, msg.sender, cur.market);
    }

    /// A recorded KURU_V1 market whose marketState() is ACTIVE; a call that fails counts as not usable.
    function routerCanUse(address series) external view override returns (bool) {
        return _usable(marketOf[series]);
    }

    // ------------------------------------------------------------------ views

    function gpuIds() external view override returns (bytes32[] memory) {
        return gpuList;
    }

    function labelOf(bytes32 gpuId) external view override returns (string memory) {
        return labels[gpuId];
    }

    // ------------------------------------------------------------------ internals

    function _salt(bytes32 gpuId, uint32 month) internal pure returns (bytes32) {
        return keccak256(abi.encode(gpuId, month));
    }

    /// The checks list makes before it reads the index: MonthNotOpen, UnknownGpu, AlreadyListed.
    function _open(bytes32 gpuId, uint32 month) internal view {
        uint32 cur = currentMonth();
        if (month != cur && uint256(month) != uint256(cur) + 1) revert MonthNotOpen(month, cur);
        if (bytes(labels[gpuId]).length == 0) revert UnknownGpu(gpuId);
        address s = seriesOf[gpuId][month];
        if (s != address(0)) revert AlreadyListed(s);
    }

    function _prepare(bytes32 gpuId, uint32 month)
        internal
        view
        returns (SeriesTerms memory t, string memory name, string memory symbol)
    {
        _open(gpuId, month);
        Listing memory l = _anchors(gpuId, month);
        IAgateIndex ix = IAgateIndex(index);
        uint256 startDay = DateLib.firstDayOf(month);
        uint32 day = ix.clocks().day;
        t = SeriesTerms({
            index: index,
            dollar: dollar,
            factory: address(this),
            router: router,
            gpuId: gpuId,
            recipeHash: ix.gpu(gpuId).recipeHash,
            month: month,
            startDay: SafeCast.toUint32(startDay),
            n: uint8(DateLib.daysIn(month)),
            startTs: ix.dayStart(SafeCast.toUint32(startDay)),
            day: day,
            lastResort: SafeCast.toUint64(LastResortLib.lastResort(day)),
            floor: l.floor,
            cap: l.cap,
            x0: l.x0,
            bandGrade: l.bandGrade,
            anchorCarried: l.anchorCarried,
            anchorMinFresh: l.anchorMinFresh,
            anchorLate: l.anchorLate
        });
        (name, symbol) = NameLib.names(labels[gpuId], month, tag);
    }

    /// BUILD-SPEC 3.1 and 3.2. The answer depends only on the index, never on the caller or the time of the call.
    function _anchors(bytes32 gpuId, uint32 month) internal view returns (Listing memory l) {
        IAgateIndex ix = IAgateIndex(index);
        (bool exists, uint32 first) = ix.firstRecordDay(gpuId);
        if (!exists) revert NotReady();
        (, bool isFinal, IAgateIndex.Record memory r) = ix.record(gpuId, first);
        if (!isFinal) revert NotReady();
        uint256 startDay = DateLib.firstDayOf(month);
        if (first > startDay) revert IndexStartsAfterMonth(first, SafeCast.toUint32(startDay));
        uint256 a = DateLib.firstDayOf(month - 1);
        if (uint256(first) + 5 <= a) {
            bool anyFresh;
            for (uint256 d = a - 5; d < a; ++d) {
                (bool ex, bool fin, IAgateIndex.Record memory rd) = ix.record(gpuId, uint32(d));
                if (!ex || !fin) revert NotReady();
                l.sum5 += rd.value;
                if (rd.status == IAgateIndex.Status.CARRIED) {
                    ++l.anchorCarried;
                } else {
                    if (!anyFresh || rd.fresh < l.anchorMinFresh) l.anchorMinFresh = rd.fresh;
                    anyFresh = true;
                    if (rd.late || rd.incomplete) l.anchorLate = true;
                }
                l.x0 = rd.value;
            }
            l.bandGrade = l.anchorCarried == 0 ? BandGrade.RULE : BandGrade.STALE;
        } else {
            // the index started less than five days before the 1st of the month before
            l.sum5 = 5 * uint256(r.value);
            l.bandGrade = BandGrade.SEEDED;
            l.anchorMinFresh = r.fresh;
            l.anchorLate = r.late || r.incomplete;
            l.x0 = r.value;
        }
        (l.floor, l.cap) = BandLib.band(l.sum5);
    }

    function _checkVerified(address kr, address market, address token) internal view {
        (
            uint32 pp,
            uint96 sp,
            address base,
            uint256 baseDecimals,
            address quote,
            uint256 quoteDecimals,
            uint32 tick,
            uint96 minSize,
            uint96 maxSize,
            uint256 tf,
            uint256 mf
        ) = IKuruRouter(kr).verifiedMarket(market);
        if (
            pp != KURU_PRICE_PRECISION || sp != KURU_SIZE_PRECISION || base != token || baseDecimals != 6
                || quote != dollar || quoteDecimals != 6 || tick != KURU_TICK_SIZE || minSize != KURU_MIN_SIZE
                || maxSize != KURU_MAX_SIZE || tf != takerFeeBps || mf != makerFeeBps
        ) revert MarketParamsMismatch();
    }

    /// The market's own getMarketParams: our precisions, token, dollar and tick (fees and sizes are the venue's).
    /// Read word by word, so an odd answer is a mismatch, never a decoding revert.
    function _paramsMatch(address market, address token) internal view returns (bool) {
        (bool ok, bytes memory ret) = market.staticcall(abi.encodeCall(IKuruOrderBook.getMarketParams, ()));
        if (!ok || ret.length < 11 * 32) return false;
        (uint256 pp, uint256 sp, uint256 base, uint256 baseDecimals, uint256 quote, uint256 quoteDecimals, uint256 tick)
        = abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        return pp == KURU_PRICE_PRECISION && sp == KURU_SIZE_PRECISION && base == uint256(uint160(token))
            && baseDecimals == 6 && quote == uint256(uint160(dollar)) && quoteDecimals == 6 && tick == KURU_TICK_SIZE;
    }

    function _active(address market) internal view returns (bool) {
        (bool ok, bytes memory ret) = market.staticcall(abi.encodeCall(IKuruOrderBook.marketState, ()));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == KURU_MARKET_ACTIVE;
    }

    function _usable(MarketRec memory m) internal view returns (bool) {
        return m.venue == Venue.KURU_V1 && _active(m.market);
    }

    function _sixDecimals(address token) internal view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) == 6;
    }
}
