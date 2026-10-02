// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateToken} from "../../../../src/market/interfaces/IAgateToken.sol";
import {U, LOT, Side} from "../../../../src/market/MarketTypes.sol";
import {SeriesUnstreamShort} from "../../invariant/Harness.sol";
import {SeriesBase} from "../../series/SeriesBase.sol";

/// Cold recheck r1, money lens: exact round trips at any size, side and day; the final day's two exits (claim or
/// unstream plus settle) worth the same to the u; an index that answers far outside its range.
contract RecheckMoneyTest is SeriesBase {
    /// A farmer mints a pair, streams one side for itself, claims on a later day, then leaves by closeWithToken or by
    /// unstream plus redeem: it gets back exactly what the pair cost (never a base unit more or less), and the series
    /// is empty again.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_RC1_roundTripReturnsExactlyThePairCost(uint256 seed) public {
        uint256 q = bound(seed, 1, 20_000_000) * LOT; // 0.0001 to 2,000 tokens
        Side side = (seed >> 200) & 1 == 0 ? Side.LONG : Side.SHORT;
        bool viaUnstream = (seed >> 201) & 1 == 1;
        uint256 k0 = bound(seed >> 8, 0, 29);
        uint256 k1 = bound(seed >> 40, k0, 29);
        uint256 k2 = bound(seed >> 72, k1, 30);
        address x = makeAddr("farmer");

        vm.warp(_afterDay(k0));
        uint256 cost = _mint(x, q);
        assertEq(cost, q * CAP / U);
        assertEq(dollar.balanceOf(x), 0);
        (uint256 id,) = _stream(x, side, q, x, x, true);
        _check();

        vm.warp(_afterDay(k1));
        vm.prank(stranger);
        s.claim(id);
        _check();

        vm.warp(_afterDay(k2));
        vm.startPrank(x);
        if (viaUnstream) {
            s.unstream(id, x); // pays back everything the position was paid
            s.redeem(q, x);
        } else {
            s.closeWithToken(id, x);
        }
        vm.stopPrank();
        _check();

        assertEq(dollar.balanceOf(x), cost, "the round trip returns exactly the pair cost");
        assertEq(_ledger(), 0, "ledger empty");
        assertEq(tok.totalSupply(), 0, "no token left");
        assertEq(_shortSupply(), 0, "no short left");
        assertEq(dollar.balanceOf(address(s)), 0, "no dollar left");
    }

    /// The round trip's check is not vacuous: on the unstream_short harness (unstream takes back one u too little)
    /// the same farm ends one u richer, paid out of another holder's collateral (alone in the series, the farmer's
    /// redeem would underflow the ledger instead).
    function test_RC1_control_aOneUnitUnstreamSlipIsCaught() public {
        s = new SeriesUnstreamShort(_terms(address(dollar), FLOOR, CAP, REF), "agate H100 Nov 2026", "H100-NOV26");
        tok = IAgateToken(s.token());
        _mint(b, 100 * U);
        address x = makeAddr("farmer");
        uint256 q = 720 * U;
        uint256 cost = _mint(x, q);
        (uint256 id, uint256 paidNow) = _stream(x, Side.LONG, q, x, x, true);
        assertGt(paidNow, 0);
        vm.startPrank(x);
        s.unstream(id, x);
        s.redeem(q, x);
        vm.stopPrank();
        assertEq(dollar.balanceOf(x), cost + 1, "the farm gains the slipped u, so RC1's equality would fail");
    }

    /// After the last day a position can be claimed (it is deleted) or unstreamed and its q settled: both are worth
    /// exactly the same to the u, on both sides, for a size whose owed rounds.
    function test_RC2_unstreamAfterTheLastDayEqualsTheFinalClaim() public {
        uint256 q = 1_234_567_800; // 1,234.5678 tokens
        vm.warp(_afterDay(7));
        uint256[2][2] memory ids; // [twin][side]
        address[2] memory twin = [a, b];
        for (uint256 i; i < 2; ++i) {
            _mint(twin[i], 2 * q);
            (ids[i][0],) = _stream(twin[i], Side.LONG, q, twin[i], twin[i], true);
            (ids[i][1],) = _stream(twin[i], Side.SHORT, q, twin[i], twin[i], true);
        }
        vm.warp(_afterDay(19));
        for (uint256 i; i < 2; ++i) {
            vm.prank(stranger);
            s.claim(ids[i][0]);
            vm.prank(stranger);
            s.claim(ids[i][1]);
        }
        vm.warp(_afterDay(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        uint256 sum = _S();
        _check();

        for (uint256 sd; sd < 2; ++sd) {
            Side side = sd == 0 ? Side.LONG : Side.SHORT;
            uint256 paidA = s.position(ids[0][sd]).paid;
            uint256 paidB = s.position(ids[1][sd]).paid;
            assertEq(paidA, paidB, "twins");
            uint256 num = side == Side.LONG ? sum : 30 * uint256(CAP) - sum;
            uint256 exact = q * num / (30 * U);

            uint256 a0 = dollar.balanceOf(a);
            vm.prank(stranger);
            s.claim(ids[0][sd]); // the final claim deletes it
            uint256 gainA = dollar.balanceOf(a) - a0;
            assertEq(s.position(ids[0][sd]).owner, address(0));

            uint256 b0 = dollar.balanceOf(b);
            vm.startPrank(b);
            s.unstream(ids[1][sd], b);
            s.settle(side, q, b);
            vm.stopPrank();
            uint256 gainB = dollar.balanceOf(b) - b0; // b paid back paidB, then settled q
            assertEq(gainB + paidB, exact, "the settle paid owed(N)");

            assertEq(gainA, exact - paidA, "final claim = owed(N) - paid");
            assertEq(gainB, gainA, "unstream plus settle = the final claim, to the u");
        }
        // what is left settles, and nothing beyond the dust of the rounded payouts stays in the ledger
        vm.startPrank(a);
        s.settle(Side.LONG, q, a);
        s.settle(Side.SHORT, q, a);
        vm.stopPrank();
        vm.startPrank(b);
        s.settle(Side.LONG, q, b);
        s.settle(Side.SHORT, q, b);
        vm.stopPrank();
        assertEq(tok.totalSupply(), 0);
        assertEq(_shortSupply(), 0);
        assertLe(_ledger(), 12, "at most one u per payout call");
    }

    /// The index is trusted, but a value far outside [P_MIN, P_MAX] still pays inside the band: 0 pays the floor,
    /// 2^32 - 1 and P_MAX pay the cap, a forced day after them repeats the raw last value, clamped; S stays in
    /// [kF, kC] and the pot pays every holder exactly (S / N = 5.40 here).
    function test_RC3_outOfRangeIndexValuesPayInsideTheBand() public {
        for (uint32 d = NOV1; d < NOV1 + 10; ++d) {
            _post(d, 0);
        }
        for (uint32 d = NOV1 + 10; d < NOV1 + 20; ++d) {
            _post(d, type(uint32).max);
        }
        for (uint32 d = NOV1 + 20; d < NOV1 + 29; ++d) {
            _post(d, 1_000_000_000);
        }
        index.del(GPU, NOV1 + 29); // the last day never closes: forced at the last value

        uint256 q = 720 * U;
        _mint(a, q);
        (uint256 idL,) = _stream(a, Side.LONG, q, a, a, true); // a keeps q short units
        _mint(b, q);
        (uint256 idS,) = _stream(b, Side.SHORT, q, b, b, true); // b keeps q tokens
        _mint(c, 100 * U); // c keeps whole pairs
        uint256 dollarsIn = dollar.totalSupply(); // every dollar a, b and c ever had went into the series

        for (uint256 kk = 5; kk <= 29; kk += 8) {
            vm.warp(_afterDay(kk));
            vm.prank(stranger);
            s.claim(idL);
            vm.prank(stranger);
            s.claim(idS);
            _check();
        }
        vm.warp(_deadline(30));
        s.sync(type(uint256).max);
        assertEq(_k(), 30);
        assertEq(_S(), 10 * uint256(FLOOR) + 20 * uint256(CAP), "0 pays F; 2^32 - 1, P_MAX and the forced day pay C");
        assertEq(_lastX(), 1_000_000_000, "lastX keeps the raw value; only the applied value is clamped");
        _check();

        vm.prank(stranger);
        s.claim(idL);
        vm.prank(stranger);
        s.claim(idS);
        vm.startPrank(a);
        assertEq(s.settle(Side.SHORT, q, a), 720 * 1_800_000, "a short unit pays C - S / N = 1.80");
        vm.stopPrank();
        vm.startPrank(b);
        assertEq(s.settle(Side.LONG, q, b), 720 * 5_400_000, "a token pays S / N = 5.40");
        vm.stopPrank();
        vm.startPrank(c);
        s.settle(Side.LONG, 100 * U, c);
        s.settle(Side.SHORT, 100 * U, c);
        vm.stopPrank();
        assertEq(_ledger(), 0, "every dollar in went out");
        assertEq(dollar.balanceOf(address(s)), 0);
        assertEq(dollar.balanceOf(a) + dollar.balanceOf(b) + dollar.balanceOf(c), dollarsIn);
    }
}
