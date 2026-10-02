// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {BandLib} from "../../../src/market/lib/BandLib.sol";
import {LastResortLib} from "../../../src/market/lib/LastResortLib.sol";
import {U, LOT, BandGrade, SeriesTerms} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {MockKuruRouter} from "../mocks/MockKuruRouter.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {StarveIndex, NCFactory} from "./Harness.sol";
import {MarketHandler} from "./MarketHandler.sol";

/// The invariant world (BUILD-SPEC 12.2 D): a production-clock MockIndex behind a StarveIndex, our dollar, a
/// MockKuruRouter, three GPUs whose anchors (Sep 26 to 30) and October sit at 3.60, 2.37 and 7.13, so three
/// November series with three bands (F/C 1.80/7.20, 1.15/4.75, 3.55/14.30), each with its Kuru market and a maker
/// book of five asks and five bids. The real factory lists them (_prodWorld), or the negative controls' NCFactory
/// deploys a harness series or router from its creation code (_ncWorld). Listed on Oct 31 07:00.
abstract contract MarketWorld is Test {
    uint32 internal constant OCT1 = 20_727;
    uint32 internal constant NOV1 = 20_758;
    uint32 internal constant NOV = 2026 * 12 + 10;
    uint64 internal constant DAY = 86_400;
    uint64 internal constant T_PEND = 21_600;

    MockIndex internal mix;
    StarveIndex internal six;
    AgateDollar internal dollar;
    MockKuruRouter internal kuru;
    MarketHandler internal handler;
    address internal routerAddr;
    address[5] internal actors;
    address internal mm = makeAddr("maker");
    address internal admin = makeAddr("marketAdmin");

    bytes32[3] internal gpus = [
        keccak256("H100-SXM/on-demand-list/neocloud/v1"),
        keccak256("H200-SXM/on-demand-list/neocloud/v1"),
        keccak256("B200-SXM/on-demand-list/neocloud/v1")
    ];
    uint32[3] internal refs = [uint32(3_600_000), 2_370_000, 7_130_000];
    string[3] internal labels = ["H100", "H200", "B200"];

    function _base() internal {
        mix = new MockIndex(uint32(DAY), 0, 0);
        six = new StarveIndex(mix);
        dollar = new AgateDollar(address(this), 10_000 * U, 1 days);
        kuru = new MockKuruRouter();
        actors = [makeAddr("a"), makeAddr("b"), makeAddr("c"), makeAddr("d"), makeAddr("e")];
        for (uint256 g; g < 3; ++g) {
            mix.register(gpus[g], keccak256(abi.encode("recipe", g)));
            for (uint32 d = OCT1 - 5; d < NOV1; ++d) {
                mix.put(gpus[g], d, refs[g], uint64((d + 1) * DAY + T_PEND), IAgateIndex.Status.FULL, 5, false, false);
            }
        }
        vm.warp(uint256(NOV1 - 1) * DAY + 7 hours);
    }

    /// The real factory over the StarveIndex lists the three Novembers and creates their markets.
    function _prodWorld() internal {
        _base();
        bytes32[] memory ids = new bytes32[](3);
        string[] memory ls = new string[](3);
        for (uint256 g; g < 3; ++g) {
            (ids[g], ls[g]) = (gpus[g], labels[g]);
        }
        AgateFactory fac = new AgateFactory(address(six), address(dollar), address(kuru), ids, ls, admin, "", 0, 0);
        routerAddr = fac.router();
        MarketHandler.Cand[] memory cands = new MarketHandler.Cand[](3);
        for (uint256 g; g < 3; ++g) {
            address s = fac.list(gpus[g], NOV);
            cands[g] = MarketHandler.Cand(s, fac.createMarket(s), gpus[g]);
        }
        _fund(cands);
        handler = new MarketHandler(mix, dollar, routerAddr, address(fac), mm, actors, cands, false);
    }

    /// The negative controls' world: the same three Novembers, deployed by the NCFactory from the creation code of
    /// a harness series (or the real one) next to a harness router (or the real one).
    function _ncWorld(string memory seriesArtifact, string memory routerArtifact, bool topUp) internal {
        _base();
        NCFactory ncf = new NCFactory(address(six), address(dollar), address(kuru), vm.getCode(routerArtifact));
        routerAddr = ncf.router();
        bytes memory code = vm.getCode(seriesArtifact);
        MarketHandler.Cand[] memory cands = new MarketHandler.Cand[](3);
        for (uint256 g; g < 3; ++g) {
            address s =
                ncf.list(code, _terms(address(ncf), g), string.concat("agate ", labels[g], " Nov 2026"), labels[g]);
            cands[g] = MarketHandler.Cand(s, ncf.createMarket(s), gpus[g]);
        }
        _fund(cands);
        handler = new MarketHandler(mix, dollar, routerAddr, address(ncf), mm, actors, cands, topUp);
    }

    /// What AgateFactory.list would give for GPU g (RULE band from five anchors at refs[g]).
    function _terms(address fac, uint256 g) internal view returns (SeriesTerms memory t) {
        (uint32 fl, uint32 cp) = BandLib.band(5 * uint256(refs[g]));
        t = SeriesTerms({
            index: address(six),
            dollar: address(dollar),
            factory: fac,
            router: routerAddr,
            gpuId: gpus[g],
            recipeHash: keccak256(abi.encode("recipe", g)),
            month: NOV,
            startDay: NOV1,
            n: 30,
            startTs: uint64(uint256(NOV1) * DAY),
            day: uint32(DAY),
            lastResort: uint64(LastResortLib.lastResort(DAY)),
            floor: fl,
            cap: cp,
            x0: refs[g],
            bandGrade: BandGrade.RULE,
            anchorCarried: 0,
            anchorMinFresh: 5,
            anchorLate: false
        });
    }

    /// Actors: $100M each and standing allowances to every series and the router. The maker: a float, 50,000 tokens
    /// per series and five asks and five bids around each reference.
    function _fund(MarketHandler.Cand[] memory cands) internal {
        for (uint256 i; i < 5; ++i) {
            dollar.mint(actors[i], 1e14);
            vm.startPrank(actors[i]);
            dollar.approve(routerAddr, type(uint256).max);
            for (uint256 g; g < cands.length; ++g) {
                dollar.approve(cands[g].series, type(uint256).max);
                IERC20(IAgateSeries(cands[g].series).token()).approve(routerAddr, type(uint256).max);
            }
            vm.stopPrank();
        }
        dollar.mint(mm, 1e15);
        vm.startPrank(mm);
        for (uint256 g; g < cands.length; ++g) {
            IAgateSeries s = IAgateSeries(cands[g].series);
            MockKuruOrderBook m = MockKuruOrderBook(cands[g].market);
            dollar.approve(address(s), type(uint256).max);
            dollar.approve(address(m), type(uint256).max);
            IERC20(s.token()).approve(address(m), type(uint256).max);
            s.mint(50_000 * U, mm);
            for (uint256 j = 1; j <= 5; ++j) {
                m.addSellOrder(uint32(refs[g] + 40_000 * j), uint96(2_000 * U / LOT), false);
                m.addBuyOrder(uint32(refs[g] - 40_000 * j), uint96(2_000 * U / LOT), false);
            }
        }
        vm.stopPrank();
    }

    /// Every action of the handler (not step, the checks or exitAll).
    function _actions() internal view returns (bytes4[] memory sels) {
        sels = new bytes4[](23);
        sels[0] = handler.mint.selector;
        sels[1] = handler.redeem.selector;
        sels[2] = handler.streamOut.selector;
        sels[3] = handler.claim.selector;
        sels[4] = handler.claimMany.selector;
        sels[5] = handler.setPayout.selector;
        sels[6] = handler.setOperator.selector;
        sels[7] = handler.closeWithToken.selector;
        sels[8] = handler.unstream.selector;
        sels[9] = handler.settle.selector;
        sels[10] = handler.sync.selector;
        sels[11] = handler.syncAtGas.selector;
        sels[12] = handler.warp.selector;
        sels[13] = handler.transferTokens.selector;
        sels[14] = handler.donate.selector;
        sels[15] = handler.topUp.selector;
        sels[16] = handler.openLong.selector;
        sels[17] = handler.openLongDaily.selector;
        sels[18] = handler.openShort.selector;
        sels[19] = handler.closeLong.selector;
        sels[20] = handler.closeShort.selector;
        sels[21] = handler.closeLongDaily.selector;
        sels[22] = handler.requote.selector;
    }
}
