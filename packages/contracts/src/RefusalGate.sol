// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { StrategyRegistry } from "./StrategyRegistry.sol";
import { ICanonicalSeries } from "./CanonicalSeries.sol";
import { PredicateEngine } from "./PredicateEngine.sol";
import { TradeSide } from "./TradeSide.sol";

/**
 * @title RefusalGate
 * @notice Decides, from the chain's own recorded prices, whether a strategy's
 *         pinned rules hold right now. Per docs/ARCHITECTURE.md's "three
 *         layers" the contract is deliberately stupid: it hashes, compares
 *         and does arithmetic over a `CanonicalSeries`. It never calls a
 *         model, accepts an assertion, or resolves anything by judgment.
 *
 * @dev    WHAT A CALLER CAN AND CANNOT SUPPLY. `evaluateOnChain(strategyId,
 *         predicates)` takes the strategy id and the predicate definitions —
 *         nothing else:
 *
 *           - the SERIES comes from `StrategyRegistry.activeSeries`, never
 *             from the caller;
 *           - the predicates must hash (`keccak256(abi.encode(predicates))`)
 *             to `StrategyRegistry.activePredicatesCommitment`, or the call
 *             reverts `CommitmentMismatch`. A proposer therefore cannot pass a
 *             shorter lookback, a lower gap threshold, a different kind or
 *             direction, or fewer/more predicates than the owner pinned;
 *           - there is NO scan window in `PredicateDefinition`. The window is
 *             derived on-chain from the series' current bucket and the
 *             predicate's own committed lookback (`PredicateEngine.windowStart`
 *             documents the rule), and only the latest candle is ever decided
 *             on;
 *           - the series' current bucket must already be recorded
 *             (`StaleSeries` otherwise), so a stale series cannot approve
 *             anything. Anyone can call `CanonicalSeries.recordSample()` to
 *             make it fresh — the same permissionless keeper pattern
 *             `MarginAccount` uses;
 *           - the TRADE SIDE is bound too: `evaluateOnChain` takes the side
 *             being proposed (`isLong`) and refuses unless it equals the side
 *             every committed predicate authorizes (`TradeSide` documents the
 *             mapping, including liquidity sweeps). A bullish rule cannot
 *             approve a short, or vice versa; a rule whose predicates mix
 *             sides is malformed and reverts `MixedDirections`;
 *           - each predicate's committed `timeframeSeconds` must equal the
 *             series' bucket size (`TimeframeMismatch`) so a spec written for
 *             one timeframe is never silently evaluated on another.
 *
 *         ANY FAILURE TO EVALUATE IS A REFUSAL, NEVER AN APPROVAL. If a
 *         predicate cannot be evaluated (a gap in the window, no reference
 *         history, a window too wide to scan) the gate refuses and reports
 *         that predicate's symbol with `decidingValue == 0`. Evaluation runs in
 *         a self-call wrapped in try/catch, so even an out-of-gas inner scan
 *         can only turn into a refusal.
 *
 *         REMOVED: the attested `evaluate(strategyId, expectedSpecHash,
 *         PredicateResult[])` path. It trusted a caller-supplied `satisfied`
 *         and a caller-supplied `expectedSpecHash` that the chain could not
 *         relate to the predicates, so it could produce a "TradeProposed" for
 *         anything. It is deleted, not gated, because no configuration of it
 *         is safe: an approval the chain cannot recompute is not an approval.
 *
 *         WHAT AN APPROVAL IS. An approval is the `true` this function returns
 *         INSIDE the transaction of the contract that acts on it
 *         (`GuardedVault.proposeTrade`, `MarginAccount.openGuardedPosition`,
 *         `CopyVault.mirrorOpen`). There is no stored approval record to
 *         replay, borrow or front-run: a pass in one block says nothing about
 *         the next, and a pass obtained by calling this gate directly
 *         authorizes nothing, because no downstream contract reads events or
 *         storage from here. The `TradeProposed`/`TradeRefused` events are the
 *         evidence trail ("evidence reachable in one tap"), not the
 *         enforcement.
 */
contract RefusalGate {
    /// @notice One committed predicate. Every field is part of the pinned
    ///         commitment; none is caller-chosen at evaluation time. `symbol`
    ///         is the identifier `packages/spec` `predicateSymbol` produces
    ///         (used only to name the failing predicate in a refusal). Unused
    ///         fields for a given `kind` are zero (e.g. `minGapBps` on a
    ///         `BreakOfStructure`) and are still committed.
    struct PredicateDefinition {
        PredicateEngine.PredicateKind kind;
        bytes32 symbol;
        PredicateEngine.Direction direction;
        uint256 swingLookbackCandles;
        uint256 minGapBps;
        PredicateEngine.ReferenceExtreme referenceExtreme;
        PredicateEngine.Lookback lookback;
        uint256 timeframeSeconds;
    }

    StrategyRegistry public immutable registry;

    event TradeProposed(uint256 indexed strategyId, bytes32 indexed specHash, address indexed proposer);
    event TradeRefused(
        uint256 indexed strategyId,
        bytes32 indexed specHash,
        address indexed proposer,
        bytes32 predicateSymbol,
        int256 decidingValue
    );

    error UnknownStrategy();
    error NoPredicates();
    error InvalidPredicate();
    error MixedDirections();
    error InconsistentSweepDirection(uint256 predicateIndex);
    error CommitmentMismatch(bytes32 committed, bytes32 supplied);
    error StaleSeries(uint256 bucketIndex);
    error TimeframeMismatch(uint256 seriesBucketSeconds, uint256 predicateTimeframeSeconds);
    error OnlySelf();

    constructor(address registry_) {
        require(registry_ != address(0), "registry required");
        registry = StrategyRegistry(registry_);
    }

    /// @notice Evaluates the strategy's pinned predicates against its pinned
    ///         series right now, for a trade on side `isLong`, and emits
    ///         `TradeProposed` (side matches and all satisfied) or
    ///         `TradeRefused` (first failing predicate and its number, or
    ///         `SIDE_MISMATCH`).
    /// @dev    Reverts only for caller/setup errors (unknown strategy, empty or
    ///         non-matching predicates, a malformed rule — mixed sides or a
    ///         contradictory sweep — stale series, timeframe mismatch). A trade
    ///         on the wrong side, a predicate that is not satisfied, or one
    ///         that cannot be evaluated is a refusal: this returns `false`.
    ///         For `SIDE_MISMATCH` the event's `decidingValue` is the rule's
    ///         side (1 = the rule authorizes longs only, 0 = shorts only).
    /// @return allSatisfied True if the side matches and every predicate holds.
    function evaluateOnChain(uint256 strategyId, bool isLong, PredicateDefinition[] calldata predicates)
        external
        returns (bool allSatisfied)
    {
        (bool ok, bytes32 symbol, int256 value) = _check(strategyId, isLong, predicates);
        bytes32 active = registry.activeSpecHash(strategyId);
        if (!ok) {
            emit TradeRefused(strategyId, active, msg.sender, symbol, value);
            return false;
        }
        emit TradeProposed(strategyId, active, msg.sender);
        return true;
    }

    /// @notice Same evaluation as `evaluateOnChain`, no events — for clients
    ///         that want to show the outcome before sending a transaction.
    ///         Not an approval of anything.
    function previewOnChain(uint256 strategyId, bool isLong, PredicateDefinition[] calldata predicates)
        external
        view
        returns (bool allSatisfied, bytes32 failingSymbol, int256 decidingValue)
    {
        return _check(strategyId, isLong, predicates);
    }

    /// @dev The rule's side: the common side of all predicates (see
    ///      `TradeSide`). Reverts on a mixed set or a contradictory sweep.
    function _ruleSide(PredicateDefinition[] calldata predicates) internal pure returns (bool ruleIsLong) {
        for (uint256 i = 0; i < predicates.length; i++) {
            PredicateDefinition calldata p = predicates[i];
            (bool isLong, bool consistent) = TradeSide.predicateSide(p.kind, p.direction, p.referenceExtreme);
            if (!consistent) revert InconsistentSweepDirection(i);
            if (i == 0) ruleIsLong = isLong;
            else if (isLong != ruleIsLong) revert MixedDirections();
        }
    }

    function _check(uint256 strategyId, bool isLong, PredicateDefinition[] calldata predicates)
        internal
        view
        returns (bool ok, bytes32 failingSymbol, int256 decidingValue)
    {
        address seriesAddress = registry.activeSeries(strategyId);
        if (seriesAddress == address(0)) revert UnknownStrategy();
        if (predicates.length == 0) revert NoPredicates();

        bytes32 committed = registry.activePredicatesCommitment(strategyId);
        bytes32 supplied = keccak256(abi.encode(predicates));
        if (supplied != committed) revert CommitmentMismatch(committed, supplied);

        bool ruleIsLong = _ruleSide(predicates);
        if (ruleIsLong != isLong) return (false, "SIDE_MISMATCH", ruleIsLong ? int256(1) : int256(0));

        ICanonicalSeries series = ICanonicalSeries(seriesAddress);
        uint256 latest = series.bucketIndexOf(block.timestamp);
        (,,,,, bool recorded) = series.getCandle(latest);
        if (!recorded) revert StaleSeries(latest);

        uint256 bucketSeconds = series.bucketSeconds();
        for (uint256 i = 0; i < predicates.length; i++) {
            PredicateDefinition calldata p = predicates[i];
            if (p.timeframeSeconds != bucketSeconds) revert TimeframeMismatch(bucketSeconds, p.timeframeSeconds);
            if (p.kind == PredicateEngine.PredicateKind.BreakOfStructure && p.swingLookbackCandles == 0) {
                revert InvalidPredicate();
            }

            try this.evaluatePredicate(series, p, latest, bucketSeconds) returns (
                PredicateEngine.PredicateResult memory r
            ) {
                if (!r.satisfied || r.atBucketIndex != latest) return (false, p.symbol, r.decidingValue);
            } catch {
                return (false, p.symbol, 0);
            }
        }
        return (true, bytes32(0), 0);
    }

    /// @dev External only so `_check` can wrap it in try/catch (a library
    ///      `internal` call cannot be caught). Callable only by this contract.
    function evaluatePredicate(
        ICanonicalSeries series,
        PredicateDefinition calldata p,
        uint256 latest,
        uint256 bucketSeconds
    ) external view returns (PredicateEngine.PredicateResult memory) {
        if (msg.sender != address(this)) revert OnlySelf();

        uint256 from = PredicateEngine.windowStart(
            p.kind, p.swingLookbackCandles, p.referenceExtreme, p.lookback, latest, bucketSeconds
        );

        if (p.kind == PredicateEngine.PredicateKind.BreakOfStructure) {
            return PredicateEngine.evaluateBreakOfStructure(series, p.direction, p.swingLookbackCandles, from, latest);
        }
        if (p.kind == PredicateEngine.PredicateKind.FairValueGap) {
            return PredicateEngine.evaluateFairValueGap(series, p.direction, p.minGapBps, from, latest);
        }
        return PredicateEngine.evaluateLiquiditySweepAtLatest(
            series, p.direction, p.referenceExtreme, p.lookback, from, latest
        );
    }
}
