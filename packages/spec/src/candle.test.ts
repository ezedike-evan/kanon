import { describe, expect, it } from 'vitest';
import { bucketTicks } from './candle';
import { compareDecimal, formatDecimal, parseDecimal } from './decimal';
import { p } from './test-fixtures';

const BUCKET_SECONDS = 900;

describe('bucketTicks', () => {
  it('buckets ticks landing in one interval into a single candle', () => {
    const series = bucketTicks(
      [
        { timestamp: 0, price: p('100.00') },
        { timestamp: 300, price: p('101.50') },
        { timestamp: 600, price: p('99.75') },
        { timestamp: 899, price: p('100.25') },
      ],
      { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS },
    );

    expect(series.candles).toHaveLength(1);
    const c = series.candles[0]!;
    expect(c.bucketIndex).toBe(0);
    expect(c.timestamp).toBe(0);
    expect(formatDecimal(c.open)).toBe('100.00');
    expect(formatDecimal(c.close)).toBe('100.25');
    expect(formatDecimal(c.high)).toBe('101.50');
    expect(formatDecimal(c.low)).toBe('99.75');
    expect(c.synthetic).toBe(false);
  });

  it('sorts out-of-order ticks before bucketing', () => {
    const series = bucketTicks(
      [
        { timestamp: 899, price: p('100.25') },
        { timestamp: 0, price: p('100.00') },
        { timestamp: 300, price: p('101.50') },
      ],
      { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS },
    );
    expect(formatDecimal(series.candles[0]!.open)).toBe('100.00');
    expect(formatDecimal(series.candles[0]!.close)).toBe('100.25');
  });

  it('splits ticks across buckets in timestamp order', () => {
    const series = bucketTicks(
      [
        { timestamp: 0, price: p('100.00') },
        { timestamp: 900, price: p('102.00') },
        { timestamp: 1800, price: p('101.00') },
      ],
      { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS },
    );
    expect(series.candles.map((c) => c.bucketIndex)).toEqual([0, 1, 2]);
  });

  it('leaves an empty bucket absent by default, not fabricated', () => {
    const series = bucketTicks(
      [
        { timestamp: 0, price: p('100.00') },
        // bucket index 1 (900-1799) has no ticks — sparse, event-driven feed
        { timestamp: 1800, price: p('105.00') },
      ],
      { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS },
    );
    expect(series.candles.map((c) => c.bucketIndex)).toEqual([0, 2]);
  });

  it('fills a gap with a flat, synthetic carry-forward candle when asked', () => {
    const series = bucketTicks(
      [
        { timestamp: 0, price: p('100.00') },
        { timestamp: 1800, price: p('105.00') },
      ],
      { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS, fillGaps: true },
    );
    expect(series.candles.map((c) => c.bucketIndex)).toEqual([0, 1, 2]);
    const filled = series.candles[1]!;
    expect(filled.synthetic).toBe(true);
    // Carried close only — no invented high or low beyond the carried value.
    expect(compareDecimal(filled.open, filled.high)).toBe(0);
    expect(compareDecimal(filled.open, filled.low)).toBe(0);
    expect(compareDecimal(filled.open, filled.close)).toBe(0);
    expect(formatDecimal(filled.close)).toBe('100.00');
  });

  it('leaves a leading gap absent even with fillGaps, since there is no close to carry', () => {
    const series = bucketTicks([{ timestamp: 1800, price: p('105.00') }], {
      asset: 'BTC/USD',
      bucketSeconds: BUCKET_SECONDS,
      fillGaps: true,
    });
    expect(series.candles.map((c) => c.bucketIndex)).toEqual([2]);
  });

  it('returns an empty series for no ticks', () => {
    const series = bucketTicks([], { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS });
    expect(series.candles).toEqual([]);
  });

  it('produces Decimal fields, never floats', () => {
    const series = bucketTicks([{ timestamp: 0, price: p('68412.50') }], {
      asset: 'BTC/USD',
      bucketSeconds: BUCKET_SECONDS,
    });
    const c = series.candles[0]!;
    expect(typeof c.close.atoms).toBe('string');
    expect(compareDecimal(c.close, parseDecimal('68412.50', 2))).toBe(0);
  });
});
