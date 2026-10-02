// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {
    U,
    LOT,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    Venue
} from "../../../src/market/MarketTypes.sol";
import {RouterBase} from "../router/RouterBase.sol";

/// A contract Kuru never made that answers getMarketParams and marketState like a Kuru V1 market. Its buy keeps
/// the whole quote and hands back exactly the taker's minimum; its sell takes the tokens and pays exactly the minimum.
contract FakeKuruMarket {
    address internal immutable base;
    address internal immutable quote;
    address internal immutable thief;

    constructor(address base_, address quote_, address thief_) {
        base = base_;
        quote = quote_;
        thief = thief_;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (
            KURU_PRICE_PRECISION,
            KURU_SIZE_PRECISION,
            base,
            6,
            quote,
            6,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0
        );
    }

    function marketState() external pure returns (uint8) {
        return 0;
    }

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minOut, bool, bool) external payable returns (uint256) {
        IERC20(quote).transferFrom(msg.sender, thief, quoteSize);
        IERC20(base).transfer(msg.sender, minOut);
        return minOut;
    }

    function placeAndExecuteMarketSell(uint96 size, uint256 minOut, bool, bool) external payable returns (uint256) {
        IERC20(base).transferFrom(msg.sender, thief, uint256(size) * LOT);
        IERC20(quote).transfer(msg.sender, minOut);
        return minOut;
    }
}

/// Security audit, finding M1 (MEDIUM, design residual of BUILD-SPEC 3.4). On a factory WITH a Kuru router the first
/// market had to be one Kuru's Router lists in verifiedMarket, but a REPLACEMENT (after Kuru pauses the recorded
/// market) only checked the candidate's own getMarketParams and marketState, so the market admin (the deployer key)
/// could record any contract as KURU_V1 and every router flow of that series would trade against it (the PoC filled
/// a 3,640-dollar openLong at exactly the user's 900-token minimum while the fake kept the whole quote).
/// FIXED in v3.2 (spec 3.4, model test_replacement_on_a_v1_factory_must_be_kuru_made): every KURU_V1 attach on such a
/// factory needs verifiedMarket to name this token and dollar. The same scenario now reverts UseCreateMarket; the
/// admin can still record the fake as an OTHER venue, which the router refuses, so no user can trade against it.
contract AdminFakeMarketTest is RouterBase {
    function test_POC_M1_FIXED_adminCannotRecordAMarketKuruNeverMade() public {
        _bookWorld();
        address thief = makeAddr("thief");
        FakeKuruMarket fake = new FakeKuruMarket(address(token), dollarAddr, thief);

        // Kuru pauses the real market: the router cannot use it, so the admin may replace it
        kuru.setMarketState(address(m), 1);
        assertFalse(factory.routerCanUse(address(s)));

        // Kuru's Router never made the fake (verifiedMarket answers zeros) ...
        (,, address vBase,, address vQuote,,,,,,) = kuru.verifiedMarket(address(fake));
        assertEq(vBase, address(0));
        assertEq(vQuote, address(0));
        // ... so the admin can no longer record it as KURU_V1
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        factory.attachMarket(address(s), address(fake), Venue.KURU_V1);
        (address rec, Venue v) = factory.marketOf(address(s));
        assertEq(rec, address(m), "the paused Kuru market stays recorded");
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        assertFalse(factory.routerCanUse(address(s)));

        // the fake has inventory, as in the PoC
        _give(thief, 10_000 * U);
        vm.startPrank(thief);
        dollar.approve(address(s), type(uint256).max);
        s.mint(1_000 * U, thief);
        token.transfer(address(fake), 1_000 * U);
        vm.stopPrank();

        // recorded as an OTHER venue (still allowed as a replacement), the router refuses it: nobody trades on it
        vm.prank(admin);
        factory.attachMarket(address(s), address(fake), Venue.OTHER);
        assertFalse(factory.routerCanUse(address(s)));
        address u = _user("u", 10_000 * U);
        uint256 ledger0 = _ledger();
        vm.prank(u);
        vm.expectRevert(abi.encodeWithSelector(IAgateRouter.VenueUnsupported.selector, address(s)));
        router.openLong(address(s), 3_640 * U, 900 * U, _none());
        assertEq(dollar.balanceOf(u), 10_000 * U, "the user keeps every dollar");
        assertEq(dollar.balanceOf(thief), 10_000 * U - 7_200 * U, "the fake got no quote");
        _holdsNothing(0, 0);
        assertEq(_ledger(), ledger0, "the series' ledger is untouched");

        // and replacing the OTHER venue: still only a market Kuru made
        FakeKuruMarket fake2 = new FakeKuruMarket(address(token), dollarAddr, thief);
        vm.prank(admin);
        vm.expectRevert(IAgateFactory.UseCreateMarket.selector);
        factory.attachMarket(address(s), address(fake2), Venue.KURU_V1);
    }
}
