import { describe, expect, it } from 'vitest';
import {
  adherenceBps,
  applyParamEdit,
  assetLabel,
  editableParams,
  formatPredicateDelta,
  formatPredicateValue,
  inferredEntries,
  parametricLines,
  parsePercentToBps,
  bpsToPercentText,
  onchainGateNote,
  predicateComparison,
  predicateHeadlines,
  referenceLabel,
  reviewSpec,
  ratioBps,
  roundedBps,
  shareSummary,
  specLines,
  timeframeLabel,
  truncateDecimal,
} from './review';
import { BOS20_15M_NO_TARGET, RULE_04, RULE_04_NO_TARGET } from './fixtures';
import { dec } from './decimal';
import { inferredDefaults } from './spec';

describe('reviewSpec', () => {
  const review = reviewSpec(RULE_04);

  it('renders one plain-English sentence per predicate, plus risk', () => {
    expect(review.plain).toHaveLength(RULE_04.predicates.length + 1);
    const first = review.plain[0]!;
    expect(first[0]).toContain('closes above the prior swing high');
    expect(first).toContainEqual({ param: '5 candles', key: 'p1.swingLookbackCandles' });
    expect(first).toContainEqual({ param: '15m', key: 'p1.timeframe' });
  });

  it('writes the FVG threshold as a percentage, from integer bps', () => {
    const second = review.plain[1]!;
    expect(second).toContainEqual({ param: '0.15%', key: 'p2.minGapBps' });
  });

  it('every chip in the plain register is an editable parameter', () => {
    const keys = new Set(review.params.map((p) => p.key));
    for (const sentence of review.plain) {
      for (const seg of sentence) {
        if (typeof seg !== 'string' && seg.param !== '') expect(keys.has(seg.key)).toBe(true);
      }
    }
  });

  it('lists every inferred default, matching the spec package count', () => {
    expect(review.inferred).toHaveLength(inferredDefaults(RULE_04).length);
    expect(review.inferred.map((i) => i.key).sort()).toEqual(
      ['p1.swingLookbackCandles', 'p2.minGapBps', 'p3.lookback'].sort(),
    );
  });

  it('parametric register pins the series first so nothing about it is hidden', () => {
    const lines = parametricLines(RULE_04);
    expect(lines[0]).toBe('series: BTC/USD · pyth/btc-usd');
    expect(lines).toContain('series_cadence: 60s');
    expect(lines).toContain('series_bucket: 900s');
    expect(lines).toContain('require: bos_bullish');
    expect(lines).toContain('swing_lookback: 5');
    expect(lines).toContain('min_gap_size: 0.15%');
    expect(lines).toContain('sweep_lookback: 1D');
    expect(lines).toContain('risk_per_trade: 0.50%');
    expect(lines).toContain('stop_distance: 0.50%');
    expect(lines).toContain('target_distance: 1.00%');
  });

  it('writes the target into the risk sentence', () => {
    const risk = review.plain[review.plain.length - 1]!;
    expect(risk).toContainEqual({ param: '0.50%', key: 'risk.stopDistanceBps' });
    expect(risk).toContainEqual({ param: '1.00%', key: 'risk.targetDistanceBps' });
    expect(risk.filter((s) => typeof s === 'string').join('')).toContain('from entry and the target');
  });

  it('shows a missing target as not stated, never skipped', () => {
    const legacy = reviewSpec(RULE_04_NO_TARGET);
    const slot = legacy.params.find((p) => p.key === 'risk.targetDistanceBps')!;
    expect(slot).toMatchObject({
      name: 'target_distance',
      display: 'not stated',
      missing: true,
      inferred: false,
      kind: 'int',
      unit: 'bps',
      min: 1,
      max: 10_000,
    });
    expect(legacy.parametric).toContain('target_distance: not stated');
    const risk = legacy.plain[legacy.plain.length - 1]!;
    expect(risk).toContainEqual({ param: 'not stated', key: 'risk.targetDistanceBps' });
    expect(risk[risk.length - 1]).toBe('.');
    // Not an inferred default: nothing was chosen. It is missing.
    expect(legacy.inferred.map((i) => i.key)).not.toContain('risk.targetDistanceBps');
  });

  it('a stated target is not marked missing', () => {
    const slot = editableParams(RULE_04).find((p) => p.key === 'risk.targetDistanceBps')!;
    expect(slot.missing).toBeUndefined();
    expect(slot.value).toBe(100);
  });

  it('only offers references on the correct side for the direction', () => {
    const ref = editableParams(RULE_04).find((p) => p.key === 'p3.referenceExtreme')!;
    expect(ref.options).toEqual(['prev_day_low', 'prev_session_low', 'swing_low']);
  });
});

describe('applyParamEdit', () => {
  it('marks an edited parameter as stated, so it leaves the inferred list', () => {
    const r = applyParamEdit(RULE_04, 'p1.swingLookbackCandles', 8);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.spec.predicates[0]!;
    if (p.kind !== 'break_of_structure') throw new Error('unexpected predicate');
    expect(p.swingLookbackCandles).toEqual({ value: 8, inferred: false });
    expect(inferredEntries(r.spec).map((i) => i.key)).not.toContain('p1.swingLookbackCandles');
    // Original is untouched.
    expect(inferredEntries(RULE_04).map((i) => i.key)).toContain('p1.swingLookbackCandles');
  });

  it('edits risk parameters', () => {
    const r = applyParamEdit(RULE_04, 'risk.stopDistanceBps', '75');
    expect(r.ok && r.spec.risk.stopDistanceBps).toEqual({ value: 75, inferred: false });
  });

  it('states a target on a rule that had none', () => {
    const r = applyParamEdit(BOS20_15M_NO_TARGET, 'risk.targetDistanceBps', 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.risk.targetDistanceBps).toEqual({ value: 400, inferred: false });
    expect(BOS20_15M_NO_TARGET.risk.targetDistanceBps).toBeUndefined();
  });

  it('holds a new target to the same bounds', () => {
    for (const value of [0, 10_001, 2.5]) {
      expect(applyParamEdit(RULE_04_NO_TARGET, 'risk.targetDistanceBps', value).ok).toBe(false);
    }
  });

  it('edits an enum parameter within its options', () => {
    const r = applyParamEdit(RULE_04, 'p3.lookback', '4h');
    expect(r.ok && (r.spec.predicates[2] as { lookback: unknown }).lookback).toEqual({
      value: '4h',
      inferred: false,
    });
  });

  it.each([
    ['p1.swingLookbackCandles', 1, /between/],
    ['p1.swingLookbackCandles', 201, /between/],
    ['p1.swingLookbackCandles', 5.5, /whole number/],
    ['p2.minGapBps', 0, /between/],
    ['p3.lookback', '2W', /one of/],
    ['p3.referenceExtreme', 'prev_day_high', /one of/],
    ['p9.timeframe', '15m', /unknown/],
  ] as const)('rejects %s = %s', (key, value, message) => {
    const r = applyParamEdit(RULE_04, key, value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});

describe('specLines', () => {
  it('flags lines the last turn changed', () => {
    const edited = applyParamEdit(RULE_04, 'risk.riskPerTradeBps', 25);
    if (!edited.ok) throw new Error('edit failed');
    const lines = specLines(edited.spec, RULE_04);
    const changed = lines.filter((l) => l.changed).map((l) => l.text);
    expect(changed).toEqual(['risk_per_trade: 0.25%']);
  });

  it('flags nothing when there is no previous spec', () => {
    expect(specLines(RULE_04).every((l) => !l.changed)).toBe(true);
  });
});

describe('headings', () => {
  it('derives the rule card header from the spec', () => {
    expect(assetLabel(RULE_04)).toBe('BTC / USD');
    expect(timeframeLabel(RULE_04)).toBe('15M');
    expect(predicateHeadlines(RULE_04)).toEqual([
      'Bullish break of structure confirmed',
      'Bullish fair value gap present',
      "Liquidity swept beyond previous day's low",
    ]);
  });

  it('summarises the spec for the share card', () => {
    expect(shareSummary(RULE_04)).toEqual([
      'bos_bullish · fvg ≥ 0.15% · sweep_prev_day_low',
      'risk ≤ 0.50% · lookback 5 · tf 15m',
    ]);
  });
});

describe('refusal number formatting', () => {
  it('writes a fair value gap in percent and the others as price', () => {
    expect(formatPredicateValue('fair_value_gap', dec('9', 0))).toBe('0.09%');
    expect(formatPredicateValue('break_of_structure', dec('6841250', 2))).toBe('68,412.50');
    expect(formatPredicateDelta('fair_value_gap', dec('-6', 0))).toBe('−0.06%');
    expect(formatPredicateDelta('break_of_structure', dec('-20520', 2))).toBe('−205.20');
  });

  it('truncates a wei-scale amount without rounding up', () => {
    const wei = dec('250099999999999999', 18);
    expect(truncateDecimal(wei, 4)).toEqual({ atoms: '2500', decimals: 4 });
    expect(truncateDecimal(dec('12', 2), 4)).toEqual(dec('12', 2));
  });
});

describe('predicateComparison', () => {
  const bos = { kind: 'break_of_structure', direction: 'long' } as const;
  const gap = { kind: 'fair_value_gap', direction: 'long' } as const;
  const sweep = { kind: 'liquidity_sweep', direction: 'long' } as const;

  it('writes the satisfied comparison the way the design canvas does', () => {
    expect(predicateComparison(bos, dec('6844120', 2), dec('6841250', 2), true)).toBe(
      '68,441.20 > 68,412.50',
    );
    expect(predicateComparison(gap, dec('22', 0), dec('15', 0), true)).toBe('0.22% ≥ 0.15%');
    expect(predicateComparison(sweep, dec('6798010', 2), dec('6801500', 2), true)).toBe(
      '67,980.10 < 68,015.00',
    );
  });

  it('a failed comparison reads as the claim that fell short', () => {
    expect(predicateComparison(bos, dec('6820730', 2), dec('6841250', 2), false)).toBe(
      '68,207.30 ≤ 68,412.50',
    );
    expect(predicateComparison(gap, dec('9', 0), dec('15', 0), false)).toBe('0.09% < 0.15%');
  });

  it('flips for shorts', () => {
    expect(
      predicateComparison({ kind: 'break_of_structure', direction: 'short' }, dec('9', 2), dec('10', 2), true),
    ).toBe('0.09 < 0.10');
  });
});

describe('roundedBps', () => {
  it('rounds half away from zero, in either sign', () => {
    expect(roundedBps(dec('-20520', 2), dec('6841250', 2))).toBe(-30);
    expect(roundedBps(dec('20520', 2), dec('6841250', 2))).toBe(30);
    expect(roundedBps(dec('0', 2), dec('6841250', 2))).toBe(0);
    expect(roundedBps(dec('5', 2), dec('0', 2))).toBe(0);
  });
});

describe('ratioBps', () => {
  it('is part of whole in integer bps, rounded half up', () => {
    expect(ratioBps(1, 3)).toBe(3333);
    expect(ratioBps(2, 3)).toBe(6667);
    expect(ratioBps(1, 8)).toBe(1250);
    expect(ratioBps(1, 20_000)).toBe(1); // 0.5 bps rounds up
    expect(ratioBps(0, 5)).toBe(0);
    expect(ratioBps(5, 5)).toBe(10_000);
  });
  it('is null against nothing', () => {
    expect(ratioBps(0, 0)).toBeNull();
  });
});

describe('onchainGateNote', () => {
  it('says plainly that a sweep rule cannot pass the gate', () => {
    expect(onchainGateNote(RULE_04)).toMatch(/^This rule cannot pass the on-chain gate: .*15m bucket/);
  });
  it('says nothing for a rule without a sweep', () => {
    expect(onchainGateNote(BOS20_15M_NO_TARGET)).toBeNull();
  });
});

describe('adherenceBps', () => {
  it('is the share of setups that satisfied the rule, in integer bps', () => {
    expect(adherenceBps(24, 9)).toBe(7273);
    expect(adherenceBps(1, 0)).toBe(10_000);
    expect(adherenceBps(0, 3)).toBe(0);
  });
  it('is null before any setup has been put to the rule', () => {
    expect(adherenceBps(0, 0)).toBeNull();
  });
});

describe('referenceLabel', () => {
  it('writes a reference in a trader\'s words', () => {
    expect(referenceLabel('prev_day_low')).toBe("previous day's low");
    expect(referenceLabel('unknown_thing')).toBe('unknown_thing');
  });
});

describe('percent text <-> basis points', () => {
  it.each([
    ['0.15', 15],
    ['0.5', 50],
    ['0.50%', 50],
    ['1', 100],
    [' 2.25 % ', 225],
    ['100', 10_000],
  ])('parses %s as %i bps', (text, bps) => {
    expect(parsePercentToBps(text)).toBe(bps);
  });

  it.each(['', 'abc', '0.155', '-1', '1,5', '.5', '1e2', '0.1.2'])('rejects %j', (text) => {
    expect(parsePercentToBps(text)).toBeNull();
  });

  it('round-trips', () => {
    for (const bps of [1, 15, 50, 99, 100, 250, 10_000]) {
      expect(parsePercentToBps(bpsToPercentText(bps))).toBe(bps);
    }
  });
});
