// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ERC777-style hook token: during `transfer`/`transferFrom` it calls
///         back into `target` with `payload` and
///         bubbles up its revert (so a test can assert the exact guard error);
///         also records whether the reentrant call succeeded.
contract ReentrantERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    bytes public payload;
    bool public armed;
    bool public reentrySucceeded;
    bool public reentryAttempted;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        _hook();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        _hook();
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function _hook() internal {
        if (!armed) return;
        armed = false; // one shot
        reentryAttempted = true;
        (bool ok,) = target.call(payload);
        reentrySucceeded = ok;
        if (!ok) {
            assembly {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }
}
