import { describe, expect, it } from 'vitest';
import {
  evaluateBreakOfStructure,
  evaluateFairValueGap,
  evaluateLiquiditySweep,
  evaluateSpec,
} from './evaluate';
import { makeCandle, makeSeries } from './test-fixtures';
import { formatDecimal } from './decimal';
import { inferred, predicateSymbol, SPEC_VERSION, stated } from './spec';
import type { Predicate, StrategySpec } from './spec';
import { BTC_15M_SERIES, RULE_04 } from './fixtures';

const bosLong: Extract<Predicate, { kind: 'break_of_structure' }> = {
  kind: 'break_of_structure',
  id: 'bos-1',
  direction: 'long',
  swingLookbackCandles: stated(3),
  timeframe: stated('15m'),
};

const bosShort: Extract<Predicate, { kind: 'break_of_structure' }> = {
  ...bosLong,
  id: 'bos-2',
  direction: 'short',
};

describe('evaluateBreakOfStructure', () => {
  it('is satisfied when close trades beyond the prior swing high', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99', '100', '95', '99', 0),
      makeCandle('100', '101', '96', '100', 900),
      makeCandle('98', '99', '94', '98', 1800),
      makeCandle('101', '102', '97', '102', 2700),
    ]);
    const result = evaluateBreakOfStructure(series, bosLong);
    expect(result.satisfied).toBe(true);
    expect(result.symbol).toBe('bos_bullish');
    expect(formatDecimal(result.decidingValue)).toBe('102.00');
    expect(formatDecimal(result.referenceValue)).toBe('101.00');
    expect(result.at).toBe(2700);
  });

  it('is refused when no close ever trades beyond the swing high, reporting the latest state', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99', '100', '95', '99', 0),
      makeCandle('100', '101', '96', '100', 900),
      makeCandle('98', '99', '94', '98', 1800),
      makeCandle('100', '100', '95', '100', 2700),
      makeCandle('101', '101', '96', '101', 3600),
      makeCandle('100', '100', '95', '100', 4500),
    ]);
    const result = evaluateBreakOfStructure(series, bosLong);
    expect(result.satisfied).toBe(false);
    expect(result.at).toBe(4500);
    expect(formatDecimal(result.decidingValue)).toBe('100.00');
    expect(formatDecimal(result.referenceValue)).toBe('101.00');
  });

  it('treats a close exactly at the swing high as not broken (boundary is strict)', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99', '100', '95', '99', 0),
      makeCandle('100', '101', '96', '100', 900),
      makeCandle('98', '99', '94', '98', 1800),
      makeCandle('101', '101', '96', '101', 2700),
    ]);
    const result = evaluateBreakOfStructure(series, bosLong);
    expect(result.satisfied).toBe(false);
    expect(formatDecimal(result.decidingValue)).toBe('101.00');
    expect(formatDecimal(result.referenceValue)).toBe('101.00');
  });

  it('mirrors the direction for short: a new low breaks structure', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('101', '105', '100', '101', 0),
      makeCandle('100', '104', '99', '100', 900),
      makeCandle('102', '106', '101', '102', 1800),
      makeCandle('98', '103', '98', '98', 2700),
    ]);
    const result = evaluateBreakOfStructure(series, bosShort);
    expect(result.satisfied).toBe(true);
    expect(formatDecimal(result.decidingValue)).toBe('98.00');
    expect(formatDecimal(result.referenceValue)).toBe('99.00');
  });

  it('throws when the series does not have enough candles for the lookback', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99', '100', '95', '99', 0),
      makeCandle('100', '101', '96', '100', 900),
    ]);
    expect(() => evaluateBreakOfStructure(series, bosLong)).toThrow(/needs at least/);
  });
});

const fvgLong: Extract<Predicate, { kind: 'fair_value_gap' }> = {
  kind: 'fair_value_gap',
  id: 'fvg-1',
  direction: 'long',
  minGapBps: stated(50),
  timeframe: stated('15m'),
};

describe('evaluateFairValueGap', () => {
  it('is satisfied when the three-candle gap clears the minimum in bps', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99.50', '100.00', '99.00', '99.80', 0),
      makeCandle('100.00', '100.50', '99.90', '100.30', 900),
      makeCandle('101.00', '101.50', '101.00', '101.20', 1800),
    ]);
    const result = evaluateFairValueGap(series, fvgLong);
    expect(result.satisfied).toBe(true);
    expect(result.symbol).toBe('fvg_present');
    expect(result.decidingValue.atoms).toBe('100'); // 100 bps
    expect(result.referenceValue.atoms).toBe('50');
    expect(result.at).toBe(1800);
  });

  it('is refused when the gap exists but is smaller than the minimum', () => {
    const strict: typeof fvgLong = { ...fvgLong, minGapBps: stated(150) };
    const series = makeSeries('BTC/USD', [
      makeCandle('99.50', '100.00', '99.00', '99.80', 0),
      makeCandle('100.00', '100.50', '99.90', '100.30', 900),
      makeCandle('101.00', '101.50', '101.00', '101.20', 1800),
    ]);
    const result = evaluateFairValueGap(series, strict);
    expect(result.satisfied).toBe(false);
    expect(result.decidingValue.atoms).toBe('100');
    expect(result.referenceValue.atoms).toBe('150');
  });

  it('satisfies a gap exactly equal to the minimum (boundary is inclusive)', () => {
    const exact: typeof fvgLong = { ...fvgLong, minGapBps: stated(100) };
    const series = makeSeries('BTC/USD', [
      makeCandle('99.50', '100.00', '99.00', '99.80', 0),
      makeCandle('100.00', '100.50', '99.90', '100.30', 900),
      makeCandle('101.00', '101.50', '101.00', '101.20', 1800),
    ]);
    const result = evaluateFairValueGap(series, exact);
    expect(result.satisfied).toBe(true);
  });

  it('reports zero bps when candle 1 and candle 3 overlap (no imbalance at all)', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99.50', '100.00', '99.00', '99.80', 0),
      makeCandle('100.00', '100.50', '99.90', '100.30', 900),
      makeCandle('99.90', '100.20', '99.50', '99.95', 1800), // low 99.90 <= c1 high 100.00
    ]);
    const result = evaluateFairValueGap(series, fvgLong);
    expect(result.satisfied).toBe(false);
    expect(result.decidingValue.atoms).toBe('0');
  });

  it('mirrors the direction for short', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('100.50', '101.00', '100.00', '100.00', 0),
      makeCandle('99.50', '100.00', '99.20', '99.60', 900),
      makeCandle('99.00', '99.00', '98.50', '98.80', 1800), // high 99.00 < c1 low 100.00
    ]);
    const short: typeof fvgLong = { ...fvgLong, direction: 'short' };
    const result = evaluateFairValueGap(series, short);
    expect(result.satisfied).toBe(true);
  });

  it('throws when the series has fewer than three candles', () => {
    const series = makeSeries('BTC/USD', [makeCandle('100', '101', '99', '100', 0)]);
    expect(() => evaluateFairValueGap(series, fvgLong)).toThrow(/needs at least/);
  });
});

const sweepPrevDayLow: Extract<Predicate, { kind: 'liquidity_sweep' }> = {
  kind: 'liquidity_sweep',
  id: 'sweep-1',
  direction: 'long',
  referenceExtreme: stated('prev_day_low'),
  lookback: inferred('1D'),
  timeframe: stated('15m'),
};

describe('evaluateLiquiditySweep', () => {
  const day0 = [
    makeCandle('99.20', '100.00', '99.00', '99.50', 0),
    makeCandle('99.80', '100.50', '98.50', '99.80', 900),
  ];

  it('is satisfied when a wick trades below the prior day low and closes back above it', () => {
    const series = makeSeries('BTC/USD', [
      ...day0,
      makeCandle('99.00', '99.30', '98.00', '99.00', 86_400),
    ]);
    const result = evaluateLiquiditySweep(series, sweepPrevDayLow);
    expect(result.satisfied).toBe(true);
    expect(result.symbol).toBe('sweep_prev_day_low');
    expect(formatDecimal(result.decidingValue)).toBe('98.00');
    expect(formatDecimal(result.referenceValue)).toBe('98.50');
    expect(result.at).toBe(86_400);
  });

  it('is refused when the wick sweeps but the close does not come back inside', () => {
    const series = makeSeries('BTC/USD', [
      ...day0,
      makeCandle('99.00', '99.10', '98.00', '98.20', 86_400),
    ]);
    const result = evaluateLiquiditySweep(series, sweepPrevDayLow);
    expect(result.satisfied).toBe(false);
    expect(formatDecimal(result.decidingValue)).toBe('98.00');
    expect(formatDecimal(result.referenceValue)).toBe('98.50');
  });

  it('treats a wick that only touches the reference as not swept (boundary is strict)', () => {
    const series = makeSeries('BTC/USD', [
      ...day0,
      makeCandle('99.00', '99.30', '98.50', '99.00', 86_400),
    ]);
    const result = evaluateLiquiditySweep(series, sweepPrevDayLow);
    expect(result.satisfied).toBe(false);
    expect(formatDecimal(result.decidingValue)).toBe('98.50');
    expect(formatDecimal(result.referenceValue)).toBe('98.50');
  });

  it('supports a swing_low reference over the stated lookback window', () => {
    const swing: typeof sweepPrevDayLow = {
      ...sweepPrevDayLow,
      referenceExtreme: stated('swing_low'),
      lookback: stated('1h'),
    };
    const series = makeSeries('BTC/USD', [
      makeCandle('99.50', '100.00', '99.00', '99.50', 0),
      makeCandle('99.00', '100.00', '98.00', '98.20', 900), // sweeps day-1 ref but doesn't close back inside
      makeCandle('98.50', '100.00', '97.50', '97.80', 1800), // still doesn't close back inside
      makeCandle('98.00', '99.50', '97.00', '99.00', 3600), // sweeps and closes back inside
    ]);
    const result = evaluateLiquiditySweep(series, swing);
    expect(result.satisfied).toBe(true);
    expect(formatDecimal(result.decidingValue)).toBe('97.00');
    expect(formatDecimal(result.referenceValue)).toBe('97.50');
  });

  it('mirrors the direction for a high-side sweep', () => {
    const sweepHigh: typeof sweepPrevDayLow = {
      ...sweepPrevDayLow,
      direction: 'short',
      referenceExtreme: stated('prev_day_high'),
    };
    const series = makeSeries('BTC/USD', [
      ...day0,
      makeCandle('100.50', '101.00', '100.00', '100.00', 86_400),
    ]);
    const result = evaluateLiquiditySweep(series, sweepHigh);
    expect(result.satisfied).toBe(true);
    expect(formatDecimal(result.decidingValue)).toBe('101.00');
    expect(formatDecimal(result.referenceValue)).toBe('100.50');
  });

  it('throws when no candle ever has enough history for a reference extreme', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99.20', '100.00', '99.00', '99.50', 0),
      makeCandle('99.80', '100.50', '98.50', '99.80', 900),
    ]);
    expect(() => evaluateLiquiditySweep(series, sweepPrevDayLow)).toThrow(/enough history/);
  });
});

describe('evaluateSpec', () => {
  it('runs every predicate and reports allSatisfied when all pass', () => {
    const series = makeSeries('BTC/USD', [
      makeCandle('99.00', '100.00', '99.00', '99.50', 0),
      makeCandle('99.50', '100.20', '99.30', '99.80', 900),
      makeCandle('99.80', '100.10', '99.40', '99.60', 1800),
      makeCandle('99.60', '100.30', '99.20', '100.00', 2700), // FVG c1
      makeCandle('100.00', '100.50', '99.90', '100.20', 3600), // FVG c2 (filler)
      makeCandle('100.50', '100.90', '100.50', '100.70', 4500), // FVG c3: gap vs 2700's high
      makeCandle('100.70', '101.00', '100.60', '100.90', 5400),
      makeCandle('100.90', '101.20', '100.70', '101.00', 6300),
      makeCandle('101.00', '101.50', '100.80', '101.20', 7200),
      makeCandle('100.00', '102.50', '98.50', '102.00', 86_400), // sweeps day0 low, breaks structure
    ]);
    const evaluation = evaluateSpec(series, RULE_04);
    expect(evaluation.allSatisfied).toBe(true);
    expect(evaluation.results.map((r) => r.symbol)).toEqual(
      RULE_04.predicates.map(predicateSymbol),
    );
    expect(evaluation.results.every((r) => r.satisfied)).toBe(true);
  });

  it('reports allSatisfied false when one predicate is refused', () => {
    const flatBos: Extract<Predicate, { kind: 'break_of_structure' }> = {
      kind: 'break_of_structure',
      id: 'p1',
      direction: 'long',
      swingLookbackCandles: stated(3),
      timeframe: stated('15m'),
    };
    const spec: StrategySpec = {
      version: SPEC_VERSION,
      id: 'flat-spec',
      name: 'flat',
      direction: 'long',
      series: { ...BTC_15M_SERIES },
      predicates: [flatBos],
      risk: { riskPerTradeBps: stated(50), stopDistanceBps: stated(50) },
    };
    const series = makeSeries('BTC/USD', [
      makeCandle('100', '100', '100', '100', 0),
      makeCandle('100', '100', '100', '100', 900),
      makeCandle('100', '100', '100', '100', 1800),
      makeCandle('100', '100', '100', '100', 2700),
    ]);
    const evaluation = evaluateSpec(series, spec);
    expect(evaluation.allSatisfied).toBe(false);
    expect(evaluation.results[0]?.satisfied).toBe(false);
  });
});

describe('scan window', () => {
  // An old break of structure, then price falls back below the swing.
  const series = makeSeries('BTC/USD', [
    makeCandle('99', '100', '95', '99', 0),
    makeCandle('100', '101', '96', '100', 900),
    makeCandle('98', '99', '94', '98', 1800),
    makeCandle('101', '102', '97', '102', 2700), // breaks 101
    makeCandle('101', '101', '95', '96', 3600),
    makeCandle('96', '97', '94', '95', 4500),
  ]);

  it('without a window, the oldest satisfying candle decides', () => {
    const r = evaluateBreakOfStructure(series, bosLong);
    expect(r.satisfied).toBe(true);
    expect(r.at).toBe(2700);
  });

  it('with a window over the recent candles, an old break no longer counts', () => {
    const r = evaluateBreakOfStructure(series, bosLong, { scanFrom: 3600 });
    expect(r.satisfied).toBe(false);
    expect(r.at).toBe(4500);
    expect(formatDecimal(r.decidingValue)).toBe('95.00');
  });

  it('keeps candles before the window as history for the swing extreme', () => {
    const r = evaluateBreakOfStructure(series, bosLong, { scanFrom: 2700 });
    expect(r.satisfied).toBe(true);
    expect(formatDecimal(r.referenceValue)).toBe('101.00');
  });

  it('applies to fair value gap decisions by their third candle', () => {
    const fvg: Extract<Predicate, { kind: 'fair_value_gap' }> = {
      kind: 'fair_value_gap',
      id: 'g1',
      direction: 'long',
      minGapBps: stated(1),
      timeframe: stated('15m'),
    };
    const gapped = makeSeries('BTC/USD', [
      makeCandle('100', '100', '99', '100', 0),
      makeCandle('101', '106', '100', '105', 900),
      makeCandle('105', '108', '104', '107', 1800), // gap 104 - 100 = 4 over c1
      makeCandle('107', '108', '106', '107', 2700),
      makeCandle('107', '108', '106', '107', 3600),
    ]);
    expect(evaluateFairValueGap(gapped, fvg).satisfied).toBe(true);
    expect(evaluateFairValueGap(gapped, fvg, { scanFrom: 2700 }).satisfied).toBe(false);
  });

  it('throws rather than inventing a result when nothing falls in the window', () => {
    expect(() => evaluateBreakOfStructure(series, bosLong, { scanFrom: 999_999 })).toThrow(
      /scan window/,
    );
  });
});
