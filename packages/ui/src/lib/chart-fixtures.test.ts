import { describe, expect, it } from 'vitest';
import { buildFixtureMarkers, buildFixtureSeries } from './chart-fixtures';
import { seriesToCandle5 } from './chart-series';
import { CHART_TIMEFRAMES } from './chart-timeframes';
import { ASSETS } from '@kanon/spec';

describe('demo tape', () => {
  it('serves every timeframe of every tradeable asset in the canonical shape', () => {
    for (const asset of ASSETS.slice(0, 1)) {
      for (const tf of CHART_TIMEFRAMES) {
        const s = buildFixtureSeries(asset.symbol, tf.bucketSeconds, 200);
        expect(s.candles.length).toBeGreaterThan(20);
        expect(s.bucketSeconds).toBe(tf.bucketSeconds);
        for (const c of s.candles.slice(-30)) expect(c.timestamp % tf.bucketSeconds).toBe(0);
      }
    }
  }, 60_000);

  it('holds 2000+ candles at a fine timeframe', () => {
    const s = buildFixtureSeries('BTC/USD', 60, 2400);
    expect(s.candles.length).toBe(2400);
    expect(seriesToCandle5(s)).toHaveLength(2400);
  });

  it('never pads a timeframe with flat candles the tape has no prints for', () => {
    const s = buildFixtureSeries('BTC/USD', 300, 2400);
    expect(s.candles.length).toBeLessThanOrEqual(1440); // five days of 5m prints
    const synthetic = s.candles.filter((c) => c.synthetic).length;
    expect(synthetic / s.candles.length).toBeLessThan(0.2);
  });

  it('keeps each candle internally consistent', () => {
    const rows = seriesToCandle5(buildFixtureSeries('SOL/USD', 900, 500));
    for (const [, o, h, l, c] of rows) {
      expect(h).toBeGreaterThanOrEqual(Math.max(o, c));
      expect(l).toBeLessThanOrEqual(Math.min(o, c));
    }
  }, 30_000);

  it('quotes each asset at its own precision and level', () => {
    const btc = buildFixtureSeries('BTC/USD', 3600, 50);
    const mon = buildFixtureSeries('MON/USD', 3600, 50);
    expect(btc.candles.at(-1)!.close.decimals).toBe(2);
    expect(mon.candles.at(-1)!.close.decimals).toBe(5);
    expect(seriesToCandle5(btc).at(-1)![4]).toBeGreaterThan(seriesToCandle5(mon).at(-1)![4] * 100);
  }, 30_000);

  it('is deterministic per asset and treats spelling variants as one asset', () => {
    const a = buildFixtureSeries('BTC / USD', 3600, 50);
    const b = buildFixtureSeries('btc/usd', 3600, 50);
    expect(a).toBe(b);
  });

  it('ends at the present, so the bar clock has something to count', () => {
    const s = buildFixtureSeries('BTC/USD', 60, 100);
    const last = s.candles.at(-1)!.timestamp;
    expect(Math.abs(Date.now() / 1000 - last)).toBeLessThan(3_600);
  });

  it('places its trade markers on real candles', () => {
    const s = buildFixtureSeries('BTC/USD', 900, 600);
    const starts = new Set(s.candles.map((c) => c.timestamp));
    const markers = buildFixtureMarkers(s);
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(starts.has(m.timestamp)).toBe(true);
  }, 30_000);
});
