// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IAgateToken} from "./interfaces/IAgateToken.sol";

/// @title AgateToken: the long side of one series, one token per GPU-hour of its month (BUILD-SPEC 4.3)
/// @notice Deployed by its series, which alone mints and burns. No hooks, no pause; the token never calls out.
contract AgateToken is ERC20, ERC20Permit, IAgateToken {
    address public immutable override series;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC20Permit(name_) {
        series = msg.sender;
    }

    modifier onlySeries() {
        if (msg.sender != series) revert OnlySeries();
        _;
    }

    function decimals() public pure override(ERC20, IERC20Metadata) returns (uint8) {
        return 6;
    }

    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }

    function mint(address to, uint256 amount) external override onlySeries {
        _mint(to, amount);
    }

    /// No allowance needed, so the series only ever burns from its own caller (BUILD-SPEC 4.4).
    function burn(address from, uint256 amount) external override onlySeries {
        _burn(from, amount);
    }
}
