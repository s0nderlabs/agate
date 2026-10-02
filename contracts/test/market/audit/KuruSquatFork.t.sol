// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {DateLib} from "../../../src/lib/DateLib.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IKuruRouter} from "../../../src/market/interfaces/IKuruRouter.sol";
import {
    U,
    KURU_TYPE_ERC20,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    KURU_AMM_SPREAD,
    Venue
} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";

/// Security audit, CREATE2 squatting of a series' Kuru market on Kuru V1's deployed code (fork of Monad testnet;
/// skipped without MONAD_FORK_URL, like test/market/fork). The token address is predictable (predictToken) as soon
/// as the band is, before list() runs. Can a stranger deploy the Kuru market of our exact parameters for a token
/// that has no code yet, so that createMarket later finds a market at its computed address whose recorded decimals
/// are wrong (MarketParamsMismatch for ever: no market for that series on V1)?
contract KuruSquatForkTest is Test {
    address internal constant KURU_ROUTER = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
    bytes32 internal constant H100 = keccak256("H100-SXM/on-demand-list/neocloud/v1");

    function test_audit_squatBeforeListing() public {
        string memory url = vm.envOr("MONAD_FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        console2.log("fork block", block.number);

        MockIndex ix = new MockIndex(86_400, 0, 0);
        ix.register(H100, keccak256("recipe/H100"));
        uint256 cur = DateLib.monthOf(ix.dayId(uint64(block.timestamp)));
        uint32 month = uint32(cur + 1);
        uint256 a = DateLib.firstDayOf(cur);
        for (uint256 d = a - 5; d < a; ++d) {
            ix.put(H100, uint32(d), 3_600_000, uint64((d + 1) * 86_400), IAgateIndex.Status.FULL, 5, false, false);
        }
        AgateDollar usd = new AgateDollar(address(this), 10_000 * U, 1 days);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = H100;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        AgateFactory fac =
            new AgateFactory(address(ix), address(usd), KURU_ROUTER, ids, labels, makeAddr("admin"), "", 0, 0);

        address predicted = fac.predictToken(H100, month);
        assertEq(predicted.code.length, 0, "the token does not exist yet");

        address squatter = makeAddr("squatter");
        vm.prank(squatter);
        try IKuruRouter(KURU_ROUTER).deployProxy(
            KURU_TYPE_ERC20,
            predicted,
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0,
            KURU_AMM_SPREAD
        ) returns (address squatted) {
            console2.log("Kuru deployed a market for a token with no code", squatted);
            IAgateSeries s = IAgateSeries(fac.list(H100, month));
            assertEq(s.token(), predicted);
            // the squatted market sits at createMarket's computed address; it must still be recordable
            address m = fac.createMarket(address(s));
            assertEq(m, squatted);
            (, Venue v) = fac.marketOf(address(s));
            assertEq(uint8(v), uint8(Venue.KURU_V1));
        } catch (bytes memory err) {
            console2.log("Kuru refuses a market for a token with no code (no squat possible)");
            console2.logBytes(err);
            // the real listing then creates the market normally
            IAgateSeries s = IAgateSeries(fac.list(H100, month));
            assertEq(fac.createMarket(address(s)).code.length > 0, true);
        }
    }
}
