// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A 6-decimal dollar with no EIP-2612 (the shape of Kuru's testnet USDC): router flows use the standing allowance.
contract NoPermitDollar is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A 6-decimal dollar that takes 1 u from every transfer: the router's pull refuses it (PullInexact).
contract FeeOnTransferDollar is NoPermitDollar {
    address public constant SINK = address(0xFEE);

    constructor() NoPermitDollar("fee on transfer dollar", "FEE") {}

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || value == 0) return super._update(from, to, value);
        super._update(from, SINK, 1);
        super._update(from, to, value - 1);
    }
}
