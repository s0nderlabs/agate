// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgateIndex} from "../../interfaces/IAgateIndex.sol";
import {Side, CloseKind, SeriesTerms, Position} from "../MarketTypes.sol";

/// constructor(SeriesTerms memory terms, string memory name, string memory symbol): deploys its AgateToken.
interface IAgateSeries {
    event Minted(address indexed payer, address indexed to, uint256 q, uint256 cost);
    event Redeemed(address indexed holder, address indexed to, uint256 q, uint256 paid);
    event ShortCredited(address indexed account, uint256 q, uint256 balance);
    event ShortDebited(address indexed account, uint256 q, uint256 balance);
    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        address indexed payee,
        Side side,
        uint256 q,
        uint256 paidNow,
        address operator,
        bool daily,
        uint8 k,
        address to
    );
    event Claimed(uint256 indexed id, address indexed payee, uint256 amount, uint256 paidTotal, uint8 k);
    event PositionClosed(
        uint256 indexed id, address indexed owner, CloseKind kind, uint256 amount, address to, address by
    );
    event PayoutChanged(uint256 indexed id, address indexed payee, bool daily);
    event OperatorSet(uint256 indexed id, address indexed operator);
    event Settled(address indexed holder, Side indexed side, uint256 q, uint256 paid, address indexed to);
    event FixApplied(
        uint8 indexed k, uint32 indexed day, uint32 x, uint32 c, IAgateIndex.Status status, uint8 flags, uint64 sumAfter
    );

    error NotImplemented();
    error BadAmount();
    error BadRecipient();
    error BadOwner();
    error BadPayee();
    error BadOperator();
    error BadBand();
    error BadTerms();
    error DollarDecimals();
    error DollarInexact();
    error TokenBalance();
    error ShortBalance();
    error MonthFinal();
    error MonthNotFinal();
    error NoPosition(uint256 id);
    error NotOwner();
    error NotOwnerOrOperator();
    error OperatorMustPayOwner();
    error SyncGasLow();

    function mint(uint256 q, address to) external returns (uint256 cost);
    function redeem(uint256 q, address to) external returns (uint256 paid);
    function streamOut(Side side, uint256 q, address owner, address payee, address to, bool daily)
        external
        returns (uint256 id, uint256 paidNow);
    function claim(uint256 id) external returns (uint256 paid);
    function claimMany(uint256[] calldata ids) external returns (uint256 total);
    function setPayout(uint256 id, address payee, bool daily) external;
    function setOperator(uint256 id, address operator) external;
    function closeWithToken(uint256 id, address to) external returns (uint256 paid);
    function unstream(uint256 id, address to) external returns (uint256 paidBack);
    function settle(Side side, uint256 q, address to) external returns (uint256 paid);
    function sync(uint256 maxDays) external returns (uint256 applied);

    function token() external view returns (address);
    function terms() external view returns (SeriesTerms memory);
    function state()
        external
        view
        returns (
            uint8 k,
            uint64 sum,
            uint32 lastX,
            bool walked,
            bool appliedReal,
            uint128 ledger,
            uint256 nextId,
            uint256 shortSupply
        );
    function shortOf(address account) external view returns (uint256);
    function position(uint256 id) external view returns (Position memory);
    function owed(Side side, uint256 q) external view returns (uint256);
    function previewSync() external view returns (uint8 k, uint64 sum);
    function claimable(uint256 id) external view returns (uint256);
    function mintCost(uint256 q) external view returns (uint256);
    function redeemValue(uint256 q) external view returns (uint256);
}
