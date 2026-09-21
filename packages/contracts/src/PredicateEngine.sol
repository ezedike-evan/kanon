// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ICanonicalSeries } from "./CanonicalSeries.sol";

/**
 * @title PredicateEngine
 * @notice The on-chain port of `packages/spec/src/evaluate.ts` — hardening (b)
 *         named in `RefusalGate.sol`'s NatSpec and item 1 of the README's
 *         "Explicit stubs / follow-ups". Reads candles directly out of a
 *         `CanonicalSeries` (via `ICanonicalSeries`, never reimplementing its
 *         storage) and decides break-of-structure, fair-value-gap and
 *         liquidity-sweep predicates itself — no caller-attested
 *         `PredicateResult` is trusted here.
 *
 * @dev    THIS IS A PORT, NOT A REIMPLEMENTATION: every boundary convention
 *         below is copied verbatim from `evaluate.ts`'s own doc comment, not
 *         reinterpreted:
 *
 *           - Break of structure: price must trade *beyond* the prior
 *             extreme. A close equal to the swing extreme has not broken it
 *             (strict inequality).
 *           - Fair value gap: the gap in bps must be >= `minGapBps`. Equal to
 *             the threshold satisfies it (inclusive boundary).
 *           - Liquidity sweep: the wick must trade *beyond* the reference
 *             extreme, strictly, and the close must come back *inside* it,
 *             strictly. A wick that only touches the reference has not swept
 *             it.
 *
 *         On refusal, each evaluator reports the most recent candle it could
 *         evaluate (the live state of the series), exactly like the TS
 *         reference — never the closest historical near-miss.
 *
 *         SCALE CONVENTION: `CanonicalSeries` pins one `priceExpo` for the
 *         lifetime of a series (see its NatSpec), so every candle a given
 *         series ever returns is already at the same fixed-point scale.
 *         `evaluate.ts`'s `Decimal` type has to align differing `decimals`
 *         between two values before comparing them (`alignAtoms`); that step
 *         is a structural no-op here, because on-chain there is only ever one
 *         scale per series. Every candle field is therefore compared as a
 *         plain `int64`/`int256`, and bps math (`(numerator * 10_000) /
 *         denominator`) mirrors `evaluate.ts`'s `bpsOf` exactly — same
 *         truncate-toward-zero integer division `evaluate.ts` gets from
 *         BigInt division, same formula, no separately-invented rounding
 *         rule.
 *
 *         POSITIONAL CANDLES, NOT BUCKET-ADJACENT ONES: `evaluate.ts` operates
 *         over `series.candles`, a *compacted* array — gaps (unsampled
 *         buckets) simply are not elements of it — and every sliding-window
 *         computation (`candles.slice(i - lookback, i)`, `candles[i + 2]`,
 *         `candles.slice(0, index)`) is positional over that compacted array,
 *         not a walk over literal adjacent bucket indices. To match that
 *         bit-for-bit, every function here first compacts the requested
 *         `[fromBucketInclusive, toBucketInclusive]` bucket range into
 *         in-memory arrays containing only `recorded` candles (exactly
 *         `CanonicalSeries.swingHigh`/`swingLow`'s own "unrecorded buckets
 *         never participate" rule), then runs the same positional algorithm
 *         `evaluate.ts` runs over its compacted `candles` array.
 *
 *         GAS, NAMED DIVERGENCE FROM THE REFERENCE: `evaluate.ts` runs once,
 *         off a JS array, with no gas model at all. This port bounds the
 *         compacted window to `MAX_SCAN_BUCKETS` (mirroring
 *         `CanonicalSeries.MAX_LOOKBACK_BUCKETS`) so a caller cannot force an
 *         unbounded loop, but the sliding-window extreme in
 *         `evaluateBreakOfStructure` and the backward reference scan in
 *         `evaluateLiquiditySweep` are both re-scanned from scratch on every
 *         outer step (`O(n * lookback)` and up to `O(n^2)` respectively)
 *         rather than maintained incrementally (e.g. a monotonic deque). That
 *         is a real, flagged gas cost this port pays that the TS reference
 *         never had to; it does not change any `satisfied`/`decidingValue`
 *         result, only how much gas computing it costs. A production version
 *         evaluating large windows in a single on-chain transaction (as
 *         opposed to an off-chain `eth_call` simulation, which has no gas
 *         limit) would want the incremental version.
 */
library PredicateEngine {
    enum Direction {
        Long,
        Short
    }

    /// @dev Mirrors `packages/spec/src/spec.ts`'s `ReferenceExtreme` enum
    ///      exactly, member for member.
    enum ReferenceExtreme {
        PrevDayLow,
        PrevDayHigh,
        PrevSessionLow,
        PrevSessionHigh,
        SwingLow,
        SwingHigh
    }

    /// @dev Mirrors `packages/spec/src/spec.ts`'s `Lookback` enum.
    enum Lookback {
        M15,
        H1,
        H4,
        D1,
        W1
    }

    /// @dev Discriminates which of the three evaluators a
    ///      `RefusalGate.PredicateDefinition` should be routed to.
    enum PredicateKind {
        BreakOfStructure,
        FairValueGap,
        LiquiditySweep
    }

    /// @notice Solidity mirror of `evaluate.ts`'s `PredicateResult`. Leaves
    ///         out `predicateId`/`symbol` — those are per-predicate metadata
    ///         the caller already supplies (see `RefusalGate.PredicateDefinition`),
    ///         not something this engine's arithmetic decides.
    struct PredicateResult {
        bool satisfied;
        /// @dev The value that decided satisfaction — a close price for BoS,
        ///      a gap in bps for FVG, a wick price for a sweep.
        int256 decidingValue;
        /// @dev The value `decidingValue` was measured against — a swing
        ///      extreme for BoS, `minGapBps` for FVG, the swept extreme for a
        ///      sweep.
        int256 referenceValue;
        uint256 atBucketIndex;
        uint256 atTimestamp;
    }

    /// @dev The on-chain analog of `evaluate.ts`'s already-compacted
    ///      `series.candles`: only `recorded` candles in the requested bucket
    ///      range, in ascending order, bundled into one struct rather than
    ///      five parallel arrays purely to keep each function's local
    ///      variable count under Solidity's stack-depth limit — a packaging
    ///      choice, not a behavioral one.
    struct Candles {
        int64[] highs;
        int64[] lows;
        int64[] closes;
        uint256[] timestamps;
        uint256[] bucketIndices;
        uint256 count;
    }

    /// @notice Bounds the compacted-array scan so a caller cannot force an
    ///         unbounded loop. Mirrors `CanonicalSeries.MAX_LOOKBACK_BUCKETS`.
    uint256 public constant MAX_SCAN_BUCKETS = 2_000;

    uint256 private constant DAY_SECONDS = 86_400;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    error InvalidWindow();
    error WindowTooWide();
    error InsufficientCandles(uint256 needed, uint256 available);
    error NoReferenceHistory();

    // -------------------------------------------------------------------
    // Live-evaluation window (used by RefusalGate)
    // -------------------------------------------------------------------

    /// @notice THE WINDOW RULE. `RefusalGate.evaluateOnChain` never lets a
    ///         caller choose a scan window: it always evaluates
    ///         `[windowStart(...), latestBucket]`, where `latestBucket` is the
    ///         series' current bucket (which the gate first requires to be
    ///         recorded) and `windowStart` is a pure function of the
    ///         predicate's own COMMITTED parameters:
    ///
    ///           - Break of structure, lookback N: `latest - N`. That is
    ///             exactly N+1 buckets, so the positional scan has one
    ///             evaluation point: the latest candle against the swing
    ///             extreme of the N candles before it. If any of those N+1
    ///             buckets is unrecorded the window holds fewer than N+1
    ///             candles and evaluation fails (a refusal) — a gap is never
    ///             bridged by reaching further back.
    ///           - Fair value gap: `latest - 2`. Exactly three buckets, one
    ///             three-candle triple ending at the latest candle.
    ///           - Liquidity sweep, swing reference: `latest - lookbackSeconds
    ///             / bucketSeconds`, so every candle inside the committed
    ///             lookback is available as reference history.
    ///           - Liquidity sweep, previous-day/session reference: the first
    ///             bucket of the previous UTC day.
    ///
    ///         All starts clamp to bucket 0. Only the latest candle is ever
    ///         decided on (see `evaluateLiquiditySweepAtLatest`; BOS and FVG
    ///         windows contain a single position by construction), so an
    ///         older setup sitting inside the window can never approve a
    ///         trade now.
    function windowStart(
        PredicateKind kind,
        uint256 swingLookbackCandles,
        ReferenceExtreme referenceExtreme,
        Lookback lookback,
        uint256 latestBucket,
        uint256 bucketSeconds
    ) internal pure returns (uint256) {
        uint256 back;
        if (kind == PredicateKind.BreakOfStructure) {
            back = swingLookbackCandles;
        } else if (kind == PredicateKind.FairValueGap) {
            back = 2;
        } else if (
            referenceExtreme == ReferenceExtreme.SwingLow || referenceExtreme == ReferenceExtreme.SwingHigh
        ) {
            back = _lookbackSeconds(lookback) / bucketSeconds;
        } else {
            uint256 latestTs = latestBucket * bucketSeconds;
            uint256 dayStart = latestTs - (latestTs % DAY_SECONDS);
            if (dayStart < DAY_SECONDS) return 0;
            return (dayStart - DAY_SECONDS) / bucketSeconds;
        }
        return latestBucket > back ? latestBucket - back : 0;
    }

    // -------------------------------------------------------------------
    // Break of structure
    // -------------------------------------------------------------------

    /// @notice Strict crossing of a prior swing extreme over
    ///         `swingLookbackCandles` recorded candles. See contract-level
    ///         NatSpec for the exact positional/boundary semantics ported
    ///         from `evaluateBreakOfStructure` in `evaluate.ts`.
    function evaluateBreakOfStructure(
        ICanonicalSeries series,
        Direction direction,
        uint256 swingLookbackCandles,
        uint256 fromBucketInclusive,
        uint256 toBucketInclusive
    ) internal view returns (PredicateResult memory) {
        Candles memory candles = _collect(series, fromBucketInclusive, toBucketInclusive);

        if (candles.count < swingLookbackCandles + 1) {
            revert InsufficientCandles(swingLookbackCandles + 1, candles.count);
        }

        for (uint256 i = swingLookbackCandles; i < candles.count; i++) {
            PredicateResult memory result = _bosResultAt(candles, i, swingLookbackCandles, direction);
            if (result.satisfied || i == candles.count - 1) return result;
        }
        revert InsufficientCandles(swingLookbackCandles + 1, candles.count); // unreachable
    }

    function _bosResultAt(Candles memory candles, uint256 i, uint256 swingLookbackCandles, Direction direction)
        private
        pure
        returns (PredicateResult memory)
    {
        int64 extreme =
            direction == Direction.Long ? candles.highs[i - swingLookbackCandles] : candles.lows[i - swingLookbackCandles];
        for (uint256 j = i - swingLookbackCandles + 1; j < i; j++) {
            if (direction == Direction.Long) {
                if (candles.highs[j] > extreme) extreme = candles.highs[j];
            } else {
                if (candles.lows[j] < extreme) extreme = candles.lows[j];
            }
        }

        int64 current = candles.closes[i];
        bool crossed = direction == Direction.Long ? current > extreme : current < extreme;

        return PredicateResult({
            satisfied: crossed,
            decidingValue: int256(current),
            referenceValue: int256(extreme),
            atBucketIndex: candles.bucketIndices[i],
            atTimestamp: candles.timestamps[i]
        });
    }

    // -------------------------------------------------------------------
    // Fair value gap
    // -------------------------------------------------------------------

    /// @notice Three-candle imbalance, gap in bps >= `minGapBps` (inclusive
    ///         boundary). See contract-level NatSpec for the bps-math scale
    ///         convention ported from `evaluateFairValueGap` in `evaluate.ts`.
    function evaluateFairValueGap(
        ICanonicalSeries series,
        Direction direction,
        uint256 minGapBps,
        uint256 fromBucketInclusive,
        uint256 toBucketInclusive
    ) internal view returns (PredicateResult memory) {
        Candles memory candles = _collect(series, fromBucketInclusive, toBucketInclusive);

        if (candles.count < 3) revert InsufficientCandles(3, candles.count);

        for (uint256 i = 0; i + 2 < candles.count; i++) {
            PredicateResult memory result = _fvgResultAt(candles, i, direction, minGapBps);
            if (result.satisfied || i + 3 == candles.count) return result;
        }
        revert InsufficientCandles(3, candles.count); // unreachable
    }

    function _fvgResultAt(Candles memory candles, uint256 i, Direction direction, uint256 minGapBps)
        private
        pure
        returns (PredicateResult memory)
    {
        int256 c1High = int256(candles.highs[i]);
        int256 c1Low = int256(candles.lows[i]);
        int256 c3Low = int256(candles.lows[i + 2]);
        int256 c3High = int256(candles.highs[i + 2]);

        int256 gap = direction == Direction.Long ? c3Low - c1High : c1Low - c3High;
        int256 refPrice = direction == Direction.Long ? c1High : c1Low;

        bool gapPositive = gap > 0;
        int256 gapBps = 0;
        if (gapPositive) {
            gapBps = refPrice == 0 ? int256(0) : (gap * int256(BPS_DENOMINATOR)) / refPrice;
        }
        bool satisfied = gapPositive && gapBps >= int256(minGapBps);

        return PredicateResult({
            satisfied: satisfied,
            decidingValue: gapBps,
            referenceValue: int256(minGapBps),
            atBucketIndex: candles.bucketIndices[i + 2],
            atTimestamp: candles.timestamps[i + 2]
        });
    }

    // -------------------------------------------------------------------
    // Liquidity sweep
    // -------------------------------------------------------------------

    /// @notice A wick beyond a reference extreme (`prev_day_low`/`high`,
    ///         `prev_session_low`/`high`, or `swing_low`/`high` over a
    ///         lookback) followed by a close strictly back inside. See
    ///         contract-level NatSpec for the boundary convention ported from
    ///         `evaluateLiquiditySweep` in `evaluate.ts`.
    /// @dev    `prev_session_*` is treated identically to `prev_day_*` — the
    ///         exact same simplification `evaluate.ts`'s `referenceExtremeAt`
    ///         documents (no session-boundary spec exists anywhere in this
    ///         codebase), carried over verbatim rather than invented fresh
    ///         here. Flagged for review in the same place: if session
    ///         boundaries are ever specified, both this function and
    ///         `evaluate.ts` need updating together.
    ///
    ///         `direction` is accepted, unused, and never read — exactly
    ///         mirroring `evaluate.ts`'s `evaluateLiquiditySweep`, which takes
    ///         a `LiquiditySweepPredicate` with a `direction` field but never
    ///         reads it either: which side is swept is fully determined by
    ///         `referenceExtreme` (a low-side reference is a long-side sweep,
    ///         a high-side reference is a short-side sweep). Kept in this
    ///         function's signature only so all three evaluators share one
    ///         parameter shape, matching `RefusalGate.PredicateDefinition`'s
    ///         single dispatch path.
    function evaluateLiquiditySweep(
        ICanonicalSeries series,
        Direction, /* direction (unused, see above) */
        ReferenceExtreme referenceExtreme,
        Lookback lookback,
        uint256 fromBucketInclusive,
        uint256 toBucketInclusive
    ) internal view returns (PredicateResult memory) {
        Candles memory candles = _collect(series, fromBucketInclusive, toBucketInclusive);

        if (candles.count < 2) revert InsufficientCandles(2, candles.count);

        bool low = _isLowReference(referenceExtreme);
        uint256 lookbackSeconds = _lookbackSeconds(lookback);

        bool haveLast;
        PredicateResult memory last;
        for (uint256 i = 1; i < candles.count; i++) {
            (bool found, PredicateResult memory result) =
                _sweepResultAt(candles, i, referenceExtreme, lookbackSeconds, low);
            if (!found) continue;

            if (result.satisfied) return result;
            last = result;
            haveLast = true;
        }

        if (!haveLast) revert NoReferenceHistory();
        return last;
    }

    /// @notice Like `evaluateLiquiditySweep`, but decides ONLY on the last
    ///         recorded candle in the window instead of returning the first
    ///         satisfying candle anywhere in it. `RefusalGate.evaluateOnChain`
    ///         uses this: a live trade must be approved by the setup that
    ///         exists NOW (the latest bucket), never by an older sweep that
    ///         happens to sit inside the scan window. Reverts
    ///         `NoReferenceHistory` when the last candle has no reference
    ///         extreme yet, exactly like the scanning variant.
    function evaluateLiquiditySweepAtLatest(
        ICanonicalSeries series,
        Direction, /* direction (unused, see `evaluateLiquiditySweep`) */
        ReferenceExtreme referenceExtreme,
        Lookback lookback,
        uint256 fromBucketInclusive,
        uint256 toBucketInclusive
    ) internal view returns (PredicateResult memory) {
        Candles memory candles = _collect(series, fromBucketInclusive, toBucketInclusive);
        if (candles.count < 2) revert InsufficientCandles(2, candles.count);

        (bool found, PredicateResult memory result) = _sweepResultAt(
            candles, candles.count - 1, referenceExtreme, _lookbackSeconds(lookback), _isLowReference(referenceExtreme)
        );
        if (!found) revert NoReferenceHistory();
        return result;
    }

    function _sweepResultAt(
        Candles memory candles,
        uint256 i,
        ReferenceExtreme referenceExtreme,
        uint256 lookbackSeconds,
        bool low
    ) private pure returns (bool found, PredicateResult memory result) {
        int256 refPrice;
        (refPrice, found) = _referenceExtremeAt(candles, i, referenceExtreme, lookbackSeconds, low);
        if (!found) return (false, result);

        int64 wick = low ? candles.lows[i] : candles.highs[i];
        int256 close = int256(candles.closes[i]);
        bool sweptBeyond = low ? int256(wick) < refPrice : int256(wick) > refPrice;
        bool closedBackInside = low ? close > refPrice : close < refPrice;

        result = PredicateResult({
            satisfied: sweptBeyond && closedBackInside,
            decidingValue: int256(wick),
            referenceValue: refPrice,
            atBucketIndex: candles.bucketIndices[i],
            atTimestamp: candles.timestamps[i]
        });
    }

    function _isLowReference(ReferenceExtreme referenceExtreme) private pure returns (bool) {
        return referenceExtreme == ReferenceExtreme.PrevDayLow || referenceExtreme == ReferenceExtreme.PrevSessionLow
            || referenceExtreme == ReferenceExtreme.SwingLow;
    }

    function _lookbackSeconds(Lookback lookback) internal pure returns (uint256) {
        if (lookback == Lookback.M15) return 900;
        if (lookback == Lookback.H1) return 3_600;
        if (lookback == Lookback.H4) return 14_400;
        if (lookback == Lookback.D1) return DAY_SECONDS;
        return 604_800; // W1
    }

    /// @dev Mirrors `referenceExtremeAt` in `evaluate.ts`: the reference
    ///      extreme as of candle `index`, computed only from candles strictly
    ///      before it (`j < index`), positionally over the compacted arrays —
    ///      never inventing a reference when there is not yet enough history
    ///      (returns `found == false` instead, exactly like the TS `null`).
    function _referenceExtremeAt(
        Candles memory candles,
        uint256 index,
        ReferenceExtreme referenceExtreme,
        uint256 lookbackSeconds,
        bool low
    ) private pure returns (int256, bool) {
        uint256 at = candles.timestamps[index];

        if (referenceExtreme == ReferenceExtreme.SwingLow || referenceExtreme == ReferenceExtreme.SwingHigh) {
            uint256 lookbackStart = at > lookbackSeconds ? at - lookbackSeconds : 0;
            bool found;
            int64 extreme;
            for (uint256 j = 0; j < index; j++) {
                if (candles.timestamps[j] < lookbackStart) continue;
                int64 v = low ? candles.lows[j] : candles.highs[j];
                if (!found || (low ? v < extreme : v > extreme)) {
                    extreme = v;
                    found = true;
                }
            }
            if (!found) return (0, false);
            return (int256(extreme), true);
        }

        // prev_day_* / prev_session_* — treated identically, see this
        // function's contract-level NatSpec note.
        uint256 currentDay = at / DAY_SECONDS;
        if (currentDay == 0) return (0, false);
        uint256 prevDay = currentDay - 1;

        bool found2;
        int64 extreme2;
        for (uint256 j = 0; j < index; j++) {
            if (candles.timestamps[j] / DAY_SECONDS != prevDay) continue;
            int64 v = low ? candles.lows[j] : candles.highs[j];
            if (!found2 || (low ? v < extreme2 : v > extreme2)) {
                extreme2 = v;
                found2 = true;
            }
        }
        if (!found2) return (0, false);
        return (int256(extreme2), true);
    }

    /// @dev Compacts `[fromBucketInclusive, toBucketInclusive]` into a
    ///      `Candles` struct holding only `recorded` candles, in ascending
    ///      bucket order — the on-chain analog of `evaluate.ts`'s
    ///      already-compacted `series.candles`. Unrecorded buckets are
    ///      skipped, never synthesized, exactly like
    ///      `CanonicalSeries.swingHigh`/`swingLow`. `open` is intentionally
    ///      not collected — no evaluator in this library reads it.
    function _collect(ICanonicalSeries series, uint256 fromBucketInclusive, uint256 toBucketInclusive)
        private
        view
        returns (Candles memory candles)
    {
        if (fromBucketInclusive > toBucketInclusive) revert InvalidWindow();
        uint256 span = toBucketInclusive - fromBucketInclusive + 1;
        if (span > MAX_SCAN_BUCKETS) revert WindowTooWide();

        uint256 bucketSeconds = series.bucketSeconds();

        candles.highs = new int64[](span);
        candles.lows = new int64[](span);
        candles.closes = new int64[](span);
        candles.timestamps = new uint256[](span);
        candles.bucketIndices = new uint256[](span);

        uint256 count = 0;
        for (uint256 i = 0; i < span; i++) {
            uint256 bucketIndex = fromBucketInclusive + i;
            (, int64 h, int64 l, int64 c,, bool recorded) = series.getCandle(bucketIndex);
            if (!recorded) continue;

            candles.highs[count] = h;
            candles.lows[count] = l;
            candles.closes[count] = c;
            candles.bucketIndices[count] = bucketIndex;
            candles.timestamps[count] = bucketIndex * bucketSeconds;
            count++;
        }
        candles.count = count;
    }
}
