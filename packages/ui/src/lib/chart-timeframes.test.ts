import { describe, expect, it } from 'vitest';
import { ALLOWED_BUCKET_SECONDS } from '../../../backend/convex/seriesLogic';
import {
  CHART_TIMEFRAMES,
  DEFAULT_TIMEFRAME,
  barClock,
  bucketStartOf,
  showsTimeOfDay,
  timeframeByBucket,
  timeframeForRule,
} from './chart-timeframes';

describe('timeframes', () => {
  it('offers exactly the widths the backend will serve', () => {
    expect(CHART_TIMEFRAMES.map((t) => t.bucketSeconds)).toEqual([...ALLOWED_BUCKET_SECONDS]);
  });

  it('labels run 1m to 1W', () => {
    expect(CHART_TIMEFRAMES.map((t) => t.label)).toEqual(['1m', '5m', '15m', '1H', '4H', '1D', '1W']);
  });

  it('looks a timeframe up by bucket width', () => {
    expect(timeframeByBucket(14_400)?.label).toBe('4H');
    expect(timeframeByBucket(7)).toBeUndefined();
  });

  it('opens on the rule timeframe when the chart offers it, else the default', () => {
    expect(timeframeForRule(900).label).toBe('15m');
    expect(timeframeForRule(1234)).toBe(DEFAULT_TIMEFRAME);
    expect(timeframeForRule(undefined)).toBe(DEFAULT_TIMEFRAME);
  });

  it('shows the time of day only for intraday candles', () => {
    expect(showsTimeOfDay(3_600)).toBe(true);
    expect(showsTimeOfDay(86_400)).toBe(false);
    expect(showsTimeOfDay(604_800)).toBe(false);
  });

  it('buckets are epoch-anchored, so a week starts on a Thursday', () => {
    const start = bucketStartOf(1_760_400_000, 604_800);
    expect(new Date(start * 1000).getUTCDay()).toBe(4);
  });
});

describe('bar clock', () => {
  it('counts down to the close of the bar that holds now', () => {
    const now = 3_600 * 10 + 1_000; // 1,000s into an hour bar
    expect(barClock(3_600 * 10, 3_600, now).remaining).toBe(2_600);
  });

  it('is live when the last candle is the current or the previous bar', () => {
    const now = 3_600 * 10 + 5;
    expect(barClock(3_600 * 10, 3_600, now).live).toBe(true);
    expect(barClock(3_600 * 9, 3_600, now).live).toBe(true);
  });

  it('is not live when the feed has gone quiet for more than a bar', () => {
    const now = 3_600 * 10 + 5;
    expect(barClock(3_600 * 8, 3_600, now).live).toBe(false);
  });

  it('is exactly one bucket at the instant a bar opens', () => {
    expect(barClock(0, 60, 120).remaining).toBe(60);
  });
});
