// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgateIndex} from "../../../src/interfaces/IAgateIndex.sol";
import {AgateSeries} from "../../../src/market/AgateSeries.sol";
import {AgateRouter} from "../../../src/market/AgateRouter.sol";
import {IAgateFactory} from "../../../src/market/interfaces/IAgateFactory.sol";
import {IAgateSeries} from "../../../src/market/interfaces/IAgateSeries.sol";
import {IKuruRouter} from "../../../src/market/interfaces/IKuruRouter.sol";
import {
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
    Flow,
    Permit,
    Position,
    SeriesTerms
} from "../../../src/market/MarketTypes.sol";
import {MockIndex} from "../mocks/MockIndex.sol";

/// The series' view of a MockIndex, with one difference: finalFix fails at once (a cheap revert that returns the
/// unused gas) when it is given less than NEED. Inside the EVM an index call that only runs out of gas burns
/// everything it was forwarded and leaves its caller 1/64, too little to force a day afterwards; an index that fails
/// fast when starved is the case where a missing gas rule would force a day whose fix is final (I26, negative
/// control `no_gas_reserve`). NEED is just under FIX_CALL_GAS, so a correct series (which always forwards the full
/// FIX_CALL_GAS) never sees the difference. Every other view the series and the factory read is passed through.
contract StarveIndex {
    error Starved(uint256 gasLeft);

    uint256 public constant NEED = 99_000;
    MockIndex public immutable inner;

    constructor(MockIndex inner_) {
        inner = inner_;
    }

    function finalFix(bytes32 gpuId, uint32 day)
        external
        view
        returns (bool, uint32, IAgateIndex.Status, uint8, bool, bool)
    {
        uint256 left = gasleft();
        if (left < NEED) revert Starved(left);
        return inner.finalFix(gpuId, day);
    }

    function record(bytes32 gpuId, uint32 day) external view returns (bool, bool, IAgateIndex.Record memory) {
        return inner.record(gpuId, day);
    }

    function firstRecordDay(bytes32 gpuId) external view returns (bool, uint32) {
        return inner.firstRecordDay(gpuId);
    }

    function gpu(bytes32 gpuId) external view returns (IAgateIndex.GpuConfig memory) {
        return inner.gpu(gpuId);
    }

    function clocks() external view returns (IAgateIndex.Clocks memory) {
        return inner.clocks();
    }

    function dayId(uint64 t) external view returns (uint32) {
        return inner.dayId(t);
    }

    function dayStart(uint32 day) external view returns (uint64) {
        return inner.dayStart(day);
    }
}

/// The test factory of the negative controls (BUILD-SPEC 11): the IAgateFactory views the router reads (isSeries,
/// marketOf, dollar, router), a router deployed from the given creation code in the constructor (the real one or a
/// harness), series deployed from the given creation code with this factory and its router in their terms, and the
/// Kuru market created exactly as AgateFactory.createMarket does. Creation code is passed in, so this contract stays
/// small whatever harness it deploys.
contract NCFactory {
    address public immutable index;
    address public immutable dollar;
    address public immutable kuruRouter;
    address public immutable router;

    mapping(address => bool) public isSeries;
    mapping(address => address) internal marketAddr;

    constructor(address index_, address dollar_, address kuruRouter_, bytes memory routerCode) {
        index = index_;
        dollar = dollar_;
        kuruRouter = kuruRouter_;
        router = _create(abi.encodePacked(routerCode, abi.encode(address(this), dollar_)));
    }

    function list(bytes calldata seriesCode, SeriesTerms memory t, string calldata name, string calldata symbol)
        external
        returns (address series)
    {
        require(t.factory == address(this) && t.router == router && t.index == index && t.dollar == dollar, "terms");
        series = _create(abi.encodePacked(seriesCode, abi.encode(t, name, symbol)));
        isSeries[series] = true;
    }

    function createMarket(address series) external returns (address market) {
        require(isSeries[series] && marketAddr[series] == address(0), "market");
        market = IKuruRouter(kuruRouter).deployProxy(
            KURU_TYPE_ERC20,
            IAgateSeries(series).token(),
            dollar,
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            0,
            0,
            KURU_AMM_SPREAD
        );
        marketAddr[series] = market;
    }

    function marketOf(address series) external view returns (address, Venue) {
        address mk = marketAddr[series];
        return (mk, mk == address(0) ? Venue.NONE : Venue.KURU_V1);
    }

    function _create(bytes memory code) internal returns (address a) {
        assembly {
            a := create(0, add(code, 32), mload(code))
        }
        require(a != address(0), "create");
    }
}

// ---------------------------------------------------------------------------------------------- series harnesses
// One per negative control of BUILD-SPEC 11, each overriding one virtual step of 4.4 (two for floor_mint).

/// complement: the short leg as k K / N minus the long's rounded value (must break I1b).
contract SeriesComplement is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function _owedShort(uint256 q, uint256 k_, uint256 s_) internal view override returns (uint256) {
        uint256 vLong = (s_ - k_ * F) / N;
        uint256 vShort = k_ * K / N - vLong;
        return q * vShort / 1_000_000;
    }
}

/// floor_mint: mint cost rounded down and no lot rule in mint and redeem (must break I1).
contract SeriesFloorMint is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function _mintCost(uint256 q) internal view override returns (uint256) {
        return q * C / 1_000_000;
    }

    function _checkLot(uint256 q) internal pure override {
        if (q == 0) revert BadAmount();
    }
}

/// operator_self: an operator's close pays whoever it names (must break I30).
contract SeriesOperatorSelf is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function _closeRecipient(Position storage p, address to) internal view override returns (address) {
        if (msg.sender != p.owner && (p.operator == address(0) || msg.sender != p.operator)) {
            revert NotOwnerOrOperator();
        }
        _okTo(to);
        return to;
    }
}

/// unstream_short: unstream takes back one u too little (must break I1).
contract SeriesUnstreamShort is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function _unstreamBack(Position storage p) internal view override returns (uint256) {
        return p.paid > 0 ? p.paid - 1 : 0;
    }
}

/// no_gas_reserve: no gas rule, so a starved index call reads as "no fix" (must break I26).
contract SeriesNoGasReserve is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function _roundGasOk() internal pure override returns (bool) {
        return true;
    }
}

/// unchecked_top: an extra function that tops up a LONG position without a checkpoint (must break I1).
contract SeriesUncheckedTop is AgateSeries {
    constructor(SeriesTerms memory t, string memory n_, string memory s_) AgateSeries(t, n_, s_) {}

    function topUp(uint256 id, uint256 dq) external nonReentrant returns (uint256 paidNow) {
        Position storage p = positions[id];
        if (p.owner == address(0)) revert NoPosition(id);
        if (p.side != Side.LONG || dq == 0 || dq % LOT != 0) revert BadAmount();
        if (IERC20(TOKEN).balanceOf(msg.sender) < dq) revert TokenBalance();
        paidNow = _owed(Side.LONG, dq, k, S);
        p.q += uint64(dq);
        _burn(dq);
        _pay(msg.sender, paidNow);
    }
}

// ---------------------------------------------------------------------------------------------- router harnesses

/// keep_surplus: closeShort keeps the surplus tokens, and the end-of-flow check no longer looks at tokens
/// (must break I25).
contract RouterKeepSurplus is AgateRouter {
    constructor(IAgateFactory f, address d) AgateRouter(f, d) {}

    function closeShort(address series, uint256[] calldata ids, uint256 dollarsIn, Permit calldata permit)
        external
        override
        nonReentrant
        returns (uint256 paid, uint256 surplusTokens, uint256 refund)
    {
        if (dollarsIn == 0) revert BadLimits();
        Ctx memory c = _open(series);
        uint256 q = _ownPositions(c, ids, Side.SHORT);
        _permit(c.dollar, permit);
        uint256 held = _pull(c.dollar, dollarsIn);
        uint256 got;
        (got, refund) = _buy(c, dollarsIn, q, held);
        for (uint256 i; i < ids.length; ++i) {
            paid += c.series.closeWithToken(ids[i], msg.sender);
        }
        surplusTokens = got - q; // kept
        _send(c.dollar, refund);
        _close(c);
        emit Routed(msg.sender, series, Flow.CLOSE_SHORT, got, dollarsIn, refund + paid, refund, 0, 0, ids);
    }

    function _close(Ctx memory c) internal view override {
        if (
            c.dollar.balanceOf(address(this)) != c.dollar0 || c.series.shortOf(address(this)) != c.short0
                || c.dollar.allowance(address(this), c.market) != 0 || c.token.allowance(address(this), c.market) != 0
                || c.dollar.allowance(address(this), address(c.series)) != 0
        ) revert RouterKeptSomething();
    }
}

/// any_owner: closes any position it operates, whoever asks, paying the position's owner as the model's router does
/// (must break I33). With only the owner check of _ownPositions removed, the series itself refuses the close
/// (OperatorMustPayOwner: the router names its caller); RouterOwnerCheckOnly shows that.
contract RouterAnyOwner is AgateRouter {
    constructor(IAgateFactory f, address d) AgateRouter(f, d) {}

    function closeShort(address series, uint256[] calldata ids, uint256 dollarsIn, Permit calldata permit)
        external
        override
        nonReentrant
        returns (uint256 paid, uint256 surplusTokens, uint256 refund)
    {
        if (dollarsIn == 0) revert BadLimits();
        Ctx memory c = _open(series);
        uint256 q = _ownPositions(c, ids, Side.SHORT);
        _permit(c.dollar, permit);
        uint256 held = _pull(c.dollar, dollarsIn);
        uint256 got;
        (got, refund) = _buy(c, dollarsIn, q, held);
        uint256 toCaller;
        for (uint256 i; i < ids.length; ++i) {
            address owner = c.series.position(ids[i]).owner;
            uint256 p = c.series.closeWithToken(ids[i], owner);
            paid += p;
            if (owner == msg.sender) toCaller += p;
        }
        surplusTokens = got - q;
        _send(c.token, surplusTokens);
        _send(c.dollar, refund);
        _close(c);
        emit Routed(
            msg.sender, series, Flow.CLOSE_SHORT, got, dollarsIn, refund + toCaller, refund, 0, surplusTokens, ids
        );
    }

    function closeLongDaily(address series, uint256[] calldata ids, uint256 minDollarsOut, Permit calldata permit)
        external
        override
        nonReentrant
        returns (uint256 cost, uint256 dollarsOut, uint256 paid)
    {
        if (minDollarsOut == 0) revert BadLimits();
        Ctx memory c = _open(series);
        uint256 q = _ownPositions(c, ids, Side.LONG);
        cost = c.series.mintCost(q);
        _permit(c.dollar, permit);
        _pull(c.dollar, cost);
        _mintPairs(c, q, cost);
        dollarsOut = _sell(c, q, minDollarsOut);
        uint256 toCaller;
        for (uint256 i; i < ids.length; ++i) {
            address owner = c.series.position(ids[i]).owner;
            uint256 p = c.series.closeWithToken(ids[i], owner);
            paid += p;
            if (owner == msg.sender) toCaller += p;
        }
        _send(c.dollar, dollarsOut);
        _close(c);
        emit Routed(msg.sender, series, Flow.CLOSE_LONG_DAILY, q, cost, dollarsOut + toCaller, 0, 0, 0, ids);
    }

    function _ownPositions(Ctx memory c, uint256[] calldata ids, Side side)
        internal
        view
        override
        returns (uint256 q)
    {
        if (ids.length == 0) revert BadAmount();
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = c.series.position(ids[i]);
            if (p.side != side) revert WrongSide(ids[i]);
            q += p.q;
        }
    }
}

/// any_owner with nothing but the owner check removed: the router still names its caller as the recipient.
contract RouterOwnerCheckOnly is AgateRouter {
    constructor(IAgateFactory f, address d) AgateRouter(f, d) {}

    function _ownPositions(Ctx memory c, uint256[] calldata ids, Side side)
        internal
        view
        override
        returns (uint256 q)
    {
        if (ids.length == 0) revert BadAmount();
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = c.series.position(ids[i]);
            if (p.side != side) revert WrongSide(ids[i]);
            q += p.q;
        }
    }
}
