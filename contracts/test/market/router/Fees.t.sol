// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {U, LOT} from "../../../src/market/MarketTypes.sol";
import {RouterFuzz} from "./RouterFuzz.sol";

/// Kuru fees nonzero (BUILD-SPEC 7: "the router stays correct with fees, it measures and returns remainders";
/// the recheck's TestR5RouterWithKuruFees). The fees are the factory's constructor arguments (taker 30, maker 10
/// bps), so the market it creates charges them: a buy returns an off-grid amount, openLongDaily streams whole lots
/// and hands the remainder back, a closeShort quoted by simulation returns the surplus, I37 and I25 hold.
contract RouterFeesTest is RouterFuzz {
    function _feeWorld() internal {
        _world(address(new AgateDollar(address(this), 10_000 * U, 86_400)), 30, 10);
        assertEq(m.takerFeeBps(), 30);
        assertEq(m.makerFeeBps(), 10);
        _maker(50_000 * U);
        _ask(3_640_000, 5_000 * U);
        _bid(3_600_000, 5_000 * U);
    }

    function test_fees_openLong_returnsAnOffGridAmount() public {
        _feeWorld();
        address u = _user("u", 10_000 * U);
        uint256 quote = 449_358_000; // 123.45 tokens at 3.64
        uint256 got = _long(u, quote, 123_000_000);
        assertEq(got, 123_450_000 - 370_350); // 30 bps of the tokens, rounded up, stay in the market
        assertTrue(got % LOT != 0);
        assertEq(token.balanceOf(u), got);
        assertEq(dollar.balanceOf(u), 10_000 * U - quote);
        _holdsNothing(0, 0);
    }

    function test_fees_openLongDaily_streamsWholeLotsAndReturnsTheRemainder() public {
        _feeWorld();
        address u = _user("u", 10_000 * U);
        vm.recordLogs();
        uint256[] memory ids = _longDaily(u, 449_358_000, 123_000_000, 2, u);
        R memory r = _routed(vm.getRecordedLogs());
        uint256 got = 123_079_650;
        uint256 per = 61_539_800;
        assertEq(r.tokens, got);
        for (uint256 i; i < 2; ++i) {
            assertEq(uint256(s.position(ids[i]).q), per);
        }
        assertEq(token.balanceOf(u), got - 2 * per); // 50 base units back
        assertEq(r.tokensOut, 50);
        assertEq(dollar.balanceOf(u), 10_000 * U - 449_358_000 + 2 * (per * F / U));
        _holdsNothing(0, 0);
    }

    function test_fees_openShort_closeLong_closeLongDaily_saleMinusFee() public {
        _feeWorld();
        address u = _user("u", 10_000 * U);
        (, uint256 cost, uint256 out) = _short(u, 100 * U, U, 1, u, true);
        assertEq(cost, 720 * U);
        assertEq(out, 360 * U - 1_080_000);
        assertEq(dollar.balanceOf(u), 10_000 * U - cost + out);
        _long(u, 364 * U, U);
        uint256 have = token.balanceOf(u) / LOT * LOT;
        uint256 d0 = dollar.balanceOf(u);
        uint256 sold = _closeLong(u, have, U);
        assertEq(sold, have * 3_600_000 / U - (have * 3_600_000 / U * 30 + 9_999) / 10_000);
        assertEq(dollar.balanceOf(u) - d0, sold);
        uint256[] memory lids = _longDaily(u, 364 * U, U, 1, u);
        uint256 q = s.position(lids[0]).q;
        uint256 paid0 = s.position(lids[0]).paid;
        (uint256 c2, uint256 o2, uint256 p2) = _closeLongDaily(u, lids, U);
        assertEq(c2, q * C / U);
        assertEq(o2, q * 3_600_000 / U - (q * 3_600_000 / U * 30 + 9_999) / 10_000);
        assertEq(p2, q * C / U - paid0);
        _holdsNothing(0, 0);
    }

    /// The app quotes an exact-out buy by simulation (the fee included); the router's non-fill-or-kill buy closes
    /// the position and the off-grid surplus comes back to the owner.
    function test_fees_closeShort_quotedBySimulation_surplusBack() public {
        _feeWorld();
        address u = _user("u", 10_000 * U);
        (uint256[] memory ids,,) = _short(u, 100 * U, U, 1, u, true);
        (bool ok, uint256 quote) = m.quoteFor(100 * U);
        assertTrue(ok);
        assertEq(quote, 365_095_640); // 1,003,010 units at 3.64: the smallest buy that nets 100 tokens after 30 bps
        (uint256 paid, uint256 surplus, uint256 refund) = _closeShort(u, ids, quote);
        assertEq(paid, 720 * U);
        assertEq(surplus, 97);
        assertEq(refund, 0);
        assertEq(token.balanceOf(u), 97);
        assertEq(s.position(ids[0]).owner, address(0));
        _holdsNothing(0, 0);
    }

    /// The recheck's fee fuzz: random books and flows on a 30 / 10 bps market.
    /// forge-config: default.fuzz.runs = 64
    /// forge-config: ci.fuzz.runs = 256
    function testFuzz_I37_randomFlowsWithFees(uint256 seed) public {
        _fuzzWorld(seed, 30, 10);
        Stats memory st;
        _run(30, st);
    }

    function test_fees_seededWorldsPutBuysOffTheGrid() public {
        Stats memory st;
        for (uint256 seed = 1; seed <= 10; ++seed) {
            _fuzzWorld(seed * 104_729, 30, 10);
            _run(30, st);
        }
        for (uint256 f; f < 6; ++f) {
            assertGt(st.ok[f], 5, "a flow barely ran");
        }
        assertGt(st.offGrid, 5); // the fee really put buys off the grid, and openLongDaily handed it back
        emit log_named_uint("routed calls checked", st.routed);
        emit log_named_uint("off-grid buys", st.offGrid);
    }
}
