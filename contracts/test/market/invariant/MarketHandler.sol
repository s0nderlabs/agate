// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateDollar} from "../../../src/market/AgateDollar.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateRouter} from "../../../src/market/interfaces/IAgateRouter.sol";
import {
    U,
    LOT,
    FLAG_LATE,
    FLAG_INCOMPLETE,
    FLAG_FORCED,
    FLAG_BELOW_FLOOR,
    FLAG_ABOVE_CAP,
    FLAG_CARRIED,
    Side,
    CloseKind,
    Permit,
    Position,
    SeriesTerms
} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";
import {MockKuruOrderBook} from "../mocks/MockKuruOrderBook.sol";
import {SeriesUncheckedTop} from "./Harness.sol";

/// The invariant handler of BUILD-SPEC 12.2 D over one series, its router and its MockKuruOrderBook: five actors
/// call every series function and every router flow with random (sometimes invalid) arguments, a maker re-quotes the
/// book, tokens and dollars move and are donated, time jumps (up to 70 days, past the last resort) and syncs run at
/// random gas limits. Each run picks one of the listed series (one band each) and writes a random November into the
/// index: 15 percent of days outside the band, late and carried records, and in some runs an index that stops or
/// reverts. Nothing here asserts: every ghost rule records its first violation as a string, read by the invariant
/// suites (which require "") and by the negative controls (which require the named one to fire).
contract MarketHandler is Test {
    struct Cand {
        address series;
        address market;
        bytes32 gpu;
    }

    struct Hist {
        address owner;
        uint8 side;
        uint64 q;
        bool closed;
    }

    // violation slots
    uint256 internal constant V4 = 4;
    uint256 internal constant V5 = 5;
    uint256 internal constant V12 = 12;
    uint256 internal constant V25 = 25;
    uint256 internal constant V26 = 26;
    uint256 internal constant V29 = 29;
    uint256 internal constant V30 = 30;
    uint256 internal constant V31 = 31;
    uint256 internal constant V33 = 33;
    uint256 internal constant V36 = 36;
    uint256 internal constant V37 = 37;

    bytes32 internal constant TRANSFER = keccak256("Transfer(address,address,uint256)");
    uint32 internal constant NOV1 = 20_758;
    uint256 internal constant T_PEND = 21_600;
    uint32 internal constant TICK = 10_000;

    // ------------------------------------------------------------------ the world (fixed for the campaign)
    MockIndex public immutable mix;
    AgateDollar public immutable dollar;
    address public immutable router;
    address public immutable factory;
    address public immutable mm;
    bool public immutable hasTopUp;
    address[5] internal actors;
    Cand[] internal cands;

    // ------------------------------------------------------------------ the run (set on its first call)
    bool public inited;
    IAgateSeries public s;
    IERC20 public tok;
    MockKuruOrderBook public m;
    bytes32 public gpu;
    uint256 public n;
    uint256 public f;
    uint256 public cap;
    uint256 internal startDay;
    uint256 internal startTs;
    uint256 internal dayLen;
    uint256 internal lastResort;
    uint256 internal x0;

    // ------------------------------------------------------------------ ghosts
    uint256 public gIn; // dollars the series took (every non-donation transfer to it)
    uint256 public gOut; // dollars it paid
    uint256 public donSeriesD;
    uint256 public donSeriesT;
    uint256 public donRouterD;
    uint256 public donRouterT;
    uint256[] internal ids;
    mapping(uint256 => Hist) internal hist;
    mapping(uint256 => uint256) internal remMax; // I30: an id's largest remaining value, set before a close
    uint256 public maxId;
    uint256 public gK;
    uint256 public gS;
    uint256 internal gLastX;
    bool internal gWalked;
    bool internal gReal;
    uint256 internal lastGL;
    uint256 internal lastGS;
    uint256 public settles;
    uint256 public opened;
    mapping(uint256 => string) internal viol;
    mapping(uint256 => uint256) public okCount; // successful calls per action, for coverage

    constructor(
        MockIndex mix_,
        AgateDollar dollar_,
        address router_,
        address factory_,
        address mm_,
        address[5] memory actors_,
        Cand[] memory cands_,
        bool hasTopUp_
    ) {
        mix = mix_;
        dollar = dollar_;
        router = router_;
        factory = factory_;
        mm = mm_;
        actors = actors_;
        hasTopUp = hasTopUp_;
        for (uint256 i; i < cands_.length; ++i) {
            cands.push(cands_[i]);
        }
    }

    // ================================================================== the run's world

    /// On the first call of a run: one of the series, and a random November for its GPU.
    function _ready(uint256 seed) internal returns (bool) {
        if (inited) return true;
        inited = true;
        uint256 r = uint256(keccak256(abi.encode(seed, "world")));
        Cand memory c = cands[r % cands.length];
        s = IAgateSeries(c.series);
        tok = IERC20(s.token());
        m = MockKuruOrderBook(c.market);
        gpu = c.gpu;
        SeriesTerms memory t = s.terms();
        (n, f, cap, startDay, startTs, dayLen, lastResort, x0) =
            (t.n, t.floor, t.cap, t.startDay, t.startTs, t.day, t.lastResort, t.x0);
        _november(r);
        gLastX = x0;
        lastGL = n * f;
        (,,,,, uint128 led,,) = s.state();
        gIn = led; // the maker's mints at listing
        donSeriesD = dollar.balanceOf(address(s)) - led;
        donRouterD = dollar.balanceOf(router);
        donRouterT = tok.balanceOf(router);
        return true;
    }

    function _november(uint256 r) internal {
        uint256 haltAt = type(uint256).max;
        if (_u(r, 1) % 100 < 10) haltAt = _u(r, 2) % n; // the index stops: no record from that day on
        if (_u(r, 3) % 100 < 5) mix.setRevertFrom(gpu, uint32(startDay + _u(r, 4) % n)); // the index reverts
        for (uint256 i; i < n && i < haltAt; ++i) {
            uint256 h = _u(r, 100 + i);
            uint256 v;
            if (h % 1000 < 75 && f > 100_000) {
                v = 100_000 + h / 1000 % ((f - 100_000) / TICK + 1) * TICK; // below the floor, down to P_MIN
            } else if (h % 1000 < 150) {
                v = cap + h / 1000 % (2 * cap / TICK + 1) * TICK; // above the cap, up to 3 C
            } else {
                v = f + h / 1000 % ((cap - f) / TICK + 1) * TICK;
            }
            uint32 d = uint32(startDay + i);
            uint256 finalAt = startTs + (i + 1) * dayLen + T_PEND;
            if (h / 7 % 100 < 10) finalAt += (1 + h / 11 % 3) * 1 days; // a late index
            uint256 kind = h / 13 % 100;
            IAgateIndex.Status st = kind < 85
                ? IAgateIndex.Status.FULL
                : (kind < 90 ? IAgateIndex.Status.DEGRADED : IAgateIndex.Status.CARRIED);
            mix.put(gpu, d, uint32(v), uint64(finalAt), st, 5, h / 17 % 10 == 0, h / 19 % 20 == 0);
        }
    }

    function _u(uint256 r, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(r, i)));
    }

    // ================================================================== actions: the series

    function mint(uint256 a, uint256 qs, uint256 ts) external {
        if (!_ready(a)) return;
        address who = actors[a % 5];
        if (_callS(who, abi.encodeCall(IAgateSeries.mint, (_lot(qs), _to(ts, who))))) ++okCount[1];
        _after();
    }

    function redeem(uint256 a, uint256 qs, uint256 ts) external {
        if (!_ready(a)) return;
        address who = actors[a % 5];
        uint256 have = _min(tok.balanceOf(who), s.shortOf(who)) / LOT;
        if (have == 0) return;
        uint256 q = (1 + qs % have) * LOT;
        if (_callS(who, abi.encodeCall(IAgateSeries.redeem, (q, _to(ts, who))))) ++okCount[2];
        _after();
    }

    function streamOut(uint256 a, uint256 sideS, uint256 qs, uint256 os, uint256 ps, uint256 ds) external {
        if (!_ready(a)) return;
        address who = actors[a % 5];
        Side side = sideS % 2 == 0 ? Side.LONG : Side.SHORT;
        uint256 have = (side == Side.LONG ? tok.balanceOf(who) : s.shortOf(who)) / LOT;
        if (have == 0) return;
        uint256 q = (1 + qs % have) * LOT;
        address owner = os % 3 == 2 ? actors[os / 3 % 5] : who;
        if (os % 50 == 7) owner = address(tok);
        if (os % 50 == 8) owner = os % 100 < 50 ? router : factory; // never an owner (v3.2, audit L1)
        address payee = ps % 2 == 0 ? owner : _who(ps / 2);
        bytes memory data = abi.encodeCall(IAgateSeries.streamOut, (side, q, owner, payee, who, ds % 2 == 0));
        if (_callS(who, data)) {
            ++okCount[3];
            _honest();
        }
        _after();
    }

    function claim(uint256 c, uint256 ix) external {
        if (!_ready(c)) return;
        uint256 id = _anyId(ix);
        if (id == 0) return;
        uint256 want;
        bool open = s.position(id).owner != address(0);
        if (open) want = s.claimable(id);
        vm.recordLogs();
        vm.prank(actors[c % 5]);
        (bool ok, bytes memory ret) = address(s).call(abi.encodeCall(IAgateSeries.claim, (id)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) {
            _digest(logs, actors[c % 5], address(0), false);
            ++okCount[4];
            if (abi.decode(ret, (uint256)) != want) _flag(V36, "I36 a claim paid other than claimable showed");
            _honest();
        } else {
            _unexpected(ret);
        }
        _after();
    }

    function claimMany(uint256 c, uint256 ix) external {
        if (!_ready(c)) return;
        uint256 len = ids.length;
        uint256[] memory batch = new uint256[](len == 0 ? 1 : 1 + ix % 3 + 1);
        for (uint256 i; i + 1 < batch.length; ++i) {
            batch[i] = ids[_u(ix, i) % len];
        }
        batch[batch.length - 1] = 1e9; // an id without a position is skipped
        if (_callS(actors[c % 5], abi.encodeCall(IAgateSeries.claimMany, (batch)))) {
            ++okCount[5];
            _honest();
        }
        _after();
    }

    function setPayout(uint256 ix, uint256 ps, bool daily) external {
        if (!_ready(ix)) return;
        uint256 id = _openId(ix);
        if (id == 0) return;
        address owner = s.position(id).owner;
        if (_callS(owner, abi.encodeCall(IAgateSeries.setPayout, (id, _who(ps), daily)))) ++okCount[6];
        _after();
    }

    function setOperator(uint256 ix, uint256 os) external {
        if (!_ready(ix)) return;
        uint256 id = _openId(ix);
        if (id == 0) return;
        address owner = s.position(id).owner;
        address op = os % 4 == 0 ? address(0) : (os % 4 == 1 ? router : actors[os / 4 % 5]);
        if (_callS(owner, abi.encodeCall(IAgateSeries.setOperator, (id, op)))) ++okCount[7];
        _after();
    }

    /// The owner, or the operator; an operator names the owner (or, 3 times in 10, itself: must revert).
    function closeWithToken(uint256 ix, uint256 ws, uint256 ts) external {
        if (!_ready(ix)) return;
        uint256 id = _openId(ix);
        if (id == 0) return;
        Position memory p = s.position(id);
        address who = p.operator != address(0) && ws % 2 == 0 ? p.operator : p.owner;
        if (who == router) who = p.owner;
        address to = who == p.owner ? (ts % 2 == 0 ? p.owner : actors[ts / 2 % 5]) : (ts % 10 < 7 ? p.owner : who);
        _prepareOpposite(who, p.side, p.q);
        remMax[id] = _remainingMax(s.position(id)); // taken right before the call, cleared right after
        if (_callS(who, abi.encodeCall(IAgateSeries.closeWithToken, (id, to)))) ++okCount[8];
        delete remMax[id];
        _after();
    }

    function unstream(uint256 ix, uint256 ts) external {
        if (!_ready(ix)) return;
        uint256 id = _openId(ix);
        if (id == 0) return;
        Position memory p = s.position(id);
        address to = ts % 3 == 0 ? actors[ts / 3 % 5] : p.owner;
        if (_callS(p.owner, abi.encodeCall(IAgateSeries.unstream, (id, to)))) ++okCount[9];
        _after();
    }

    function settle(uint256 a, uint256 sideS, uint256 qs, uint256 ts) external {
        if (!_ready(a)) return;
        address who = actors[a % 5];
        Side side = sideS % 2 == 0 ? Side.LONG : Side.SHORT;
        uint256 have = side == Side.LONG ? tok.balanceOf(who) : s.shortOf(who);
        if (have == 0) return;
        if (_callS(who, abi.encodeCall(IAgateSeries.settle, (side, 1 + qs % have, _to(ts, who))))) {
            ++okCount[10];
            _honest();
        }
        _after();
    }

    function sync(uint256 ms) external {
        if (!_ready(ms)) return;
        uint256[3] memory limits = [uint256(1), 3, type(uint256).max];
        uint256 maxDays = limits[ms % 3];
        if (_callS(actors[ms / 3 % 5], abi.encodeCall(IAgateSeries.sync, (maxDays)))) {
            ++okCount[11];
            if (maxDays == type(uint256).max) _honest();
        }
        _after();
    }

    /// sync at a random gas limit: a success applies every ended day whose fix is final, never forces one (I26).
    function syncAtGas(uint256 gs) external {
        if (!_ready(gs)) return;
        uint256 g = 21_000 + gs % 380_000;
        address who = actors[gs / 7 % 5];
        vm.recordLogs();
        vm.prank(who);
        (bool ok,) = address(s).call{gas: g}(abi.encodeCall(IAgateSeries.sync, (type(uint256).max)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) {
            _digest(logs, who, address(0), false);
            ++okCount[12];
            _honest();
        }
        _after();
    }

    function warp(uint256 ws) external {
        if (!_ready(ws)) return;
        uint256[11] memory steps =
            [uint256(1 hours), 1 hours, 6 hours, 6 hours, 1 days, 1 days, 1 days, 3 days, 3 days, 9 days, 70 days];
        vm.warp(block.timestamp + steps[ws % 11]);
        ++okCount[13];
    }

    function transferTokens(uint256 a, uint256 b, uint256 qs) external {
        if (!_ready(a)) return;
        address from = actors[a % 5];
        uint256 bal = tok.balanceOf(from);
        if (bal == 0) return;
        vm.prank(from);
        tok.transfer(actors[b % 5], 1 + qs % bal);
        ++okCount[14];
    }

    /// Dollars or tokens sent to the series or the router: they change no payout and block nothing (I13, I25).
    function donate(uint256 a, uint256 what, uint256 amt) external {
        if (!_ready(a)) return;
        address who = actors[a % 5];
        address target = what % 2 == 0 ? address(s) : router;
        IERC20 asset = what / 2 % 2 == 0 ? IERC20(address(dollar)) : tok;
        uint256 v = 1 + amt % 1_000;
        if (asset.balanceOf(who) < v) return;
        vm.recordLogs();
        vm.prank(who);
        asset.transfer(target, v);
        _digest(vm.getRecordedLogs(), who, address(0), true);
        ++okCount[15];
        _after();
    }

    /// Negative control `unchecked_top` only: a top-up without a checkpoint. A no-op on every other series.
    function topUp(uint256 ix, uint256 qs) external {
        if (!_ready(ix) || !hasTopUp) return;
        uint256 id = _openId(ix);
        if (id == 0) return;
        Position memory p = s.position(id);
        if (p.side != Side.LONG) return;
        uint256 dq = (1 + qs % 4) * LOT;
        _prepareOpposite(p.owner, Side.SHORT, dq); // the owner needs dq tokens
        if (_callS(p.owner, abi.encodeCall(SeriesUncheckedTop.topUp, (id, dq)))) ++okCount[16];
        _after();
    }

    // ================================================================== actions: the router (and the maker)

    function openLong(uint256 a, uint256 qs, uint256 ms) external {
        if (!_ready(a)) return;
        uint256 qin = (1 + qs % 20_000) * 1_000;
        (uint256 got,) = m.simulateBuy(qin);
        uint256 minOut = got > LOT && ms % 3 == 0 ? got - LOT : got;
        if (minOut == 0) minOut = 1;
        if (_callR(actors[a % 5], abi.encodeCall(IAgateRouter.openLong, (address(s), qin, minOut, _none())))) {
            ++okCount[17];
        }
        _after();
    }

    function openLongDaily(uint256 a, uint256 qs, uint256 ps, uint256 py) external {
        if (!_ready(a)) return;
        address u = actors[a % 5];
        uint256 qin = (1 + qs % 20_000) * 1_000;
        (uint256 got,) = m.simulateBuy(qin);
        address payee = py % 2 == 0 ? u : _who(py / 2);
        bytes memory data = abi.encodeCall(
            IAgateRouter.openLongDaily, (address(s), qin, got == 0 ? 1 : got, 1 + ps % 4, payee, _none())
        );
        if (_callR(u, data)) {
            ++okCount[18];
            _honest();
        }
        _after();
    }

    function openShort(uint256 a, uint256 qs, uint256 ps, uint256 py, uint256 ds) external {
        if (!_ready(a)) return;
        address u = actors[a % 5];
        uint256 parts = 1 + ps % 4;
        uint256 q = parts * (1 + qs % 2_000) * LOT;
        address payee = py % 2 == 0 ? u : _who(py / 2);
        bytes memory data =
            abi.encodeCall(IAgateRouter.openShort, (address(s), q, 1, parts, payee, ds % 2 == 0, _none()));
        if (_callR(u, data)) {
            ++okCount[19];
            _honest();
        }
        _after();
    }

    function closeLong(uint256 a, uint256 qs) external {
        if (!_ready(a)) return;
        address u = actors[a % 5];
        uint256 have = tok.balanceOf(u) / LOT;
        if (have == 0) return;
        uint256 q = (1 + qs % have) * LOT;
        if (_callR(u, abi.encodeCall(IAgateRouter.closeLong, (address(s), q, 1, _none())))) ++okCount[20];
        _after();
    }

    /// Up to three SHORT positions the router operates: the caller's own 7 times in 10, anyone's otherwise (must
    /// revert NotYourPosition). The app's quote (quoteFor) plus a random headroom.
    function closeShort(uint256 a, uint256 pick, uint256 hs) external {
        if (!_ready(a)) return;
        address u = actors[a % 5];
        (uint256[] memory sel, uint256 q) = _pickRouted(u, Side.SHORT, pick);
        if (sel.length == 0) return;
        (bool fillable, uint256 quote) = m.quoteFor(q);
        if (!fillable) return;
        uint256[4] memory heads = [uint256(0), 365, 10 * U, 100 * U];
        bytes memory data = abi.encodeCall(IAgateRouter.closeShort, (address(s), sel, quote + heads[hs % 4], _none()));
        _setRemMax(sel);
        if (_callR(u, data)) ++okCount[21];
        _clearRemMax(sel);
        _after();
    }

    function closeLongDaily(uint256 a, uint256 pick) external {
        if (!_ready(a)) return;
        address u = actors[a % 5];
        (uint256[] memory sel,) = _pickRouted(u, Side.LONG, pick);
        if (sel.length == 0) return;
        _setRemMax(sel);
        if (_callR(u, abi.encodeCall(IAgateRouter.closeLongDaily, (address(s), sel, 1, _none())))) ++okCount[22];
        _clearRemMax(sel);
        _after();
    }

    /// I30 for the router's closes: each id's bound taken right before the flow (the router syncs nothing, and a
    /// close reads no fix), cleared right after, so no close is checked against a stale or missing bound.
    function _setRemMax(uint256[] memory sel) internal {
        for (uint256 i; i < sel.length; ++i) {
            remMax[sel[i]] = _remainingMax(s.position(sel[i]));
        }
    }

    function _clearRemMax(uint256[] memory sel) internal {
        for (uint256 i; i < sel.length; ++i) {
            delete remMax[sel[i]];
        }
    }

    /// The maker adds an ask and a bid around a random mid inside the band, minting pairs when it needs tokens.
    function requote(uint256 r) external {
        if (!_ready(r)) return;
        uint256 mid = f + (r % ((cap - f) / TICK + 1)) * TICK;
        uint256 askUnits = (1 + r / 7 % 4_000) * (U / LOT);
        uint256 bidUnits = (1 + r / 11 % 4_000) * (U / LOT);
        uint256 askPx = mid + (1 + r / 13 % 4) * TICK;
        uint256 bidPx = mid - (1 + r / 17 % 4) * TICK;
        vm.recordLogs();
        if (tok.balanceOf(mm) < askUnits * LOT) {
            vm.prank(mm);
            s.mint(askUnits * LOT, mm);
        }
        vm.prank(mm);
        m.addSellOrder(uint32(askPx), uint96(askUnits), false);
        if (bidPx >= TICK) {
            vm.prank(mm);
            m.addBuyOrder(uint32(bidPx), uint96(bidUnits), false);
        }
        _digest(vm.getRecordedLogs(), mm, address(0), false);
        ++okCount[23];
        _after();
    }

    /// The negative controls' driver: one action chosen and parameterized from one seed (the same actions the
    /// invariant engine calls one by one).
    function step(uint256 seed) external {
        uint256 a = _u(seed, 1);
        uint256 b = _u(seed, 2);
        uint256 c = _u(seed, 3);
        uint256 d = _u(seed, 4);
        uint256 e = _u(seed, 5);
        uint256 g = _u(seed, 6);
        uint256 op = seed % 30;
        if (op < 3) this.mint(a, b, c);
        else if (op < 4) this.redeem(a, b, c);
        else if (op < 7) this.streamOut(a, b, c, d, e, g);
        else if (op < 8) this.claim(a, b);
        else if (op < 9) this.claimMany(a, b);
        else if (op < 10) this.setPayout(a, b, c % 2 == 0);
        else if (op < 11) this.setOperator(a, b);
        else if (op < 13) this.closeWithToken(a, b, c);
        else if (op < 14) this.unstream(a, b);
        else if (op < 15) this.settle(a, b, c, d);
        else if (op < 16) this.sync(a);
        else if (op < 17) this.syncAtGas(a);
        else if (op < 19) this.warp(a);
        else if (op < 20) this.transferTokens(a, b, c);
        else if (op < 21) this.donate(a, b, c);
        else if (op < 22) this.topUp(a, b);
        else if (op < 23) this.openLong(a, b, c);
        else if (op < 24) this.openLongDaily(a, b, c, d);
        else if (op < 25) this.openShort(a, b, c, d, e);
        else if (op < 26) this.closeLong(a, b);
        else if (op < 28) this.closeShort(a, b, c);
        else if (op < 29) this.closeLongDaily(a, b);
        else this.requote(a);
    }

    // ================================================================== calls and their logs

    function _callS(address who, bytes memory data) internal returns (bool ok) {
        vm.recordLogs();
        vm.prank(who);
        bytes memory ret;
        (ok, ret) = address(s).call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs(); // Foundry records the logs of a call that reverted too
        if (ok) _digest(logs, who, address(0), false);
        else _unexpected(ret);
    }

    /// A router flow by u: the router is the series' caller. I37 and I33 are checked on the flow's logs.
    function _callR(address u, bytes memory data) internal returns (bool ok) {
        uint256 d0 = dollar.balanceOf(u);
        uint256 t0 = tok.balanceOf(u);
        vm.recordLogs();
        vm.prank(u);
        bytes memory ret;
        (ok, ret) = router.call(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) {
            _digest(logs, router, u, false);
            _routedTruth(logs, u, d0, t0);
        } else {
            bytes4 sel = _sel(ret);
            if (sel == IAgateRouter.RouterKeptSomething.selector || sel == IAgateRouter.PullInexact.selector) {
                _flag(V25, "I25 a router flow reverted RouterKeptSomething or PullInexact");
            }
            _unexpected(ret);
        }
    }

    /// A panic or an empty revert from a call with ample gas is a bug (a payout beyond the ledger is a panic).
    function _unexpected(bytes memory ret) internal {
        if (ret.length == 0) {
            _flag(V4, "I4 a call reverted without a reason");
        } else if (_sel(ret) == bytes4(0x4e487b71)) {
            _flag(V4, "I4 a call panicked (arithmetic: a payout beyond the ledger)");
        }
    }

    /// Reads one call's logs. caller: the account that called the series (an actor, the maker, or the router);
    /// flowUser: the router flow's msg.sender (zero outside router flows); donation: a plain transfer to the series
    /// or the router.
    function _digest(Vm.Log[] memory logs, address caller, address flowUser, bool donation) internal {
        address sa = address(s);
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            bytes32 t0 = l.topics.length > 0 ? l.topics[0] : bytes32(0);
            if (l.emitter == address(dollar) && t0 == TRANSFER) {
                address from = address(uint160(uint256(l.topics[1])));
                address to = address(uint160(uint256(l.topics[2])));
                uint256 v = abi.decode(l.data, (uint256));
                if (to == sa) {
                    if (donation) donSeriesD += v;
                    else gIn += v;
                }
                if (from == sa) gOut += v;
                if ((to == sa || from == sa) && v == 0) _flag(V4, "I4 a zero amount was transferred");
                if (to == router && donation) donRouterD += v;
            } else if (l.emitter == address(tok) && t0 == TRANSFER) {
                address from = address(uint160(uint256(l.topics[1])));
                address to = address(uint160(uint256(l.topics[2])));
                uint256 v = abi.decode(l.data, (uint256));
                if (to == address(0) && from != caller) _flag(V12, "I12 a burn was not from the series' caller");
                if (donation && to == sa) donSeriesT += v;
                if (donation && to == router) donRouterT += v;
            } else if (l.emitter == sa) {
                _seriesLog(l, caller, flowUser);
            }
        }
    }

    function _seriesLog(Vm.Log memory l, address caller, address flowUser) internal {
        bytes32 t0 = l.topics[0];
        if (t0 == IAgateSeries.ShortCredited.selector || t0 == IAgateSeries.ShortDebited.selector) {
            if (address(uint160(uint256(l.topics[1]))) != caller) {
                _flag(V29, "I29 a short was credited or debited to an account other than the series' caller");
            }
        } else if (t0 == IAgateSeries.PositionOpened.selector) {
            uint256 id = uint256(l.topics[1]);
            address owner = address(uint160(uint256(l.topics[2])));
            (uint8 side, uint256 q,, address operator,,,) =
                abi.decode(l.data, (uint8, uint256, uint256, address, bool, uint8, address));
            if (id <= maxId) _flag(V31, "I31 a position id did not increase");
            maxId = id;
            hist[id] = Hist(owner, side, uint64(q), false);
            ids.push(id);
            ++opened;
            if (side == uint8(Side.SHORT) && owner != caller && (caller != router || owner != flowUser)) {
                _flag(V29, "I29 a SHORT position was opened for another owner other than by the router for its caller");
            }
            if (caller == router && (owner != flowUser || operator != router)) {
                _flag(V33, "I33 the router opened a position not owned by its caller or not operated by itself");
            }
            if (operator != (owner == caller ? address(0) : caller)) {
                _flag(V30, "I30 a position's operator is not its creator");
            }
        } else if (t0 == IAgateSeries.PositionClosed.selector) {
            uint256 id = uint256(l.topics[1]);
            address owner = address(uint160(uint256(l.topics[2])));
            (uint8 kind, uint256 amount, address to, address by) =
                abi.decode(l.data, (uint8, uint256, address, address));
            Hist storage h = hist[id];
            if (h.owner == address(0) || h.closed) _flag(V31, "I31 a position was closed twice or never opened");
            h.closed = true;
            if (owner != h.owner) _flag(V31, "I31 a position's owner changed");
            if (kind == uint8(CloseKind.WITH_TOKEN) && by != owner) {
                if (to != owner) _flag(V30, "I30 an operator close paid someone other than the owner");
                if (amount < remMax[id]) _flag(V30, "I30 an operator close paid less than the position's value");
            }
            if (by == router && owner != flowUser) _flag(V33, "I33 the router closed a position of another account");
        } else if (t0 == IAgateSeries.FixApplied.selector) {
            (uint32 x, uint32 c, uint8 st, uint8 fl, uint64 sumAfter) =
                abi.decode(l.data, (uint32, uint32, uint8, uint8, uint64));
            _fixApplied(uint256(l.topics[1]), uint256(l.topics[2]), x, c, st, fl, sumAfter);
        } else if (t0 == IAgateSeries.Settled.selector) {
            ++settles;
        }
    }

    /// I5 (one day per step, clamped, equal to the index when not forced) and I26 (forced only past the last resort,
    /// never while the index has a final fix, at lastX or the one walk's value).
    function _fixApplied(uint256 k, uint256 day, uint256 x, uint256 c, uint8 st, uint8 fl, uint256 sumAfter) internal {
        if (k != gK + 1 || day != startDay + k - 1) _flag(V5, "I5 k did not rise by exactly one day");
        uint256 cl = x < f ? f : (x > cap ? cap : x);
        if (c != cl || sumAfter != gS + c) _flag(V5, "I5 a day was not clamped to [F, C] or S moved by other than c");
        if (((fl & FLAG_BELOW_FLOOR) != 0) != (x < f) || ((fl & FLAG_ABOVE_CAP) != 0) != (x > cap)) {
            _flag(V5, "I5 a band flag is wrong");
        }
        (bool ok, uint32 v, uint8 ist, bool late, bool inc) = _innerFix(day);
        if (fl & FLAG_FORCED != 0) {
            if (block.timestamp < startTs + k * dayLen + lastResort) {
                _flag(V26, "I26 a day was forced before its last resort");
            }
            if (ok) _flag(V26, "I26 a day was forced although its fix was final");
            uint256 want = gReal || gWalked ? gLastX : _walkValue();
            if (x != want) _flag(V26, "I26 a forced day is not lastX (or the one walk's value)");
            if (!gReal) gWalked = true;
        } else {
            if (!ok || v != x || ist != st) _flag(V5, "I5 an applied day differs from the index's final value");
            if (((fl & FLAG_LATE) != 0) != late || ((fl & FLAG_INCOMPLETE) != 0) != inc) _flag(V5, "I5 a flag differs");
            if (((fl & FLAG_CARRIED) != 0) != (ist == uint8(IAgateIndex.Status.CARRIED))) _flag(V5, "I5 carried flag");
            gReal = true;
        }
        gLastX = x;
        gK = k;
        gS = sumAfter;
    }

    function _innerFix(uint256 day) internal view returns (bool ok, uint32 v, uint8 st, bool late, bool inc) {
        try mix.finalFix(gpu, uint32(day)) returns (
            bool ok_, uint32 v_, IAgateIndex.Status st_, uint8, bool l_, bool i_
        ) {
            return (ok_, v_, uint8(st_), l_, i_);
        } catch {}
    }

    function _walkValue() internal view returns (uint256) {
        for (uint256 j = 1; j <= 31 && j <= startDay; ++j) {
            (bool ok, uint32 v,,,) = _innerFix(startDay - j);
            if (ok) return v;
        }
        return x0;
    }

    /// I36: after a successful call that synced with no day limit, nothing more can be applied now.
    function _honest() internal {
        (uint8 pk, uint64 ps) = s.previewSync();
        (uint8 k, uint64 sum,,,,,,) = s.state();
        if (pk != k || ps != sum) _flag(V36, "I36 a successful sync left an applicable day behind");
    }

    /// I37: the caller's balances moved exactly as its Routed event says.
    function _routedTruth(Vm.Log[] memory logs, address u, uint256 d0, uint256 t0) internal {
        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory l = logs[i - 1];
            if (l.emitter != router || l.topics[0] != IAgateRouter.Routed.selector) continue;
            (, uint256 dIn, uint256 dOut,, uint256 tIn, uint256 tOut,) =
                abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256[]));
            if (
                int256(dollar.balanceOf(u)) - int256(d0) != int256(dOut) - int256(dIn)
                    || int256(tok.balanceOf(u)) - int256(t0) != int256(tOut) - int256(tIn)
                    || address(uint160(uint256(l.topics[1]))) != u
            ) _flag(V37, "I37 a Routed event differs from the caller's balance change");
            return;
        }
        _flag(V37, "I37 a router flow emitted no Routed event");
    }

    /// I5 after every action: the state is what the FixApplied events say, and neither G falls.
    function _after() internal {
        (uint8 k, uint64 sum,,,,,,) = s.state();
        if (k != gK || sum != gS) _flag(V5, "I5 k or S moved without a FixApplied");
        uint256 gl = uint256(sum) + (n - k) * f;
        uint256 gsh = k * cap - sum;
        if (gl < lastGL || gsh < lastGS) _flag(V5, "I5 G_LONG or G_SHORT fell");
        lastGL = gl;
        lastGS = gsh;
    }

    // ================================================================== helpers

    function _flag(uint256 slot, string memory what) internal {
        if (bytes(viol[slot]).length == 0) viol[slot] = what;
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length >= 4) sel = bytes4(ret);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _none() internal pure returns (Permit memory p) {}

    /// 8 percent off the lot grid (must revert), else 1 to 49 lots of four sizes, as the model's fuzz.
    function _lot(uint256 r) internal pure returns (uint256) {
        if (r % 100 < 8) return 1 + r / 100 % (10 * LOT - 1);
        uint256[4] memory unit = [uint256(LOT), 10_000, U, 37 * LOT];
        return (1 + r / 100 % 49) * unit[r / 10_000 % 4];
    }

    /// A recipient: mostly the actor or another one, rarely zero, the series, the token, the router or the factory
    /// (must revert; v3.2, audit L1: tokens or dollars sent to the router or the factory could never leave).
    function _to(uint256 r, address who) internal view returns (address) {
        uint256 x = r % 100;
        if (x < 2) return address(0);
        if (x < 3) return address(s);
        if (x < 4) return address(tok);
        if (x < 5) return router;
        if (x < 6) return factory;
        return x < 60 ? who : actors[r / 100 % 5];
    }

    /// A payee: an actor, rarely one of the system's contracts or zero (must revert).
    function _who(uint256 r) internal view returns (address) {
        uint256 x = r % 100;
        if (x < 2) return address(0);
        if (x < 3) return address(s);
        if (x < 4) return address(tok);
        if (x < 5) return router;
        if (x < 6) return factory;
        return actors[r / 100 % 5];
    }

    function _anyId(uint256 r) internal view returns (uint256) {
        return ids.length == 0 ? 0 : ids[r % ids.length];
    }

    /// An open id, trying a few from a random start.
    function _openId(uint256 r) internal view returns (uint256) {
        uint256 len = ids.length;
        for (uint256 i; i < len && i < 8; ++i) {
            uint256 id = ids[(r % len + i) % len];
            if (!hist[id].closed) return id;
        }
        return 0;
    }

    /// Up to three open positions on `side` that the router operates: u's own 7 times in 10, else anyone's.
    function _pickRouted(address u, Side side, uint256 r) internal view returns (uint256[] memory sel, uint256 q) {
        bool any = r % 10 >= 7;
        uint256[] memory live = new uint256[](ids.length);
        uint256 cnt;
        for (uint256 i; i < ids.length; ++i) {
            Hist storage h = hist[ids[i]];
            if (h.closed || h.side != uint8(side) || (!any && h.owner != u)) continue;
            if (s.position(ids[i]).operator != router) continue;
            live[cnt++] = ids[i];
        }
        if (cnt == 0) return (sel, 0);
        uint256 take = 1 + r / 10 % (cnt < 3 ? cnt : 3);
        uint256 start = r / 100 % cnt;
        sel = new uint256[](take);
        for (uint256 i; i < take; ++i) {
            sel[i] = live[(start + i) % cnt];
            q += hist[sel[i]].q;
        }
    }

    /// Gives `who` q of the side opposite to `side` (q tokens for a SHORT position, q short units for a LONG one) by
    /// minting pairs, if it lacks them.
    function _prepareOpposite(address who, Side side, uint256 q) internal {
        uint256 have = side == Side.SHORT ? tok.balanceOf(who) : s.shortOf(who);
        if (have >= q || who == router) return;
        _callS(who, abi.encodeCall(IAgateSeries.mint, (q, who)));
    }

    /// The model's remaining_max: what the position can still be worth at the most favourable future.
    function _remainingMax(Position memory p) internal view returns (uint256) {
        (uint8 k, uint64 sum,,,,,,) = s.state();
        uint256 e = uint256(sum) + (n - k) * (p.side == Side.LONG ? cap : f);
        uint256 num = p.side == Side.LONG ? e : n * cap - e;
        uint256 v = uint256(p.q) * num / (n * U);
        return v > p.paid ? v - p.paid : 0;
    }

    // ================================================================== checks (an empty string: none violated)

    function check(string memory inv) public view returns (string memory) {
        bytes32 h = keccak256(bytes(inv));
        if (h == keccak256("I1")) return checkI1();
        if (h == keccak256("I1b")) return checkI1b();
        if (h == keccak256("I2")) return checkI2();
        if (h == keccak256("I3")) return checkI3();
        if (h == keccak256("I4")) return checkI4();
        if (h == keccak256("I5")) return checkI5();
        if (h == keccak256("I12")) return viol[V12];
        if (h == keccak256("I25")) return checkI25();
        if (h == keccak256("I26")) return viol[V26];
        if (h == keccak256("I29")) return checkI29();
        if (h == keccak256("I30")) return viol[V30];
        if (h == keccak256("I31")) return checkI31();
        if (h == keccak256("I33")) return viol[V33];
        if (h == keccak256("I36")) return viol[V36];
        if (h == keccak256("I37")) return viol[V37];
        revert("unknown invariant");
    }

    function violated(string calldata inv) external view returns (bool) {
        return bytes(check(inv)).length != 0;
    }

    function ghost(uint256 slot) external view returns (string memory) {
        return viol[slot];
    }

    struct St {
        uint256 k;
        uint256 sum;
        uint256 led;
        uint256 sh;
        uint256 tSup;
    }

    function _st() internal view returns (St memory x) {
        (uint8 k, uint64 sum,,,, uint128 led,, uint256 sh) = s.state();
        x = St(k, sum, led, sh, tok.totalSupply());
    }

    /// I1: for both extreme futures, the ledger covers every claim, exact integers.
    function checkI1() public view returns (string memory) {
        if (!inited) return "";
        St memory x = _st();
        for (uint256 e; e < 2; ++e) {
            uint256 ext = x.sum + (n - x.k) * (e == 0 ? f : cap);
            uint256 claims = x.tSup * ext + x.sh * (n * cap - ext);
            uint256 paidScaled;
            for (uint256 i; i < ids.length; ++i) {
                Position memory p = s.position(ids[i]);
                if (p.owner == address(0)) continue;
                claims += uint256(p.q) * (p.side == Side.LONG ? ext : n * cap - ext);
                paidScaled += uint256(p.paid) * n * U;
            }
            if (x.led * n * U + paidScaled < claims) return "I1 solvency: the ledger does not cover every claim";
        }
        return "";
    }

    /// I1b: no open position has been paid more than it has vested now.
    function checkI1b() public view returns (string memory) {
        if (!inited) return "";
        St memory x = _st();
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = s.position(ids[i]);
            if (p.owner == address(0)) continue;
            uint256 g = p.side == Side.LONG ? x.sum + (n - x.k) * f : x.k * cap - x.sum;
            if (uint256(p.paid) * n * U > uint256(p.q) * g) return "I1b a position was paid more than it has vested";
        }
        return "";
    }

    function _posSums() internal view returns (uint256 tPos, uint256 sPos, uint256 paid) {
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = s.position(ids[i]);
            if (p.owner == address(0)) continue;
            if (p.side == Side.LONG) tPos += p.q;
            else sPos += p.q;
            paid += p.paid;
        }
    }

    /// I2 (k < N): ledger * U == (T + Tpos) * C - U * paid.
    function checkI2() public view returns (string memory) {
        if (!inited) return "";
        St memory x = _st();
        if (x.k >= n) return "";
        (uint256 tPos,, uint256 paid) = _posSums();
        if (x.led * U != (x.tSup + tPos) * cap - U * paid) return "I2 ledger identity";
        return "";
    }

    /// I3 (k < N): T + Tpos == Sh + Shpos.
    function checkI3() public view returns (string memory) {
        if (!inited) return "";
        St memory x = _st();
        if (x.k >= n) return "";
        (uint256 tPos, uint256 sPos,) = _posSums();
        if (x.tSup + tPos != x.sh + sPos) return "I3 pair conservation";
        return "";
    }

    /// I4: dollars in minus out equals the ledger; the balance is the ledger plus donations; no zero transfer, no
    /// panic.
    function checkI4() public view returns (string memory) {
        if (bytes(viol[V4]).length != 0) return viol[V4];
        if (!inited) return "";
        St memory x = _st();
        if (gOut > gIn || gIn - gOut != x.led) return "I4 dollars in minus dollars out differs from the ledger";
        if (dollar.balanceOf(address(s)) != x.led + donSeriesD) {
            return "I4 the balance is not the ledger plus donations";
        }
        return "";
    }

    /// I5: 0 <= S - kF <= kK, plus the FixApplied and G ghosts.
    function checkI5() public view returns (string memory) {
        if (bytes(viol[V5]).length != 0) return viol[V5];
        if (!inited) return "";
        St memory x = _st();
        if (x.sum < x.k * f || x.sum - x.k * f > x.k * (cap - f)) return "I5 S outside [kF, kC]";
        return "";
    }

    /// I25: the router holds what it was given (donations only), no short, and no allowance to the market or the
    /// series.
    function checkI25() public view returns (string memory) {
        if (bytes(viol[V25]).length != 0) return viol[V25];
        if (!inited) return "";
        if (dollar.balanceOf(router) != donRouterD || tok.balanceOf(router) != donRouterT) {
            return "I25 the router holds dollars or tokens beyond donations";
        }
        if (s.shortOf(router) != 0) return "I25 the router holds a short";
        if (
            dollar.allowance(router, address(m)) != 0 || tok.allowance(router, address(m)) != 0
                || dollar.allowance(router, address(s)) != 0 || tok.allowance(router, address(s)) != 0
        ) return "I25 the router left an allowance";
        return "";
    }

    /// I29: the short ghosts, and shortSupply is the sum of every holder's balance.
    function checkI29() public view returns (string memory) {
        if (bytes(viol[V29]).length != 0) return viol[V29];
        if (!inited) return "";
        uint256 sum = s.shortOf(mm) + s.shortOf(router);
        for (uint256 i; i < 5; ++i) {
            sum += s.shortOf(actors[i]);
        }
        if (sum != _st().sh) return "I29 shortSupply is not the sum of the holders' short balances";
        return "";
    }

    /// I31: ids increase and close once (ghost); an open position keeps its owner, side and q; a closed one stays
    /// closed.
    function checkI31() public view returns (string memory) {
        if (bytes(viol[V31]).length != 0) return viol[V31];
        if (!inited) return "";
        for (uint256 i; i < ids.length; ++i) {
            Hist storage h = hist[ids[i]];
            Position memory p = s.position(ids[i]);
            if (h.closed) {
                if (p.owner != address(0)) return "I31 a closed position came back";
            } else if (p.owner != h.owner || uint8(p.side) != h.side || p.q != h.q) {
                return "I31 a position's owner, side or q changed";
            }
        }
        return "";
    }

    // ================================================================== I9: everyone exits (afterInvariant)

    struct Exit {
        uint256 claims;
        uint256 dust;
        uint256 paths;
        uint256 stuck;
    }

    /// Far past the month and its last resort, every open position is claimed and every holder settles its tokens
    /// and shorts; nothing may revert. The market's resting tokens go back to the maker first (Kuru's cancel). Then
    /// the ledger, beyond the exact value of tokens stuck where nobody can settle them (the series and the router,
    /// by donation), is at most one u per payout path (settles plus positions ever opened).
    function exitAll() external returns (string memory why, Exit memory e) {
        if (!inited) return ("", e);
        uint256 end = startTs + n * dayLen + lastResort + 1;
        if (block.timestamp < end) vm.warp(end);
        vm.recordLogs();
        s.sync(type(uint256).max);
        _digest(vm.getRecordedLogs(), address(this), address(0), false);
        if (_st().k != n) return ("I26 not final after every day's last resort", e);
        for (uint256 i; i < ids.length; ++i) {
            if (s.position(ids[i]).owner == address(0)) continue;
            vm.recordLogs();
            s.claim(ids[i]);
            _digest(vm.getRecordedLogs(), address(this), address(0), false);
            ++e.claims;
        }
        uint256 parked = tok.balanceOf(address(m));
        if (parked > 0) {
            vm.prank(address(m));
            tok.transfer(mm, parked);
        }
        address[6] memory holders = [actors[0], actors[1], actors[2], actors[3], actors[4], mm];
        for (uint256 i; i < 6; ++i) {
            address who = holders[i];
            _exitSettle(who, Side.LONG, tok.balanceOf(who));
            _exitSettle(who, Side.SHORT, s.shortOf(who));
        }
        St memory x = _st();
        e.stuck = tok.balanceOf(address(s)) + tok.balanceOf(router);
        if (x.tSup != e.stuck) return ("I10 tokens left that nobody settled", e);
        if (x.sh != 0) return ("I10 short units left", e);
        if (gOut > gIn) return ("I9 dollars out exceed dollars in", e);
        if (x.led * n * U < e.stuck * x.sum) return ("I9 the ledger is below the stuck tokens' value", e);
        e.dust = (x.led * n * U - e.stuck * x.sum) / (n * U);
        e.paths = settles + opened;
        if (e.dust > e.paths) return ("I9 dust above one u per payout path", e);
        if (bytes(checkI1()).length != 0 || bytes(checkI4()).length != 0) return ("I1 or I4 after everyone left", e);
        return ("", e);
    }

    function _exitSettle(address who, Side side, uint256 q) internal {
        if (q == 0) return;
        vm.recordLogs();
        vm.prank(who);
        s.settle(side, q, who);
        _digest(vm.getRecordedLogs(), who, address(0), false);
    }
}
