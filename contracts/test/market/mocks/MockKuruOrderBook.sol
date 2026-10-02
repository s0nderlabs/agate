// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IKuruOrderBook} from "../../../src/market/interfaces/IKuruOrderBook.sol";

/// @notice Integer stand-in for a Kuru V1 OrderBook market (BUILD-SPEC 6.3, 6.5, 7), ported from the reference
/// model's MockKuruMarket (docs/market/model/market_model.py) step for step:
/// - a market buy spends an exact quote and, at every price level, re-derives the quote left from the units left
///   (Kuru's _marketBuyMatch), so a remainder smaller than one unit's cost is lost at each level crossed; not
///   fill-or-kill, the quote it could not use (book exhausted) goes back to the taker's wallet;
/// - a market sell sells an exact number of size units, fill-or-kill reverts InsufficientLiquidity;
/// - the taker fee is taken from what the taker receives (tokens on a buy, quote on a sell) and stays here;
/// - makers are paid straight to their wallets (Kuru credits their margin account; nothing in the series or the
///   router depends on the difference); resting orders do not match on entry; no AMM vault; wallet path only;
/// - msg.sender == address(0) on a buy returns what the quote would buy, before any transfer and before the
///   fill-or-kill check (Kuru's simulation path, BUILD-SPEC 6.5);
/// - marketState() is ACTIVE (0) until its Kuru router's owner pauses it; a paused market reverts every order.
/// Deployed and initialized only by MockKuruRouter.deployProxy.
contract MockKuruOrderBook is IKuruOrderBook {
    using SafeERC20 for IERC20;

    error Unauthorized();
    error AlreadyInitialized();
    error MarketStateError();
    error PriceError();
    error TickSizeError();
    error SizeError();
    error ZeroSize();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error MarginUnsupported(); // mock: wallet path only, as the router always uses
    error NativeUnsupported();

    struct Order {
        uint40 id;
        address maker;
        uint96 units;
    }

    uint8 internal constant ACTIVE = 0;

    address public immutable kuruRouter;

    IERC20 public base;
    IERC20 public quote;
    uint96 public sizePrecision;
    uint32 public pricePrecision;
    uint32 public tickSize;
    uint96 public minSize;
    uint96 public maxSize;
    uint256 public takerFeeBps;
    uint256 public makerFeeBps;
    uint256 public baseDecimals;
    uint256 public quoteDecimals;
    uint256 public unit; // base units per size unit
    uint256 internal qmul; // 10 ** quoteDecimals
    bool internal initialized;

    uint8 public marketState;
    uint40 public nextOrderId = 1;

    uint32[] internal askPrices; // ascending
    uint32[] internal bidPrices; // descending
    mapping(uint32 => Order[]) internal askOrders;
    mapping(uint32 => uint256) internal askHead; // FIFO head per level
    mapping(uint32 => Order[]) internal bidOrders;
    mapping(uint32 => uint256) internal bidHead;

    constructor() {
        kuruRouter = msg.sender;
    }

    function initialize(
        address base_,
        address quote_,
        uint96 sizePrecision_,
        uint32 pricePrecision_,
        uint32 tickSize_,
        uint96 minSize_,
        uint96 maxSize_,
        uint256 takerFeeBps_,
        uint256 makerFeeBps_
    ) external {
        if (msg.sender != kuruRouter) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        base = IERC20(base_);
        quote = IERC20(quote_);
        sizePrecision = sizePrecision_;
        pricePrecision = pricePrecision_;
        tickSize = tickSize_;
        minSize = minSize_;
        maxSize = maxSize_;
        takerFeeBps = takerFeeBps_;
        makerFeeBps = makerFeeBps_;
        baseDecimals = IERC20Metadata(base_).decimals();
        quoteDecimals = IERC20Metadata(quote_).decimals();
        unit = 10 ** baseDecimals / sizePrecision_;
        qmul = 10 ** quoteDecimals;
    }

    /// Kuru's Router owner pauses and resumes markets (toggleMarkets); here through MockKuruRouter.setMarketState.
    function setMarketState(uint8 state) external {
        if (msg.sender != kuruRouter) revert Unauthorized();
        marketState = state;
    }

    // ------------------------------------------------------------------ resting orders (makers)

    function addSellOrder(uint32 price, uint96 size, bool) external {
        _checkOrder(price, size);
        base.safeTransferFrom(msg.sender, address(this), uint256(size) * unit);
        _add(true, price, size);
    }

    function addBuyOrder(uint32 price, uint96 size, bool) external {
        _checkOrder(price, size);
        quote.safeTransferFrom(
            msg.sender, address(this), _ceilDiv(uint256(price) * size, sizePrecision) * qmul / pricePrecision
        );
        _add(false, price, size);
    }

    // ------------------------------------------------------------------ market orders (takers)

    function placeAndExecuteMarketBuy(uint96 quoteSize, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256)
    {
        _checkTaker(quoteSize, isMargin);
        (uint256 units, uint256 rem) = _buyMath(quoteSize);
        uint256 tokens = units * unit;
        tokens -= _ceilDiv(tokens * takerFeeBps, 10_000);
        if (msg.sender == address(0)) return tokens; // Kuru's simulation path: no transfer, no fill-or-kill check
        if (rem != 0 && isFillOrKill) revert InsufficientLiquidity();
        if (tokens < minAmountOut) revert SlippageExceeded();
        quote.safeTransferFrom(msg.sender, address(this), uint256(quoteSize) * qmul / pricePrecision);

        rem = quoteSize;
        while (rem > 0 && askPrices.length > 0) {
            uint256 price = askPrices[0];
            uint256 fillable = rem * sizePrecision / price;
            uint256 got = _fillLevel(true, uint32(price), fillable);
            rem = price * (fillable - got) / sizePrecision;
        }
        if (rem > 0) quote.safeTransfer(msg.sender, rem * qmul / pricePrecision);
        if (tokens > 0) base.safeTransfer(msg.sender, tokens);
        return tokens;
    }

    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        payable
        returns (uint256)
    {
        _checkTaker(size, isMargin);
        (uint256 quotePp, uint256 left) = _sellMath(size);
        uint256 out = quotePp * qmul / pricePrecision;
        out -= _ceilDiv(out * takerFeeBps, 10_000);
        if (left != 0 && isFillOrKill) revert InsufficientLiquidity();
        if (out < minAmountOut) revert SlippageExceeded();
        base.safeTransferFrom(msg.sender, address(this), uint256(size) * unit);

        uint256 rem = size;
        while (rem > 0 && bidPrices.length > 0) {
            rem -= _fillLevel(false, bidPrices[0], rem);
        }
        if (rem > 0) base.safeTransfer(msg.sender, rem * unit);
        if (out > 0) quote.safeTransfer(msg.sender, out);
        return out;
    }

    // ------------------------------------------------------------------ views

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return (
            pricePrecision,
            sizePrecision,
            address(base),
            baseDecimals,
            address(quote),
            quoteDecimals,
            tickSize,
            minSize,
            maxSize,
            takerFeeBps,
            makerFeeBps
        );
    }

    /// Best bid and ask in Kuru's vault precision (as Trade.price: 10^18 per pricePrecision unit); 0 for an empty side.
    function bestBidAsk() external view returns (uint256 bid, uint256 ask) {
        if (bidPrices.length > 0) bid = _vault(bidPrices[0]);
        if (askPrices.length > 0) ask = _vault(askPrices[0]);
    }

    /// What a market buy of quotePp would return now (tokens after the taker fee) and the quote left unused.
    function simulateBuy(uint256 quotePp) public view returns (uint256 tokens, uint256 rem) {
        uint256 units;
        (units, rem) = _buyMath(quotePp);
        tokens = units * unit;
        tokens -= _ceilDiv(tokens * takerFeeBps, 10_000);
    }

    /// What a market sell of `size` units would pay now (after the taker fee) and the units left unsold.
    function simulateSell(uint256 size) external view returns (uint256 out, uint256 left) {
        uint256 quotePp;
        (quotePp, left) = _sellMath(size);
        out = quotePp * qmul / pricePrecision;
        out -= _ceilDiv(out * takerFeeBps, 10_000);
    }

    /// The app's exact-out quote (BUILD-SPEC 6.5, model quote_for): the smallest quote up to Kuru's uint96 whose
    /// simulated buy returns at least `tokens`; ok = false when the book cannot fill it.
    function quoteFor(uint256 tokens) external view returns (bool ok, uint256 quoteIn) {
        uint256 lo = 1;
        uint256 hi = type(uint96).max;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            (uint256 t,) = simulateBuy(mid);
            if (t >= tokens) hi = mid;
            else lo = mid + 1;
        }
        (uint256 got,) = simulateBuy(lo);
        return (got >= tokens, lo);
    }

    /// Resting units at one price on one side.
    function depthAt(bool ask, uint32 price) public view returns (uint256 units) {
        Order[] storage os = ask ? askOrders[price] : bidOrders[price];
        for (uint256 i = ask ? askHead[price] : bidHead[price]; i < os.length; ++i) {
            units += os[i].units;
        }
    }

    function levels(bool ask) external view returns (uint32[] memory) {
        return ask ? askPrices : bidPrices;
    }

    // ------------------------------------------------------------------ internals

    function _checkTaker(uint256 amount, bool isMargin) internal view {
        if (msg.value != 0) revert NativeUnsupported();
        if (marketState != ACTIVE) revert MarketStateError();
        if (isMargin) revert MarginUnsupported();
        if (amount == 0) revert ZeroSize();
    }

    function _checkOrder(uint32 price, uint96 size) internal view {
        if (marketState != ACTIVE) revert MarketStateError();
        if (price == 0 || price == type(uint32).max) revert PriceError();
        if (price % tickSize != 0) revert TickSizeError();
        if (size < minSize || size > maxSize) revert SizeError();
    }

    /// Kuru's _marketBuyMatch on the current book, without touching it: (units bought, quote left).
    function _buyMath(uint256 quotePp) internal view returns (uint256 units, uint256 rem) {
        rem = quotePp;
        for (uint256 i; i < askPrices.length && rem > 0; ++i) {
            uint256 price = askPrices[i];
            uint256 fillable = rem * sizePrecision / price;
            uint256 avail = depthAt(true, uint32(price));
            uint256 got = fillable < avail ? fillable : avail;
            units += got;
            rem = price * (fillable - got) / sizePrecision;
        }
    }

    function _sellMath(uint256 units) internal view returns (uint256 quotePp, uint256 left) {
        left = units;
        for (uint256 i; i < bidPrices.length && left > 0; ++i) {
            uint256 price = bidPrices[i];
            uint256 avail = depthAt(false, uint32(price));
            uint256 got = left < avail ? left : avail;
            quotePp += got * price / sizePrecision;
            left -= got;
        }
    }

    /// FIFO at the best level of one side, up to `want` units; pays the makers; drops the level once empty.
    function _fillLevel(bool ask, uint32 price, uint256 want) internal returns (uint256 filled) {
        Order[] storage os = ask ? askOrders[price] : bidOrders[price];
        uint256 h = ask ? askHead[price] : bidHead[price];
        while (h < os.length && filled < want) {
            Order storage o = os[h];
            uint256 take = o.units < want - filled ? o.units : want - filled;
            o.units -= uint96(take);
            filled += take;
            if (ask) quote.safeTransfer(o.maker, uint256(price) * take / sizePrecision * qmul / pricePrecision);
            else base.safeTransfer(o.maker, take * unit);
            emit Trade(o.id, o.maker, ask, _vault(price), o.units, msg.sender, tx.origin, uint96(take));
            if (o.units == 0) ++h;
        }
        if (ask) askHead[price] = h;
        else bidHead[price] = h;
        if (h == os.length) _popFront(ask ? askPrices : bidPrices);
    }

    function _add(bool ask, uint32 price, uint96 size) internal {
        uint40 id = nextOrderId++;
        uint32[] storage ps = ask ? askPrices : bidPrices;
        Order[] storage os = ask ? askOrders[price] : bidOrders[price];
        uint256 h = ask ? askHead[price] : bidHead[price];
        if (h == os.length) {
            // a new (or emptied) level: insert its price in order
            uint256 i = ps.length;
            ps.push(price);
            while (i > 0 && (ask ? ps[i - 1] > price : ps[i - 1] < price)) {
                ps[i] = ps[i - 1];
                --i;
            }
            ps[i] = price;
        }
        os.push(Order(id, msg.sender, size));
    }

    function _popFront(uint32[] storage ps) internal {
        for (uint256 i = 1; i < ps.length; ++i) {
            ps[i - 1] = ps[i];
        }
        ps.pop();
    }

    function _vault(uint256 price) internal view returns (uint256) {
        return price * 1e18 / pricePrecision;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
