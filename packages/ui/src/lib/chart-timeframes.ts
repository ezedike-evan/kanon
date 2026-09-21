/**
 * The chart's timeframes and the clock maths around a bar.
 *
 * Every option re-buckets the same canonical series at a different candle
 * width, so `bucketSeconds` is the timeframe. The set is the backend's
 * allow-list (`ALLOWED_BUCKET_SECONDS` in `packages/backend/convex/seriesLogic.ts`);
 * `chart-timeframes.test.ts` fails if the two drift apart, because a width the
 * backend does not accept is a chart that never loads.
 *
 * Buckets are epoch-anchored like the contract's, which puts a 1W candle's
 * start on a Thursday.
 */

export interface Timeframe {
  /** What the picker and the watermark show. */
  label: string;
  bucketSeconds: number;
}

export const CHART_TIMEFRAMES: readonly Timeframe[] = [
  { label: '1m', bucketSeconds: 60 },
  { label: '5m', bucketSeconds: 300 },
  { label: '15m', bucketSeconds: 900 },
  { label: '1H', bucketSeconds: 3_600 },
  { label: '4H', bucketSeconds: 14_400 },
  { label: '1D', bucketSeconds: 86_400 },
  { label: '1W', bucketSeconds: 604_800 },
];

export const DEFAULT_TIMEFRAME: Timeframe = CHART_TIMEFRAMES[3]!;

export function timeframeByBucket(bucketSeconds: number): Timeframe | undefined {
  return CHART_TIMEFRAMES.find((t) => t.bucketSeconds === bucketSeconds);
}

/**
 * The timeframe a rule was pinned on: its `bucketSeconds` when the chart
 * offers it, otherwise the default. The chart opens on the rule's own candles.
 */
export function timeframeForRule(bucketSeconds: number | undefined): Timeframe {
  return (bucketSeconds !== undefined && timeframeByBucket(bucketSeconds)) || DEFAULT_TIMEFRAME;
}

/** Whether candles this wide are drawn with a time of day on the axis. */
export function showsTimeOfDay(bucketSeconds: number): boolean {
  return bucketSeconds < 86_400;
}

/** Start of the bucket that holds `nowSeconds`. */
export function bucketStartOf(nowSeconds: number, bucketSeconds: number): number {
  return Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
}

export interface BarClock {
  /** Seconds until the current bar closes. */
  remaining: number;
  /**
   * The last candle belongs to the current bar or the one before it. Past that
   * the feed is stale and a countdown would state a bar that is not forming.
   */
  live: boolean;
}

export function barClock(lastCandleStart: number, bucketSeconds: number, nowSeconds: number): BarClock {
  const current = bucketStartOf(nowSeconds, bucketSeconds);
  return {
    remaining: current + bucketSeconds - nowSeconds,
    live: lastCandleStart >= current - bucketSeconds,
  };
}
