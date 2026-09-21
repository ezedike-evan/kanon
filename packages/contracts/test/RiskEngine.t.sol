// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { deployGate, two } from "./helpers/GateFixture.sol";

/**
 * @title RiskEngineTest
 * @notice Risk engine v1: partial de-leveraging (ADL), the liquidation
 *         penalty, cross-margin debt, and the insurance fund's shortfall
 *         cover. Numbers are chosen so every expected value is hand-derivable
 *         (10% maintenance, 100_000 entry, 10_000 size => 1 price tick of
 *         1_000 is 100 collateral units of PnL).
 */
contract RiskEngineTest is Test {
    bytes32 constant FEED_A = bytes32(uint256(1));
    bytes32 constant FEED_B = bytes32(uint256(2));
    uint256 constant CADENCE = 300;
    uint256 constant BUCKET = 900;
    uint256 constant MAX_AGE = 60;
    uint256 constant MAINTENANCE_BPS = 1000; // 10%
    uint256 constant PENALTY_BPS = 200; // 2%
    uint256 constant ADL_THRESHOLD = 1.2e18;
    uint256 constant ADL_FRACTION_BPS = 2_500; // 25%

    MockPyth pyth;
    CanonicalSeries seriesA;
    CanonicalSeries seriesB;
    MockERC20 usdc;
    MarginAccount margin;
    InsuranceFund fund;
    RefusalGate gate;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    event PositionDeleveraged(
        address indexed account,
        uint256 indexed positionId,
        uint256 closedSize,
        uint256 remainingSize,
        uint256 exitPrice,
        int256 pnl,
        uint256 healthFactorBefore,
        uint256 healthFactorAfter
    );
    event LiquidationPenaltyCharged(address indexed account, uint256 indexed positionId, uint256 penalty);
    event DebtIncurred(address indexed account, uint256 amount);
    event DebtRepaid(address indexed account, uint256 amount);
    event BadDebtResolved(address indexed account, uint256 debt, uint256 coveredByFund, uint256 uncovered);
    event ShortfallCovered(uint256 requested, uint256 covered);

    function setUp() public {
        pyth = new MockPyth();
        seriesA = new CanonicalSeries("BTC/USD", FEED_A, CADENCE, BUCKET, address(pyth), MAX_AGE);
        seriesB = new CanonicalSeries("ETH/USD", FEED_B, CADENCE, BUCKET, address(pyth), MAX_AGE);
        usdc = new MockERC20("USD Coin", "USDC", 18);

        (, gate) = deployGate(two(address(seriesA), address(seriesB)));
        address predictedMargin = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fund = new InsuranceFund(address(usdc), predictedMargin);
        margin = new MarginAccount(
            address(usdc), MAINTENANCE_BPS, address(fund), PENALTY_BPS, ADL_THRESHOLD, ADL_FRACTION_BPS, address(gate)
        );

        vm.warp(1_000_000 * BUCKET);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 100_000);
            vm.prank(users[i]);
            usdc.approve(address(margin), type(uint256).max);
            vm.prank(users[i]);
            usdc.approve(address(fund), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _recordA(int64 price) internal {
        pyth.setPrice(FEED_A, price, 1, -8, block.timestamp);
        seriesA.recordSample();
    }

    function _recordB(int64 price) internal {
        pyth.setPrice(FEED_B, price, 1, -8, block.timestamp);
        seriesB.recordSample();
    }

    /// @dev Moves to the next bucket and records a new close on series A.
    function _moveA(int64 price) internal {
        vm.warp(block.timestamp + BUCKET);
        _recordA(price);
    }

    function _moveBoth(int64 priceA, int64 priceB) internal {
        vm.warp(block.timestamp + BUCKET);
        _recordA(priceA);
        _recordB(priceB);
    }

    function _depositAndOpenLong(address who, uint256 collateral, uint256 size) internal returns (uint256 id) {
        vm.prank(who);
        margin.deposit(collateral);
        _recordA(100_000);
        vm.prank(who);
        id = margin.openPosition(address(seriesA), true, size);
    }

    function _assertLedgerIdentity() internal view {
        assertEq(
            int256(usdc.balanceOf(address(margin))), int256(margin.totalCollateral()) + margin.counterpartyBalance()
        );
    }

    // ------------------------------------------------------------------
    // ADL v1
    // ------------------------------------------------------------------

    function test_Deleverage_ClosesQuarterOfLargestPosition_InBand_Permissionless() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(96_000); // pnl -400, equity 1_100, maint 1_000, h = 1.1e18 (in [1.0, 1.2))
        assertEq(margin.healthFactor(alice), 1.1e18);

        vm.expectEmit(true, true, false, true);
        emit PositionDeleveraged(alice, 0, 2_500, 7_500, 96_000, -100, 1.1e18, uint256(1_100 * 1e18) / 750);
        vm.prank(bob); // a stranger
        (uint256 id, uint256 closed) = margin.deleverage(alice);

        assertEq(id, 0);
        assertEq(closed, 2_500);
        (,, uint256 size, uint256 entry, bool open) = margin.positionOf(alice, 0);
        assertEq(size, 7_500);
        assertEq(entry, 100_000, "entry price of the remainder is unchanged");
        assertTrue(open);
        // slice PnL = 2_500 * -4_000 / 100_000 = -100 realized into collateral.
        assertEq(margin.collateralOf(alice), 1_400);
        // equity unchanged (1_400 - 300), maint fell to 750 -> health rose.
        assertEq(margin.healthFactor(alice), uint256(1_100 * 1e18) / 750);
        assertGt(margin.healthFactor(alice), 1.1e18);
        // ADL charges no penalty and pays the fund nothing.
        assertEq(usdc.balanceOf(address(fund)), 0);
        _assertLedgerIdentity();
    }

    function test_Deleverage_RevertsWhenHealthyAboveThreshold() public {
        _depositAndOpenLong(alice, 1_500, 10_000); // h = 1.5e18
        vm.expectRevert(MarginAccount.NotDeleverageable.selector);
        margin.deleverage(alice);
    }

    function test_Deleverage_RevertsExactlyAtUpperThreshold_StrictBoundary() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(97_000); // pnl -300, equity 1_200, h == 1.2e18 exactly
        assertEq(margin.healthFactor(alice), ADL_THRESHOLD);
        vm.expectRevert(MarginAccount.NotDeleverageable.selector);
        margin.deleverage(alice);
    }

    function test_Deleverage_AllowedExactlyAtLiquidationThreshold_WhichIsNotLiquidatable() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(95_000); // equity 1_000 == maint -> h == 1e18
        assertEq(margin.healthFactor(alice), 1e18);

        vm.expectRevert(MarginAccount.NotLiquidatable.selector);
        margin.liquidate(alice, 0);

        margin.deleverage(alice); // in band [1.0, 1.2): allowed
        (,, uint256 size,,) = margin.positionOf(alice, 0);
        assertEq(size, 7_500);
    }

    function test_Deleverage_RevertsWhenLiquidatable_LiquidationIsTheOnlyPath() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(94_000); // h < 1
        assertLt(margin.healthFactor(alice), 1e18);
        vm.expectRevert(MarginAccount.NotDeleverageable.selector);
        margin.deleverage(alice);
    }

    function test_Deleverage_RevertsWhenAccountHasNoPositions() public {
        vm.prank(alice);
        margin.deposit(1_500);
        vm.expectRevert(MarginAccount.NotDeleverageable.selector);
        margin.deleverage(alice);
    }

    function test_Deleverage_PicksLargestPosition_NotTheFirst() public {
        vm.prank(alice);
        margin.deposit(1_500);
        _recordA(100_000);
        vm.startPrank(alice);
        margin.openPosition(address(seriesA), true, 4_000); // id 0
        margin.openPosition(address(seriesA), true, 6_000); // id 1, largest
        vm.stopPrank();

        _moveA(96_000); // pnl -400 total, equity 1_100, maint 1_000 -> h 1.1
        (uint256 id, uint256 closed) = margin.deleverage(alice);

        assertEq(id, 1);
        assertEq(closed, 1_500);
        (,, uint256 size0,,) = margin.positionOf(alice, 0);
        (,, uint256 size1,,) = margin.positionOf(alice, 1);
        assertEq(size0, 4_000);
        assertEq(size1, 4_500);
    }

    function test_Deleverage_TieBreaksToLowestPositionId() public {
        vm.prank(alice);
        margin.deposit(1_500);
        _recordA(100_000);
        vm.startPrank(alice);
        margin.openPosition(address(seriesA), true, 5_000); // id 0
        margin.openPosition(address(seriesA), true, 5_000); // id 1
        vm.stopPrank();

        _moveA(96_000);
        (uint256 id,) = margin.deleverage(alice);
        assertEq(id, 0);
    }

    function test_Deleverage_TieBreakIsIndependentOfOpenListOrder() public {
        // Close id 0 so the open list is reordered by swap-and-pop, then tie
        // on the remaining two: lowest id (1) must still win.
        vm.prank(alice);
        margin.deposit(3_000);
        _recordA(100_000);
        vm.startPrank(alice);
        margin.openPosition(address(seriesA), true, 1_000); // id 0
        margin.openPosition(address(seriesA), true, 5_000); // id 1
        margin.openPosition(address(seriesA), true, 5_000); // id 2
        margin.closePosition(0); // open list is now [2, 1] after swap-and-pop
        vm.stopPrank();

        // equity 3_000 + pnl; maint 1_000. h in [1.0, 1.2) <=> equity in [1_000, 1_200)
        // 10_000 size * diff/100_000 => need pnl -1_900: unreachable at this size.
        // Use a much bigger move instead: -19% on 10_000 = -1_900.
        _moveA(81_000);
        assertGe(margin.healthFactor(alice), 1e18);
        assertLt(margin.healthFactor(alice), ADL_THRESHOLD);
        (uint256 id,) = margin.deleverage(alice);
        assertEq(id, 1);
    }

    function test_Deleverage_RepeatedCallsStopOnceHealthy() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(96_000);
        margin.deleverage(alice); // h -> 1.4667e18, above the 1.2e18 threshold
        vm.expectRevert(MarginAccount.NotDeleverageable.selector);
        margin.deleverage(alice);
    }

    function test_Deleverage_MultiPosition_RealizesOnlyTheLargestPositionsSlice() public {
        // Two positions on two series: a big loser and a winner. Only the
        // largest position's slice is realized; the winner is untouched.
        vm.prank(alice);
        margin.deposit(1_000);
        _recordA(100_000);
        _recordB(100_000);
        vm.startPrank(alice);
        margin.openPosition(address(seriesA), true, 4_000); // id 0: loser (largest)
        margin.openPosition(address(seriesB), false, 3_000); // id 1: winner (short)
        vm.stopPrank();

        // A -30%: long 4_000 loses 1_200. B -30%: short 3_000 gains 900.
        // equity = 1_000 - 1_200 + 900 = 700 == maint 700 -> h == 1.0 (in band).
        _moveBoth(70_000, 70_000);
        assertEq(margin.healthFactor(alice), 1e18);

        (uint256 id, uint256 closed) = margin.deleverage(alice);
        assertEq(id, 0);
        assertEq(closed, 1_000);
        // slice pnl = 1_000 * -30_000 / 100_000 = -300, taken from the 1_000 collateral.
        assertEq(margin.collateralOf(alice), 700);
        assertEq(margin.debtOf(alice), 0);
        (,, uint256 winnerSize,,) = margin.positionOf(alice, 1);
        assertEq(winnerSize, 3_000, "the winner is untouched");
        _assertLedgerIdentity();
    }

    // ------------------------------------------------------------------
    // Liquidation penalty + insurance fund
    // ------------------------------------------------------------------

    function test_Liquidate_ChargesPenaltyToFund_CallerReceivesNothing() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(94_000); // pnl -600, collateral after loss 900, penalty 2% of 10_000 = 200

        uint256 bobBefore = usdc.balanceOf(bob);
        vm.expectEmit(true, true, false, true);
        emit LiquidationPenaltyCharged(alice, 0, 200);
        vm.prank(bob);
        margin.liquidate(alice, 0);

        assertEq(usdc.balanceOf(bob), bobBefore, "liquidator is not paid");
        assertEq(margin.collateralOf(alice), 700);
        assertEq(usdc.balanceOf(address(fund)), 200);
        assertEq(fund.totalPenaltiesReceived(), 200);
        _assertLedgerIdentity();
    }

    function test_Liquidate_PenaltyIsCappedAtRemainingCollateral() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(85_000); // pnl -1_500: collateral 0 exactly, no debt, penalty capped to 0
        margin.liquidate(alice, 0);
        assertEq(margin.collateralOf(alice), 0);
        assertEq(margin.debtOf(alice), 0);
        assertEq(usdc.balanceOf(address(fund)), 0);
        _assertLedgerIdentity();
    }

    function test_Liquidate_PenaltyTakesWhatIsLeftWhenLessThanFullPenalty() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(86_000); // pnl -1_400: 100 left; full penalty would be 200 -> capped at 100
        margin.liquidate(alice, 0);
        assertEq(margin.collateralOf(alice), 0);
        assertEq(usdc.balanceOf(address(fund)), 100);
        _assertLedgerIdentity();
    }

    function test_Liquidate_ShortfallCoveredByFund() public {
        vm.prank(carol);
        fund.deposit(1_000); // explicit top-up
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(80_000); // pnl -2_000: 500 beyond collateral

        vm.expectEmit(true, false, false, true);
        emit DebtIncurred(alice, 500);
        vm.expectEmit(false, false, false, true);
        emit ShortfallCovered(500, 500);
        vm.expectEmit(true, false, false, true);
        emit BadDebtResolved(alice, 500, 500, 0);
        margin.liquidate(alice, 0);

        assertEq(margin.collateralOf(alice), 0);
        assertEq(margin.debtOf(alice), 0);
        assertEq(margin.uncoveredBadDebt(), 0);
        assertEq(usdc.balanceOf(address(fund)), 500);
        assertEq(fund.totalShortfallCovered(), 500);
        // The margin holds alice's 1_500 plus the fund's 500 = the full 2_000 loss.
        assertEq(usdc.balanceOf(address(margin)), 2_000);
        assertEq(margin.counterpartyBalance(), 2_000);
        _assertLedgerIdentity();
    }

    function test_Liquidate_ShortfallBeyondFundIsRecordedNotSocialized() public {
        // A bystander with healthy collateral must be untouched.
        vm.prank(bob);
        margin.deposit(5_000);

        vm.prank(carol);
        fund.deposit(300);
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(80_000); // shortfall 500, fund holds 300

        margin.liquidate(alice, 0);

        assertEq(margin.uncoveredBadDebt(), 200);
        assertEq(usdc.balanceOf(address(fund)), 0);
        assertEq(margin.collateralOf(bob), 5_000, "nobody else's collateral is socialized");
        assertEq(margin.debtOf(alice), 0, "resolved (written off) once flat");
        _assertLedgerIdentity();
    }

    function test_Liquidate_ShortfallWithEmptyFundIsAllUncovered() public {
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(80_000);
        margin.liquidate(alice, 0);
        assertEq(margin.uncoveredBadDebt(), 500);
        _assertLedgerIdentity();
    }

    function test_Penalties_FundLaterShortfalls() public {
        // First liquidation pays a penalty into the fund...
        _depositAndOpenLong(alice, 1_500, 10_000);
        _moveA(94_000);
        margin.liquidate(alice, 0);
        assertEq(usdc.balanceOf(address(fund)), 200);

        // ...which then covers part of a later shortfall.
        vm.prank(bob);
        margin.deposit(1_500);
        _moveA(100_000);
        vm.prank(bob);
        margin.openPosition(address(seriesA), true, 10_000);
        _moveA(80_000); // shortfall 500; fund has 200
        margin.liquidate(bob, 0);
        assertEq(usdc.balanceOf(address(fund)), 0);
        assertEq(margin.uncoveredBadDebt(), 300);
        _assertLedgerIdentity();
    }

    // ------------------------------------------------------------------
    // Cross-margin debt: the loss cannot be written off while winners remain
    // ------------------------------------------------------------------

    function _openLongAShortB(uint256 collateral) internal {
        vm.prank(alice);
        margin.deposit(collateral);
        _recordA(100_000);
        _recordB(100_000);
        vm.startPrank(alice);
        margin.openPosition(address(seriesA), true, 10_000); // id 0: long A
        margin.openPosition(address(seriesB), false, 10_000); // id 1: short B
        vm.stopPrank();
    }

    function test_Liquidate_LoserWhileWinnerOpen_BecomesDebt_FundUntouched() public {
        _openLongAShortB(3_000);
        // A -40% => long loses 4_000. B -29% => short gains 2_900. equity 1_900 < maint 2_000.
        _moveBoth(60_000, 71_000);
        assertLt(margin.healthFactor(alice), 1e18);

        vm.expectEmit(true, false, false, true);
        emit DebtIncurred(alice, 1_000);
        margin.liquidate(alice, 0);

        assertEq(margin.collateralOf(alice), 0);
        assertEq(margin.debtOf(alice), 1_000);
        assertEq(margin.uncoveredBadDebt(), 0);
        assertEq(fund.totalShortfallCovered(), 0, "no fund draw while the winner can still cover it");
        assertEq(margin.openPositionCount(alice), 1);
        _assertLedgerIdentity();

        // equity still counts the debt: 0 - 1_000 + 2_900 = 1_900, maint 1_000.
        assertEq(margin.healthFactor(alice), (1_900 * 1e18) / 1_000);

        // Closing the winner nets against the debt; the owner ends with the
        // account's true equity, not more.
        vm.prank(alice);
        margin.closePosition(1);
        assertEq(margin.debtOf(alice), 0);
        assertEq(margin.collateralOf(alice), 1_900);
        _assertLedgerIdentity();
    }

    function test_Debt_DepositRepaysDebtBeforeCreditingCollateral() public {
        _openLongAShortB(3_000);
        _moveBoth(60_000, 71_000);
        margin.liquidate(alice, 0);
        assertEq(margin.debtOf(alice), 1_000);

        vm.expectEmit(true, false, false, true);
        emit DebtRepaid(alice, 1_000);
        vm.prank(alice);
        margin.deposit(1_500);

        assertEq(margin.debtOf(alice), 0);
        assertEq(margin.collateralOf(alice), 500);
        _assertLedgerIdentity();
    }

    function test_Debt_PartialDepositOnlyReducesDebt() public {
        _openLongAShortB(3_000);
        _moveBoth(60_000, 71_000);
        margin.liquidate(alice, 0);

        vm.prank(alice);
        margin.deposit(400);
        assertEq(margin.debtOf(alice), 600);
        assertEq(margin.collateralOf(alice), 0);
        _assertLedgerIdentity();
    }

    function test_Debt_BlocksWithdraw() public {
        _openLongAShortB(3_000);
        _moveBoth(60_000, 71_000);
        margin.liquidate(alice, 0);
        vm.prank(alice);
        vm.expectRevert(MarginAccount.InsufficientCollateral.selector);
        margin.withdraw(1);
    }

    function test_Debt_LastPositionClosedAtALoss_ResolvesThroughFund() public {
        vm.prank(carol);
        fund.deposit(1_000);
        _openLongAShortB(3_000);
        _moveBoth(60_000, 71_000);
        margin.liquidate(alice, 0); // debt 1_000, short B still open (+2_900)

        // B reverses hard before alice closes it: B back to 130_000 => short loses 3_000.
        _moveBoth(60_000, 130_000);
        vm.prank(alice);
        margin.closePosition(1);

        // debt was 1_000; closing B realizes -3_000 => debt 4_000, flat => fund covers 1_000, 3_000 uncovered.
        assertEq(margin.debtOf(alice), 0);
        assertEq(fund.totalShortfallCovered(), 1_000);
        assertEq(margin.uncoveredBadDebt(), 3_000);
        _assertLedgerIdentity();
    }

    // ------------------------------------------------------------------
    // Guard rails
    // ------------------------------------------------------------------

    function test_OpenPosition_RevertsBeyondMaxOpenPositions() public {
        vm.prank(alice);
        margin.deposit(50_000);
        _recordA(100_000);
        uint256 max = margin.MAX_OPEN_POSITIONS();
        vm.startPrank(alice);
        for (uint256 i = 0; i < max; i++) {
            margin.openPosition(address(seriesA), true, 100);
        }
        vm.expectRevert(MarginAccount.TooManyOpenPositions.selector);
        margin.openPosition(address(seriesA), true, 100);

        // Closing one frees a slot.
        margin.closePosition(0);
        margin.openPosition(address(seriesA), true, 100);
        vm.stopPrank();
    }

    function test_OpenPosition_RevertsOnAbsurdSize() public {
        vm.prank(alice);
        margin.deposit(1_500);
        _recordA(100_000);
        uint256 tooBig = uint256(type(uint128).max) + 1;
        vm.prank(alice);
        vm.expectRevert(MarginAccount.SizeTooLarge.selector);
        margin.openPosition(address(seriesA), true, tooBig);
    }

    function test_Constructor_RejectsFundBoundToAnotherMargin() public {
        InsuranceFund wrong = new InsuranceFund(address(usdc), address(0xDEAD));
        vm.expectRevert("fund bound to another margin");
        new MarginAccount(address(usdc), MAINTENANCE_BPS, address(wrong), PENALTY_BPS, ADL_THRESHOLD, ADL_FRACTION_BPS, address(gate));
    }

    function test_Constructor_RejectsFundWithDifferentToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InsuranceFund f = new InsuranceFund(address(other), predicted);
        vm.expectRevert("fund token mismatch");
        new MarginAccount(address(usdc), MAINTENANCE_BPS, address(f), PENALTY_BPS, ADL_THRESHOLD, ADL_FRACTION_BPS, address(gate));
    }

    function test_Constructor_RejectsBadAdlParameters() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        InsuranceFund f = new InsuranceFund(address(usdc), predicted);

        vm.expectRevert("invalid adl threshold");
        new MarginAccount(address(usdc), MAINTENANCE_BPS, address(f), PENALTY_BPS, 1e18, ADL_FRACTION_BPS, address(gate));

        predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        f = new InsuranceFund(address(usdc), predicted);
        vm.expectRevert("invalid adl fraction");
        new MarginAccount(address(usdc), MAINTENANCE_BPS, address(f), PENALTY_BPS, ADL_THRESHOLD, 10_000, address(gate));
    }
}
