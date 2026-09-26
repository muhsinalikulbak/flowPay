// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Plain 6-decimals ERC-20 with a public `mint`, used purely to drive the
 *      unit tests. The testnet deployment targets the real Circle USDC at
 *      0x534b2f3A21130d7a60830c2Df862319e593943A3 - this mock is never deployed
 *      to a public network and is not part of the product flow.
 */
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
