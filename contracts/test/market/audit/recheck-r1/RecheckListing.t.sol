// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAgateFactory} from "../../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../../../../src/market/interfaces/IAgateSeries.sol";
import {BandGrade, SeriesTerms} from "../../../../src/market/MarketTypes.sol";
import {FactoryBase} from "../../factory/FactoryBase.sol";

/// Cold recheck r1, listing: the turn of the year and of a month to the second, and a month that has passed.
contract RecheckListingTest is FactoryBase {
    uint32 internal constant JAN1 = 20_819; // 2027-01-01
    uint32 internal constant FEB1 = 20_850; // 2027-02-01
    uint32 internal constant JAN = 2027 * 12;
    uint32 internal constant FEB = 2027 * 12 + 1;

    /// December lists January 2027 (anchors Nov 26 to 30 across no boundary, the series across the year's);
    /// February opens exactly at the first second of January (MonthNotOpen one second before) and lists once Dec
    /// 27 to 31 are final (NotReady until the very second Dec 31 is); December is closed from then on.
    function test_RC11_listingAcrossTheTurnOfTheYear() public {
        _prodWorld();
        _post(H100, SEP1, FEB1, REF);
        _at(_finalTime(DEC1 - 1));
        assertEq(f.currentMonth(), DEC);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, NOV, DEC));
        f.list(H100, NOV);

        address jan = f.list(H100, JAN);
        SeriesTerms memory t = _terms(jan);
        assertEq(t.month, JAN);
        assertEq(t.startDay, JAN1);
        assertEq(t.n, 31);
        assertEq(t.startTs, ix.dayStart(JAN1));
        assertEq(t.floor, 1_800_000);
        assertEq(t.cap, 7_200_000);
        assertEq(uint8(t.bandGrade), uint8(BandGrade.RULE));
        address tok = IAgateSeries(jan).token();
        assertEq(IERC20Metadata(tok).name(), "agate H100 Jan 2027");
        assertEq(IERC20Metadata(tok).symbol(), "H100-JAN27");
        assertEq(f.predictToken(H100, JAN), tok);

        _at(ix.dayStart(JAN1) - 1);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, FEB, DEC));
        f.list(H100, FEB);
        _at(ix.dayStart(JAN1));
        assertEq(f.currentMonth(), JAN);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, FEB);
        _at(_finalTime(JAN1 - 1) - 1);
        vm.expectRevert(IAgateFactory.NotReady.selector);
        f.list(H100, FEB);
        _at(_finalTime(JAN1 - 1));
        address feb = f.list(H100, FEB);
        t = _terms(feb);
        assertEq(t.startDay, FEB1);
        assertEq(t.n, 28);
        assertEq(IERC20Metadata(IAgateSeries(feb).token()).symbol(), "H100-FEB27");
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, DEC, JAN));
        f.list(H100, DEC);
    }

    /// Once its month has passed, a listed series is closed to list and previewListing (MonthNotOpen, not
    /// AlreadyListed) while predictSeries / predictToken still name it; a month never listed cannot be predicted
    /// any more; the series itself still works (it does not depend on the factory's months).
    function test_RC12_aPastMonthIsClosedButItsAddressesStayKnown() public {
        _prodWorld();
        _post(H100, SEP1, DEC1 + 5, REF);
        _post(H200, SEP1, DEC1 + 5, REF);
        _at(_finalTime(OCT1 - 1));
        address nov = f.list(H100, NOV);
        address tok = IAgateSeries(nov).token();

        _at(ix.dayStart(DEC1));
        assertEq(f.currentMonth(), DEC);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, NOV, DEC));
        f.list(H100, NOV);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, NOV, DEC));
        f.previewListing(H100, NOV);
        assertEq(f.predictSeries(H100, NOV), nov);
        assertEq(f.predictToken(H100, NOV), tok);
        assertTrue(f.isSeries(nov));

        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, NOV, DEC));
        f.predictSeries(H200, NOV);
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MonthNotOpen.selector, NOV, DEC));
        f.predictToken(H200, NOV);

        address u = makeAddr("late minter");
        vm.prank(minter);
        usd.mint(u, 720e6);
        vm.startPrank(u);
        usd.approve(nov, type(uint256).max);
        IAgateSeries(nov).mint(100e6, u);
        vm.stopPrank();
        assertEq(IERC20Metadata(tok).balanceOf(u), 100e6);
    }
}
