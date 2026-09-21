import { describe, expect, it } from 'vitest';
import type { Candle, Decimal, Series } from '@kanon/spec';
import { changeOver24h, formatDecimalAt, seriesDecimals, seriesDisplayDecimals } from './chart-series';

const d = (atoms: string, decimals = 8): Decimal => ({ atoms, decimals });

/** Hourly candles, closes in Pyth-style 8-decimal atoms. */
function series(closes: string[], decimals = 8): Series {
  const candles: Candle[] = closes.map((c, i) => ({
    bucketIndex: i,
    timestamp: i * 3_600,
    open: d(c, decimals),
    high: d(c, decimals),
    low: d(c, decimals),
    close: d(c, decimals),
    synthetic: false,
  }));
  return { asset: 'BTC/USD', bucketSeconds: 3_600, candles };
}

describe('display precision of a series', () => {
  it('a Pyth-precision BTC series shows to the cent, while its data keeps 8 decimals', () => {
    const s = series(['8596587774282']);
    expect(seriesDecimals(s)).toBe(8);
    expect(seriesDisplayDecimals(s)).toBe(2);
    expect(formatDecimalAt(s.candles[0]!.close, seriesDisplayDecimals(s))).toBe('85,965.88');
    expect(s.candles[0]!.close.atoms).toBe('8596587774282'); // nothing was rounded in the data
  });

  it('a sub-cent asset keeps more places', () => {
    expect(seriesDisplayDecimals(series(['3420000'], 8))).toBe(5);
  });

  it('an empty series has a defined default', () => {
    expect(seriesDisplayDecimals({ asset: 'X', bucketSeconds: 60, candles: [] })).toBe(2);
  });
});

describe('24h change, display-rounded', () => {
  // 25 hourly closes: the reference (>= 24h old) is index 0.
  const closes = ['8500000000000', ...Array.from({ length: 23 }, () => '8500000000000'), '8596587774282'];

  it('shows the move at the display precision, and the percentage from exact atoms', () => {
    const change = changeOver24h(series(closes))!;
    expect(change.absText).toBe('+965.88');
    expect(change.percentText).toBe('+1.13%');
    expect(change.direction).toBe('up');
    expect(change.abs.atoms).toBe('96587774282'); // exact
    expect(change.bps).toBe(113);
  });

  it('a down move carries a true minus and its own direction', () => {
    const change = changeOver24h(series([...closes.slice(0, -1), '8403412225718']))!;
    expect(change.absText).toBe('\u2212965.88');
    expect(change.percentText).toBe('\u22121.13%');
    expect(change.direction).toBe('down');
  });

  it('an explicit precision overrides the magnitude rule', () => {
    expect(changeOver24h(series(closes), 4)!.absText).toBe('+965.8777');
  });

  it('a flat move is unsigned', () => {
    const change = changeOver24h(series(['8500000000000', ...Array.from({ length: 24 }, () => '8500000000000')]))!;
    expect(change.absText).toBe('0.00');
    expect(change.direction).toBe('flat');
  });
});
