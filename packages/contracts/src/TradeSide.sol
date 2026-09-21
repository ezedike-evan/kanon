// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { PredicateEngine } from "./PredicateEngine.sol";

/**
 * @title TradeSide
 * @notice The one definition of which trade side a committed predicate
 *         authorizes. `RefusalGate` applies it, and `GuardedVault`,
 *         `MarginAccount` and `CopyVault` all reach it only through
 *         `RefusalGate.evaluateOnChain(strategyId, isLong, predicates)`, so the
 *         three cannot disagree.
 *
 * @dev    THE MAPPING (a predicate's side is a function of committed fields
 *         only, never of anything the proposer supplies):
 *
 *           - Break of structure and fair value gap: the predicate's
 *             `direction`. A bullish (`Long`) break of structure / gap
 *             authorizes a long; a bearish (`Short`) one authorizes a short.
 *           - Liquidity sweep: fixed by `referenceExtreme`, because the engine
 *             defines which side is swept by the reference alone
 *             (`PredicateEngine.evaluateLiquiditySweep` never reads
 *             `direction`). A wick below a LOW reference
 *             (`PrevDayLow`/`PrevSessionLow`/`SwingLow`) that closes back
 *             inside is a long setup; a wick above a HIGH reference is a short
 *             setup. The committed `direction` must equal that derived side;
 *             a sweep committed with the opposite `direction` is contradictory
 *             and is rejected (`consistent == false`) rather than silently
 *             trusted either way.
 *
 *         A RULE's side is the common side of all its predicates. Predicates
 *         are ANDed, and a set that mixes a long setup with a short setup
 *         describes no single trade, so a mixed set is rejected outright
 *         (`RefusalGate.MixedDirections`) instead of being given an arbitrary
 *         meaning. A trade is authorized only if `isLong` equals the rule's
 *         side; a long against an all-bearish rule (or a short against an
 *         all-bullish one) is a refusal.
 */
library TradeSide {
    /// @return isLong The side this predicate authorizes.
    /// @return consistent False only for a liquidity sweep whose committed
    ///         `direction` contradicts the side its `referenceExtreme` implies.
    function predicateSide(
        PredicateEngine.PredicateKind kind,
        PredicateEngine.Direction direction,
        PredicateEngine.ReferenceExtreme referenceExtreme
    ) internal pure returns (bool isLong, bool consistent) {
        if (kind != PredicateEngine.PredicateKind.LiquiditySweep) {
            return (direction == PredicateEngine.Direction.Long, true);
        }
        bool lowReference = referenceExtreme == PredicateEngine.ReferenceExtreme.PrevDayLow
            || referenceExtreme == PredicateEngine.ReferenceExtreme.PrevSessionLow
            || referenceExtreme == PredicateEngine.ReferenceExtreme.SwingLow;
        return (lowReference, (direction == PredicateEngine.Direction.Long) == lowReference);
    }
}
