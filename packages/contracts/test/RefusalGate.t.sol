// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test, Vm } from "forge-std/Test.sol";
import { StrategyRegistry } from "../src/StrategyRegistry.sol";
import { RefusalGate } from "../src/RefusalGate.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { MockPyth } from "./mocks/MockPyth.sol";
import { two } from "./helpers/GateFixture.sol";

/// @dev Exposes the internal window rule so it can be tested directly.
contract WindowHarness {
    function windowStart(
        PredicateEngine.PredicateKind kind,
        uint256 swing,
        PredicateEngine.ReferenceExtreme ref,
        PredicateEngine.Lookback lookback,
        uint256 latest,
        uint256 bucketSeconds
    ) external pure returns (uint256) {
        return PredicateEngine.windowStart(kind, swing, ref, lookback, latest, bucketSeconds);
    }
}

/**
 * @title RefusalGateTest
 * @notice The gate is adversarially tested: every field a proposer used to
 *         control (predicates, series, scan window, spec hash, a stale
 *         series, an attested `satisfied`) is either removed from the API or
 *         bound to the pinned strategy, and each of those bindings has a test
 *         that tries to break it.
 */
contract RefusalGateTest is Test {
    uint256 constant BUCKET = 900;
    uint256 constant BASE = 1_000_000; // bucket index of the first candle
    bytes32 constant FEED_A = bytes32(uint256(1));
    bytes32 constant FEED_B = bytes32(uint256(2));
    bytes32 constant SPEC_HASH = keccak256("spec");

    MockPyth pyth;
    CanonicalSeries series; // A
    CanonicalSeries otherSeries; // B
    StrategyRegistry registry;
    RefusalGate gate;

    address owner = address(0xA11CE);
    address proposer = address(0xB0B);

    event TradeProposed(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer);
    event TradeRefused(
        uint256 indexed strategyId,
        bytes32 indexed specHash,
        address indexed proposer,
        bytes32 predicateSymbol,
        int256 decidingValue
    );

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED_A, 1, BUCKET, address(pyth), 60);
        otherSeries = new CanonicalSeries("ETH/USD", FEED_B, 1, BUCKET, address(pyth), 60);
        registry = new StrategyRegistry(0.01 ether, 3 days, two(address(series), address(otherSeries)));
        gate = new RefusalGate(address(registry));
        vm.deal(owner, 10 ether);
        vm.warp(BASE * BUCKET);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _sample(CanonicalSeries s, bytes32 feed, int64 price) internal {
        pyth.setPrice(feed, price, 1, -2, block.timestamp);
        s.recordSample();
    }

    /// @dev Moves to the start of bucket `BASE + i` and records one price.
    function _candle(uint256 i, int64 price) internal {
        vm.warp((BASE + i) * BUCKET);
        _sample(series, FEED_A, price);
    }

    function _bos(bool long_, uint256 lookback) internal pure returns (RefusalGate.PredicateDefinition memory) {
        return RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.BreakOfStructure,
            symbol: long_ ? bytes32("bos_bullish") : bytes32("bos_bearish"),
            direction: long_ ? PredicateEngine.Direction.Long : PredicateEngine.Direction.Short,
            swingLookbackCandles: lookback,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: BUCKET
        });
    }

    function _fvg(bool long_, uint256 minGapBps) internal pure returns (RefusalGate.PredicateDefinition memory) {
        return RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.FairValueGap,
            symbol: "fvg_present",
            direction: long_ ? PredicateEngine.Direction.Long : PredicateEngine.Direction.Short,
            swingLookbackCandles: 0,
            minGapBps: minGapBps,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: BUCKET
        });
    }

    function _sweep(PredicateEngine.ReferenceExtreme ref, PredicateEngine.Lookback lb)
        internal
        pure
        returns (RefusalGate.PredicateDefinition memory)
    {
        return RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.LiquiditySweep,
            symbol: "sweep_swing_low",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 0,
            minGapBps: 0,
            referenceExtreme: ref,
            lookback: lb,
            timeframeSeconds: BUCKET
        });
    }

    function _arr(RefusalGate.PredicateDefinition memory a)
        internal
        pure
        returns (RefusalGate.PredicateDefinition[] memory out)
    {
        out = new RefusalGate.PredicateDefinition[](1);
        out[0] = a;
    }

    function _commit(RefusalGate.PredicateDefinition[] memory preds) internal pure returns (bytes32) {
        return keccak256(abi.encode(preds));
    }

    function _pin(RefusalGate.PredicateDefinition[] memory preds) internal returns (uint256 id) {
        return _pinOn(preds, address(series));
    }

    function _pinOn(RefusalGate.PredicateDefinition[] memory preds, address onSeries) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.pinStrategy{ value: 0.01 ether }(SPEC_HASH, _commit(preds), onSeries);
    }

    /// @dev Two candles: 100.00 then 101.00 -> a bullish BOS (lookback 1) at the latest candle.
    function _risingTwoCandles() internal {
        _candle(0, 10_000);
        _candle(1, 10_100);
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_Approves_WhenCommittedPredicatesHoldNow() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();

        vm.expectEmit(true, true, true, true);
        emit TradeProposed(id, SPEC_HASH, proposer);
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));
    }

    function test_Refuses_NamingThePredicateAndTheNumber() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(false, 1)); // bearish: needs a lower close
        uint256 id = _pin(preds);
        _risingTwoCandles();

        // decidingValue = latest close (10_100), the number that failed to cross.
        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, SPEC_HASH, proposer, "bos_bearish", 10_100);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, false, preds)); // a short, on the rule's own side
    }

    function test_Refuses_OnTheFirstFailingPredicate_InCommittedOrder() public {
        RefusalGate.PredicateDefinition[] memory preds = new RefusalGate.PredicateDefinition[](2);
        preds[0] = _bos(true, 1); // holds
        preds[1] = _fvg(true, 100); // needs three candles; only two exist: cannot be evaluated
        uint256 id = _pin(preds);
        _risingTwoCandles();

        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, SPEC_HASH, proposer, "fvg_present", 0);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_PreviewMatchesEvaluate_AndEmitsNothing() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(false, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();

        vm.recordLogs();
        (bool ok, bytes32 sym, int256 value) = gate.previewOnChain(id, false, preds);
        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(ok);
        assertEq(sym, "bos_bearish");
        assertEq(value, 10_100);
    }

    // ------------------------------------------------------------------
    // Cheaper predicates are rejected
    // ------------------------------------------------------------------

    /// @dev Pin a HARD rule (BOS over 3 candles: needs 4 recorded candles).
    ///      The proposer passes an EASY rule (BOS over 1 candle) that the
    ///      current tape satisfies. It must not be accepted.
    function test_CheaperPredicates_ShorterLookback_Rejected() public {
        RefusalGate.PredicateDefinition[] memory hard = _arr(_bos(true, 3));
        uint256 id = _pin(hard);
        _risingTwoCandles(); // satisfies lookback 1, cannot satisfy lookback 3

        RefusalGate.PredicateDefinition[] memory easy = _arr(_bos(true, 1));
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RefusalGate.CommitmentMismatch.selector, _commit(hard), _commit(easy)));
        gate.evaluateOnChain(id, true, easy);

        // And the honest evaluation of the committed rule is a refusal.
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, hard));
    }

    function test_CheaperPredicates_LowerGapThreshold_Rejected() public {
        RefusalGate.PredicateDefinition[] memory strict = _arr(_fvg(true, 500));
        uint256 id = _pin(strict);
        _candle(0, 10_000);
        _candle(1, 10_150);
        _candle(2, 10_300); // gap 300 bps: passes 100, fails 500

        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, _arr(_fvg(true, 100)));

        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, strict));
    }

    function test_CheaperPredicates_DroppingAPredicate_Rejected() public {
        RefusalGate.PredicateDefinition[] memory both = new RefusalGate.PredicateDefinition[](2);
        both[0] = _bos(true, 1);
        both[1] = _fvg(true, 1);
        uint256 id = _pin(both);
        _risingTwoCandles();

        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, _arr(_bos(true, 1))); // drop the one that cannot be evaluated
    }

    function test_CheaperPredicates_ReorderingOrAddingRejected() public {
        RefusalGate.PredicateDefinition[] memory two_ = new RefusalGate.PredicateDefinition[](2);
        two_[0] = _bos(true, 1);
        two_[1] = _fvg(true, 1);
        uint256 id = _pin(two_);

        RefusalGate.PredicateDefinition[] memory swapped = new RefusalGate.PredicateDefinition[](2);
        swapped[0] = two_[1];
        swapped[1] = two_[0];
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, swapped);

        RefusalGate.PredicateDefinition[] memory extra = new RefusalGate.PredicateDefinition[](3);
        extra[0] = two_[0];
        extra[1] = two_[1];
        extra[2] = two_[1];
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, extra);
    }

    /// @notice Fuzz: mutate ANY one field of the committed predicate; the gate
    ///         must reject every mutant before evaluating anything.
    function testFuzz_AnyMutationOfTheCommittedPredicatesIsRejected(uint8 field, uint256 newValue) public {
        RefusalGate.PredicateDefinition memory base = _bos(true, 3);
        RefusalGate.PredicateDefinition[] memory committed = _arr(base);
        uint256 id = _pin(committed);
        _risingTwoCandles();

        RefusalGate.PredicateDefinition memory m = _bos(true, 3);
        field = field % 8;
        if (field == 0) {
            uint8 k = uint8(bound(newValue, 0, 2));
            vm.assume(k != uint8(base.kind));
            m.kind = PredicateEngine.PredicateKind(k);
        } else if (field == 1) {
            vm.assume(bytes32(newValue) != base.symbol);
            m.symbol = bytes32(newValue);
        } else if (field == 2) {
            m.direction = PredicateEngine.Direction.Short;
        } else if (field == 3) {
            vm.assume(newValue != base.swingLookbackCandles);
            m.swingLookbackCandles = newValue;
        } else if (field == 4) {
            vm.assume(newValue != base.minGapBps);
            m.minGapBps = newValue;
        } else if (field == 5) {
            m.referenceExtreme = PredicateEngine.ReferenceExtreme(uint8(bound(newValue, 1, 5)));
        } else if (field == 6) {
            m.lookback = PredicateEngine.Lookback(uint8(bound(newValue, 1, 4)));
        } else {
            vm.assume(newValue != base.timeframeSeconds);
            m.timeframeSeconds = newValue;
        }

        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, _arr(m));
    }

    // ------------------------------------------------------------------
    // Wrong series is rejected: the caller cannot choose it
    // ------------------------------------------------------------------

    function test_Series_ComesFromTheRegistry_CallerCannotRedirectIt() public {
        // Strategy pinned to series B, whose tape is FALLING; series A's tape
        // (which a caller would love to point at) is rising and satisfies.
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pinOn(preds, address(otherSeries));

        _candle(0, 10_000);
        _candle(1, 10_100); // series A rises
        vm.warp((BASE) * BUCKET);
        _sample(otherSeries, FEED_B, 10_000);
        vm.warp((BASE + 1) * BUCKET);
        _sample(otherSeries, FEED_B, 9_000); // series B falls

        // There is no series parameter to abuse; the gate reads B and refuses.
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_Series_UnknownStrategyReverts() public {
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.UnknownStrategy.selector);
        gate.evaluateOnChain(99, true, _arr(_bos(true, 1)));
    }

    function test_Series_RogueSeriesCannotBePinned() public {
        CanonicalSeries rogue = new CanonicalSeries("EVIL", FEED_A, 1, BUCKET, address(pyth), 60);
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(StrategyRegistry.SeriesNotCanonical.selector, address(rogue)));
        registry.pinStrategy{ value: 0.01 ether }(SPEC_HASH, _commit(preds), address(rogue));
    }

    // ------------------------------------------------------------------
    // Stale series is rejected
    // ------------------------------------------------------------------

    function test_StaleSeries_Reverts_NotApproved() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));

        // A full bucket passes and nobody records a sample.
        vm.warp(block.timestamp + BUCKET);
        uint256 staleBucket = block.timestamp / BUCKET;
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RefusalGate.StaleSeries.selector, staleBucket));
        gate.evaluateOnChain(id, true, preds);

        vm.expectRevert(abi.encodeWithSelector(RefusalGate.StaleSeries.selector, staleBucket));
        gate.previewOnChain(id, true, preds);
    }

    function test_StaleSeries_AnyoneCanFreshenIt_ThenTheGateEvaluatesTheNewTape() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();

        vm.warp(block.timestamp + BUCKET);
        _sample(series, FEED_A, 10_200); // newer, higher close: still a break vs. the 10_100 high
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));
    }

    // ------------------------------------------------------------------
    // The window is derived on-chain: only the latest candle decides
    // ------------------------------------------------------------------

    function test_OlderSetupInsideTheWindowDoesNotApproveNow() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _candle(0, 10_000);
        _candle(1, 10_100); // a bullish BOS happened HERE
        _candle(2, 10_050); // ...but the latest candle does not break candle 1's high

        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, SPEC_HASH, proposer, "bos_bullish", 10_050);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_GapInTheWindow_IsARefusal_NeverBridged() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _candle(0, 10_000);
        _candle(2, 10_100); // bucket BASE+1 is empty: window [BASE+1, BASE+2] holds 1 candle

        vm.expectEmit(true, true, true, true);
        emit TradeRefused(id, SPEC_HASH, proposer, "bos_bullish", 0);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_FairValueGap_UsesTheLatestThreeBuckets() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_fvg(true, 100));
        uint256 id = _pin(preds);
        _candle(0, 10_000);
        _candle(1, 10_150);
        _candle(2, 10_300); // gap = 10_300 - 10_000 = 300 -> 300 bps >= 100
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));

        _candle(3, 10_310); // new triple (10_150, 10_300, 10_310): 10_310 - 10_150 = 160 -> 105 bps >= 100 still
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));

        _candle(4, 10_305); // triple (10_300, 10_310, 10_305): 10_305 - 10_300 = 5 -> 4 bps < 100
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_LiquiditySweep_DecidesOnlyOnTheLatestCandle() public {
        // Long sweep: wick below the swing low, close back above it.
        RefusalGate.PredicateDefinition[] memory preds =
            _arr(_sweep(PredicateEngine.ReferenceExtreme.SwingLow, PredicateEngine.Lookback.H1));
        uint256 id = _pin(preds);

        _candle(0, 10_000); // reference low 100.00
        // candle 1: wick to 90.00, close 105.00 (two samples in one bucket)
        vm.warp((BASE + 1) * BUCKET);
        _sample(series, FEED_A, 9_000);
        vm.warp((BASE + 1) * BUCKET + 1);
        _sample(series, FEED_A, 10_500);
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, preds));

        // candle 2 does not sweep anything. The sweep at candle 1 is still
        // inside the window, but it must NOT approve a trade now.
        _candle(2, 10_600);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, preds));
    }

    function test_TimeframeMismatch_Reverts() public {
        RefusalGate.PredicateDefinition memory p = _bos(true, 1);
        p.timeframeSeconds = 3_600; // committed as 1h, series buckets are 15m
        RefusalGate.PredicateDefinition[] memory preds = _arr(p);
        uint256 id = _pin(preds);
        _risingTwoCandles();

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(RefusalGate.TimeframeMismatch.selector, BUCKET, 3_600));
        gate.evaluateOnChain(id, true, preds);
    }

    function test_EmptyPredicates_Revert() public {
        RefusalGate.PredicateDefinition[] memory none = new RefusalGate.PredicateDefinition[](0);
        uint256 id = _pin(none);
        _risingTwoCandles();
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.NoPredicates.selector);
        gate.evaluateOnChain(id, true, none);
    }

    function test_ZeroLookbackBreakOfStructure_IsInvalid() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 0));
        uint256 id = _pin(preds);
        _risingTwoCandles();
        vm.prank(proposer);
        vm.expectRevert(RefusalGate.InvalidPredicate.selector);
        gate.evaluateOnChain(id, true, preds);
    }

    // ------------------------------------------------------------------
    // Replay: there is no approval to replay
    // ------------------------------------------------------------------

    function test_ApprovalIsNotStored_AReplayInALaterBlockIsEvaluatedAgainstTheNewTape() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();

        bytes memory callData = abi.encodeCall(RefusalGate.evaluateOnChain, (id, true, preds));

        vm.prank(proposer);
        (bool ok, bytes memory ret) = address(gate).call(callData);
        assertTrue(ok);
        assertTrue(abi.decode(ret, (bool))); // approved in this block

        // The market turns. Replaying the identical calldata later refuses.
        _candle(2, 10_000);
        vm.prank(proposer);
        (ok, ret) = address(gate).call(callData);
        assertTrue(ok);
        assertFalse(abi.decode(ret, (bool)));

        // Same block, same calldata, second call: still evaluated fresh, and
        // still no state anywhere records that a first call ever passed.
        vm.prank(proposer);
        (ok, ret) = address(gate).call(callData);
        assertFalse(abi.decode(ret, (bool)));
    }

    function test_ApprovalFromOneCallerIsNotUsableByAnother_NothingIsStored() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        _risingTwoCandles();

        // The gate holds no per-caller state at all: this is a pure function
        // of (strategy, predicates, tape, time). Prove it by checking that no
        // storage slot of the gate changes on an approval.
        vm.record();
        vm.prank(proposer);
        gate.evaluateOnChain(id, true, preds);
        (, bytes32[] memory writes) = vm.accesses(address(gate));
        assertEq(writes.length, 0, "the gate must not write storage");
    }

    // ------------------------------------------------------------------
    // The attested path is gone
    // ------------------------------------------------------------------

    function test_AttestedEvaluate_DoesNotExist_CannotProduceAnApproval() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 1));
        uint256 id = _pin(preds);
        // (Note: no candles at all. The old path would have approved anyway.)

        // Old signature: evaluate(uint256,bytes32,(bytes32,bool,int256)[]) with satisfied = true.
        bytes memory legacy = abi.encodeWithSignature(
            "evaluate(uint256,bytes32,(bytes32,bool,int256)[])", id, SPEC_HASH, _attestedAllTrue()
        );
        vm.recordLogs();
        vm.prank(proposer);
        (bool ok,) = address(gate).call(legacy);
        assertFalse(ok, "no function answers the legacy selector");
        assertEq(vm.getRecordedLogs().length, 0, "no TradeProposed can be emitted through it");

        // And the old evaluateOnChain shape (caller-supplied spec hash + series) is gone too.
        bytes memory legacyOnChain = abi.encodeWithSignature(
            "evaluateOnChain(uint256,bytes32,address,(uint8,bytes32,uint8,uint256,uint256,uint8,uint8,uint256,uint256)[])",
            id,
            SPEC_HASH,
            address(series),
            new uint256[](0)
        );
        vm.prank(proposer);
        (ok,) = address(gate).call(legacyOnChain);
        assertFalse(ok);
    }

    function _attestedAllTrue() internal pure returns (bytes memory) {
        // (bytes32 symbol, bool satisfied, int256 decidingValue)[] of length 1, satisfied = true
        return abi.encode(bytes32("bos_bullish"), true, int256(1));
    }

    // ------------------------------------------------------------------
    // Commitment changes obey the cooling-off rule
    // ------------------------------------------------------------------

    function test_CommitmentLoosening_WaitsOutTheCooldown_ThenTheEasyRulesApply() public {
        RefusalGate.PredicateDefinition[] memory hard = _arr(_bos(true, 3));
        RefusalGate.PredicateDefinition[] memory easy = _arr(_bos(true, 1));
        uint256 id = _pin(hard);
        _risingTwoCandles();

        // Owner asks for the easy rule.
        vm.prank(owner);
        registry.proposeLoosening(id, keccak256("easy-spec"), _commit(easy), address(series));

        // Immediately: the easy rule is NOT active; the hard one still is.
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, easy);
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, hard));

        // Even the owner cannot finalize early.
        vm.warp(block.timestamp + 3 days - 1);
        vm.prank(owner);
        vm.expectRevert();
        registry.finalizeLoosening(id);
        _sample(series, FEED_A, 10_100); // keep the series fresh
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, easy);

        // After the cooldown (permissionless finalize), the easy rule applies
        // and the old commitment no longer does.
        vm.warp(block.timestamp + 1);
        registry.finalizeLoosening(id);
        _sample(series, FEED_A, 10_200);
        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, hard);
        // The tape has adjacent fresh candles (10_100 then 10_200), so the
        // easy rule now genuinely holds and approves.
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, easy));
    }

    function test_CommitmentTightening_AppliesImmediately() public {
        RefusalGate.PredicateDefinition[] memory easy = _arr(_bos(true, 1));
        RefusalGate.PredicateDefinition[] memory hard = _arr(_bos(true, 3));
        uint256 id = _pin(easy);
        _risingTwoCandles();
        vm.prank(proposer);
        assertTrue(gate.evaluateOnChain(id, true, easy));

        vm.prank(owner);
        registry.tighten(id, keccak256("hard-spec"), _commit(hard), address(series));

        vm.prank(proposer);
        vm.expectRevert();
        gate.evaluateOnChain(id, true, easy); // the old, easier rule is dead at once
        vm.prank(proposer);
        assertFalse(gate.evaluateOnChain(id, true, hard));
    }

    function test_StrangerCannotChangeTheCommitment() public {
        RefusalGate.PredicateDefinition[] memory preds = _arr(_bos(true, 3));
        uint256 id = _pin(preds);
        RefusalGate.PredicateDefinition[] memory easy = _arr(_bos(true, 1));
        vm.prank(proposer);
        vm.expectRevert(StrategyRegistry.NotOwner.selector);
        registry.tighten(id, keccak256("x"), _commit(easy), address(series));
        vm.prank(proposer);
        vm.expectRevert(StrategyRegistry.NotOwner.selector);
        registry.proposeLoosening(id, keccak256("x"), _commit(easy), address(series));
    }

    // ------------------------------------------------------------------
    // Only the gate's own self-call may reach the evaluator
    // ------------------------------------------------------------------

    function test_EvaluatePredicate_OnlyCallableByTheGateItself() public {
        vm.expectRevert(RefusalGate.OnlySelf.selector);
        gate.evaluatePredicate(series, _bos(true, 1), 1, BUCKET);
    }

    // ------------------------------------------------------------------
    // TypeScript <-> Solidity encoding vector
    // ------------------------------------------------------------------

    /// @notice The same three predicates and expected bytes as
    ///         `packages/spec/src/onchain.test.ts`. The hex was produced with
    ///         `cast abi-encode` and is asserted by BOTH suites, so
    ///         `encodePredicates` (viem) and `abi.encode` (Solidity) cannot
    ///         drift apart unnoticed.
    function test_EncodingVector_MatchesTypeScript() public pure {
        RefusalGate.PredicateDefinition[] memory preds = new RefusalGate.PredicateDefinition[](3);
        preds[0] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.BreakOfStructure,
            symbol: "bos_bullish",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 5,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: 900
        });
        preds[1] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.FairValueGap,
            symbol: "fvg_present",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 0,
            minGapBps: 25,
            referenceExtreme: PredicateEngine.ReferenceExtreme.PrevDayLow,
            lookback: PredicateEngine.Lookback.M15,
            timeframeSeconds: 900
        });
        preds[2] = RefusalGate.PredicateDefinition({
            kind: PredicateEngine.PredicateKind.LiquiditySweep,
            symbol: "sweep_swing_low",
            direction: PredicateEngine.Direction.Long,
            swingLookbackCandles: 0,
            minGapBps: 0,
            referenceExtreme: PredicateEngine.ReferenceExtreme.SwingLow,
            lookback: PredicateEngine.Lookback.H1,
            timeframeSeconds: 900
        });

        bytes memory expected = hex"000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000000626f735f62756c6c69736800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038400000000000000000000000000000000000000000000000000000000000000016676675f70726573656e74000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000019000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000384000000000000000000000000000000000000000000000000000000000000000273776565705f7377696e675f6c6f770000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000384";
        assertEq(abi.encode(preds), expected);
        assertEq(keccak256(abi.encode(preds)), 0x7262d284aebd8e34968cb3a99cafa494e403ec861b314b104bb9147bae191dce);
    }

    // ------------------------------------------------------------------
    // The window rule
    // ------------------------------------------------------------------

    function test_WindowRule() public {
        WindowHarness h = new WindowHarness();
        PredicateEngine.ReferenceExtreme lowRef = PredicateEngine.ReferenceExtreme.PrevDayLow;
        PredicateEngine.Lookback m15 = PredicateEngine.Lookback.M15;

        // BOS lookback N -> exactly N+1 buckets ending at latest.
        assertEq(h.windowStart(PredicateEngine.PredicateKind.BreakOfStructure, 5, lowRef, m15, 1_000, 900), 995);
        // FVG -> exactly 3 buckets.
        assertEq(h.windowStart(PredicateEngine.PredicateKind.FairValueGap, 0, lowRef, m15, 1_000, 900), 998);
        // Swing sweep, H1 on 15m buckets -> 4 buckets back.
        assertEq(
            h.windowStart(
                PredicateEngine.PredicateKind.LiquiditySweep,
                0,
                PredicateEngine.ReferenceExtreme.SwingLow,
                PredicateEngine.Lookback.H1,
                1_000,
                900
            ),
            996
        );
        // Prev-day sweep: bucket 1_000 * 900s = day 10 (864_000 .. 950_399)? 900_000 s / 86_400 = day 10;
        // day 10 starts at 864_000 s; the previous day starts at 777_600 s = bucket 864.
        assertEq(h.windowStart(PredicateEngine.PredicateKind.LiquiditySweep, 0, lowRef, m15, 1_000, 900), 864);
        // Clamps to bucket 0.
        assertEq(h.windowStart(PredicateEngine.PredicateKind.BreakOfStructure, 5, lowRef, m15, 3, 900), 0);
        assertEq(h.windowStart(PredicateEngine.PredicateKind.LiquiditySweep, 0, lowRef, m15, 10, 900), 0);
    }

    function testFuzz_WindowNeverExtendsPastLatest_AndIsCallerIndependent(uint256 latest, uint16 lookback) public {
        WindowHarness h = new WindowHarness();
        latest = bound(latest, 0, 1e9);
        uint256 n = bound(lookback, 1, 200);
        uint256 from = h.windowStart(
            PredicateEngine.PredicateKind.BreakOfStructure,
            n,
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.Lookback.M15,
            latest,
            900
        );
        assertLe(from, latest);
        assertEq(from, latest > n ? latest - n : 0);
    }
}
