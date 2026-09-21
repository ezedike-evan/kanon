// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { GuardedVault } from "../src/GuardedVault.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { one } from "./helpers/GateFixture.sol";

/**
 * @title GuardedVaultTest
 * @notice `proposeTrade` now routes its predicate-satisfaction check through
 *         `RefusalGate.evaluateOnChain` / `PredicateEngine` (README item 7,
 *         now resolved) instead of trusting an attestation. Every test plants
 *         a trivially satisfiable break-of-structure predicate on a real
 *         `CanonicalSeries` — swing-lookback 1, a second candle whose close
 *         crosses the first candle's high — so the whitelist and
 *         daily-drawdown assertions inherited from the original stub-era
 *         suite exercise exactly the same guardrail behavior as before, with
 *         one new, real gate in front of them. `test_ProposeTrade_Refuses...
 *         PredicateNotSatisfied` covers the new gate itself.
 */
contract GuardedVaultTest is Test {
    bytes32 constant BTC = keccak256("BTC-USD");
    bytes32 constant ETH = keccak256("ETH-USD");
    bytes32 constant DOGE = keccak256("DOGE-USD"); // deliberately not whitelisted

    uint256 constant MAX_DAILY_DRAWDOWN_BPS = 1_000; // 10%

    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant CADENCE = 1;
    uint256 constant BUCKET = 900;
    uint256 constant MAX_AGE = 60;
    uint256 constant BASE_BUCKET = 1_000_000;

    bytes32 constant SPEC_HASH = keccak256("spec");

    MockERC20 usdc;
    MockPyth pyth;
    CanonicalSeries series;
    StrategyRegistry registry;
    RefusalGate refusalGate;
    GuardedVault vault;
    uint256 strategyId;
    uint256 refusedStrategyId; // pinned with the bearish predicates, which the tape does not satisfy

    address owner = address(0xA11CE);
    address executor = address(0xEEEE);
    address rando = address(0xB0B);

    event TradeProposed(
        bytes32 indexed assetId, address indexed proposer, bool isLong, uint256 size, int256 projectedPnL
    );
    event TradeRefused(bytes32 indexed assetId, address indexed proposer, bytes32 reason, int256 decidingValue);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 18);
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
        registry = new StrategyRegistry(0.01 ether, 3 days, one(address(series)));
        refusalGate = new RefusalGate(address(registry));

        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        strategyId = registry.pinStrategy{ value: 0.01 ether }(
            SPEC_HASH, keccak256(abi.encode(_satisfiedPredicates())), address(series)
        );
        refusedStrategyId = registry.pinStrategy{ value: 0.01 ether }(
            SPEC_HASH, keccak256(abi.encode(_refusedPredicates())), address(series)
        );
        vm.stopPrank();

        bytes32[] memory whitelist = new bytes32[](2);
        whitelist[0] = BTC;
        whitelist[1] = ETH;

        vault = new GuardedVault(
            address(usdc),
            owner,
            executor,
            address(registry),
            strategyId,
            whitelist,
            MAX_DAILY_DRAWDOWN_BPS,
            address(refusalGate)
        );

        usdc.mint(owner, 10_000);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(owner);
        vault.deposit(10_000);

        // A trivially satisfiable break-of-structure predicate: lookback 1,
        // candle 1's close (101.00) crosses candle 0's high (100.00).
        vm.warp(BASE_BUCKET * BUCKET);
        _sampleAt(9_900); // candle 0 open
        vm.warp(BASE_BUCKET * BUCKET + 1);
        _sampleAt(10_000); // candle 0 high (and close)
        vm.warp((BASE_BUCKET + 1) * BUCKET);
        _sampleAt(10_100); // candle 1: open == high == low == close
    }

    function _sampleAt(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    function _satisfiedPredicates() internal pure returns (RefusalGate.PredicateDefinition[] memory predicates) {
        predicates = new RefusalGate.PredicateDefinition[](1);
        predicates[0] = RefusalGate.PredicateDefinition({
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

    /// @dev The same two planted candles as `_satisfiedPredicates`, but
    ///      checked `short`: candle 1's close (101.00) does not cross candle
    ///      0's low (99.00) downward, so `PredicateEngine` evaluates cleanly
    ///      (no revert) and reports `satisfied == false` — the real, graceful
    ///      refusal path `test_ProposeTrade_RefusesWhenPredicateNotSatisfied`
    ///      exercises.
    function _refusedPredicates() internal pure returns (RefusalGate.PredicateDefinition[] memory predicates) {
        predicates = new RefusalGate.PredicateDefinition[](1);
        predicates[0] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.BreakOfStructure,
            symbol: "bos_bearish",
            direction: PredicateEngine.Direction.Short,
            swingLookbackCandles: 1,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: BUCKET
        });
    }

    function test_Constructor_RevertsOnEmptyWhitelist() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.expectRevert();
        new GuardedVault(
            address(usdc), owner, executor, address(registry), 0, empty, MAX_DAILY_DRAWDOWN_BPS, address(refusalGate)
        );
    }

    function test_IsWhitelisted_ReflectsConstructorSet() public view {
        assertTrue(vault.isWhitelisted(BTC));
        assertTrue(vault.isWhitelisted(ETH));
        assertFalse(vault.isWhitelisted(DOGE));
    }

    /// @notice Load-bearing: a non-whitelisted asset is refused, not
    ///         reverted — refusal is a success state, per CLAUDE.md. The
    ///         whitelist check happens before the (now real) predicate check,
    ///         so an unsatisfiable predicate array doesn't matter here.
    function test_ProposeTrade_RefusesNonWhitelistedAsset() public {
        vm.expectEmit(true, true, false, true);
        emit TradeRefused(DOGE, executor, "ASSET_NOT_WHITELISTED", 0);

        vm.prank(executor);
        bool allowed = vault.proposeTrade(DOGE, true, 1_000, 50, _satisfiedPredicates());

        assertFalse(allowed);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), 0, "refused trade must not touch the ledger");
    }

    function test_ProposeTrade_AllowsWhitelistedAssetWithinDrawdown() public {
        vm.expectEmit(true, true, false, true);
        emit TradeProposed(BTC, executor, true, 1_000, -500);

        vm.prank(executor);
        bool allowed = vault.proposeTrade(BTC, true, 1_000, -500, _satisfiedPredicates());

        assertTrue(allowed);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), -500);
    }

    function _vaultFor(uint256 sid) internal returns (GuardedVault v) {
        bytes32[] memory whitelist = new bytes32[](2);
        whitelist[0] = BTC;
        whitelist[1] = ETH;
        v = new GuardedVault(
            address(usdc), owner, executor, address(registry), sid, whitelist, MAX_DAILY_DRAWDOWN_BPS, address(refusalGate)
        );
        usdc.mint(owner, 10_000);
        vm.startPrank(owner);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(10_000);
        vm.stopPrank();
    }

    /// @notice The gate: a real, on-chain-evaluated predicate that is not
    ///         satisfied refuses the trade before the drawdown check ever
    ///         runs, and never touches the P&L ledger — same "refusal is a
    ///         success state" shape as the whitelist and drawdown guardrails.
    ///         The vault is bound to a strategy whose pinned (bearish)
    ///         predicates the rising tape does not satisfy.
    function test_ProposeTrade_RefusesWhenPredicateNotSatisfied() public {
        GuardedVault refusedVault = _vaultFor(refusedStrategyId);

        // `refusalGate.evaluateOnChain` emits its own (differently-shaped)
        // TradeRefused first, with the specific predicate symbol/value; filter
        // by emitter so this matches only the vault's own generic log.
        vm.expectEmit(true, true, false, true, address(refusedVault));
        emit TradeRefused(BTC, executor, "PREDICATE_NOT_SATISFIED", 0);

        vm.prank(executor);
        bool allowed = refusedVault.proposeTrade(BTC, true, 1_000, -500, _refusedPredicates());

        assertFalse(allowed);
        assertEq(refusedVault.dailyRealizedPnL(block.timestamp / 1 days), 0, "refused trade must not touch the ledger");
    }

    /// @notice A bullish rule (the vault's committed predicates) never approves a
    ///         short, even though the tape satisfies it; a refusal, not a revert.
    function test_ProposeTrade_RefusesAShortUnderABullishRule() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit TradeRefused(BTC, executor, "PREDICATE_NOT_SATISFIED", 0);
        vm.prank(executor);
        bool allowed = vault.proposeTrade(BTC, false, 1_000, 0, _satisfiedPredicates());
        assertFalse(allowed);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), 0);

        vm.prank(executor);
        assertTrue(vault.proposeTrade(BTC, true, 1_000, 0, _satisfiedPredicates()));
    }

    /// @notice A proposer cannot swap in easier predicates: they must hash to
    ///         the strategy's pinned commitment. A caller error, so it reverts.
    function test_ProposeTrade_RevertsWhenPredicatesAreNotTheCommittedOnes() public {
        // `vault` is bound to the strategy that committed to the bullish
        // predicates. Handing it the bearish array instead must revert.
        vm.prank(executor);
        vm.expectRevert();
        vault.proposeTrade(BTC, true, 1_000, -500, _refusedPredicates());

        // A tampered copy of the right ones is rejected the same way.
        RefusalGate.PredicateDefinition[] memory tampered = _satisfiedPredicates();
        tampered[0].minGapBps = 1;
        vm.prank(executor);
        vm.expectRevert();
        vault.proposeTrade(BTC, true, 1_000, -500, tampered);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), 0);
    }

    /// @notice A stale series cannot approve a trade: the vault call reverts
    ///         until somebody records a sample in the current bucket.
    function test_ProposeTrade_RevertsOnStaleSeries_ThenWorksOnceFreshened() public {
        vm.warp(block.timestamp + BUCKET);
        vm.prank(executor);
        vm.expectRevert();
        vault.proposeTrade(BTC, true, 1_000, -500, _satisfiedPredicates());

        _sampleAt(10_200); // a new higher close: still breaks candle 1's high
        vm.prank(executor);
        assertTrue(vault.proposeTrade(BTC, true, 1_000, -500, _satisfiedPredicates()));
    }

    /// @notice There is no approval to replay: a pass in one bucket does not
    ///         carry to the next, where the same call is evaluated against the
    ///         new tape (which no longer breaks structure) and refused.
    function test_ProposeTrade_ApprovalDoesNotReplayAcrossBuckets() public {
        vm.prank(executor);
        assertTrue(vault.proposeTrade(BTC, true, 1_000, 0, _satisfiedPredicates()));

        vm.warp(block.timestamp + BUCKET);
        _sampleAt(10_050); // below candle 1's high: no break of structure now
        vm.prank(executor);
        assertFalse(vault.proposeTrade(BTC, true, 1_000, 0, _satisfiedPredicates()));
    }

    /// @notice Calling the gate directly authorizes nothing: it emits events
    ///         but the vault reads no stored approval, so its ledger and every
    ///         guardrail are untouched and still enforced on its own call.
    function test_DirectGateCallDoesNotAuthorizeAnythingInTheVault() public {
        vm.prank(rando);
        assertTrue(refusalGate.evaluateOnChain(strategyId, true, _satisfiedPredicates()));
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), 0);

        // The vault still refuses on its own terms.
        vm.prank(executor);
        assertFalse(vault.proposeTrade(DOGE, true, 1_000, 0, _satisfiedPredicates()));
    }

    /// @notice Load-bearing: a single trade whose projected loss alone
    ///         breaches the daily cap is refused, not reverted, and never
    ///         touches the ledger.
    function test_ProposeTrade_RefusesWhenSingleTradeBreachesDrawdownCap() public {
        // referenceBalance = 10_000, cap = 10%, max loss = -1_000.
        vm.expectEmit(true, true, false, true);
        emit TradeRefused(BTC, executor, "DAILY_DRAWDOWN_EXCEEDED", -1_001);

        vm.prank(executor);
        bool allowed = vault.proposeTrade(BTC, true, 5_000, -1_001, _satisfiedPredicates());

        assertFalse(allowed);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), 0);
    }

    /// @notice Load-bearing: cumulative losses across multiple allowed trades
    ///         in the same UTC day still trip the cap on the trade that
    ///         would push the cumulative total past it — and the ledger
    ///         stops exactly at the last *allowed* value, not the refused one.
    function test_ProposeTrade_RefusesWhenCumulativeLossBreachesDrawdownCap() public {
        vm.startPrank(executor);

        bool first = vault.proposeTrade(BTC, true, 2_000, -500, _satisfiedPredicates());
        assertTrue(first);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), -500);

        // -500 + -600 = -1_100, past the -1_000 cap.
        bool second = vault.proposeTrade(ETH, false, 2_000, -600, _satisfiedPredicates());
        assertFalse(second);
        assertEq(vault.dailyRealizedPnL(block.timestamp / 1 days), -500, "refused trade must not move the ledger");

        vm.stopPrank();
    }

    function test_ProposeTrade_OwnerMayAlsoPropose() public {
        vm.prank(owner);
        bool allowed = vault.proposeTrade(BTC, true, 1_000, 100, _satisfiedPredicates());
        assertTrue(allowed);
    }

    /// @notice No-backdoor: nobody outside {owner, strategyExecutor} can even
    ///         attempt a trade proposal, and only `owner` can withdraw — a
    ///         compromised executor key still cannot move funds out.
    function test_NoBackdoor_RandomAddressCannotProposeTradeOrWithdraw() public {
        vm.prank(rando);
        vm.expectRevert();
        vault.proposeTrade(BTC, true, 1_000, 10, _satisfiedPredicates());

        vm.prank(rando);
        vm.expectRevert();
        vault.withdraw(1);

        vm.prank(executor);
        vm.expectRevert();
        vault.withdraw(1); // even the executor cannot withdraw, only owner
    }
}
