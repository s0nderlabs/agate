// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KuruRouterBase} from "./KuruRouterBase.sol";

/// @notice A Kuru V1 market as the factory sees it: getMarketParams and marketState, nothing else (no book).
contract KuruMarketStub {
    error OnlyRouter();

    address public immutable router;
    bytes internal params; // abi-encoded getMarketParams answer
    uint8 public marketState;

    constructor() {
        router = msg.sender;
    }

    function init(bytes calldata p) external {
        if (msg.sender != router) revert OnlyRouter();
        params = p;
    }

    function setMarketState(uint8 s) external {
        if (msg.sender != router) revert OnlyRouter();
        marketState = s;
    }

    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        return abi.decode(
            params, (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
        );
    }
}

/// @notice BUILD-SPEC 12.2: a Kuru V1 Router stand-in for the factory's I24 tests. deployProxy's checks,
/// its CREATE2 address over the market parameters only (so a front-run with our parameters is the same market),
/// computeAddress, closing permissionless deployment (RC4) and pausing a market come from KuruRouterBase, shared with
/// MockKuruRouter; verifiedMarket answers zeros for a market it did not make. Test switches of its own: deploy
/// somewhere else than computeAddress said (an implementation upgrade between the two calls), or lie in
/// verifiedMarket.
contract KuruRouterStub is KuruRouterBase {
    bool public skewDeploy; // deployProxy deploys at another address than computeAddress gives
    bool public lie; // verifiedMarket reports a wrong tick
    uint256 public deploys;
    mapping(address => bytes) internal verified;

    function setSkewDeploy(bool on) external {
        skewDeploy = on;
    }

    function setLie(bool on) external {
        lie = on;
    }

    function deployProxy(
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
    ) external returns (address proxy) {
        bytes32 salt = _checkDeploy(
            _type,
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
        if (skewDeploy) salt = keccak256(abi.encode(salt, "skew"));
        proxy = address(new KuruMarketStub{salt: salt}());
        bytes memory p = abi.encode(
            _pricePrecision,
            _sizePrecision,
            _base,
            _decimals(_base),
            _quote,
            _decimals(_quote),
            _tickSize,
            _minSize,
            _maxSize,
            _takerFeeBps,
            _makerFeeBps
        );
        KuruMarketStub(proxy).init(p);
        verified[proxy] = p;
        ++deploys;
    }

    function verifiedMarket(address market)
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256)
    {
        bytes memory p = verified[market];
        if (p.length == 0) return (0, 0, address(0), 0, address(0), 0, 0, 0, 0, 0, 0);
        (
            uint32 pp,
            uint96 sp,
            address base,
            uint256 bd,
            address quote,
            uint256 qd,
            uint32 tick,
            uint96 mn,
            uint96 mx,
            uint256 tf,
            uint256 mf
        ) = abi.decode(p, (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256));
        if (lie) tick += 1;
        return (pp, sp, base, bd, quote, qd, tick, mn, mx, tf, mf);
    }

    function _decimals(address t) internal view returns (uint256) {
        (bool ok, bytes memory r) = t.staticcall(abi.encodeWithSignature("decimals()"));
        return ok && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }

    function _marketCode() internal pure override returns (bytes memory) {
        return type(KuruMarketStub).creationCode;
    }
}
