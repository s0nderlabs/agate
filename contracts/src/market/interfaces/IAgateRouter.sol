// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Flow, Permit} from "../MarketTypes.sol";

/// constructor(IAgateFactory factory, address dollar): stores both, makes no call (the factory deploys the router in
/// its constructor and passes its own dollar; v3.4).
interface IAgateRouter {
    /// BUILD-SPEC 8.4: per flow, the user's dollar balance changes by dollarsOut - dollarsIn and its token balance by
    /// tokensOut - tokensIn in this transaction; refund is the part of dollarsOut that is Kuru's unused quote.
    event Routed(
        address indexed user,
        address indexed series,
        Flow indexed flow,
        uint256 tokens,
        uint256 dollarsIn,
        uint256 dollarsOut,
        uint256 refund,
        uint256 tokensIn,
        uint256 tokensOut,
        uint256[] positionIds
    );

    error NotSeries(address series);
    error NoMarket(address series);
    error VenueUnsupported(address series);
    error BadLimits();
    error BadParts();
    error BadAmount();
    error BadSize();
    error BadPayee(address payee);
    error PullInexact();
    error SlippageExceeded(uint256 got, uint256 min);
    error NotYourPosition(uint256 id);
    error WrongSide(uint256 id);
    error RouterKeptSomething();

    function openLong(address series, uint256 dollarsIn, uint256 minTokensOut, Permit calldata permit)
        external
        returns (uint256 tokensOut);
    function openLongDaily(
        address series,
        uint256 dollarsIn,
        uint256 minTokensOut,
        uint256 parts,
        address payee,
        Permit calldata permit
    ) external returns (uint256[] memory ids);
    function openShort(
        address series,
        uint256 tokens,
        uint256 minDollarsOut,
        uint256 parts,
        address payee,
        bool daily,
        Permit calldata permit
    ) external returns (uint256[] memory ids, uint256 cost, uint256 dollarsOut);
    function closeLong(address series, uint256 tokens, uint256 minDollarsOut, Permit calldata permit)
        external
        returns (uint256 dollarsOut);
    function closeShort(address series, uint256[] calldata ids, uint256 dollarsIn, Permit calldata permit)
        external
        returns (uint256 paid, uint256 surplusTokens, uint256 refund);
    function closeLongDaily(address series, uint256[] calldata ids, uint256 minDollarsOut, Permit calldata permit)
        external
        returns (uint256 cost, uint256 dollarsOut, uint256 paid);

    function sizeFor(uint256 gpus, uint256 days_) external pure returns (uint256 tokens);
    function factory() external view returns (address);
}
