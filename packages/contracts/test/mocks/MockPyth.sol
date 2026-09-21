// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IPyth } from "../../src/pyth/IPyth.sol";
import { PythStructs } from "../../src/pyth/PythStructs.sol";

/**
 * @title MockPyth
 * @notice Minimal test double for IPyth. The test sets whatever price it wants
 *         for a given feed id and controls staleness by choosing publishTime
 *         relative to the test's own warped block.timestamp — it never talks
 *         to a real oracle.
 */
contract MockPyth is IPyth {
    mapping(bytes32 => PythStructs.Price) private _prices;
    mapping(bytes32 => bool) private _set;

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = PythStructs.Price({ price: price, conf: conf, expo: expo, publishTime: publishTime });
        _set[id] = true;
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory price) {
        require(_set[id], "MockPyth: no price set");
        price = _prices[id];
        require(block.timestamp - price.publishTime <= age, "MockPyth: price too stale");
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price) {
        require(_set[id], "MockPyth: no price set");
        price = _prices[id];
    }
}
