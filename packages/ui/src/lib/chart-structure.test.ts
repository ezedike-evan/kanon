import { describe, expect, it } from 'vitest';
import { RULE_04 } from '@kanon/spec';
import { buildFixtureSeries } from './chart-fixtures';
import { STRUCTURE_MAX_PER_PREDICATE, computeStructure } from './chart-structure';

describe('rule structure', () => {
  const series = buildFixtureSeries('BTC/USD', 900, 700);

  it('finds the pinned rule predicates on the tape, in time order', () => {
    const items = computeStructure(series, RULE_04);
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) expect(items[i]!.time).toBeGreaterThanOrEqual(items[i - 1]!.time);
    const kinds = new Set(items.map((i) => i.kind));
    expect([...kinds].every((k) => ['swing', 'fvg', 'sweep'].includes(k))).toBe(true);
  });

  it('a swing level starts at the candle that set it and ends at the candle that broke it', () => {
    const swings = computeStructure(series, RULE_04).flatMap((i) => (i.kind === 'swing' ? [i] : []));
    for (const s of swings) {
      expect(s.endTime).toBeGreaterThan(s.time);
      expect(s.price).toBeGreaterThan(0);
    }
  });

  it('a fair value gap box has its top above its bottom', () => {
    const gaps = computeStructure(series, RULE_04).flatMap((i) => (i.kind === 'fvg' ? [i] : []));
    for (const g of gaps) expect(g.top).toBeGreaterThan(g.bottom);
  });

  it('a sweep wick runs through its reference on the side it names', () => {
    const sweeps = computeStructure(series, RULE_04).flatMap((i) => (i.kind === 'sweep' ? [i] : []));
    for (const s of sweeps) {
      if (s.side === 'low') expect(s.price).toBeLessThan(s.refPrice);
      else expect(s.price).toBeGreaterThan(s.refPrice);
    }
  });

  it('caps what it returns per predicate', () => {
    const items = computeStructure(series, RULE_04);
    expect(items.length).toBeLessThanOrEqual(STRUCTURE_MAX_PER_PREDICATE * RULE_04.predicates.length);
  });

  it('returns nothing, rather than throwing, when there is too little history', () => {
    const tiny = { ...series, candles: series.candles.slice(-2) };
    expect(computeStructure(tiny, RULE_04)).toEqual([]);
  });

  it('scans a long series quickly enough to run beside a live tick', () => {
    const long = buildFixtureSeries('BTC/USD', 300, 2400);
    const t0 = performance.now();
    computeStructure(long, RULE_04);
    expect(performance.now() - t0).toBeLessThan(1_500);
  });
});
