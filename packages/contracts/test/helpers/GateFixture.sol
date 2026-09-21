// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { StrategyRegistry } from "../../src/StrategyRegistry.sol";
import { RefusalGate } from "../../src/RefusalGate.sol";

/// @dev Test-only: a real registry (canonical set = `series`) and a real gate.
function deployGate(address[] memory series) returns (StrategyRegistry registry, RefusalGate gate) {
    registry = new StrategyRegistry(0.01 ether, 1 days, series);
    gate = new RefusalGate(address(registry));
}

function one(address a) pure returns (address[] memory arr) {
    arr = new address[](1);
    arr[0] = a;
}

function two(address a, address b) pure returns (address[] memory arr) {
    arr = new address[](2);
    arr[0] = a;
    arr[1] = b;
}
