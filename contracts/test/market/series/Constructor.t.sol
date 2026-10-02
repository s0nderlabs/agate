// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {LAST_RESORT_FLOOR, BandGrade, SeriesTerms, Position} from "../../../src/market/MarketTypes.sol";
import {SeriesBase, Dollar18} from "./SeriesBase.sol";

/// BUILD-SPEC 4.4: the constructor's checks, the terms it stores and the token it deploys.
contract SeriesConstructorTest is SeriesBase {
    function _expectBad(SeriesTerms memory t, bytes4 err) internal {
        vm.expectRevert(err);
        new AgateSeries(t, "n", "s");
    }

    function test_zeroAddressesAreBadTerms() public {
        SeriesTerms memory t = _terms(address(dollar), FLOOR, CAP, REF);
        t.index = address(0);
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t = _terms(address(dollar), FLOOR, CAP, REF);
        t.dollar = address(0);
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t = _terms(address(dollar), FLOOR, CAP, REF);
        t.factory = address(0);
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t = _terms(address(dollar), FLOOR, CAP, REF);
        t.router = address(0);
        _expectBad(t, IAgateSeries.BadTerms.selector);
    }

    function test_dollarMustHaveSixDecimals() public {
        _expectBad(_terms(address(new Dollar18()), FLOOR, CAP, REF), IAgateSeries.DollarDecimals.selector);
    }

    function test_band() public {
        _expectBad(_terms(address(dollar), 1_810_000, CAP, REF), IAgateSeries.BadBand.selector); // F off the grid
        _expectBad(_terms(address(dollar), FLOOR, 7_210_000, REF), IAgateSeries.BadBand.selector); // C off the grid
        _expectBad(_terms(address(dollar), 0, CAP, REF), IAgateSeries.BadBand.selector); // F below GRID
        _expectBad(_terms(address(dollar), CAP, CAP, REF), IAgateSeries.BadBand.selector); // F == C
        _expectBad(_terms(address(dollar), CAP, FLOOR, REF), IAgateSeries.BadBand.selector); // F > C
        new AgateSeries(_terms(address(dollar), 50_000, 100_000, REF), "n", "s"); // the smallest band
        new AgateSeries(_terms(address(dollar), 50_000, 2_000_000_000, REF), "n", "s"); // the widest
    }

    function test_monthLengthDayAndLastResort() public {
        SeriesTerms memory t = _terms(address(dollar), FLOOR, CAP, REF);
        t.n = 27;
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t.n = 32;
        _expectBad(t, IAgateSeries.BadTerms.selector);
        for (uint8 n = 28; n <= 31; ++n) {
            t.n = n;
            new AgateSeries(t, "n", "s");
        }
        t = _terms(address(dollar), FLOOR, CAP, REF);
        t.day = 0;
        t.lastResort = uint64(LAST_RESORT_FLOOR);
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t = _terms(address(dollar), FLOOR, CAP, REF);
        t.lastResort += 1;
        _expectBad(t, IAgateSeries.BadTerms.selector);
        // the 3-day floor on short days (600 s demo, 24 s FAST): 60 DAY is below it
        t.day = 600;
        t.lastResort = 36_000;
        _expectBad(t, IAgateSeries.BadTerms.selector);
        t.lastResort = uint64(LAST_RESORT_FLOOR);
        new AgateSeries(t, "n", "s");
        t.day = 24;
        new AgateSeries(t, "n", "s");
    }

    function test_termsRoundTrip() public {
        SeriesTerms memory t = _terms(address(dollar), FLOOR, CAP, REF);
        t.bandGrade = BandGrade.STALE;
        t.anchorCarried = 2;
        t.anchorMinFresh = 4;
        t.anchorLate = true;
        AgateSeries x = new AgateSeries(t, "n", "s");
        assertEq(abi.encode(x.terms()), abi.encode(t));
    }

    function test_initialState() public view {
        (uint8 k, uint64 sum, uint32 lastX, bool walked, bool appliedReal, uint128 led, uint256 nextId, uint256 sh) =
            s.state();
        assertEq(k, 0);
        assertEq(sum, 0);
        assertEq(lastX, REF); // x0
        assertFalse(walked);
        assertFalse(appliedReal);
        assertEq(led, 0);
        assertEq(nextId, 1);
        assertEq(sh, 0);
        Position memory p = s.position(1);
        assertEq(p.owner, address(0));
    }

    function test_deploysItsTokenAtNonceOne() public view {
        address predicted = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(s), bytes1(0x01)))))
        );
        assertEq(s.token(), predicted);
        assertEq(tok.series(), address(s));
        assertEq(tok.name(), "agate H100 Nov 2026");
        assertEq(tok.symbol(), "H100-NOV26");
        assertEq(tok.decimals(), 6);
        assertEq(tok.totalSupply(), 0);
    }
}
