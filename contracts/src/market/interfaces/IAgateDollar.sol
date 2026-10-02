// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// constructor(address minter, uint256 dripAmount, uint64 dripPeriod). name "agate test dollar", symbol "tUSD",
/// 6 decimals, ERC20Permit("agate test dollar").
interface IAgateDollar is IERC20Metadata, IERC20Permit {
    event Dripped(address indexed to, uint256 amount, uint64 nextAt);

    error BadInit();
    error DripTooSoon(uint64 nextAt);
    error NotMinter();

    function drip() external returns (uint256 amount);
    function mint(address to, uint256 amount) external;
    function minter() external view returns (address);
    function dripAmount() external view returns (uint256);
    function dripPeriod() external view returns (uint64);
    function nextDripAt(address account) external view returns (uint64);
}
