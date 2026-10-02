// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IKuruOrderBook {
    event Trade(
        uint40 orderId,
        address makerAddress,
        bool isBuy,
        uint256 price,
        uint96 updatedSize,
        address takerAddress,
        address txOrigin,
        uint96 filledSize
    );

    function placeAndExecuteMarketBuy(uint96 _quoteSize, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function placeAndExecuteMarketSell(uint96 _size, uint256 _minAmountOut, bool _isMargin, bool _isFillOrKill)
        external
        payable
        returns (uint256);
    function addBuyOrder(uint32 _price, uint96 size, bool _postOnly) external;
    function addSellOrder(uint32 _price, uint96 _size, bool _postOnly) external;
    function bestBidAsk() external view returns (uint256, uint256);
    function marketState() external view returns (uint8);
    function getMarketParams()
        external
        view
        returns (uint32, uint96, address, uint256, address, uint256, uint32, uint96, uint96, uint256, uint256);
}
