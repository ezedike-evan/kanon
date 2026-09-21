// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { deployGate, one } from "./helpers/GateFixture.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

contract MarginAccountTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant CADENCE = 300;
    uint256 constant BUCKET = 900;
    uint256 constant MAX_AGE = 60;
    uint256 constant MAINTENANCE_BPS = 1000; // 10%
    uint256 constant PENALTY_BPS = 200; // 2% of liquidated size
    uint256 constant ADL_THRESHOLD = 1.2e18;
    uint256 constant ADL_FRACTION_BPS = 2_500; // 25% of the largest position

    MockPyth pyth;
    CanonicalSeries series;
    MockERC20 usdc;
    MarginAccount margin;
    InsuranceFund fund;
    RefusalGate gate;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
        usdc = new MockERC20("USD Coin", "USDC", 18);
        // MarginAccount and InsuranceFund reference each other: the fund is
        // bound to the margin's predicted CREATE address (no privileged binder).
        (, gate) = deployGate(one(address(series)));
        address predictedMargin = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fund = new InsuranceFund(address(usdc), predictedMargin);
        margin = new MarginAccount(
            address(usdc), MAINTENANCE_BPS, address(fund), PENALTY_BPS, ADL_THRESHOLD, ADL_FRACTION_BPS, address(gate)
        );
        assertEq(address(margin), predictedMargin);

        vm.warp(1_000_000 * BUCKET);

        usdc.mint(alice, 1_500);
        vm.prank(alice);
        usdc.approve(address(margin), type(uint256).max);
    }

    function _record(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -8, block.timestamp);
        series.recordSample();
    }

    function _openHealthyLong() internal returns (uint256 positionId) {
        vm.prank(alice);
        margin.deposit(1_500);

        _record(100_000);
        vm.prank(alice);
        positionId = margin.openPosition(address(series), true, 10_000);
    }

    function test_Deposit_CreditsCollateral() public {
        vm.prank(alice);
        margin.deposit(1_500);
        assertEq(margin.collateralOf(alice), 1_500);
        assertEq(usdc.balanceOf(address(margin)), 1_500);
    }

    function test_OpenPosition_RecordsEntryPriceFromCurrentBucket() public {
        uint256 id = _openHealthyLong();
        (address seriesContract, bool isLong, uint256 size, uint256 entryPrice, bool open) =
            margin.positionOf(alice, id);
        assertEq(seriesContract, address(series));
        assertTrue(isLong);
        assertEq(size, 10_000);
        assertEq(entryPrice, 100_000);
        assertTrue(open);
    }

    function test_OpenPosition_RevertsWhenCurrentBucketHasNoRecordedSample() public {
        vm.prank(alice);
        margin.deposit(1_500);
        // Nobody called recordSample in the current bucket.
        vm.prank(alice);
        vm.expectRevert();
        margin.openPosition(address(series), true, 10_000);
    }

    function test_HealthFactor_FullyHealthyAtEntry() public {
        _openHealthyLong();
        // maintenance requirement = 10_000 * 10% = 1_000; equity = 1_500 + 0 pnl.
        assertEq(margin.healthFactor(alice), (1_500 * 1e18) / 1_000);
    }

    function test_Liquidate_RevertsWhenHealthy() public {
        _openHealthyLong();
        vm.expectRevert();
        margin.liquidate(alice, 0);
    }

    /// @notice Load-bearing boundary test: healthFactor exactly at the
    ///         threshold (equity == maintenance requirement) must NOT be
    ///         liquidatable. "< threshold", not "<=".
    function test_Liquidate_RevertsExactlyAtThreshold_NotBefore() public {
        _openHealthyLong();

        vm.warp(block.timestamp + BUCKET);
        _record(95_000); // pnl = 10_000 * (95_000 - 100_000) / 100_000 = -500; equity = 1_000 = maintReq
        assertEq(margin.healthFactor(alice), 1e18);

        vm.expectRevert();
        margin.liquidate(alice, 0);
    }

    /// @notice The other half of the boundary: one tick past the threshold
    ///         (equity < maintenance requirement) is liquidatable, by anyone.
    function test_Liquidate_SucceedsJustBelowThreshold_PermissionlessCaller() public {
        _openHealthyLong();

        vm.warp(block.timestamp + BUCKET);
        _record(94_000); // pnl = -600; equity = 900 < maintReq (1_000)
        assertLt(margin.healthFactor(alice), 1e18);

        uint256 collateralBefore = margin.collateralOf(alice);

        // Liquidated by a random, unrelated address — no keeper allowlist.
        vm.prank(bob);
        margin.liquidate(alice, 0);

        (,,,, bool open) = margin.positionOf(alice, 0);
        assertFalse(open);
        // pnl (-600) plus the 2% liquidation penalty on 10_000 size (200).
        assertEq(margin.collateralOf(alice), collateralBefore - 600 - 200);
        assertEq(usdc.balanceOf(address(fund)), 200);
        // No open positions left -> maximally healthy by definition.
        assertEq(margin.healthFactor(alice), type(uint256).max);
    }

    function test_Liquidate_RevertsOnAlreadyClosedPosition() public {
        _openHealthyLong();
        vm.warp(block.timestamp + BUCKET);
        _record(94_000);
        margin.liquidate(alice, 0);

        vm.expectRevert();
        margin.liquidate(alice, 0);
    }

    function test_ClosePosition_RealizesProfitForOwnerOnly() public {
        _openHealthyLong();

        vm.warp(block.timestamp + BUCKET);
        _record(110_000); // pnl = 10_000 * 10_000 / 100_000 = +1_000

        vm.prank(alice);
        margin.closePosition(0);

        assertEq(margin.collateralOf(alice), 1_500 + 1_000);
        (,,,, bool open) = margin.positionOf(alice, 0);
        assertFalse(open);
    }

    function test_Withdraw_RevertsWhenItWouldBreachMaintenanceMargin() public {
        _openHealthyLong();
        // Withdrawing everything above the 1_000 maintenance requirement
        // leaves headroom; withdrawing past it must revert.
        vm.prank(alice);
        vm.expectRevert();
        margin.withdraw(600); // 1_500 - 600 = 900 < 1_000 maintReq
    }

    function test_Withdraw_SucceedsWhenMarginStaysHealthy() public {
        _openHealthyLong();
        vm.prank(alice);
        margin.withdraw(400); // 1_500 - 400 = 1_100 >= 1_000 maintReq
        assertEq(margin.collateralOf(alice), 1_100);
    }

    /// @notice No-backdoor: a random address cannot forge or reach into
    ///         another account's position ledger. `closePosition` is always
    ///         scoped to `msg.sender`'s own positions, and `liquidate` only
    ///         ever succeeds against a genuinely unhealthy account, for
    ///         anyone — there is no privileged path that skips the health
    ///         check or lets an outsider touch a healthy account's position.
    function test_NoBackdoor_RandomAddressCannotCloseOrForgePositions() public {
        _openHealthyLong(); // alice has position 0, open and healthy

        // bob has no positions of his own; closePosition is scoped to
        // msg.sender, so this cannot reach alice's position 0.
        vm.prank(bob);
        vm.expectRevert();
        margin.closePosition(0);

        // bob also cannot liquidate alice's healthy position.
        vm.prank(bob);
        vm.expectRevert();
        margin.liquidate(alice, 0);

        (,,,, bool open) = margin.positionOf(alice, 0);
        assertTrue(open, "alice's position must be untouched by bob's calls");
    }
}
