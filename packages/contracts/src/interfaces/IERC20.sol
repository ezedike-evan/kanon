// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IERC20
 * @notice Minimal ERC20 interface — only the functions the contracts in this
 *         package actually call. No OpenZeppelin dependency is vendored here
 *         (see packages/contracts/README.md's "Pyth interface" section for why
 *         this package hand-writes its external interfaces rather than
 *         `forge install`ing a dependency into the monorepo root); this
 *         follows the same local-stand-in pattern as `src/pyth/IPyth.sol`.
 *         Collateral in this package is always an 18-decimal ERC20 in tests
 *         (a mock USDC-equivalent); this interface itself is decimals-agnostic.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
