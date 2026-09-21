// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { CanonicalSeries } from "../src/CanonicalSeries.sol";
import { PredicateEngine } from "../src/PredicateEngine.sol";
import { MockPyth } from "./mocks/MockPyth.sol";

/**
 * @title PredicateEngineTest
 * @notice Every candle planted here reuses `packages/spec/src/evaluate.test.ts`'s
 *         own fixture numbers verbatim (same OHLC values, same timestamps, same
 *         predicate parameters), at cent-scale (`expo = -2`) so the raw `int64`
 *         atoms this contract asserts on are the exact same digits the TS
 *         suite's `formatDecimal`/`.atoms` assertions print — e.g. TS
 *         `formatDecimal(result.decidingValue) === '102.00'` is asserted here
 *         as `result.decidingValue == 10_200`. This is the strongest possible
 *         evidence the Solidity port matches the reference bit-for-bit: not
 *         "produces a plausible answer" but "produces the identical number".
 *
 * @dev    Candles are planted on a real `CanonicalSeries` (not a hand-rolled
 *         mock) via four `recordSample()` calls per candle — price sequence
 *         (open, high, low, close) — exactly reproducing arbitrary OHLC in one
 *         bucket. See `_setCandle`. `PredicateEngine`'s functions are
 *         `internal`, so they're called directly on the imported library from
 *         this test contract; Solidity inlines them, no linking needed.
 */
contract PredicateEngineTest is Test {
    bytes32 constant FEED = bytes32(uint256(1));
    uint256 constant CADENCE = 1;
    uint256 constant BUCKET = 900; // matches TEST_BUCKET_SECONDS in packages/spec/src/test-fixtures.ts
    uint256 constant MAX_AGE = 60;
    uint256 constant BASE_BUCKET = 1_000_000; // arbitrary clean bucket boundary, like the other test files

    /// @dev The absolute timestamp of bucket `BASE_BUCKET` — added to every
    ///      TS-fixture timestamp (which starts at t=0) since this test plants
    ///      candles on a real bucketed series that can't start at t=0.
    uint256 constant T0 = BASE_BUCKET * BUCKET;

    MockPyth pyth;
    CanonicalSeries series;

    function setUp() public {
        pyth = new MockPyth();
        series = new CanonicalSeries("BTC/USD", FEED, CADENCE, BUCKET, address(pyth), MAX_AGE);
    }

    // Thin `external` wrappers so `vm.expectRevert()` watches the whole
    // evaluation (including its nested `series.getCandle` calls) as a single
    // outer call, rather than latching onto the first harmless external
    // `getCandle` staticcall `PredicateEngine`'s internal (inlined) code
    // happens to make first.
    function _evalBOS(PredicateEngine.Direction direction, uint256 lookback, uint256 from, uint256 to)
        external
        view
        returns (PredicateEngine.PredicateResult memory)
    {
        return PredicateEngine.evaluateBreakOfStructure(series, direction, lookback, from, to);
    }

    function _evalFVG(PredicateEngine.Direction direction, uint256 minGapBps, uint256 from, uint256 to)
        external
        view
        returns (PredicateEngine.PredicateResult memory)
    {
        return PredicateEngine.evaluateFairValueGap(series, direction, minGapBps, from, to);
    }

    function _evalSweep(
        PredicateEngine.Direction direction,
        PredicateEngine.ReferenceExtreme referenceExtreme,
        PredicateEngine.Lookback lookback,
        uint256 from,
        uint256 to
    ) external view returns (PredicateEngine.PredicateResult memory) {
        return PredicateEngine.evaluateLiquiditySweep(series, direction, referenceExtreme, lookback, from, to);
    }

    /// @dev Plants one candle at bucket `BASE_BUCKET + candleIndex`, i.e. at
    ///      timestamp `(BASE_BUCKET + candleIndex) * BUCKET` — matching
    ///      `makeCandle(..., candleIndex * TEST_BUCKET_SECONDS)` in
    ///      packages/spec/src/test-fixtures.ts one-for-one when candles are
    ///      contiguous. `open` sets O=H=L=C; `high` then strictly raises H
    ///      (or is a no-op if it already equals O); `low` strictly lowers L;
    ///      `close` unconditionally becomes the final close without
    ///      disturbing H/L, since a valid candle always has low <= close <=
    ///      high. Prices are cent-atoms (expo -2), matching
    ///      packages/spec/src/test-fixtures.ts's TEST_DECIMALS = 2.
    function _setCandle(uint256 bucketIndex, int64 open, int64 high, int64 low, int64 close) internal {
        uint256 bucketStart = bucketIndex * BUCKET;
        vm.warp(bucketStart);
        _sample(open);
        vm.warp(bucketStart + 1);
        _sample(high);
        vm.warp(bucketStart + 2);
        _sample(low);
        vm.warp(bucketStart + 3);
        _sample(close);
    }

    function _sample(int64 price) internal {
        pyth.setPrice(FEED, price, 1, -2, block.timestamp);
        series.recordSample();
    }

    // ------------------------------------------------------------------
    // Break of structure — candle values from evaluate.test.ts's
    // `describe('evaluateBreakOfStructure')`.
    // ------------------------------------------------------------------

    function test_BreakOfStructure_Satisfied_MatchesTsFixture() public {
        // TS: "is satisfied when close trades beyond the prior swing high"
        _setCandle(BASE_BUCKET, 9_900, 10_000, 9_500, 9_900); // 99/100/95/99 @ t=0
        _setCandle(BASE_BUCKET + 1, 10_000, 10_100, 9_600, 10_000); // 100/101/96/100 @ t=900
        _setCandle(BASE_BUCKET + 2, 9_800, 9_900, 9_400, 9_800); // 98/99/94/98 @ t=1800
        _setCandle(BASE_BUCKET + 3, 10_100, 10_200, 9_700, 10_200); // 101/102/97/102 @ t=2700

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateBreakOfStructure(
            series, PredicateEngine.Direction.Long, 3, BASE_BUCKET, BASE_BUCKET + 3
        );

        assertTrue(result.satisfied);
        assertEq(result.decidingValue, 10_200, "TS: formatDecimal(decidingValue) === '102.00'");
        assertEq(result.referenceValue, 10_100, "TS: formatDecimal(referenceValue) === '101.00'");
        assertEq(result.atTimestamp, T0 + 2700, "TS: result.at === 2700");
    }

    function test_BreakOfStructure_Refused_ReportsLatestState_MatchesTsFixture() public {
        // TS: "is refused when no close ever trades beyond the swing high,
        // reporting the latest state"
        _setCandle(BASE_BUCKET, 9_900, 10_000, 9_500, 9_900); // t=0
        _setCandle(BASE_BUCKET + 1, 10_000, 10_100, 9_600, 10_000); // t=900
        _setCandle(BASE_BUCKET + 2, 9_800, 9_900, 9_400, 9_800); // t=1800
        _setCandle(BASE_BUCKET + 3, 10_000, 10_000, 9_500, 10_000); // t=2700
        _setCandle(BASE_BUCKET + 4, 10_100, 10_100, 9_600, 10_100); // t=3600
        _setCandle(BASE_BUCKET + 5, 10_000, 10_000, 9_500, 10_000); // t=4500

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateBreakOfStructure(
            series, PredicateEngine.Direction.Long, 3, BASE_BUCKET, BASE_BUCKET + 5
        );

        assertFalse(result.satisfied);
        assertEq(result.atTimestamp, T0 + 4500, "TS: result.at === 4500");
        assertEq(result.decidingValue, 10_000, "TS: formatDecimal(decidingValue) === '100.00'");
        assertEq(result.referenceValue, 10_100, "TS: formatDecimal(referenceValue) === '101.00'");
    }

    function test_BreakOfStructure_ExactlyAtSwingHigh_IsNotBroken_StrictBoundary() public {
        // TS: "treats a close exactly at the swing high as not broken
        // (boundary is strict)"
        _setCandle(BASE_BUCKET, 9_900, 10_000, 9_500, 9_900);
        _setCandle(BASE_BUCKET + 1, 10_000, 10_100, 9_600, 10_000);
        _setCandle(BASE_BUCKET + 2, 9_800, 9_900, 9_400, 9_800);
        _setCandle(BASE_BUCKET + 3, 10_100, 10_100, 9_600, 10_100);

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateBreakOfStructure(
            series, PredicateEngine.Direction.Long, 3, BASE_BUCKET, BASE_BUCKET + 3
        );

        assertFalse(result.satisfied, "close == swing high must not satisfy (strict inequality)");
        assertEq(result.decidingValue, 10_100);
        assertEq(result.referenceValue, 10_100);
    }

    function test_BreakOfStructure_RevertsBelowLookbackCandleCount() public {
        // TS: "throws when the series does not have enough candles for the lookback"
        _setCandle(BASE_BUCKET, 9_900, 10_000, 9_500, 9_900);
        _setCandle(BASE_BUCKET + 1, 10_000, 10_100, 9_600, 10_000);

        vm.expectRevert();
        this._evalBOS(PredicateEngine.Direction.Long, 3, BASE_BUCKET, BASE_BUCKET + 1);
    }

    // ------------------------------------------------------------------
    // Fair value gap — candle values from evaluate.test.ts's
    // `describe('evaluateFairValueGap')`.
    // ------------------------------------------------------------------

    function test_FairValueGap_Satisfied_MatchesTsFixture() public {
        // TS: "is satisfied when the three-candle gap clears the minimum in bps"
        // minGapBps = 50, actual gap = 100 bps.
        _setCandle(BASE_BUCKET, 9_950, 10_000, 9_900, 9_980); // 99.50/100.00/99.00/99.80
        _setCandle(BASE_BUCKET + 1, 10_000, 10_050, 9_990, 10_030); // 100.00/100.50/99.90/100.30
        _setCandle(BASE_BUCKET + 2, 10_100, 10_150, 10_100, 10_120); // 101.00/101.50/101.00/101.20

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateFairValueGap(
            series, PredicateEngine.Direction.Long, 50, BASE_BUCKET, BASE_BUCKET + 2
        );

        assertTrue(result.satisfied);
        assertEq(result.decidingValue, 100, "TS: decidingValue.atoms === '100' (100 bps)");
        assertEq(result.referenceValue, 50, "TS: referenceValue.atoms === '50'");
        assertEq(result.atTimestamp, T0 + 1800, "TS: result.at === 1800");
    }

    function test_FairValueGap_Refused_GapSmallerThanMinimum_MatchesTsFixture() public {
        // TS: "is refused when the gap exists but is smaller than the minimum"
        // minGapBps = 150, actual gap = 100 bps.
        _setCandle(BASE_BUCKET, 9_950, 10_000, 9_900, 9_980);
        _setCandle(BASE_BUCKET + 1, 10_000, 10_050, 9_990, 10_030);
        _setCandle(BASE_BUCKET + 2, 10_100, 10_150, 10_100, 10_120);

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateFairValueGap(
            series, PredicateEngine.Direction.Long, 150, BASE_BUCKET, BASE_BUCKET + 2
        );

        assertFalse(result.satisfied);
        assertEq(result.decidingValue, 100);
        assertEq(result.referenceValue, 150);
    }

    function test_FairValueGap_ExactlyAtMinimum_IsSatisfied_InclusiveBoundary() public {
        // TS: "satisfies a gap exactly equal to the minimum (boundary is inclusive)"
        // minGapBps = 100, actual gap = 100 bps.
        _setCandle(BASE_BUCKET, 9_950, 10_000, 9_900, 9_980);
        _setCandle(BASE_BUCKET + 1, 10_000, 10_050, 9_990, 10_030);
        _setCandle(BASE_BUCKET + 2, 10_100, 10_150, 10_100, 10_120);

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateFairValueGap(
            series, PredicateEngine.Direction.Long, 100, BASE_BUCKET, BASE_BUCKET + 2
        );

        assertTrue(result.satisfied, "gap == minGapBps must satisfy (inclusive boundary)");
        assertEq(result.decidingValue, 100);
        assertEq(result.referenceValue, 100);
    }

    function test_FairValueGap_RevertsBelowThreeCandles() public {
        // TS: "throws when the series has fewer than three candles"
        _setCandle(BASE_BUCKET, 10_000, 10_100, 9_900, 10_000);

        vm.expectRevert();
        this._evalFVG(PredicateEngine.Direction.Long, 50, BASE_BUCKET, BASE_BUCKET);
    }

    // ------------------------------------------------------------------
    // Liquidity sweep — candle values from evaluate.test.ts's
    // `describe('evaluateLiquiditySweep')`. Day-0 candles at t=0 and t=900;
    // the swept candle lands at t=86_400, i.e. bucket BASE_BUCKET + 96.
    // ------------------------------------------------------------------

    function _setDay0() internal {
        _setCandle(BASE_BUCKET, 9_920, 10_000, 9_900, 9_950); // 99.20/100.00/99.00/99.50 @ t=0
        _setCandle(BASE_BUCKET + 1, 9_980, 10_050, 9_850, 9_980); // 99.80/100.50/98.50/99.80 @ t=900
    }

    function test_LiquiditySweep_Satisfied_MatchesTsFixture() public {
        // TS: "is satisfied when a wick trades below the prior day low and
        // closes back above it"
        _setDay0();
        _setCandle(BASE_BUCKET + 96, 9_900, 9_930, 9_800, 9_900); // 99.00/99.30/98.00/99.00 @ t=86_400

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateLiquiditySweep(
            series,
            PredicateEngine.Direction.Long,
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.Lookback.D1,
            BASE_BUCKET,
            BASE_BUCKET + 96
        );

        assertTrue(result.satisfied);
        assertEq(result.decidingValue, 9_800, "TS: formatDecimal(decidingValue) === '98.00'");
        assertEq(result.referenceValue, 9_850, "TS: formatDecimal(referenceValue) === '98.50'");
        assertEq(result.atTimestamp, T0 + 86_400, "TS: result.at === 86_400");
    }

    function test_LiquiditySweep_Refused_ClosesDoNotComeBackInside_MatchesTsFixture() public {
        // TS: "is refused when the wick sweeps but the close does not come back inside"
        _setDay0();
        _setCandle(BASE_BUCKET + 96, 9_900, 9_910, 9_800, 9_820); // 99.00/99.10/98.00/98.20

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateLiquiditySweep(
            series,
            PredicateEngine.Direction.Long,
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.Lookback.D1,
            BASE_BUCKET,
            BASE_BUCKET + 96
        );

        assertFalse(result.satisfied);
        assertEq(result.decidingValue, 9_800, "TS: formatDecimal(decidingValue) === '98.00'");
        assertEq(result.referenceValue, 9_850, "TS: formatDecimal(referenceValue) === '98.50'");
    }

    function test_LiquiditySweep_WickTouchesReference_IsNotSwept_StrictBoundary() public {
        // TS: "treats a wick that only touches the reference as not swept
        // (boundary is strict)"
        _setDay0();
        _setCandle(BASE_BUCKET + 96, 9_900, 9_930, 9_850, 9_900); // low === prev-day-low exactly

        PredicateEngine.PredicateResult memory result = PredicateEngine.evaluateLiquiditySweep(
            series,
            PredicateEngine.Direction.Long,
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.Lookback.D1,
            BASE_BUCKET,
            BASE_BUCKET + 96
        );

        assertFalse(result.satisfied, "a wick exactly at the reference extreme must not count as swept");
        assertEq(result.decidingValue, 9_850, "TS: formatDecimal(decidingValue) === '98.50'");
        assertEq(result.referenceValue, 9_850, "TS: formatDecimal(referenceValue) === '98.50'");
    }

    function test_LiquiditySweep_RevertsWhenNoCandleHasEnoughHistory() public {
        // TS: "throws when no candle ever has enough history for a reference extreme"
        _setDay0();

        vm.expectRevert();
        this._evalSweep(
            PredicateEngine.Direction.Long,
            PredicateEngine.ReferenceExtreme.PrevDayLow,
            PredicateEngine.Lookback.D1,
            BASE_BUCKET,
            BASE_BUCKET + 1
        );
    }
}
