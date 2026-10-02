// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BandGrade, Venue, Listing} from "../MarketTypes.sol";

/// constructor(address index, address dollar, address kuruRouter, bytes32[] memory gpuIds, string[] memory labels,
///             address marketAdmin, string memory tag, uint256 takerFeeBps, uint256 makerFeeBps)
/// The constructor deploys this factory's AgateRouter: router = address(new AgateRouter(IAgateFactory(address(this)),
/// dollar)), passing its own dollar (v3.4).
/// tag: "" or 1 to 8 letters a to z (else BadInit); a nonempty tag's first letter prefixes every symbol (BUILD-SPEC 4.2).
/// attachMarket with no market recorded on a factory with a Kuru router: only a KURU_V1 market that
/// kuruRouter.verifiedMarket lists with base = the series' token and quote = dollar (else UseCreateMarket; 3.4).
interface IAgateFactory {
    event SeriesListed(
        address indexed series,
        bytes32 indexed gpuId,
        uint32 indexed month,
        address token,
        uint32 startDay,
        uint8 n,
        uint64 startTs,
        uint32 day,
        uint64 lastResort,
        uint32 floor,
        uint32 cap,
        uint32 x0,
        BandGrade bandGrade,
        uint8 anchorCarried,
        uint8 anchorMinFresh,
        bool anchorLate,
        string name,
        string symbol
    );
    event MarketRecorded(
        address indexed series, address indexed market, Venue venue, bool created, address indexed by, address previous
    );

    error BadInit();
    error MonthNotOpen(uint32 month, uint32 currentMonth);
    error UnknownGpu(bytes32 gpuId);
    error AlreadyListed(address series);
    error NotReady();
    error IndexStartsAfterMonth(uint32 firstRecordDay, uint32 startDay);
    error BadBand(uint256 sum5);
    error NoKuruRouter();
    error NotSeries(address series);
    error MarketAlreadySet(address market);
    error MarketAddressMismatch(address expected, address got);
    error MarketParamsMismatch();
    error MarketNotActive(address market);
    error UseCreateMarket();
    error NotMarketAdmin();
    error BadVenue();
    error NoCode(address market);

    function list(bytes32 gpuId, uint32 month) external returns (address series);
    function createMarket(address series) external returns (address market);
    function attachMarket(address series, address market, Venue venue) external;

    function previewListing(bytes32 gpuId, uint32 month) external view returns (Listing memory);
    function predictSeries(bytes32 gpuId, uint32 month) external view returns (address);
    function predictToken(bytes32 gpuId, uint32 month) external view returns (address);
    function seriesOf(bytes32 gpuId, uint32 month) external view returns (address);
    function isSeries(address series) external view returns (bool);
    function marketOf(address series) external view returns (address market, Venue venue);
    function routerCanUse(address series) external view returns (bool);
    function currentMonth() external view returns (uint32);
    function gpuIds() external view returns (bytes32[] memory);
    function labelOf(bytes32 gpuId) external view returns (string memory);
    function index() external view returns (address);
    function dollar() external view returns (address);
    function router() external view returns (address);
    function kuruRouter() external view returns (address);
    function marketAdmin() external view returns (address);
    function tag() external view returns (string memory);
    function takerFeeBps() external view returns (uint256);
    function makerFeeBps() external view returns (uint256);
}
