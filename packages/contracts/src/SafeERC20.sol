// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "./interfaces/IERC20.sol";

/**
 * @title SafeERC20
 * @notice Local, dependency-free token transfer helpers. A call succeeds only
 *         if it did not revert AND (returned no data OR returned a true bool),
 *         so tokens that return nothing (USDT-style) work and tokens that
 *         return `false` revert. Also requires the target to be a contract.
 *
 *         FEE-ON-TRANSFER POLICY: `safeTransferFromExact` measures the
 *         recipient's balance before and after and REVERTS unless exactly
 *         `amount` arrived. Fee-on-transfer (and rebasing-on-transfer) tokens
 *         are therefore unsupported and rejected rather than credited short.
 */
library SafeERC20 {
    error SafeERC20Failed();
    error ReceivedLessThanAmount(uint256 expected, uint256 received);

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    /// @dev Pulls `amount` from `from` into `to` and reverts unless `to`'s
    ///      balance rose by exactly `amount`. `to` is normally `address(this)`.
    function safeTransferFromExact(IERC20 token, address from, address to, uint256 amount) internal {
        uint256 beforeBal = token.balanceOf(to);
        safeTransferFrom(token, from, to, amount);
        uint256 received = token.balanceOf(to) - beforeBal;
        if (received != amount) revert ReceivedLessThanAmount(amount, received);
    }

    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert SafeERC20Failed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            // Bubble the token's own revert reason (e.g. a reentrancy guard error) when present.
            if (ret.length != 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert SafeERC20Failed();
        }
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert SafeERC20Failed();
    }
}
