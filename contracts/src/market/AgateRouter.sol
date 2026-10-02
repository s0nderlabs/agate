// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAgateFactory} from "./interfaces/IAgateFactory.sol";
import {IAgateRouter} from "./interfaces/IAgateRouter.sol";
import {IAgateSeries} from "./interfaces/IAgateSeries.sol";
import {IKuruOrderBook} from "./interfaces/IKuruOrderBook.sol";
import {LOT, U, Side, Venue, Flow, Permit, Position} from "./MarketTypes.sol";

/// @title AgateRouter: one-click flows over a factory's series and their Kuru V1 markets (BUILD-SPEC 6)
/// @notice Convenience only: every flow is also a few plain transactions (BUILD-SPEC 6.4). Acts only for
/// msg.sender: pulls only from msg.sender, sends every output to msg.sender, opens positions owned by msg.sender
/// (and so becomes their operator) and closes only msg.sender's positions. Holds nothing after a call: its dollar,
/// token and short balances end where they started and every allowance it gave is back to 0, checked at the end
/// of every flow. No owner, no admin, no state but the factory and its dollar; deployed by the factory in its
/// constructor.
/// The flows, _close and _ownPositions are virtual only for the negative-control harnesses of BUILD-SPEC 11
/// (keep_surplus, any_owner); no external behaviour depends on it.
contract AgateRouter is IAgateRouter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable factory;
    /// The factory's dollar (immutable there too), so no flow asks the factory for it.
    IERC20 internal immutable DOLLAR;

    /// One flow's context: the series, its assets and market, and the router's balances at the start.
    struct Ctx {
        IAgateSeries series;
        IERC20 dollar;
        IERC20 token;
        address market;
        uint256 dollar0;
        uint256 token0;
        uint256 short0;
    }

    /// Stores the factory and its dollar, makes no call: the factory is still being constructed and passes its own
    /// dollar (BUILD-SPEC 3.5, v3.4).
    constructor(IAgateFactory factory_, address dollar_) {
        factory = address(factory_);
        DOLLAR = IERC20(dollar_);
    }

    // ------------------------------------------------------------------ flows (BUILD-SPEC 6.3)

    function openLong(address series, uint256 dollarsIn, uint256 minTokensOut, Permit calldata permit)
        external
        virtual
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (dollarsIn == 0 || minTokensOut == 0) revert BadLimits();
        Ctx memory c = _open(series);
        _permit(c.dollar, permit);
        uint256 held = _pull(c.dollar, dollarsIn);
        uint256 refund;
        (tokensOut, refund) = _buy(c, dollarsIn, minTokensOut, held);
        _send(c.token, tokensOut);
        _send(c.dollar, refund);
        _close(c);
        emit Routed(
            msg.sender, series, Flow.OPEN_LONG, tokensOut, dollarsIn, refund, refund, 0, tokensOut, new uint256[](0)
        );
    }

    function openLongDaily(
        address series,
        uint256 dollarsIn,
        uint256 minTokensOut,
        uint256 parts,
        address payee,
        Permit calldata permit
    ) external virtual nonReentrant returns (uint256[] memory ids) {
        if (parts == 0) revert BadParts();
        if (dollarsIn == 0 || minTokensOut == 0) revert BadLimits();
        Ctx memory c = _open(series);
        _payeeOk(c, payee);
        _permit(c.dollar, permit);
        uint256 held = _pull(c.dollar, dollarsIn);
        (uint256 got, uint256 refund) = _buy(c, dollarsIn, minTokensOut, held);
        uint256 per = got / parts / LOT * LOT;
        if (per == 0) revert BadParts();
        ids = new uint256[](parts);
        uint256 paidNow;
        for (uint256 i; i < parts; ++i) {
            // burns the router's own tokens; the floor goes to msg.sender at once
            (uint256 id, uint256 p) = c.series.streamOut(Side.LONG, per, msg.sender, payee, msg.sender, true);
            ids[i] = id;
            paidNow += p;
        }
        uint256 rest = got - per * parts;
        _send(c.token, rest);
        _send(c.dollar, refund);
        _close(c);
        emit Routed(msg.sender, series, Flow.OPEN_LONG_DAILY, got, dollarsIn, refund + paidNow, refund, 0, rest, ids);
    }

    function openShort(
        address series,
        uint256 tokens,
        uint256 minDollarsOut,
        uint256 parts,
        address payee,
        bool daily,
        Permit calldata permit
    ) external virtual nonReentrant returns (uint256[] memory ids, uint256 cost, uint256 dollarsOut) {
        if (tokens == 0 || parts == 0 || tokens % parts != 0 || (tokens / parts) % LOT != 0) revert BadParts();
        if (minDollarsOut == 0) revert BadLimits();
        Ctx memory c = _open(series);
        _payeeOk(c, payee);
        cost = c.series.mintCost(tokens);
        _permit(c.dollar, permit);
        _pull(c.dollar, cost);
        _mintPairs(c, tokens, cost); // the short units are credited to the router, the payer
        dollarsOut = _sell(c, tokens, minDollarsOut);
        ids = new uint256[](parts);
        uint256 per = tokens / parts;
        uint256 paidNow;
        for (uint256 i; i < parts; ++i) {
            // debits the router's own short balance; allowed only because the caller is the factory's router
            (uint256 id, uint256 p) = c.series.streamOut(Side.SHORT, per, msg.sender, payee, msg.sender, daily);
            ids[i] = id;
            paidNow += p;
        }
        _send(c.dollar, dollarsOut);
        _close(c);
        emit Routed(msg.sender, series, Flow.OPEN_SHORT, tokens, cost, dollarsOut + paidNow, 0, 0, 0, ids);
    }

    function closeLong(address series, uint256 tokens, uint256 minDollarsOut, Permit calldata permit)
        external
        virtual
        nonReentrant
        returns (uint256 dollarsOut)
    {
        if (tokens == 0 || tokens % LOT != 0) revert BadAmount();
        if (minDollarsOut == 0) revert BadLimits();
        Ctx memory c = _open(series);
        _permit(c.token, permit);
        _pull(c.token, tokens);
        dollarsOut = _sell(c, tokens, minDollarsOut);
        _send(c.dollar, dollarsOut);
        _close(c);
        emit Routed(msg.sender, series, Flow.CLOSE_LONG, tokens, 0, dollarsOut, 0, tokens, 0, new uint256[](0));
    }

    function closeShort(address series, uint256[] calldata ids, uint256 dollarsIn, Permit calldata permit)
        external
        virtual
        nonReentrant
        returns (uint256 paid, uint256 surplusTokens, uint256 refund)
    {
        if (dollarsIn == 0) revert BadLimits();
        Ctx memory c = _open(series);
        uint256 q = _ownPositions(c, ids, Side.SHORT);
        _permit(c.dollar, permit);
        uint256 held = _pull(c.dollar, dollarsIn);
        uint256 got;
        (got, refund) = _buy(c, dollarsIn, q, held); // not fill-or-kill: any headroom works at any depth
        for (uint256 i; i < ids.length; ++i) {
            // the router is the operator: burns q of its own tokens, the series pays the owner
            paid += c.series.closeWithToken(ids[i], msg.sender);
        }
        surplusTokens = got - q;
        _send(c.token, surplusTokens);
        _send(c.dollar, refund);
        _close(c);
        emit Routed(msg.sender, series, Flow.CLOSE_SHORT, got, dollarsIn, refund + paid, refund, 0, surplusTokens, ids);
    }

    function closeLongDaily(address series, uint256[] calldata ids, uint256 minDollarsOut, Permit calldata permit)
        external
        virtual
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
        for (uint256 i; i < ids.length; ++i) {
            // the router is the operator: debits q of its own short units, the series pays the owner
            paid += c.series.closeWithToken(ids[i], msg.sender);
        }
        _send(c.dollar, dollarsOut);
        _close(c);
        emit Routed(msg.sender, series, Flow.CLOSE_LONG_DAILY, q, cost, dollarsOut + paid, 0, 0, 0, ids);
    }

    /// 24 GPU-hours per GPU per day, in token base units: a full month for G GPUs is sizeFor(G, N).
    function sizeFor(uint256 gpus, uint256 days_) external pure returns (uint256 tokens) {
        tokens = 24 * gpus * days_ * U;
        if (tokens == 0) revert BadSize();
    }

    // ------------------------------------------------------------------ internals (BUILD-SPEC 6.2)

    /// Only a series of this factory, only its recorded KURU_V1 market; snapshots the router's balances.
    function _open(address series) internal view returns (Ctx memory c) {
        IAgateFactory f = IAgateFactory(factory);
        if (!f.isSeries(series)) revert NotSeries(series);
        (address market, Venue venue) = f.marketOf(series);
        if (venue == Venue.NONE) revert NoMarket(series);
        if (venue != Venue.KURU_V1) revert VenueUnsupported(series);
        c.series = IAgateSeries(series);
        c.dollar = DOLLAR;
        c.token = IERC20(c.series.token());
        c.market = market;
        c.dollar0 = c.dollar.balanceOf(address(this));
        c.token0 = c.token.balanceOf(address(this));
        c.short0 = c.series.shortOf(address(this));
    }

    /// Holds nothing: balances back at the snapshot (donations stay donations) and no allowance left.
    function _close(Ctx memory c) internal view virtual {
        if (
            c.dollar.balanceOf(address(this)) != c.dollar0 || c.token.balanceOf(address(this)) != c.token0
                || c.series.shortOf(address(this)) != c.short0 || c.dollar.allowance(address(this), c.market) != 0
                || c.token.allowance(address(this), c.market) != 0
                || c.dollar.allowance(address(this), address(c.series)) != 0
        ) revert RouterKeptSomething();
    }

    /// A payee that is a contract of this system would hold every claim for ever (finding M1).
    function _payeeOk(Ctx memory c, address payee) internal view {
        if (
            payee == address(0) || payee == address(this) || payee == address(c.series) || payee == address(c.token)
                || payee == c.market || payee == factory
        ) revert BadPayee(payee);
    }

    /// An optional EIP-2612 permit signed by msg.sender for this router. A failing permit is ignored (it may have
    /// been submitted first by someone else, which already set the allowance, or the asset has no permit); the
    /// pull then succeeds or fails on the allowance alone.
    function _permit(IERC20 asset, Permit calldata p) internal {
        if (p.deadline == 0) return;
        try IERC20Permit(address(asset)).permit(msg.sender, address(this), p.value, p.deadline, p.v, p.r, p.s) {}
            catch {}
    }

    /// Pulls exactly amt from msg.sender, measured by the router's balance change. Returns the balance after the
    /// pull (a buy right after it starts from there).
    function _pull(IERC20 asset, uint256 amt) internal returns (uint256 held) {
        uint256 b0 = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amt);
        held = asset.balanceOf(address(this));
        if (held - b0 != amt) revert PullInexact();
    }

    function _send(IERC20 asset, uint256 amt) internal {
        if (amt > 0) asset.safeTransfer(msg.sender, amt);
    }

    /// Mints q pairs to the router: the tokens to its wallet, the short units to its short balance.
    function _mintPairs(Ctx memory c, uint256 q, uint256 cost) internal {
        c.dollar.forceApprove(address(c.series), cost);
        c.series.mint(q, address(this));
        c.dollar.forceApprove(address(c.series), 0);
    }

    /// Kuru market buy, not fill-or-kill: spends at most quoteIn, Kuru returns the quote it could not use.
    /// Returns (tokens bought, dollars returned), both measured by balance change from the known starting balances:
    /// d0, the dollars _pull just measured, and c.token0, as no flow moves a token before its buy.
    function _buy(Ctx memory c, uint256 quoteIn, uint256 minOut, uint256 d0)
        internal
        returns (uint256 got, uint256 refund)
    {
        uint96 quoteSize = SafeCast.toUint96(quoteIn); // quoteSize is in u: pricePrecision = 10^6 = 10^decimals
        c.dollar.forceApprove(c.market, quoteIn);
        IKuruOrderBook(c.market).placeAndExecuteMarketBuy(quoteSize, minOut, false, false);
        c.dollar.forceApprove(c.market, 0);
        got = c.token.balanceOf(address(this)) - c.token0;
        refund = quoteIn - (d0 - c.dollar.balanceOf(address(this)));
        if (got < minOut) revert SlippageExceeded(got, minOut);
    }

    /// Kuru market sell of exactly q tokens (q / LOT size units), fill-or-kill. Returns the dollars received.
    function _sell(Ctx memory c, uint256 q, uint256 minOut) internal returns (uint256 out) {
        uint96 size = SafeCast.toUint96(q / LOT);
        uint256 d0 = c.dollar.balanceOf(address(this));
        c.token.forceApprove(c.market, q);
        IKuruOrderBook(c.market).placeAndExecuteMarketSell(size, minOut, false, true);
        c.token.forceApprove(c.market, 0);
        out = c.dollar.balanceOf(address(this)) - d0;
        if (out < minOut) revert SlippageExceeded(out, minOut);
    }

    /// Sums q over ids, each a position of msg.sender on `side` (I33: the router closes only the caller's).
    function _ownPositions(Ctx memory c, uint256[] calldata ids, Side side) internal view virtual returns (uint256 q) {
        if (ids.length == 0) revert BadAmount();
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = c.series.position(ids[i]);
            if (p.owner != msg.sender) revert NotYourPosition(ids[i]);
            if (p.side != side) revert WrongSide(ids[i]);
            q += p.q;
        }
    }
}
