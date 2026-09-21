// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PythStructs } from "./PythStructs.sol";

/**
 * @title IPyth
 * @notice Local stand-in for Pyth's `IPyth.sol` consumer interface. Only the
 *         subset this package actually calls (`getPriceNoOlderThan`) plus
 *         `getPriceUnsafe` for completeness/testability. See
 *         `PythStructs.sol` in this directory for why this is hand-written
 *         instead of the vendored SDK.
 *
 * @dev    Signature matches the real interface exactly:
 *         https://github.com/pyth-network/pyth-sdk-solidity/blob/main/IPyth.sol
 */
interface IPyth {
    /// @notice Returns the price that is no older than `age` seconds from the
    ///         current block time. Reverts if the price is unavailable or
    ///         staler than `age`.
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory price);

    /// @notice Returns the most recent price update without any staleness
    ///         check. Unsafe on its own; exposed for callers that want to do
    ///         their own freshness check against `publishTime`.
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price);
}
