// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IndexBase} from "../../Base.t.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {U, LOT, Side, Permit} from "../../../src/market/MarketTypes.sol";
import {MockKuruRouter} from "../mocks/MockKuruRouter.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";

/// The gas world of BUILD-SPEC 9.1 step 4: the real AgateIndex (the wall) on the demo clock (600-second days from
/// 2026-10-01), one GPU of three single-slot families fed every slice by the primary writer at 3.60, each day closed
/// at the earliest second (the first countersigned); our dollar; a MockKuruRouter; the demo factory with H100.
/// November lists SEEDED and December RULE on Nov 1. Two numbers per shape (9.1 step 4), each measured on a state
/// snapshot and rolled back, logged as "GAS | shape | ...":
///   used  = the execution gas of the call before refunds, every storage slot cold (refund: what a transaction
///           gets back, capped at a fifth of its gas when isolated; Monad bills the gas limit, so it saves nothing);
///   LIMIT = the smallest execution gas at which the call succeeds and applies every pending day (binary search on
///           call{gas: g}; every smaller g sampled must revert, and a success that applies fewer days fails the test);
///   tx    = LIMIT + 21,000 + the calldata's gas (16 per nonzero byte, 4 per zero byte): a transaction's gas limit.
/// Run with --isolate (the published numbers): every call is its own transaction, so every account but the target
/// and the sender is cold, as on chain. Without it vm.cool cools storage but not accounts (forge 1.3.5), so an
/// account already touched in the test costs 100 instead of 2,600: the lines are then marked "(warm accounts)".
abstract contract GasBase is IndexBase {
    uint32 internal constant NOV = 2026 * 12 + 10;
    uint32 internal constant DEC = 2026 * 12 + 11;
    uint32 internal constant JAN = 2027 * 12;
    uint32 internal constant JAN1 = 20_819;
    uint32 internal constant REF = 3_600_000;

    AgateDollar internal usd;
    MockKuruRouter internal kuru;
    AgateFactory internal fac;
    IAgateRouter internal router;
    IAgateSeries internal dec;
    IERC20 internal decTok;
    MockKuruOrderBook internal decMkt;
    uint32[] internal V;
    uint32 internal fedThrough; // the last day posted and closed

    address internal admin = makeAddr("gas-admin");
    address internal mm = makeAddr("gas-maker");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal payer = makeAddr("payer");

    struct M {
        uint256 used;
        uint256 limit;
        uint256 tx_;
        int256 refund;
    }

    // ------------------------------------------------------------------ the world

    /// Demo clock from Oct 1; fed and closed through `through` (at least Oct 31), the factory deployed on Nov 1.
    function _wall(uint32 through) internal {
        deploy(Profile(600, 4, 2, 1, true, false, false, OCT1), OCT1);
        registerSimple(GPU, 3, OCT1);
        V = fill(3, REF);
        bootDay(OCT1, V, none());
        fedThrough = OCT1;
        _feed(NOV1 - 1);
        usd = new AgateDollar(address(this), 10_000 * U, 1 days);
        kuru = new MockKuruRouter();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = GPU;
        string[] memory labels = new string[](1);
        labels[0] = "H100";
        fac = new AgateFactory(address(ix), address(usd), address(kuru), ids, labels, admin, "demo", 0, 0);
        router = IAgateRouter(fac.router());
        _feed(through);
    }

    /// The standard world: November and December listed with their markets, alice and bob funded with standing
    /// allowances, a maker book on December (asks 1,000 tokens at 3.64, 3.65, 3.66; bids at 3.60, 3.59, 3.58).
    function _world() internal {
        _wall(NOV1 - 1);
        fac.list(GPU, NOV);
        dec = IAgateSeries(fac.list(GPU, DEC));
        fac.createMarket(address(dec));
        decTok = IERC20(dec.token());
        (address mk,) = fac.marketOf(address(dec));
        decMkt = MockKuruOrderBook(mk);
        _fundUser(alice);
        _fundUser(bob);
        usd.mint(mm, 1e15);
        vm.startPrank(mm);
        usd.approve(address(dec), type(uint256).max);
        usd.approve(address(decMkt), type(uint256).max);
        decTok.approve(address(decMkt), type(uint256).max);
        dec.mint(50_000 * U, mm);
        vm.stopPrank();
        for (uint256 i; i < 3; ++i) {
            _ask(uint32(3_640_000 + i * 10_000), 1_000 * U);
            _bid(uint32(3_600_000 - i * 10_000), 1_000 * U);
        }
    }

    function _fundUser(address u) internal {
        usd.mint(u, 1e13);
        vm.startPrank(u);
        usd.approve(address(router), type(uint256).max);
        if (address(dec) != address(0)) {
            usd.approve(address(dec), type(uint256).max);
            IERC20(dec.token()).approve(address(router), type(uint256).max);
        }
        vm.stopPrank();
    }

    function _ask(uint32 price, uint256 tokens) internal {
        vm.prank(mm);
        decMkt.addSellOrder(price, uint96(tokens / LOT), false);
    }

    function _bid(uint32 price, uint256 tokens) internal {
        vm.prank(mm);
        decMkt.addBuyOrder(price, uint96(tokens / LOT), false);
    }

    /// Posts and closes every day after fedThrough up to `last`, then waits until `last` is final.
    function _feed(uint32 last) internal {
        for (uint32 d = fedThrough + 1; d <= last; ++d) {
            feedDay(d, V, none());
            closeEarliest(w1, d);
        }
        if (last > fedThrough) fedThrough = last;
        warpTo(rec(fedThrough).finalAt);
    }

    /// December days 1 to c are final and day c + 1 is running: a sync-bearing call makes c index calls.
    function _decPending(uint256 c) internal {
        _feed(DEC1 + uint32(c) - 1);
    }

    function _k(IAgateSeries x) internal view returns (uint256 k) {
        (k,,,,,,,) = x.state();
    }

    // ------------------------------------------------------------------ measuring

    function _coolAll() internal {
        vm.cool(address(ix));
        vm.cool(address(usd));
        vm.cool(address(fac));
        vm.cool(address(router));
        vm.cool(address(kuru));
        if (address(dec) != address(0)) {
            vm.cool(address(dec));
            vm.cool(address(decTok));
            vm.cool(address(decMkt));
        }
    }

    function _cd(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    /// Whether this run isolates calls (--isolate): an isolated call's gas includes the 21,000 of a transaction.
    function _isolated() internal returns (bool) {
        (bool ok,) = address(usd).call(abi.encodeWithSignature("decimals()"));
        require(ok);
        (uint256 used,) = _lastCallGas();
        return used >= 21_000;
    }

    struct Call {
        address caller;
        address target;
        bytes data;
        address ser; // the series whose k a success must leave at wantK (zero: none)
        uint256 wantK;
    }

    /// One call at gas g, storage cold, rolled back. ok only if it succeeded; a success must apply every pending day.
    function _probe(Call memory c, uint256 g) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        _coolAll();
        vm.prank(c.caller);
        (ok,) = c.target.call{gas: g}(c.data);
        if (ok && c.ser != address(0)) {
            assertEq(_k(IAgateSeries(c.ser)), c.wantK, "a success applied fewer days than were pending (I36)");
        }
        vm.revertToStateAndDelete(snap);
    }

    /// The call with ample gas, storage cold, rolled back: its gas (isolated: minus 21,000 and the calldata).
    function _used(string memory shape, Call memory c, bool iso) internal returns (uint256 used, int256 refund) {
        uint256 snap = vm.snapshotState();
        _coolAll();
        vm.prank(c.caller);
        (bool ok, bytes memory ret) = c.target.call(c.data);
        (used, refund) = _lastCallGas();
        if (!ok) revert(string.concat(shape, ": the call reverts with ample gas: ", vm.toString(ret)));
        if (c.ser != address(0)) assertEq(_k(IAgateSeries(c.ser)), c.wantK, string.concat(shape, ": days applied"));
        vm.revertToStateAndDelete(snap);
        // isolated, the gas is a transaction's: with its 21,000 and calldata, and net of the (capped) refund
        if (iso) used = used + uint256(refund > 0 ? refund : int256(0)) - 21_000 - _cd(c.data);
    }

    /// The smallest g at which the call succeeds, searched from `base` (its gas with ample gas); every g sampled
    /// below it must revert.
    function _search(string memory shape, Call memory c, uint256 base) internal returns (uint256 hi) {
        uint256 lo = base > 2_000 ? base - 2_000 : 0;
        hi = base + 400_000;
        assertTrue(_probe(c, hi), string.concat(shape, ": fails at used + 400,000"));
        assertFalse(_probe(c, lo), string.concat(shape, ": succeeds below used"));
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_probe(c, mid)) hi = mid;
            else lo = mid;
        }
        for (uint256 i = 1; i <= 8; ++i) {
            assertFalse(_probe(c, hi - i), string.concat(shape, ": not monotone"));
        }
        for (uint256 g = 21_000; g < hi; g += hi / 12 + 1) {
            assertFalse(_probe(c, g), string.concat(shape, ": not monotone (sweep)"));
        }
    }

    /// Measures one shape (see the contract comment) and logs it. Isolated, a call's gas includes the transaction's
    /// 21,000 and its calldata, and a call{gas: g} succeeds from execution + calldata; both become execution gas.
    function _m(string memory shape, address caller, address target, bytes memory data, address ser, uint256 wantK)
        internal
        returns (M memory r)
    {
        Call memory c = Call(caller, target, data, ser, wantK);
        bool iso = _isolated();
        uint256 off = iso ? _cd(data) : 0;
        (r.used, r.refund) = _used(shape, c, iso);
        r.limit = _search(shape, c, r.used + off) - off;
        r.tx_ = r.limit + 21_000 + _cd(data);
        _log(shape, r, iso);
    }

    function _log(string memory shape, M memory r, bool iso) internal pure {
        console2.log(
            string.concat(
                "GAS | ",
                shape,
                " | used ",
                vm.toString(r.used),
                " | LIMIT ",
                vm.toString(r.limit),
                " | tx ",
                vm.toString(r.tx_),
                " | refund ",
                vm.toString(r.refund),
                iso ? "" : " (warm accounts)"
            )
        );
    }

    function _none() internal pure returns (Permit memory p) {}

    /// vm.lastCallGas read by hand: forge 1.3.5 returns five fields, forge-std 1.17 declares six.
    function _lastCallGas() internal view returns (uint256 used, int256 refund) {
        (bool ok, bytes memory ret) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && ret.length >= 160, "lastCallGas");
        (, uint64 u,, int64 rf,) = abi.decode(ret, (uint64, uint64, uint64, int64, uint64));
        (used, refund) = (u, rf);
    }
}
