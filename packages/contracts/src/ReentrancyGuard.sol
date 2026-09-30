// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal non-reentrancy guard. No owner, no admin; one storage slot.
abstract contract ReentrancyGuard {
    uint256 private _status = 1;

    error Reentrancy();

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }
}
