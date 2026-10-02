// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockKuruOrderBook} from "./MockKuruOrderBook.sol";
import {KuruRouterBase} from "./KuruRouterBase.sol";

/// @notice Integer stand-in for the Kuru V1 Router (BUILD-SPEC 3.4, 7), ported from the reference model's
/// MockKuruRouter: deployProxy with Kuru's parameter checks and its CREATE2 address, computeAddress and the owner's
/// switches (KuruRouterBase, shared with KuruRouterStub), deploying a MockKuruOrderBook with Kuru's arithmetic;
/// verifiedMarket (zeros for a market it did not make).
contract MockKuruRouter is KuruRouterBase {
    error FailedDeployment();

    event MarketRegistered(address indexed market, address base, address quote);

    struct Params {
        uint32 pricePrecision;
        uint96 sizePrecision;
        address base;
        uint256 baseDecimals;
        address quote;
        uint256 quoteDecimals;
        uint32 tickSize;
        uint96 minSize;
        uint96 maxSize;
        uint256 takerFeeBps;
        uint256 makerFeeBps;
    }

    mapping(address => Params) internal verified;

    function deployProxy(
        uint8 _type,
        address _baseAssetAddress,
        address _quoteAssetAddress,
        uint96 _sizePrecision,
        uint32 _pricePrecision,
        uint32 _tickSize,
        uint96 _minSize,
        uint96 _maxSize,
        uint256 _takerFeeBps,
        uint256 _makerFeeBps,
        uint96 _kuruAmmSpread
    ) external returns (address proxy) {
        bytes32 salt = _checkDeploy(
            _type,
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
        );
        proxy = _predict(salt);
        if (proxy.code.length != 0) revert FailedDeployment();
        MockKuruOrderBook m = new MockKuruOrderBook{salt: salt}();
        m.initialize(
            _baseAssetAddress,
            _quoteAssetAddress,
            _sizePrecision,
            _pricePrecision,
            _tickSize,
            _minSize,
            _maxSize,
            _takerFeeBps,
            _makerFeeBps
        );
        verified[proxy] = Params(
            _pricePrecision,
            _sizePrecision,
            _baseAssetAddress,
            m.baseDecimals(),
            _quoteAssetAddress,
            m.quoteDecimals(),
            _tickSize,
            _minSize,
            _maxSize,
            _takerFeeBps,
            _makerFeeBps
        );
        emit MarketRegistered(proxy, _baseAssetAddress, _quoteAssetAddress);
    }

    function verifiedMarket(address market)
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        Params storage p = verified[market];
        return (
            p.pricePrecision,
            p.sizePrecision,
            p.base,
            p.baseDecimals,
            p.quote,
            p.quoteDecimals,
            p.tickSize,
            p.minSize,
            p.maxSize,
            p.takerFeeBps,
            p.makerFeeBps
        );
    }

    function _marketCode() internal pure override returns (bytes memory) {
        return type(MockKuruOrderBook).creationCode;
    }
}
