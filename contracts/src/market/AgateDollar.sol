// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IAgateDollar} from "./interfaces/IAgateDollar.sol";

/// @title AgateDollar: the test dollar (tUSD), 6 decimals, no value (BUILD-SPEC 5)
/// @notice An open faucet limited per address (one drip per dripPeriod of real time) and one immutable minter for
/// the market maker's float. The limit is per address, so it is sybil-able; on testnet that is accepted.
contract AgateDollar is ERC20, ERC20Permit, IAgateDollar {
    address public immutable override minter;
    uint256 public immutable override dripAmount;
    uint64 public immutable override dripPeriod;

    mapping(address => uint64) public override nextDripAt;

    constructor(address minter_, uint256 dripAmount_, uint64 dripPeriod_)
        ERC20("agate test dollar", "tUSD")
        ERC20Permit("agate test dollar")
    {
        if (minter_ == address(0) || dripAmount_ == 0 || dripPeriod_ == 0) revert BadInit();
        minter = minter_;
        dripAmount = dripAmount_;
        dripPeriod = dripPeriod_;
    }

    function decimals() public pure override(ERC20, IERC20Metadata) returns (uint8) {
        return 6;
    }

    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }

    function drip() external override returns (uint256 amount) {
        uint64 at = nextDripAt[msg.sender];
        if (block.timestamp < at) revert DripTooSoon(at);
        uint256 next = block.timestamp + dripPeriod;
        uint64 nextAt = next > type(uint64).max ? type(uint64).max : uint64(next);
        nextDripAt[msg.sender] = nextAt;
        amount = dripAmount;
        _mint(msg.sender, amount);
        emit Dripped(msg.sender, amount, nextAt);
    }

    function mint(address to, uint256 amount) external override {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
