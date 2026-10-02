// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IAgateToken} from "../../../src/market/interfaces/IAgateToken.sol";
import {LastResortLib} from "../../../src/market/lib/LastResortLib.sol";
import {U, LOT, Side, BandGrade, SeriesTerms, Position} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";

/// A plain 6-decimal dollar anyone can mint (tests only).
contract TestDollar is ERC20 {
    constructor() ERC20("test dollar", "tUSD") {}

    function decimals() public pure virtual override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Takes 1 u of every transfer: the series must refuse it (DollarInexact).
contract FeeDollar is TestDollar {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

contract Dollar18 is TestDollar {
    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// Calls back into a target on every transfer (once armed): the series' guard must refuse the reentry.
contract ReenterDollar is TestDollar {
    address public target;
    bytes public data;
    bool public lastOk;
    bytes public lastRet;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address t = target;
        if (t != address(0) && from != address(0)) {
            target = address(0);
            (lastOk, lastRet) = t.call(data);
            if (!lastOk) {
                bytes memory r = lastRet;
                assembly {
                    revert(add(r, 32), mload(r))
                }
            }
        }
    }
}

/// Sets k and S directly, for the fuzz of owed and settle against the exact rational (tests only).
contract SeriesKS is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function setKS(uint8 k_, uint64 s_) external {
        k = k_;
        S = s_;
    }
}

/// BUILD-SPEC 12.1 example 1 on the MockIndex: November 2026 (N = 30), F 1.80, C 7.20, x0 3.60, the index at
/// 3.60 on days 1 to 10 and 4.20 on days 11 to 30, records final T_PEND after each day ends.
abstract contract SeriesBase is Test {
    bytes32 internal constant GPU = keccak256("H100-SXM/on-demand-list/neocloud/v1");
    bytes32 internal constant RECIPE = keccak256("recipe");
    uint32 internal constant OCT1 = 20_727;
    uint32 internal constant NOV1 = 20_758;
    uint32 internal constant DEC1 = 20_788;
    uint32 internal constant JAN1 = 20_819;
    uint32 internal constant NOV = 24_322; // 2026 * 12 + 10
    uint32 internal constant REF = 3_600_000;
    uint32 internal constant STEP = 4_200_000;
    uint32 internal constant FLOOR = 1_800_000;
    uint32 internal constant CAP = 7_200_000;
    uint256 internal constant RESERVE = 131_587; // FIX_CALL_GAS * 64 / 63 + SYNC_ROUND_GAS
    uint256 internal constant MAXQ = type(uint64).max;

    MockIndex internal index;
    TestDollar internal dollar;
    AgateSeries internal s;
    IAgateToken internal tok;
    uint32 internal dayLen;
    uint64 internal tPend;
    uint256 internal tList;

    address internal router = makeAddr("router");
    address internal factory = makeAddr("factory");
    address internal a = makeAddr("a");
    address internal b = makeAddr("b");
    address internal c = makeAddr("c");
    address internal payer = makeAddr("payer");
    address internal stranger = makeAddr("stranger");

    uint256[] internal opened; // every id opened, for the invariant check

    function setUp() public virtual {
        _world(86_400, 0, 0, 21_600, REF);
    }

    /// The November world on any clock; preMonth is the index value of the 31 days before November.
    function _world(uint32 day, uint64 epochTs, uint32 epochDay, uint64 tPend_, uint32 preMonth) internal {
        dayLen = day;
        tPend = tPend_;
        index = new MockIndex(day, epochTs, epochDay);
        index.register(GPU, RECIPE);
        dollar = new TestDollar();
        for (uint32 d = OCT1 - 5; d < OCT1; ++d) {
            if (d >= epochDay) _post(d, REF);
        }
        for (uint32 d = OCT1; d < NOV1; ++d) {
            if (d >= epochDay) _post(d, preMonth);
        }
        for (uint32 d = NOV1; d < DEC1; ++d) {
            _post(d, d < NOV1 + 10 ? REF : STEP);
        }
        for (uint32 d = DEC1; d < JAN1; ++d) {
            _post(d, REF);
        }
        s = _deploy(address(dollar), FLOOR, CAP, REF);
        tok = IAgateToken(s.token());
        tList = index.dayStart(NOV1 - 1) + uint256(7) * day / 24;
        vm.warp(tList);
    }

    function _terms(address dollar_, uint32 f, uint32 cap, uint32 x0) internal view returns (SeriesTerms memory t) {
        t = SeriesTerms({
            index: address(index),
            dollar: dollar_,
            factory: factory,
            router: router,
            gpuId: GPU,
            recipeHash: RECIPE,
            month: NOV,
            startDay: NOV1,
            n: 30,
            startTs: index.dayStart(NOV1),
            day: dayLen,
            lastResort: uint64(_lastResort()),
            floor: f,
            cap: cap,
            x0: x0,
            bandGrade: BandGrade.RULE,
            anchorCarried: 0,
            anchorMinFresh: 5,
            anchorLate: false
        });
    }

    function _deploy(address dollar_, uint32 f, uint32 cap, uint32 x0) internal returns (AgateSeries) {
        return new AgateSeries(_terms(dollar_, f, cap, x0), "agate H100 Nov 2026", "H100-NOV26");
    }

    /// The December 2026 series (N = 31) on the same index, the index at 3.60 every day.
    function _deployDecember() internal returns (AgateSeries) {
        SeriesTerms memory t = _terms(address(dollar), FLOOR, CAP, REF);
        t.month = NOV + 1;
        t.startDay = DEC1;
        t.n = 31;
        t.startTs = uint64(index.dayStart(DEC1));
        return new AgateSeries(t, "agate H100 Dec 2026", "H100-DEC26");
    }

    // ------------------------------------------------------------------ the index

    function _post(uint32 d, uint32 v) internal {
        index.put(GPU, d, v, uint64(_dayEnd(d) + tPend), IAgateIndex.Status.FULL, 5, false, false);
    }

    function _dayEnd(uint32 d) internal view returns (uint256) {
        return index.dayStart(d + 1);
    }

    /// A time at which the record of month day kk (1-based) is final.
    function _afterDay(uint256 kk) internal view returns (uint256) {
        return _dayEnd(NOV1 + uint32(kk) - 1) + tPend + 1;
    }

    function _deadline(uint256 kk) internal view returns (uint256) {
        return _dayEnd(NOV1 + uint32(kk) - 1) + _lastResort();
    }

    function _lastResort() internal view returns (uint256) {
        return LastResortLib.lastResort(dayLen);
    }

    // ------------------------------------------------------------------ actors

    function _give(address who, uint256 amount) internal {
        dollar.mint(who, amount);
        vm.prank(who);
        dollar.approve(address(s), type(uint256).max);
    }

    function _mint(address who, uint256 q) internal returns (uint256 cost) {
        if (dollar.allowance(who, address(s)) == 0) {
            vm.prank(who);
            dollar.approve(address(s), type(uint256).max);
        }
        if (dollar.balanceOf(who) < q * CAP / U) dollar.mint(who, q * CAP / U);
        vm.prank(who);
        cost = s.mint(q, who);
    }

    function _stream(address who, Side side, uint256 q, address owner, address payee, bool daily)
        internal
        returns (uint256 id, uint256 paidNow)
    {
        vm.prank(who);
        (id, paidNow) = s.streamOut(side, q, owner, payee, who, daily);
        opened.push(id);
    }

    function _k() internal view returns (uint256 k) {
        (k,,,,,,,) = s.state();
    }

    function _S() internal view returns (uint256 sum) {
        (, sum,,,,,,) = s.state();
    }

    function _ledger() internal view returns (uint256 l) {
        (,,,,, l,,) = s.state();
    }

    function _lastX() internal view returns (uint256 x) {
        (,, x,,,,,) = s.state();
    }

    function _walked() internal view returns (bool w) {
        (,,, w,,,,) = s.state();
    }

    function _nextId() internal view returns (uint256 n) {
        (,,,,,, n,) = s.state();
    }

    function _shortSupply() internal view returns (uint256 x) {
        (,,,,,,, x) = s.state();
    }

    function _G(Side side, uint256 k, uint256 sum) internal pure returns (uint256) {
        return side == Side.LONG ? sum + (30 - k) * uint256(FLOOR) : k * uint256(CAP) - sum;
    }

    // ------------------------------------------------------------------ the model's check() (I1, I1b, I2 to I5)

    function _check() internal view {
        _checkSeries(s, opened);
    }

    function _checkSeries(AgateSeries x, uint256[] memory ids) internal view {
        SeriesTerms memory t = x.terms();
        (uint8 k8, uint64 sum64,,,, uint128 led,, uint256 shSup) = x.state();
        uint256 n = t.n;
        uint256 f = t.floor;
        uint256 cap = t.cap;
        uint256 k = k8;
        uint256 sum = sum64;
        uint256 led_ = led;
        uint256 tSup = IAgateToken(x.token()).totalSupply();
        uint256 tPos;
        uint256 sPos;
        uint256 paid;
        assertGe(IAgateToken(t.dollar).balanceOf(address(x)), led_, "I4 the ledger is not backed");
        for (uint256 e; e < 2; ++e) {
            uint256 E = sum + (n - k) * (e == 0 ? f : cap);
            uint256 claims = tSup * E + shSup * (n * cap - E);
            uint256 paidScaled;
            for (uint256 i; i < ids.length; ++i) {
                Position memory p = x.position(ids[i]);
                if (p.owner == address(0)) continue;
                claims += uint256(p.q) * (p.side == Side.LONG ? E : n * cap - E);
                paidScaled += uint256(p.paid) * n * U;
            }
            assertGe(led_ * n * U + paidScaled, claims, "I1 solvency");
        }
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = x.position(ids[i]);
            if (p.owner == address(0)) continue;
            if (p.side == Side.LONG) tPos += p.q;
            else sPos += p.q;
            paid += p.paid;
        }
        if (k < n) {
            assertEq(tSup + tPos, shSup + sPos, "I3 pair conservation");
            assertEq(led_ * U, (tSup + tPos) * cap - U * paid, "I2 ledger identity");
        }
        assertGe(sum, k * f, "I5 S >= kF");
        assertLe(sum - k * f, k * (cap - f), "I5 S - kF <= kK");
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = x.position(ids[i]);
            if (p.owner == address(0)) continue;
            uint256 g = p.side == Side.LONG ? sum + (n - k) * f : k * cap - sum;
            assertLe(uint256(p.paid) * n * U, uint256(p.q) * g, "I1b a position was paid more than it vested");
        }
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length >= 4) sel = bytes4(ret);
    }
}
