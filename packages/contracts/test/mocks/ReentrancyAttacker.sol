// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Generic caller: forwards `data` to `target` and bubbles reverts. Used as the
///         vault owner / follower / depositor so reentrant calls pass authorization and
///         only the reentrancy guard can stop them.
contract ReentrancyAttacker {
    function go(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function approveToken(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok);
    }
}
