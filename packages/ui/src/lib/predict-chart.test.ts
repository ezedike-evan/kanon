import { describe, expect, it } from 'vitest';
import { parseDecimal, type Series } from '@kanon/spec';
import { MAX_POINTS, candleCountFor, chartGeometry, closesOf, downsample } from './predict-chart';

const box = { width: 400, height: 300, plotRight: 330, padTop: 20, padBottom: 20 };

describe('candles a page shows', () => {
  it('shows about three windows, bounded', () => {
    expect(candleCountFor(3_600, 900)).toBe(32); // 12 candles wanted, floor of 32
    expect(candleCountFor(14_400, 900)).toBe(48);
    expect(candleCountFor(86_400, 900)).toBe(MAX_POINTS); // 288 wanted, capped
    expect(candleCountFor(3_600, 0)).toBe(MAX_POINTS);
  });

  it('takes the last closes as numbers', () => {
    const series: Series = {
      asset: 'BTC/USD',
      bucketSeconds: 900,
      candles: [1, 2, 3, 4].map((n) => ({
        bucketIndex: n,
        timestamp: n * 900,
        open: parseDecimal(`${n}`, 2),
        high: parseDecimal(`${n + 1}`, 2),
        low: parseDecimal(`${n - 1}`, 2),
        close: parseDecimal(`${n}.5`, 2),
        synthetic: false,
      })),
    };
    expect(closesOf(series, 2)).toEqual([3.5, 4.5]);
    expect(closesOf(series, 99)).toEqual([1.5, 2.5, 3.5, 4.5]);
  });
});

describe('downsample', () => {
  it('leaves a short series alone', () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('keeps the first and the last point, so the line still ends on the live price', () => {
    const long = Array.from({ length: 1_000 }, (_, i) => i);
    const out = downsample(long, 90);
    expect(out).toHaveLength(90);
    expect(out[0]).toBe(0);
    expect(out[89]).toBe(999);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });
});

describe('chartGeometry', () => {
  it('keeps the level on screen even when it is far from the line', () => {
    const g = chartGeometry([100, 101, 100.5, 101.2], 110, 101.2, box)!;
    expect(g.targetY).toBeGreaterThanOrEqual(box.padTop);
    expect(g.targetY).toBeLessThanOrEqual(box.height - box.padBottom);
    expect(g.end!.y).toBeGreaterThan(g.targetY!); // the price is below a level above it
    const below = chartGeometry([100, 101, 100.5, 101.2], 90, 101.2, box)!;
    expect(below.targetY).toBeGreaterThan(below.end!.y);
  });

  it('gives the line the whole box when there is no level, and draws none', () => {
    const g = chartGeometry([10, 20, 15], null, null, box)!;
    expect(g.targetY).toBeNull();
    expect(g.min).toBe(10);
    expect(g.max).toBe(20);
    expect(g.end).toEqual({ x: box.plotRight, y: (box.padTop + box.height - box.padBottom) / 2 });
    // Nothing to draw and nothing to place: no geometry at all.
    expect(chartGeometry([], null, null, box)).toBeNull();
  });

  it('draws a higher price higher up, and ends at the right edge of the plot', () => {
    const g = chartGeometry([10, 20], 15, null, box)!;
    expect(g.end).toEqual({ x: box.plotRight, y: box.padTop });
    expect(g.line.startsWith('M0 ')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
  });

  it('adds the live price as the last point', () => {
    const without = chartGeometry([10, 20, 30], 25, null, box)!;
    const withLive = chartGeometry([10, 20, 30], 25, 40, box)!;
    expect(withLive.max).toBeGreaterThan(without.max);
    expect(withLive.end!.x).toBe(box.plotRight);
  });

  it('centres a flat series instead of dividing by zero', () => {
    const g = chartGeometry([5, 5, 5], 5, 5, box)!;
    expect(Number.isFinite(g.targetY)).toBe(true);
    expect(g.targetY!).toBeCloseTo((box.padTop + box.height - box.padBottom) / 2, 0);
  });

  it('still places the level with fewer than two points, and draws no line', () => {
    const g = chartGeometry([], 50, null, box)!;
    expect(g.line).toBe('');
    expect(g.end).toBeNull();
    expect(Number.isFinite(g.targetY)).toBe(true);
  });

  it('refuses an empty box or a level that is not a number', () => {
    expect(chartGeometry([1, 2], 1, null, { ...box, width: 0 })).toBeNull();
    expect(chartGeometry([1, 2], Number.NaN, null, box)).toBeNull();
  });
});
