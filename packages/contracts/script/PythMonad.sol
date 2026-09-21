// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title PythMonad
 * @notice Real, verified constants for Pyth on Monad mainnet (chain id 143).
 *         Not a stub, not a placeholder — cross-checked against three
 *         independent sources on 2026-09-17:
 *
 *         1. The community-maintained protocol registry
 *            https://github.com/monad-crypto/protocols/blob/main/mainnet/pyth.jsonc
 *         2. Pyth's own live Hermes API (https://hermes.pyth.network/v2/price_feeds),
 *            which returned identical feed ids for BTC/USD and ETH/USD.
 *         3. Block explorers (GnosisScan, BeraScan) showing the same
 *            `PRICE_FEED` address as Pyth's "Price Feed Proxy" on other EVM
 *            chains — Pyth deploys this proxy at the same address across most
 *            EVM chains via a deterministic factory, which is why it matches.
 *
 *         `docs.monad.xyz/tooling-and-infra/oracles` (fetched the same day)
 *         lists this identical address under a "testnet" heading with no
 *         separate mainnet value given — most likely the same deterministic
 *         proxy serving both, consistent with source 3 above, but this is
 *         flagged rather than silently assumed. Re-verify against
 *         `docs.pyth.network/price-feeds/core/contract-addresses/evm` and a
 *         Monad mainnet block explorer before any deployment that moves real
 *         funds.
 */
library PythMonad {
    /// @notice Pyth's PriceFeed proxy contract. Pass this as `pyth_` to
    ///         CanonicalSeries's constructor.
    address internal constant PRICE_FEED = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    // Premium feeds — 1h heartbeat, 0.02% deviation threshold (per
    // ARCHITECTURE.md's "Oracle" section and pyth.jsonc's own comment).
    bytes32 internal constant BTC_USD = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH_USD = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant MON_USD = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;
    bytes32 internal constant SOL_USD = 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d;

    // Standard feeds — 1h heartbeat, 0.05% deviation threshold. Sourced from
    // the same pyth.jsonc; only the ones this product's docs name as
    // realistic Predict-tab crypto assets are kept here to avoid an
    // unreviewed 60-entry constant list. Add more only as a screen actually
    // uses them.
    bytes32 internal constant USDC_USD = 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a;
    bytes32 internal constant USDT_USD = 0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b;
    bytes32 internal constant WBTC_USD = 0xc9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33;
    bytes32 internal constant WETH_USD = 0x9d4294bbcd1174d6f2003ec365831e64cc31d9f6f15a2b85399db8d5000960f6;
    bytes32 internal constant WSTETH_USD = 0x6df640f3b8963d8f8358f791f352b8364513f6ab1cca5ed3f1f7b5448980e784;
}
