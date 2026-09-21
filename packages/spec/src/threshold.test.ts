import { describe, expect, it } from 'vitest';
import { settleThreshold } from './threshold';
import { makeCandle, makeSeries, p } from './test-fixtures';
import { formatDecimal } from './decimal';

describe('settleThreshold', () => {
  it('settles a hit for direction "above" on the first candle whose high crosses it', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.50', '99.50', '100.20', 0),
      makeCandle('100.20', '101.20', '100.00', '101.00', 900),
      makeCandle('101.00', '102.00', '100.90', '101.80', 1800),
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 2700,
    });
    expect(result.settled).toBe(true);
    expect(result.hit).toBe(true);
    expect(result.decidingAt).toBe(900);
    expect(formatDecimal(result.decidingPrice!)).toBe('101.20');
  });

  it('settles a hit for direction "below" on the first candle whose low crosses it', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.50', '99.80', '100.20', 0),
      makeCandle('100.20', '100.60', '98.90', '99.50', 900),
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'below',
      thresholdPrice: p('99.00'),
      windowStart: 0,
      windowEnd: 1800,
    });
    expect(result.settled).toBe(true);
    expect(result.hit).toBe(true);
    expect(result.decidingAt).toBe(900);
    expect(formatDecimal(result.decidingPrice!)).toBe('98.90');
  });

  it('settles no-hit once recorded samples cover the full window', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.30', '99.80', '100.10', 0),
      makeCandle('100.10', '100.40', '99.90', '100.20', 900),
      makeCandle('100.20', '100.50', '100.00', '100.30', 1800),
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 1800,
    });
    expect(result.settled).toBe(true);
    expect(result.hit).toBe(false);
    expect(result.decidingPrice).toBeUndefined();
  });

  it('refuses to settle no-hit while the window has not finished being observed', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.30', '99.80', '100.10', 0),
      // no candle yet at or after windowEnd — the tape has not caught up
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 3600,
    });
    expect(result.settled).toBe(false);
    expect(result.hit).toBe(false);
  });

  it('counts touching the threshold as a hit (boundary is inclusive)', () => {
    const series = makeSeries('BTC/USD', [makeCandle('100', '101.00', '99.80', '100.90', 0)]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 900,
    });
    expect(result.hit).toBe(true);
    expect(formatDecimal(result.decidingPrice!)).toBe('101.00');
  });

  it('ignores candles outside the window even if they would have crossed', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.30', '99.80', '100.10', 0),
      makeCandle('100.10', '105.00', '100.00', '104.00', 900), // crosses, but after windowEnd
      makeCandle('104.00', '104.50', '103.80', '104.20', 1800),
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 0,
    });
    expect(result.settled).toBe(true);
    expect(result.hit).toBe(false);
  });

  it('settles honestly off recorded samples through a sparse window, never assuming an unrecorded tick crossed', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100.30', '99.80', '100.10', 0),
      // bucket at 900 never printed — event-driven feed
      makeCandle('100.10', '100.40', '99.90', '100.20', 1800),
    ]);
    const result = settleThreshold(series, {
      asset: 'BTC/USD',
      direction: 'above',
      thresholdPrice: p('101.00'),
      windowStart: 0,
      windowEnd: 1800,
    });
    expect(result.settled).toBe(true);
    expect(result.hit).toBe(false);
  });
});
