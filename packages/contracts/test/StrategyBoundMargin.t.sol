// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { MarginAccount } from "../src/MarginAccount.sol";
import { InsuranceFund } from "../src/InsuranceFund.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { one } from "./helpers/GateFixture.sol";

/**
 * @notice A rule-bound margin account can open positions ONLY through a
 *         passing on-chain evaluation of its own strategy, in the same tx.
 */
contract StrategyBoundMarginTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant BUCKET = 900;
    uint256 constant BASE = 1_000_000;

    MockPyth pyth;
    CanonicalSeries series;
    MockERC20 usdc;
    StrategyRegistry registry;
    RefusalGate gate;
    InsuranceFund fund;
    MarginAccount margin;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 aliceStrategy;

    event TradeRefused(
        uint256 indexed strategyId,
        bytes32 indexed specHash,
        address indexed proposer,
        bytes32 predicateSymbol,
        int256 decidingValue
    );
    event StrategyBound(address indexed account, uint256 indexed strategyId);

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, 1, BUCKET, address(pyth), 60);
        usdc = new MockERC20("USD Coin", "USDC", 18);
        registry = new StrategyRegistry(0.01 ether, 1 days, one(address(series)));
        gate = new RefusalGate(address(registry));

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        fund = new InsuranceFund(address(usdc), predicted);
        margin = new MarginAccount(address(usdc), 1000, address(fund), 200, 1.2e18, 2_500, address(gate));

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        aliceStrategy =
            registry.pinStrategy{ value: 0.01 ether }(keccak256("spec"), keccak256(abi.encode(_preds())), address(series));

        usdc.mint(alice, 100_000);
        usdc.mint(bob, 100_000);
        vm.prank(alice);
        usdc.approve(address(margin), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(margin), type(uint256).max);

        vm.warp(BASE * BUCKET);
        _sample(10_000);
        vm.warp((BASE + 1) * BUCKET);
        _sample(10_100); // bullish BOS (lookback 1) holds at the latest candle
    }

    function _sample(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    function _preds() internal pure returns (RefusalGate.PredicateDefinition[] memory p) {
        p = new RefusalGate.PredicateDefinition[](1);
        p[0] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.BreakOfStructure,
            symbol: "bos_bullish",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 1,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: BUCKET
        });
    }

    function _boundAliceWithCollateral() internal {
        vm.startPrank(alice);
        margin.bindStrategy(aliceStrategy);
        margin.deposit(1_500);
        vm.stopPrank();
    }

    // ---- binding ------------------------------------------------------

    function test_Bind_OnlyTheStrategyOwner_OnlyOnce() public {
        vm.prank(bob);
        vm.expectRevert(MarginAccount.NotStrategyOwner.selector);
        margin.bindStrategy(aliceStrategy);

        vm.prank(alice);
        vm.expectRevert(MarginAccount.NotStrategyOwner.selector);
        margin.bindStrategy(99); // unknown strategy

        vm.expectEmit(true, true, false, true);
        emit StrategyBound(alice, aliceStrategy);
        vm.prank(alice);
        margin.bindStrategy(aliceStrategy);
        assertTrue(margin.isStrategyBound(alice));
        assertEq(margin.boundStrategyOf(alice), aliceStrategy);

        // One-way: there is no unbind, and no re-bind to something else.
        vm.prank(alice);
        vm.expectRevert(MarginAccount.AlreadyBound.selector);
        margin.bindStrategy(aliceStrategy);
    }

    // ---- the only way in is the gate ----------------------------------

    function test_BoundAccount_CannotUseTheUngatedOpen() public {
        _boundAliceWithCollateral();
        vm.prank(alice);
        vm.expectRevert(MarginAccount.AccountIsStrategyBound.selector);
        margin.openPosition(address(series), true, 5_000);
    }

    function testFuzz_BoundAccount_UngatedOpenAlwaysReverts(address anySeries, bool isLong, uint256 size) public {
        _boundAliceWithCollateral();
        vm.prank(alice);
        vm.expectRevert(MarginAccount.AccountIsStrategyBound.selector);
        margin.openPosition(anySeries, isLong, size);
    }

    function test_UnboundAccount_CannotUseTheGuardedOpen() public {
        vm.prank(bob);
        vm.expectRevert(MarginAccount.NotBound.selector);
        margin.openGuardedPosition(true, 5_000, _preds());
    }

    function test_GuardedOpen_OpensWhenThePinnedRulesHold_PricedFromTheStrategySeries() public {
        _boundAliceWithCollateral();
        vm.prank(alice);
        (bool opened, uint256 id) = margin.openGuardedPosition(true, 5_000, _preds());

        assertTrue(opened);
        (address s, bool isLong, uint256 size, uint256 entry, bool open) = margin.positionOf(alice, id);
        assertEq(s, address(series));
        assertTrue(isLong);
        assertEq(size, 5_000);
        assertEq(entry, 10_100);
        assertTrue(open);
    }

    /// @notice Refusal is a success state: the call succeeds, returns false,
    ///         opens nothing, and the gate names the failing predicate.
    function test_GuardedOpen_RefusesWhenTheRulesNoLongerHold() public {
        _boundAliceWithCollateral();
        vm.warp(block.timestamp + BUCKET);
        _sample(10_050); // does not break the previous high

        vm.expectEmit(true, false, true, true, address(gate));
        emit TradeRefused(aliceStrategy, bytes32(0), address(margin), "bos_bullish", 10_050);
        vm.prank(alice);
        (bool opened, uint256 id) = margin.openGuardedPosition(true, 5_000, _preds());

        assertFalse(opened);
        assertEq(id, 0);
        assertEq(margin.positionCount(alice), 0);
    }

    /// @notice The committed rule is bullish: a bound account cannot open a
    ///         short through the gated path even while the rule "holds".
    function test_GuardedOpen_RefusesAShortUnderABullishRule() public {
        _boundAliceWithCollateral();
        vm.prank(alice);
        (bool opened, uint256 id) = margin.openGuardedPosition(false, 5_000, _preds());
        assertFalse(opened);
        assertEq(id, 0);
        assertEq(margin.positionCount(alice), 0);

        vm.prank(alice);
        (opened,) = margin.openGuardedPosition(true, 5_000, _preds());
        assertTrue(opened);
    }

    function test_GuardedOpen_CheaperPredicatesRevert() public {
        _boundAliceWithCollateral();
        RefusalGate.PredicateDefinition[] memory cheaper = _preds();
        cheaper[0].swingLookbackCandles = 1;
        cheaper[0].minGapBps = 0;
        cheaper[0].direction = PredicateEngine.Direction.Short; // any change at all
        vm.prank(alice);
        vm.expectRevert();
        margin.openGuardedPosition(true, 5_000, cheaper);
        assertEq(margin.positionCount(alice), 0);
    }

    function test_GuardedOpen_StaleSeriesReverts() public {
        _boundAliceWithCollateral();
        vm.warp(block.timestamp + BUCKET);
        vm.prank(alice);
        vm.expectRevert();
        margin.openGuardedPosition(true, 5_000, _preds());
    }

    function test_GuardedOpen_StillRespectsTheHealthCheck() public {
        _boundAliceWithCollateral(); // 1_500 collateral, 10% maintenance
        vm.prank(alice);
        vm.expectRevert(MarginAccount.InsufficientCollateral.selector);
        margin.openGuardedPosition(true, 100_000, _preds()); // needs 10_000 maintenance
    }

    // ---- a bound account can always get out ---------------------------

    function test_BoundAccount_CanCloseAndWithdraw_AndIsLiquidatedLikeAnyOther() public {
        _boundAliceWithCollateral();
        vm.prank(alice);
        (, uint256 id) = margin.openGuardedPosition(true, 5_000, _preds());

        vm.prank(alice);
        margin.closePosition(id);
        vm.prank(alice);
        margin.withdraw(1_500);
        assertEq(usdc.balanceOf(alice), 100_000);

        // Re-enter, then get liquidated by a stranger when the market turns.
        vm.prank(alice);
        margin.deposit(600);
        vm.warp(block.timestamp + BUCKET);
        _sample(10_200);
        vm.prank(alice);
        (bool opened, uint256 id2) = margin.openGuardedPosition(true, 5_000, _preds());
        assertTrue(opened);
        vm.warp(block.timestamp + BUCKET);
        _sample(9_000); // -11.7%: equity 600 - 588 = 12 vs maintenance 500
        vm.prank(bob);
        margin.liquidate(alice, id2);
        (,,,, bool stillOpen) = margin.positionOf(alice, id2);
        assertFalse(stillOpen);
    }

    function test_UnboundAccount_IsUnaffected() public {
        vm.startPrank(bob);
        margin.deposit(1_500);
        uint256 id = margin.openPosition(address(series), false, 5_000);
        vm.stopPrank();
        (,, uint256 size,,) = margin.positionOf(bob, id);
        assertEq(size, 5_000);
    }
}
