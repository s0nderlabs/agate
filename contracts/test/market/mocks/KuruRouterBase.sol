// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IKuruRouter} from "../../../src/market/interfaces/IKuruRouter.sol";

/// A stand-in market's pause switch (both stand-in market types have it).
interface IKuruMarketSwitch {
    function setMarketState(uint8 state) external;
}

/// @notice What both Kuru V1 Router stand-ins share (BUILD-SPEC 3.4, 7), so Kuru's rules live in one place:
/// deployProxy's parameter checks (Router.sol and OrderBook.initialize, confirmed on testnet by read-only eth_call on
/// Oct 2 2026), a CREATE2 address that hashes only the market parameters (so a front-run with our parameters is the
/// same market), computeAddress, and the owner's switches: closing permissionless deployment (as on mainnet since
/// Sep 4, RC4) and pausing or resuming a market. Each stand-in deploys its own market type (_marketCode):
/// MockKuruRouter an order book with Kuru's arithmetic, KuruRouterStub a parameters-only market for the factory tests.
/// Tests name these errors through this contract (an inherited error is not reachable through a derived name).
abstract contract KuruRouterBase is IKuruRouter {
    error Unauthorized();
    error MarketTypeMismatch();
    error InvalidTickSize();
    error InvalidSizePrecision();
    error InvalidPricePrecision();
    error MarketFeeError();
    error InvalidSpread();
    error MarketSizeError();

    address public immutable owner;
    bool public permissionless = true;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function setPermissionless(bool open) external onlyOwner {
        permissionless = open;
    }

    function setMarketState(address market, uint8 state) external onlyOwner {
        IKuruMarketSwitch(market).setMarketState(state);
    }

    /// oldImplementation and old are ignored: a stand-in has one implementation (the `old = false` path).
    function computeAddress(
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread,
        address,
        bool
    ) external view returns (address) {
        return _predict(
            _saltOf(
                _baseAssetAddress,
                _quoteAssetAddress,
                _sizePrecision,
                _pricePrecision,
                _tickSize,
                _minSize,
                _maxSize,
                _takerFeeBps,
                _makerFeeBps,
                _kuruAmmSpread
            )
        );
    }

    /// deployProxy's checks in Kuru's order, then the market's CREATE2 salt.
    function _checkDeploy(
        uint8 _type,
        address _base,
        address _quote,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _spread
    ) internal view returns (bytes32) {
        if (!permissionless && msg.sender != owner) revert Unauthorized();
        if (_type != 0 || _base == _quote) revert MarketTypeMismatch();
        if (_tickSize == 0) revert InvalidTickSize();
        if (!_pow10(_sizePrecision)) revert InvalidSizePrecision();
        if (!_pow10(_pricePrecision)) revert InvalidPricePrecision();
        if (_makerFeeBps > _takerFeeBps || _takerFeeBps >= 10_000) revert MarketFeeError();
        if (_spread % 10 != 0 || _spread == 0 || _spread >= 500) revert InvalidSpread();
        if (_minSize == 0 || _minSize >= _maxSize) revert MarketSizeError();
        return _saltOf(
            _base,
            _quote,
            _sizePrecision,
            _pricePrecision,
            _tickSize,
            _minSize,
            _maxSize,
            _takerFeeBps,
            _makerFeeBps,
            _spread
        );
    }

    /// The creation code of the market type this stand-in deploys.
    function _marketCode() internal pure virtual returns (bytes memory);

    function _predict(bytes32 salt) internal view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(_marketCode())))))
        );
    }

    function _saltOf(
        address base,
        address quote,
        uint96 sp,
        uint32 pp,
        uint32 tick,
        uint96 mn,
        uint96 mx,
        uint256 tf,
        uint256 mf,
        uint96 spread
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(base, quote, sp, pp, tick, mn, mx, tf, mf, spread));
    }

    function _pow10(uint256 x) internal pure returns (bool) {
        if (x == 0) return false;
        while (x % 10 == 0) {
            x /= 10;
        }
        return x == 1;
    }
}
