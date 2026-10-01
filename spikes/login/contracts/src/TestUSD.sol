// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// Testnet-only dollar for the login spikes. Anyone can mint to anyone, so a sponsor or relayer can fund a user.
contract TestUSD is ERC20, ERC20Permit {
    uint256 public constant DRIP = 10_000e6;

    constructor() ERC20("agate test dollar", "testUSD") ERC20Permit("agate test dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        _mint(to, DRIP);
    }
}
