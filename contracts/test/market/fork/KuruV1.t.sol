// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {DateLib} from "../../../src/lib/DateLib.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {AgateFactory} from "../../../src/market/AgateFactory.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IKuruRouter} from "../../../src/market/interfaces/IKuruRouter.sol";
import {IKuruOrderBook} from "../../../src/market/interfaces/IKuruOrderBook.sol";
import {
    U,
    LOT,
    KURU_TYPE_ERC20,
    KURU_SIZE_PRECISION,
    KURU_PRICE_PRECISION,
    KURU_TICK_SIZE,
    KURU_MIN_SIZE,
    KURU_MAX_SIZE,
    KURU_AMM_SPREAD,
    Side,
    Venue,
    Permit
} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";

/// Kuru's MarginAccount, the one view this test reads (Kuru SDK 0.0.95 abi/MarginAccount.json, selector 0xd4fac45d).
interface IKuruMarginAccount {
    function getBalance(address user, address token) external view returns (uint256);
}

/// The maker's deposit into Kuru's MarginAccount (same ABI file).
interface IKuruMarginDeposit {
    function deposit(address user, address token, uint256 amount) external payable;
}

/// BUILD-SPEC 12.3: the market against Kuru V1's deployed code on a fork of Monad testnet. Skipped without
/// MONAD_FORK_URL. Run through contracts/script/rehearse-market.sh fork-test (an anvil-safe fork of
/// https://testnet-rpc.monad.xyz on port 8546), or for debugging in process with MONAD_FORK_URL set to the public
/// RPC. Fresh addresses only (makeAddr; Anvil's default accounts are EIP-7702 sweepers on Monad testnet). Our dollar,
/// a MockIndex on the production clock (next month listed, RULE at 3.60), a factory over the real Kuru Router; a
/// maker resting orders from the real MarginAccount. After every router flow the router holds nothing, in its wallet
/// and in Kuru's MarginAccount (v3, finding RC7). Every test logs the fork block.
contract KuruV1ForkTest is Test {
    address internal constant KURU_ROUTER = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
    address internal constant MARGIN = 0xd029C2D98ff85D8F64799017fE00a59B1159CE02;
    bytes32 internal constant TRADE = 0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581;
    bytes32 internal constant H100 = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant H200 = keccak256("H200-SXM/on-demand-list/neocloud/v1");
    uint32 internal constant REF = 3_600_000;
    uint256 internal constant T_PEND = 21_600;

    MockIndex internal ix;
    AgateDollar internal usd;
    AgateFactory internal fac;
    IAgateRouter internal router;
    IAgateSeries internal s;
    IERC20 internal tok;
    IKuruOrderBook internal mkt;
    uint32 internal month;

    address internal admin = makeAddr("agate-fork-admin");
    address internal maker = makeAddr("agate-fork-maker");
    address internal user = makeAddr("agate-fork-user");
    address internal frontRunner = makeAddr("agate-fork-front-runner");

    // ------------------------------------------------------------------ the fork and the world

    /// BUILD-SPEC 12.3, verbatim: no URL, no fork test.
    function _fork() internal {
        string memory url = vm.envOr("MONAD_FORK_URL", string(""));
        if (bytes(url).length == 0) vm.skip(true);
        vm.createSelectFork(url);
        console2.log("fork block", block.number);
        console2.log("fork timestamp", block.timestamp);
        assertEq(block.chainid, 10_143, "not Monad testnet");
        assertGt(KURU_ROUTER.code.length, 0, "no Kuru Router at this block");
        assertGt(MARGIN.code.length, 0, "no Kuru MarginAccount at this block");
        assertEq(maker.code.length + user.code.length + frontRunner.code.length + admin.code.length, 0, "not fresh");
    }

    /// The next month from the fork's clock, listed RULE at 3.60 (the index at 3.60 every day, 4.20 from day 11).
    function _world() internal {
        ix = new MockIndex(86_400, 0, 0);
        ix.register(H100, keccak256("recipe/H100"));
        ix.register(H200, keccak256("recipe/H200"));
        uint256 cur = DateLib.monthOf(ix.dayId(uint64(block.timestamp)));
        month = uint32(cur + 1);
        uint256 a = DateLib.firstDayOf(cur);
        uint256 start = DateLib.firstDayOf(month);
        uint256 end = start + DateLib.daysIn(month);
        for (uint256 d = a - 5; d < end; ++d) {
            uint32 v = d < start + 10 ? REF : 4_200_000;
            ix.put(H100, uint32(d), v, uint64((d + 1) * 86_400 + T_PEND), IAgateIndex.Status.FULL, 5, false, false);
            ix.put(H200, uint32(d), v, uint64((d + 1) * 86_400 + T_PEND), IAgateIndex.Status.FULL, 5, false, false);
        }
        usd = new AgateDollar(address(this), 10_000 * U, 1 days);
        bytes32[] memory ids = new bytes32[](2);
        (ids[0], ids[1]) = (H100, H200);
        string[] memory labels = new string[](2);
        (labels[0], labels[1]) = ("H100", "H200");
        fac = new AgateFactory(address(ix), address(usd), KURU_ROUTER, ids, labels, admin, "fork", 0, 0);
        router = IAgateRouter(fac.router());
        s = IAgateSeries(fac.list(H100, month));
        tok = IERC20(s.token());
    }

    function _market() internal {
        mkt = IKuruOrderBook(fac.createMarket(address(s)));
    }

    /// The maker: dollars and pairs, both deposited into Kuru's MarginAccount, then resting orders (price in u per
    /// token, size in units of 100 base units).
    function _maker(uint256 pairs) internal {
        usd.mint(maker, 100_000 * U);
        vm.startPrank(maker);
        usd.approve(address(s), type(uint256).max);
        s.mint(pairs, maker);
        tok.approve(MARGIN, type(uint256).max);
        usd.approve(MARGIN, type(uint256).max);
        IKuruMarginDeposit(MARGIN).deposit(maker, address(tok), pairs);
        IKuruMarginDeposit(MARGIN).deposit(maker, address(usd), 50_000 * U);
        vm.stopPrank();
    }

    function _ask(uint32 price, uint256 tokens) internal {
        vm.prank(maker);
        mkt.addSellOrder(price, uint96(tokens / LOT), false);
    }

    function _bid(uint32 price, uint256 tokens) internal {
        vm.prank(maker);
        mkt.addBuyOrder(price, uint96(tokens / LOT), false);
    }

    function _user() internal {
        usd.mint(user, 100_000 * U);
        vm.startPrank(user);
        usd.approve(address(router), type(uint256).max);
        usd.approve(address(s), type(uint256).max);
        tok.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _none() internal pure returns (Permit memory p) {}

    // ------------------------------------------------------------------ checks

    /// I25 on Kuru's real code: nothing in the router's wallet, no short, no allowance, and nothing credited to it
    /// in Kuru's MarginAccount.
    function _holdsNothing(string memory flow) internal view {
        assertEq(usd.balanceOf(address(router)), 0, string.concat(flow, ": router dollars"));
        assertEq(tok.balanceOf(address(router)), 0, string.concat(flow, ": router tokens"));
        assertEq(s.shortOf(address(router)), 0, string.concat(flow, ": router short"));
        assertEq(usd.allowance(address(router), address(mkt)), 0, string.concat(flow, ": allowance to the market"));
        assertEq(tok.allowance(address(router), address(mkt)), 0, string.concat(flow, ": allowance to the market"));
        assertEq(usd.allowance(address(router), address(s)), 0, string.concat(flow, ": allowance to the series"));
        IKuruMarginAccount ma = IKuruMarginAccount(MARGIN);
        assertEq(ma.getBalance(address(router), address(usd)), 0, string.concat(flow, ": router dollars at Kuru"));
        assertEq(ma.getBalance(address(router), address(tok)), 0, string.concat(flow, ": router tokens at Kuru"));
    }

    /// I37: the user's balances moved exactly as the Routed event says. Returns the event's fields.
    function _routed(Vm.Log[] memory logs, uint256 d0, uint256 t0) internal view returns (uint256[6] memory f) {
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != address(router) || l.topics[0] != IAgateRouter.Routed.selector) continue;
            (f[0], f[1], f[2], f[3], f[4], f[5],) =
                abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256[]));
            assertEq(address(uint160(uint256(l.topics[1]))), user);
            assertEq(int256(usd.balanceOf(user)) - int256(d0), int256(f[2]) - int256(f[1]), "I37 dollars");
            assertEq(int256(tok.balanceOf(user)) - int256(t0), int256(f[5]) - int256(f[4]), "I37 tokens");
            return f;
        }
        revert("no Routed event");
    }

    /// A router flow as the user (tx.origin too), its logs, and I25 / I37 after it. Logs the gas the flow used.
    function _flow(string memory name, bytes memory data) internal returns (bytes memory ret, Vm.Log[] memory logs) {
        uint256 d0 = usd.balanceOf(user);
        uint256 t0 = tok.balanceOf(user);
        vm.recordLogs();
        vm.prank(user, user);
        uint256 g0 = gasleft();
        bool ok;
        (ok, ret) = address(router).call(data);
        uint256 used = g0 - gasleft();
        logs = vm.getRecordedLogs();
        if (!ok) revert(string.concat(name, " reverted: ", vm.toString(ret)));
        _routed(logs, d0, t0);
        _holdsNothing(name);
        console2.log(string.concat("flow on Kuru V1: ", name, ", gas (gasleft, informational)"), used);
    }

    // ------------------------------------------------------------------ I24: createMarket on Kuru's Router

    function test_I24_createMarket() public {
        _fork();
        _world();
        address expected = IKuruRouter(KURU_ROUTER).computeAddress(
            address(tok),
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0,
            KURU_AMM_SPREAD,
            address(0),
            false
        );
        vm.expectEmit(address(fac));
        emit IAgateFactory.MarketRecorded(address(s), expected, Venue.KURU_V1, true, frontRunner, address(0));
        vm.prank(frontRunner);
        uint256 g0 = gasleft();
        address m = fac.createMarket(address(s));
        console2.log("createMarket on Kuru V1 (real deployProxy), gas (gasleft, informational)", g0 - gasleft());
        assertEq(m, expected, "deployProxy == computeAddress");
        (address rec, Venue v) = fac.marketOf(address(s));
        assertEq(rec, m);
        assertEq(uint8(v), uint8(Venue.KURU_V1));
        (uint32 pp, uint96 sp, address base, uint256 bd, address quote, uint256 qd, uint32 tick, uint96 mn, uint96 mx,,)
        = IKuruRouter(KURU_ROUTER).verifiedMarket(m);
        assertEq(pp, KURU_PRICE_PRECISION);
        assertEq(sp, KURU_SIZE_PRECISION);
        assertEq(base, address(tok));
        assertEq(bd, 6);
        assertEq(quote, address(usd));
        assertEq(qd, 6);
        assertEq(tick, KURU_TICK_SIZE);
        assertEq(mn, KURU_MIN_SIZE);
        assertEq(mx, KURU_MAX_SIZE);
        assertEq(IKuruOrderBook(m).marketState(), 0, "a fresh market is ACTIVE");
        assertTrue(fac.routerCanUse(address(s)));
        vm.expectRevert(abi.encodeWithSelector(IAgateFactory.MarketAlreadySet.selector, m));
        fac.createMarket(address(s));
    }

    /// A front-run with our parameters is the same market and is recorded (created = false); a market with other
    /// parameters for our token has another address and is ignored.
    function test_I24_frontRunIsRecorded() public {
        _fork();
        _world();
        IAgateSeries s2 = IAgateSeries(fac.list(H200, month));
        address t2 = s2.token();
        vm.startPrank(frontRunner);
        address other = IKuruRouter(KURU_ROUTER).deployProxy(
            KURU_TYPE_ERC20,
            t2,
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
        address ours = IKuruRouter(KURU_ROUTER).deployProxy(
            KURU_TYPE_ERC20,
            t2,
            address(usd),
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0,
            KURU_AMM_SPREAD
        );
        vm.stopPrank();
        assertTrue(other != ours);
        vm.expectEmit(address(fac));
        emit IAgateFactory.MarketRecorded(address(s2), ours, Venue.KURU_V1, false, user, address(0));
        vm.prank(user);
        assertEq(fac.createMarket(address(s2)), ours, "the front-run market is ours");
        (address rec,) = fac.marketOf(address(s2));
        assertEq(rec, ours);
    }

    // ------------------------------------------------------------------ every router flow on Kuru's code

    function test_routerFlows_holdNothing() public {
        _fork();
        _world();
        _market();
        _maker(5_000 * U);
        _ask(3_640_000, 1_000 * U);
        _ask(3_650_000, 1_000 * U);
        _bid(3_600_000, 1_000 * U);
        _bid(3_590_000, 1_000 * U);
        _user();
        address sa = address(s);
        Permit memory none;

        (bytes memory r,) = _flow("openLong", abi.encodeCall(IAgateRouter.openLong, (sa, 364 * U, 100 * U, none)));
        assertEq(abi.decode(r, (uint256)), 100 * U);

        (r,) = _flow(
            "openLongDaily, parts 2", abi.encodeCall(IAgateRouter.openLongDaily, (sa, 728 * U, 200 * U, 2, user, none))
        );
        uint256[] memory lids = abi.decode(r, (uint256[]));
        assertEq(lids.length, 2);
        assertEq(s.position(lids[0]).operator, address(router));

        (r,) =
            _flow("openShort, parts 2", abi.encodeCall(IAgateRouter.openShort, (sa, 200 * U, 1, 2, user, true, none)));
        (uint256[] memory sids, uint256 cost, uint256 out) = abi.decode(r, (uint256[], uint256, uint256));
        assertEq(cost, 200 * 7_200_000);
        assertEq(out, 200 * 3_600_000, "sold into the 3.60 bid, exact");
        assertEq(s.position(sids[1]).owner, user);

        (r,) = _flow("closeLong", abi.encodeCall(IAgateRouter.closeLong, (sa, 100 * U, 1, none)));
        assertEq(abi.decode(r, (uint256)), 100 * 3_600_000);

        (r,) = _flow("closeShort, two ids", abi.encodeCall(IAgateRouter.closeShort, (sa, sids, 729 * U, none)));
        (uint256 paid, uint256 surplus, uint256 refund) = abi.decode(r, (uint256, uint256, uint256));
        assertEq(paid, 200 * 7_200_000, "the full pair, nothing paid yet");
        assertEq(surplus, 0.2747 * 1e6, "one dollar of headroom at 3.64 buys 0.2747 more tokens");
        assertLe(refund, U);

        (r,) = _flow("closeLongDaily, two ids", abi.encodeCall(IAgateRouter.closeLongDaily, (sa, lids, 1, none)));
        (uint256 c2, uint256 o2, uint256 p2) = abi.decode(r, (uint256, uint256, uint256));
        assertEq(c2, 200 * 7_200_000);
        assertGt(o2, 0);
        assertEq(p2, 200 * 7_200_000 - 200 * 1_800_000, "the full pair minus the floor paid at once");
    }

    // ------------------------------------------------------------------ 6.5: Kuru's dust, exact depth, simulation

    /// The book of BUILD-SPEC 6.5 (asks 1,000 at 3.64 and 100 at 3.65, bids 1,000 at 3.60 and 100 at 3.59): a short of
    /// 1,100 tokens in two parts sells into both bids; closing it with the exact two-level cost plus $10 buys exactly
    /// 1,100 tokens and returns 9,999,540 u (Kuru's dust over two levels: 460 u).
    function test_exactDepthClose() public {
        _fork();
        _world();
        _market();
        _maker(2_000 * U);
        _ask(3_640_000, 1_000 * U);
        _ask(3_650_000, 100 * U);
        _bid(3_600_000, 1_000 * U);
        _bid(3_590_000, 100 * U);
        _user();
        Permit memory none;
        (bytes memory r,) = _flow(
            "openShort 1,100 tokens, parts 2",
            abi.encodeCall(IAgateRouter.openShort, (address(s), 1_100 * U, 1, 2, user, true, none))
        );
        (uint256[] memory ids,, uint256 out) = abi.decode(r, (uint256[], uint256, uint256));
        assertEq(out, 1_000 * 3_600_000 + 100 * 3_590_000, "both bids, exact");
        uint256 exact = 1_000 * 3_640_000 + 100 * 3_650_000;
        (r,) = _flow(
            "closeShort at exact depth + $10",
            abi.encodeCall(IAgateRouter.closeShort, (address(s), ids, exact + 10 * U, none))
        );
        (uint256 paid, uint256 surplus, uint256 refund) = abi.decode(r, (uint256, uint256, uint256));
        assertEq(paid, 1_100 * 7_200_000);
        assertEq(surplus, 0);
        assertEq(refund, 9_999_540, "Kuru's dust over two levels: 460 u");
        assertEq(s.position(ids[0]).owner, address(0));
        assertEq(s.position(ids[1]).owner, address(0));
    }

    /// The exact two-level cost buys one size unit less than the book (1,099.9999 tokens); the eth_call from
    /// address(0) returns exactly what the real fill gives; the Trade events decode as BUILD-SPEC 8.5 says.
    function test_dustSimulationAndTradeEvents() public {
        _fork();
        _world();
        _market();
        _maker(2_000 * U);
        _ask(3_640_000, 1_000 * U);
        _ask(3_650_000, 100 * U);
        _user();
        uint256 exact = 1_000 * 3_640_000 + 100 * 3_650_000;
        uint256 snap = vm.snapshotState();
        vm.prank(address(0));
        uint256 sim = mkt.placeAndExecuteMarketBuy(uint96(exact), 0, false, false);
        vm.revertToStateAndDelete(snap);
        assertEq(sim, 1_100 * U - LOT, "one size unit short: Kuru's per-level dust");
        Permit memory none;
        (bytes memory r, Vm.Log[] memory logs) = _flow(
            "openLong at the exact two-level cost", abi.encodeCall(IAgateRouter.openLong, (address(s), exact, 1, none))
        );
        assertEq(abi.decode(r, (uint256)), sim, "the address(0) simulation is the fill");
        uint256 trades;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(mkt) || logs[i].topics[0] != TRADE) continue;
            assertEq(logs[i].topics.length, 1, "Trade has no indexed field");
            (, address mk, bool isBuy, uint256 price,, address taker, address origin, uint96 filled) =
                abi.decode(logs[i].data, (uint40, address, bool, uint256, uint96, address, address, uint96));
            assertEq(mk, maker);
            assertTrue(isBuy, "the taker's side");
            assertEq(taker, address(router));
            assertEq(origin, user);
            assertTrue(price / 1e12 == 3_640_000 || price / 1e12 == 3_650_000, "price / 10^12 is u per token");
            assertGt(filled, 0);
            ++trades;
        }
        assertEq(trades, 2, "one Trade per maker order filled");
    }

    // ------------------------------------------------------------------ gas on Kuru's code (BUILD-SPEC 9.2)

    function test_gas_flowsOnKuru() public {
        _fork();
        _world();
        _limit(
            "createMarket (Kuru V1's deployProxy)",
            user,
            address(fac),
            abi.encodeCall(IAgateFactory.createMarket, (address(s)))
        );
        _market();
        _maker(5_000 * U);
        for (uint256 i; i < 3; ++i) {
            _ask(uint32(3_640_000 + i * 10_000), 1_000 * U);
            _bid(uint32(3_600_000 - i * 10_000), 1_000 * U);
        }
        _user();
        address sa = address(s);
        address r = address(router);
        Permit memory none;
        _limit(
            "openLong, one maker order crossed",
            user,
            r,
            abi.encodeCall(IAgateRouter.openLong, (sa, 364 * U, 100 * U, none))
        );
        _limit(
            "openLong, two maker orders crossed",
            user,
            r,
            abi.encodeCall(IAgateRouter.openLong, (sa, 3_640 * U + 1_825 * U + 1_000, 1_500 * U, none))
        );
        _limit(
            "openLongDaily, parts 8",
            user,
            r,
            abi.encodeCall(IAgateRouter.openLongDaily, (sa, 2_912 * U, 800 * U, 8, user, none))
        );
        _limit(
            "openShort, parts 8", user, r, abi.encodeCall(IAgateRouter.openShort, (sa, 800 * U, 1, 8, user, true, none))
        );
        vm.prank(user);
        s.mint(100 * U, user);
        _limit("closeLong", user, r, abi.encodeCall(IAgateRouter.closeLong, (sa, 100 * U, 1, none)));
        vm.startPrank(user);
        (uint256[] memory sids,,) = router.openShort(sa, 200 * U, 1, 2, user, true, none);
        uint256[] memory lids = router.openLongDaily(sa, 728 * U, 200 * U, 2, user, none);
        vm.stopPrank();
        uint256[] memory one = new uint256[](1);
        one[0] = sids[0];
        _limit("closeShort, one id", user, r, abi.encodeCall(IAgateRouter.closeShort, (sa, one, 365 * U, none)));
        _limit("closeShort, two ids", user, r, abi.encodeCall(IAgateRouter.closeShort, (sa, sids, 730 * U, none)));
        one[0] = lids[0];
        _limit("closeLongDaily, one id", user, r, abi.encodeCall(IAgateRouter.closeLongDaily, (sa, one, 1, none)));
        _limit("closeLongDaily, two ids", user, r, abi.encodeCall(IAgateRouter.closeLongDaily, (sa, lids, 1, none)));
    }

    struct Call {
        address caller;
        address target;
        bytes data;
        uint256 cd; // the calldata's gas
    }

    /// Execution gas used (before refunds) and the smallest gas at which the call succeeds, every storage slot cold;
    /// under --isolate every account but the target and the sender is cold too (forge 1.3.5's vm.cool cools storage
    /// only), and the transaction's 21,000 and calldata are taken out.
    function _limit(string memory name, address caller, address target, bytes memory data) internal {
        Call memory c = Call(caller, target, data, 0);
        for (uint256 i; i < data.length; ++i) {
            c.cd += data[i] == 0 ? 4 : 16;
        }
        (bool okI,) = address(usd).call(abi.encodeWithSignature("decimals()"));
        require(okI);
        bool iso = _lastGas() >= 21_000;
        uint256 used = _usedOf(name, c, iso);
        uint256 off = iso ? c.cd : 0;
        uint256 limit = _search(c, used + off) - off;
        console2.log(
            string.concat(
                "GAS | Kuru V1 fork | ",
                name,
                " | used ",
                vm.toString(used),
                " | LIMIT ",
                vm.toString(limit),
                " | tx ",
                vm.toString(limit + 21_000 + c.cd),
                iso ? "" : " (warm accounts)"
            )
        );
    }

    function _usedOf(string memory name, Call memory c, bool iso) internal returns (uint256 used) {
        uint256 snap = vm.snapshotState();
        _cool();
        vm.prank(c.caller, c.caller);
        (bool ok,) = c.target.call(c.data);
        require(ok, name);
        (bool okR, bytes memory gr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(okR && gr.length >= 160, "lastCallGas");
        (, uint64 u,, int64 refund,) = abi.decode(gr, (uint64, uint64, uint64, int64, uint64));
        vm.revertToStateAndDelete(snap);
        used = u;
        if (iso) used = used + uint256(int256(refund > 0 ? refund : int64(0))) - 21_000 - c.cd;
    }

    function _search(Call memory c, uint256 base) internal returns (uint256 hi) {
        uint256 lo = base - 2_000;
        hi = base + 300_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 sn = vm.snapshotState();
            _cool();
            vm.prank(c.caller, c.caller);
            (bool okM,) = c.target.call{gas: mid}(c.data);
            vm.revertToStateAndDelete(sn);
            if (okM) hi = mid;
            else lo = mid;
        }
    }

    function _cool() internal {
        vm.cool(address(s));
        vm.cool(address(tok));
        vm.cool(address(usd));
        vm.cool(address(router));
        vm.cool(address(fac));
        vm.cool(address(mkt));
        vm.cool(MARGIN);
        vm.cool(KURU_ROUTER);
    }

    function _lastGas() internal view returns (uint256) {
        (bool ok, bytes memory gr) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && gr.length >= 160, "lastCallGas"); // forge 1.3.5: five fields (forge-std 1.17 declares six)
        (, uint64 used,,,) = abi.decode(gr, (uint64, uint64, uint64, int64, uint64));
        return used;
    }
}
