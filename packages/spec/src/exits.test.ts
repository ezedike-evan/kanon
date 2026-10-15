import { describe, expect, it } from 'vitest';
import { EXIT_PARAM_KEY, exitsQuestion, exitsSentence, exitsStated, missingExits } from './exits';
import { BOS20_15M_NO_TARGET, RULE_04, RULE_04_NO_TARGET } from './fixtures';
import { editableParams } from './review';
import { inferred, stated } from './spec';
import type { StrategySpec } from './spec';

const withRisk = (risk: Partial<StrategySpec['risk']>): StrategySpec => ({
  ...RULE_04,
  risk: { ...RULE_04.risk, ...risk },
});

describe('missingExits', () => {
  it('is empty when the user stated a stop and a target', () => {
    expect(missingExits(RULE_04)).toEqual([]);
    expect(exitsStated(RULE_04)).toBe(true);
  });

  it('counts an absent target as missing', () => {
    expect(missingExits(RULE_04_NO_TARGET)).toEqual(['target_distance']);
    expect(missingExits(BOS20_15M_NO_TARGET)).toEqual(['target_distance']);
    expect(exitsStated(BOS20_15M_NO_TARGET)).toBe(false);
  });

  it('counts an exit the compiler chose as missing, exactly like an absent one', () => {
    expect(missingExits(withRisk({ targetDistanceBps: inferred(100) }))).toEqual(['target_distance']);
    expect(missingExits(withRisk({ stopDistanceBps: inferred(50) }))).toEqual(['stop_distance']);
    expect(
      missingExits(withRisk({ stopDistanceBps: inferred(50), targetDistanceBps: inferred(100) })),
    ).toEqual(['stop_distance', 'target_distance']);
  });

  it('does not care whether the risk per trade was stated', () => {
    expect(missingExits(withRisk({ riskPerTradeBps: inferred(50), targetDistanceBps: stated(100) }))).toEqual([]);
  });

  it('names exits by keys the review can open', () => {
    const keys = new Set(editableParams(RULE_04_NO_TARGET).map((p) => p.key));
    expect(keys.has(EXIT_PARAM_KEY.stop_distance)).toBe(true);
    expect(keys.has(EXIT_PARAM_KEY.target_distance)).toBe(true);
  });
});

describe('exitsSentence', () => {
  it('names what is missing and why it matters', () => {
    expect(exitsSentence(['target_distance'])).toBe(
      'This rule has no stated target. A rule is pinned and tested only with a stop and a target you set.',
    );
    expect(exitsSentence(['stop_distance'])).toMatch(/^This rule has no stated stop\./);
    expect(exitsSentence(['stop_distance', 'target_distance'])).toMatch(/^This rule has no stated stop or target\./);
  });

  it('says nothing when nothing is missing', () => {
    expect(exitsSentence([])).toBe('');
  });
});

describe('exitsQuestion', () => {
  it('asks for a distance from entry, never a price', () => {
    for (const missing of [['target_distance'], ['stop_distance'], ['stop_distance', 'target_distance']] as const) {
      const q = exitsQuestion(missing);
      expect(q).toContain('distance from entry');
      expect(q).not.toMatch(/sorry|apolog/i);
    }
  });

  it('asks only for what is missing', () => {
    expect(exitsQuestion(['target_distance'])).toMatch(/^Where is your target\?/);
    expect(exitsQuestion(['target_distance'])).toContain('2R');
    expect(exitsQuestion(['stop_distance'])).toMatch(/^Where is your stop\?/);
    expect(exitsQuestion(['stop_distance', 'target_distance'])).toMatch(/^Where are your stop and your target\?/);
  });
});
