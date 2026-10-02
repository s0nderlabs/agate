// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// constructor(string memory name, string memory symbol): series = msg.sender. decimals() == 6. ERC20Permit(name).
interface IAgateToken is IERC20Metadata, IERC20Permit {
    error OnlySeries();

    function series() external view returns (address);
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}
