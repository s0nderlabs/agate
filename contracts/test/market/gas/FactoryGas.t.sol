// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {
    KURU_TYPE_ERC20,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    KURU_AMM_SPREAD,
    Venue
} from "../../../src/market/MarketTypes.sol";
import {GasBase} from "./GasBase.sol";

/// The factory and dollar shapes of BUILD-SPEC 9.2: list (RULE and SEEDED; two CREATE2 deployments, series and
/// token), createMarket (on the MockKuruRouter here; Kuru's real deployProxy is measured in fork/KuruV1.t.sol),
/// attachMarket (the admin replacing a paused market), drip.
contract FactoryGasTest is GasBase {
    function setUp() public {
        _wall(NOV1 - 1);
    }

    function test_gas_list() public {
        _m("list December (RULE)", bob, address(fac), abi.encodeCall(IAgateFactory.list, (GPU, DEC)), address(0), 0);
        _m("list November (SEEDED)", bob, address(fac), abi.encodeCall(IAgateFactory.list, (GPU, NOV)), address(0), 0);
    }

    function test_gas_markets() public {
        address s = fac.list(GPU, DEC);
        _m(
            "createMarket (MockKuruRouter)",
            bob,
            address(fac),
            abi.encodeCall(IAgateFactory.createMarket, (s)),
            address(0),
            0
        );
        address m1 = fac.createMarket(s);
        kuru.setMarketState(m1, 1); // Kuru pauses it: the router can no longer use it
        address m2 = kuru.deployProxy(
            KURU_TYPE_ERC20,
            IAgateSeries(s).token(),
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            10,
            0,
            KURU_AMM_SPREAD
        );
        _m(
            "attachMarket (replaces a paused market)",
            admin,
            address(fac),
            abi.encodeCall(IAgateFactory.attachMarket, (s, m2, Venue.KURU_V1)),
            address(0),
            0
        );
    }

    function test_gas_drip() public {
        _m(
            "drip (an address's first)",
            makeAddr("faucet-user"),
            address(usd),
            abi.encodeCall(AgateDollar.drip, ()),
            address(0),
            0
        );
    }
}
