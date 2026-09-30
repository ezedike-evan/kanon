// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { ThresholdMarket } from "../src/ThresholdMarket.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { MockPyth } from "../test/mocks/MockPyth.sol";
import { MockERC20 } from "../test/mocks/MockERC20.sol";
import { PythMonad } from "./PythMonad.sol";

/**
 * @title Deploy
 * @notice Deploys Kanon's whole on-chain system in one broadcast and writes
 *         every address to `deployments/<chainid>.json` for the indexer and
 *         the web/mobile clients:
 *
 *           CollateralToken (mock only), Pyth (mock only),
 *           CanonicalSeries (BTC/USD, ETH/USD), StrategyRegistry, RefusalGate,
 *           ThresholdMarket, InsuranceFund, MarginAccount, VaultFactory.
 *
 *         `GuardedVault` and `CopyVault` are per-user; they are created
 *         through `VaultFactory`, not deployed here.
 *
 * MODES
 *   Real (Monad mainnet, chain 143): the real Pyth PriceFeed proxy from
 *   `PythMonad`, and `COLLATERAL_TOKEN` must be supplied. No address for
 *   USDC/AUSD on Monad mainnet was found in the sources checked when this
 *   script was written (see `PythMonad.sol`'s header for what WAS
 *   cross-verified); a fabricated address would be worse than requiring the
 *   caller to look it up.
 *
 *   Mock (chain 31337, i.e. anvil, or `USE_MOCKS=true`): deploys `MockPyth`
 *   and a 6-decimal `MockERC20`, and seeds both feed ids with a price. Used by
 *   `script/e2e-local.sh`. Mocks are only ever deployed in this mode.
 *
 * USAGE
 *   forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --private-key <key> --broadcast
 *
 * ENV (all optional unless stated)
 *   COLLATERAL_TOKEN          required in real mode.
 *   MIN_BOND_WEI              default 0.25 ether
 *   LOOSEN_COOLDOWN_SECONDS   default 86400 (24h)
 *   PRICE_MAX_AGE_SECONDS     default 3600 (BTC/USD 1h heartbeat)
 *   MAINTENANCE_MARGIN_BPS    default 500 (5%)
 *   LIQUIDATION_PENALTY_BPS   default 200 (2% of the liquidated size, to the fund)
 *   ADL_HEALTH_THRESHOLD      default 1.2e18 (ADL band is [1.0, 1.2))
 *   ADL_FRACTION_BPS          default 2500 (25% of the largest position)
 *   INSURANCE_SEED            default 0; explicit fund deposit from the deployer
 *   USE_MOCKS                 default false
 *
 * Every risk parameter above is immutable in the deployed contracts. Changing
 * one means redeploying, not calling anything.
 */
contract Deploy is Script {
    uint256 internal constant MONAD_MAINNET = 143;

    struct Params {
        bool mocks;
        bool coreOnly;
        uint256 minBond;
        uint256 loosenCooldownSeconds;
        uint256 priceMaxAgeSeconds;
        uint256 maintenanceMarginBps;
        uint256 liquidationPenaltyBps;
        uint256 adlHealthThreshold;
        uint256 adlFractionBps;
        uint256 insuranceSeed;
    }

    struct Deployed {
        address deployer;
        address collateralToken;
        address pyth;
        address btcSeries;
        address ethSeries;
        address registry;
        address refusalGate;
        address thresholdMarket;
        address insuranceFund;
        address marginAccount;
        address vaultFactory;
        uint256 startBlock;
    }

    function run() external returns (Deployed memory d) {
        Params memory p = _params();

        d.startBlock = block.number;
        vm.startBroadcast();
        (, d.deployer,) = vm.readCallers();

        if (p.mocks) {
            MockPyth mockPyth = new MockPyth();
            mockPyth.setPrice(PythMonad.BTC_USD, 100_000e8, 1e6, -8, block.timestamp);
            mockPyth.setPrice(PythMonad.ETH_USD, 3_000e8, 1e5, -8, block.timestamp);
            d.pyth = address(mockPyth);
            d.collateralToken = address(new MockERC20("Mock USDC", "USDC", 6));
        } else {
            d.pyth = PythMonad.PRICE_FEED;
            // Core-only deployments hold no collateral, so no token is required.
            if (!p.coreOnly) d.collateralToken = vm.envAddress("COLLATERAL_TOKEN");
        }

        // BTC/USD and ETH/USD, 15m buckets, 60s cadence — the demo assets from
        // docs/ARCHITECTURE.md. cadence/bucket match packages/spec fixtures.
        d.btcSeries = address(
            new CanonicalSeries("BTC/USD", PythMonad.BTC_USD, 60, 900, d.pyth, p.priceMaxAgeSeconds)
        );
        d.ethSeries = address(
            new CanonicalSeries("ETH/USD", PythMonad.ETH_USD, 60, 900, d.pyth, p.priceMaxAgeSeconds)
        );

        // The registry's immutable canonical-series set: a strategy can only be
        // pinned to one of these, so no lookalike series can ever be bound.
        address[] memory canonical = new address[](2);
        canonical[0] = d.btcSeries;
        canonical[1] = d.ethSeries;
        d.registry = address(new StrategyRegistry(p.minBond, p.loosenCooldownSeconds, canonical));
        d.refusalGate = address(new RefusalGate(d.registry));

        // Series ids are fixed in the constructor: no registerSeries, so an id
        // cannot be squatted or re-pointed after deployment.
        bytes32[] memory marketIds = new bytes32[](2);
        marketIds[0] = keccak256("BTC/USD");
        marketIds[1] = keccak256("ETH/USD");
        d.thresholdMarket = address(new ThresholdMarket(marketIds, canonical));

        // Monad mainnet ships the core only (series, registry, gate, market). The margin ledger,
        // insurance fund and vaults are unbacked or attested-input designs that are not safe
        // with real deposits yet (docs/SECURITY.md), so they stay testnet-only.
        if (!p.coreOnly) {
            // InsuranceFund <-> MarginAccount reference each other. The fund is
            // bound to the MarginAccount's *predicted* CREATE address (the fund is
            // deployed at `nonce`, the margin at `nonce + 1`); MarginAccount's
            // constructor then asserts `fund.margin() == address(this)`. No
            // privileged binder, no setter.
            uint256 nonce = vm.getNonce(d.deployer);
            address predictedMargin = vm.computeCreateAddress(d.deployer, nonce + 1);
            InsuranceFund fund = new InsuranceFund(d.collateralToken, predictedMargin);
            MarginAccount margin = new MarginAccount(
                d.collateralToken,
                p.maintenanceMarginBps,
                address(fund),
                p.liquidationPenaltyBps,
                p.adlHealthThreshold,
                p.adlFractionBps,
                d.refusalGate
            );
            require(address(margin) == predictedMargin, "margin address prediction failed");
            d.insuranceFund = address(fund);
            d.marginAccount = address(margin);

            d.vaultFactory = address(new VaultFactory(d.collateralToken, d.registry, d.refusalGate));

            if (p.insuranceSeed > 0) {
                if (p.mocks) MockERC20(d.collateralToken).mint(d.deployer, p.insuranceSeed);
                MockERC20(d.collateralToken).approve(address(fund), p.insuranceSeed);
                fund.deposit(p.insuranceSeed);
            }
        }

        vm.stopBroadcast();

        _log(d);
        _write(d, p);
    }

    function _params() internal view returns (Params memory p) {
        p.mocks = block.chainid == 31337 || vm.envOr("USE_MOCKS", false);
        p.coreOnly = block.chainid == MONAD_MAINNET;
        require(!(p.mocks && block.chainid == MONAD_MAINNET), "mocks are never deployed to mainnet");
        p.minBond = vm.envOr("MIN_BOND_WEI", uint256(0.25 ether));
        p.loosenCooldownSeconds = vm.envOr("LOOSEN_COOLDOWN_SECONDS", uint256(86_400));
        p.priceMaxAgeSeconds = vm.envOr("PRICE_MAX_AGE_SECONDS", uint256(3600));
        p.maintenanceMarginBps = vm.envOr("MAINTENANCE_MARGIN_BPS", uint256(500));
        p.liquidationPenaltyBps = vm.envOr("LIQUIDATION_PENALTY_BPS", uint256(200));
        p.adlHealthThreshold = vm.envOr("ADL_HEALTH_THRESHOLD", uint256(1.2e18));
        p.adlFractionBps = vm.envOr("ADL_FRACTION_BPS", uint256(2_500));
        p.insuranceSeed = vm.envOr("INSURANCE_SEED", uint256(0));
    }

    function _log(Deployed memory d) internal pure {
        console2.log("Deployer:", d.deployer);
        console2.log("CollateralToken:", d.collateralToken);
        console2.log("Pyth:", d.pyth);
        console2.log("CanonicalSeries (BTC/USD):", d.btcSeries);
        console2.log("CanonicalSeries (ETH/USD):", d.ethSeries);
        console2.log("StrategyRegistry:", d.registry);
        console2.log("RefusalGate:", d.refusalGate);
        console2.log("ThresholdMarket:", d.thresholdMarket);
        console2.log("InsuranceFund:", d.insuranceFund);
        console2.log("MarginAccount:", d.marginAccount);
        console2.log("VaultFactory:", d.vaultFactory);
    }

    /// @dev Flat, stable JSON: every key is a contract name (or a documented
    ///      role), every value an address, plus chain metadata and the risk
    ///      parameters the deployment was built with.
    function _write(Deployed memory d, Params memory p) internal {
        string memory k = "kanon-deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", d.startBlock);
        vm.serializeBool(k, "mocks", p.mocks);
        vm.serializeAddress(k, "deployer", d.deployer);
        vm.serializeAddress(k, "CollateralToken", d.collateralToken);
        vm.serializeAddress(k, "Pyth", d.pyth);
        vm.serializeAddress(k, "CanonicalSeriesBTCUSD", d.btcSeries);
        vm.serializeAddress(k, "CanonicalSeriesETHUSD", d.ethSeries);
        vm.serializeAddress(k, "StrategyRegistry", d.registry);
        vm.serializeAddress(k, "RefusalGate", d.refusalGate);
        vm.serializeAddress(k, "ThresholdMarket", d.thresholdMarket);
        vm.serializeAddress(k, "InsuranceFund", d.insuranceFund);
        vm.serializeAddress(k, "MarginAccount", d.marginAccount);
        vm.serializeAddress(k, "VaultFactory", d.vaultFactory);
        vm.serializeUint(k, "maintenanceMarginBps", p.maintenanceMarginBps);
        vm.serializeUint(k, "liquidationPenaltyBps", p.liquidationPenaltyBps);
        vm.serializeUint(k, "adlHealthThreshold", p.adlHealthThreshold);
        vm.serializeUint(k, "adlFractionBps", p.adlFractionBps);
        vm.serializeUint(k, "minBondWei", p.minBond);
        string memory json = vm.serializeUint(k, "loosenCooldownSeconds", p.loosenCooldownSeconds);

        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("Wrote", path);
    }
}
