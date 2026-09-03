import { describe, expect, it } from 'vitest';
import { RULE_04, RULE_04_LOOSENED } from './fixtures';
import { inferredDefaults, parseSpec, predicateSymbol, stated } from './spec';
import { COOLING_OFF_SECONDS, diffSpec } from './diff';
import { abbreviateHash, canonicalizeSpec, specHash } from './hash';
import { compareDecimal, formatBps, formatDecimal, parseDecimal, subDecimal } from './decimal';

describe('schema', () => {
  it('accepts the pinned rule', () => {
    expect(() => parseSpec(RULE_04)).not.toThrow();
  });

  it('rejects a spec with no predicates', () => {
    expect(() => parseSpec({ ...RULE_04, predicates: [] })).toThrow();
  });

  it('rejects a parameter that does not say whether it was inferred', () => {
    const naked = structuredClone(RULE_04) as unknown as Record<string, unknown>;
    (naked['risk'] as Record<string, unknown>)['riskPerTradeBps'] = 50;
    expect(() => parseSpec(naked)).toThrow();
  });

  it('names predicates the way the evidence chain does', () => {
    expect(RULE_04.predicates.map(predicateSymbol)).toEqual([
      'bos_bullish',
      'fvg_present',
      'sweep_prev_day_low',
    ]);
  });
});

describe('inferred defaults', () => {
  it('surfaces every default the compiler chose', () => {
    expect(inferredDefaults(RULE_04).map((d) => d.path)).toEqual([
      'swing_lookback',
      'min_gap_size',
      'sweep_lookback',
    ]);
  });

  it('reports nothing once the user has stated them all', () => {
    const explicit = structuredClone(RULE_04);
    (explicit.predicates[0] as { swingLookbackCandles: unknown }).swingLookbackCandles =
      stated(5);
    (explicit.predicates[1] as { minGapBps: unknown }).minGapBps = stated(15);
    (explicit.predicates[2] as { lookback: unknown }).lookback = stated('1D');
    expect(inferredDefaults(explicit)).toEqual([]);
  });
});

describe('tighten and loosen', () => {
  it('holds a wider stop and more risk for the cooling-off period', () => {
    const diff = diffSpec(RULE_04, RULE_04_LOOSENED);
    expect(diff.requiresCoolingOff).toBe(true);
    expect(diff.changes).toEqual([
      { path: 'risk_per_trade', before: '50', after: '75', kind: 'loosen' },
      { path: 'stop_distance', before: '50', after: '90', kind: 'loosen' },
    ]);
    expect(COOLING_OFF_SECONDS).toBe(86_400);
  });

  it('applies a tightening immediately', () => {
    const tighter = structuredClone(RULE_04);
    tighter.risk.riskPerTradeBps = stated(25);
    const diff = diffSpec(RULE_04, tighter);
    expect(diff.changes).toEqual([
      { path: 'risk_per_trade', before: '50', after: '25', kind: 'tighten' },
    ]);
    expect(diff.requiresCoolingOff).toBe(false);
  });

  it('treats a longer swing lookback as a tightening', () => {
    const tighter = structuredClone(RULE_04);
    (tighter.predicates[0] as { swingLookbackCandles: unknown }).swingLookbackCandles =
      stated(9);
    expect(diffSpec(RULE_04, tighter).requiresCoolingOff).toBe(false);
  });

  it('treats a longer sweep window as a loosening', () => {
    const looser = structuredClone(RULE_04);
    (looser.predicates[2] as { lookback: unknown }).lookback = stated('1W');
    expect(diffSpec(RULE_04, looser).requiresCoolingOff).toBe(true);
  });

  it('waits out a change it cannot order', () => {
    const swapped = structuredClone(RULE_04);
    (swapped.predicates[0] as { timeframe: unknown }).timeframe = stated('1h');
    const diff = diffSpec(RULE_04, swapped);
    expect(diff.changes[0]?.kind).toBe('loosen');
    expect(diff.requiresCoolingOff).toBe(true);
  });

  it('reports a dropped predicate once, not once per parameter', () => {
    const fewer = structuredClone(RULE_04);
    fewer.predicates = fewer.predicates.slice(0, 2);
    const diff = diffSpec(RULE_04, fewer);
    expect(diff.changes).toEqual([
      { path: 'sweep_prev_day_low', before: 'required', after: null, kind: 'remove' },
    ]);
    expect(diff.requiresCoolingOff).toBe(true);
  });

  it('reports an added predicate once, and immediately', () => {
    const fewer = structuredClone(RULE_04);
    fewer.predicates = fewer.predicates.slice(0, 2);
    const diff = diffSpec(fewer, RULE_04);
    expect(diff.changes).toEqual([
      { path: 'sweep_prev_day_low', before: null, after: 'required', kind: 'add' },
    ]);
    expect(diff.requiresCoolingOff).toBe(false);
  });
});

describe('hash', () => {
  it('does not depend on key order', () => {
    const shuffled = Object.fromEntries(
      Object.entries(RULE_04 as Record<string, unknown>).reverse(),
    );
    const reordered = JSON.parse(JSON.stringify(shuffled)) as typeof RULE_04;
    expect(canonicalizeSpec(reordered)).toBe(canonicalizeSpec(RULE_04));
  });

  it('changes when a parameter changes', async () => {
    expect(await specHash(RULE_04)).not.toBe(await specHash(RULE_04_LOOSENED));
  });

  it('abbreviates for display', () => {
    expect(abbreviateHash('0x7f3c9a41b8e2d055c31a')).toBe('0x7f3c…c31a');
  });
});

describe('fixed-point figures', () => {
  it('keeps trailing zeros so columns line up', () => {
    expect(formatDecimal(parseDecimal('68,412.50', 2))).toBe('68,412.50');
    expect(formatDecimal(parseDecimal('69118.4', 2))).toBe('69,118.40');
  });

  it('uses a real minus sign, not a hyphen', () => {
    const shortfall = subDecimal(parseDecimal('68207.30', 2), parseDecimal('68412.50', 2));
    expect(formatDecimal(shortfall)).toBe('−205.20');
  });

  it('refuses precision it cannot represent', () => {
    expect(() => parseDecimal('1.005', 2)).toThrow();
  });

  it('compares across scales', () => {
    expect(compareDecimal(parseDecimal('1.5', 2), parseDecimal('1.50', 8))).toBe(0);
    expect(compareDecimal(parseDecimal('1.6', 2), parseDecimal('1.50', 8))).toBe(1);
  });

  it('formats basis points at the requested precision', () => {
    expect(formatBps(50)).toBe('0.50%');
    expect(formatBps(-30)).toBe('−0.30%');
    expect(formatBps(99, { signed: true })).toBe('+0.99%');
    expect(formatBps(9620, { dp: 1 })).toBe('96.2%');
  });
});
