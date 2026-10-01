// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract SpikeUp is ERC20 {
    address public immutable market;

    constructor() ERC20("spike UP H100-NOV", "spUP") {
        market = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == market, "only market");
        _mint(to, amount);
    }
}

/// Stand-in for the real market so each login stack can be compared on the same calls:
/// a plain buy, a one-signature buy (permit), and a buy made by an agent the user approved with a cap and an expiry.
contract SpikeMarket {
    using SafeERC20 for IERC20;

    struct Allowance {
        uint128 remaining;
        uint64 expiry;
    }

    IERC20 public immutable usd;
    SpikeUp public immutable up;
    mapping(address user => mapping(address agent => Allowance)) public agentAllowance;

    event Bought(address indexed user, address indexed payer, uint256 amount, address agent);
    event AgentApproved(address indexed user, address indexed agent, uint256 cap, uint64 expiry);

    error AgentNotAllowed();

    constructor(IERC20 usd_) {
        usd = usd_;
        up = new SpikeUp();
    }

    function buyUp(uint256 amount) external {
        _buy(msg.sender, amount, address(0));
    }

    function buyUpWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        // Ignore a failed permit so a front-run permit cannot block the buy.
        try IERC20Permit(address(usd)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _buy(msg.sender, amount, address(0));
    }

    function approveAgent(address agent, uint128 cap, uint64 expiry) external {
        agentAllowance[msg.sender][agent] = Allowance(cap, expiry);
        emit AgentApproved(msg.sender, agent, cap, expiry);
    }

    function buyUpFor(address user, uint256 amount) external {
        Allowance storage a = agentAllowance[user][msg.sender];
        if (block.timestamp > a.expiry || amount > a.remaining) revert AgentNotAllowed();
        a.remaining -= uint128(amount);
        _buy(user, amount, msg.sender);
    }

    function _buy(address user, uint256 amount, address agent) internal {
        usd.safeTransferFrom(user, address(this), amount);
        up.mint(user, amount);
        emit Bought(user, user, amount, agent);
    }
}
