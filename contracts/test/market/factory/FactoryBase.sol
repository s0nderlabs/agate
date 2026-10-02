// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {SeriesTerms} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {KuruRouterStub} from "../mocks/KuruRouterStub.sol";

/// Shared world for the factory tests: a MockIndex on a chosen clock, our dollar, a Kuru V1 stub and one factory
/// over three GPUs. Records are put directly; a day's record is final T_PEND after the day ends unless said.
abstract contract FactoryBase is Test {
    MockIndex internal ix;
    AgateDollar internal usd;
    KuruRouterStub internal kuru;
    AgateFactory internal f;

    address internal admin = makeAddr("marketAdmin");
    address internal minter = makeAddr("minter");

    bytes32 internal constant H100 = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant H200 = keccak256("H200-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant B200 = keccak256("B200-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant RECIPE = keccak256("recipe-h100");

    uint32 internal constant SEP1 = 20_697; // 2026-09-01
    uint32 internal constant OCT1 = 20_727; // 2026-10-01
    uint32 internal constant NOV1 = 20_758; // 2026-11-01
    uint32 internal constant DEC1 = 20_788; // 2026-12-01
    uint32 internal constant SEP = 2026 * 12 + 8;
    uint32 internal constant OCT = 2026 * 12 + 9;
    uint32 internal constant NOV = 2026 * 12 + 10;
    uint32 internal constant DEC = 2026 * 12 + 11;
    uint32 internal constant REF = 3_600_000; // $3.60

    uint64 internal constant T0 = 1_800_000_000; // epoch second of the demo and FAST clocks
    uint32 internal day;
    uint64 internal tPend;

    /// PRODUCTION clock: DAY 86,400, epoch 0, T_PEND 6 h.
    function _prodWorld() internal {
        _world(86_400, 0, 0, 21_600, "", address(0));
    }

    /// DEMO clock with the demo index's calendar (epochDay = 2026-10-01): DAY 600, CLOSE_GRACE + T_PEND = 360 s.
    function _demoWorld() internal {
        _world(600, T0, OCT1, 360, "demo", address(0));
    }

    function _world(uint32 day_, uint64 epochTs, uint32 epochDay, uint64 tPend_, string memory tag, address kr)
        internal
    {
        day = day_;
        tPend = tPend_;
        ix = new MockIndex(day_, epochTs, epochDay);
        ix.register(H100, RECIPE);
        ix.register(H200, keccak256("recipe-h200"));
        ix.register(B200, keccak256("recipe-b200"));
        usd = new AgateDollar(minter, 10_000e6, 1 days);
        kuru = new KuruRouterStub();
        f = _factory(tag, kr == address(0) ? address(kuru) : kr, 0, 0);
    }

    function _factory(string memory tag, address kr, uint256 tf, uint256 mf) internal returns (AgateFactory) {
        (bytes32[] memory ids, string[] memory labels) = _gpus();
        return new AgateFactory(address(ix), address(usd), kr, ids, labels, admin, tag, tf, mf);
    }

    function _gpus() internal pure returns (bytes32[] memory ids, string[] memory labels) {
        ids = new bytes32[](3);
        labels = new string[](3);
        (ids[0], ids[1], ids[2]) = (H100, H200, B200);
        (labels[0], labels[1], labels[2]) = ("H100", "H200", "B200");
    }

    // ------------------------------------------------------------------ clock and records

    function _dayEnd(uint32 d) internal view returns (uint256) {
        return uint256(ix.dayStart(d)) + day;
    }

    function _finalTime(uint32 d) internal view returns (uint256) {
        return _dayEnd(d) + tPend;
    }

    /// Records of days [from, to) at value v, FULL, 5 fresh, final T_PEND after each day ends.
    function _post(bytes32 g, uint32 from, uint32 to, uint32 v) internal {
        for (uint32 d = from; d < to; ++d) {
            ix.put(g, d, v, uint64(_finalTime(d)), IAgateIndex.Status.FULL, 5, false, false);
        }
    }

    function _putFinal(uint32 d, uint32 v, IAgateIndex.Status st, uint8 fresh, bool late, bool incomplete) internal {
        ix.put(H100, d, v, uint64(_finalTime(d)), st, fresh, late, incomplete);
    }

    function _at(uint256 t) internal {
        vm.warp(t);
    }

    function _terms(address series) internal view returns (SeriesTerms memory) {
        return IAgateSeries(series).terms();
    }
}
