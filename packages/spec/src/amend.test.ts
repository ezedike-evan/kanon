import { describe, expect, it } from 'vitest';
import {
  cooldownElapsed,
  cooldownEndsAt,
  cooldownRemainingMs,
  planAmendment,
} from './amend';
import { RULE_04, RULE_04_LOOSENED } from './fixtures';
import { applyParamEdit } from './review';
import type { StrategySpec } from './spec';
import { COOLING_OFF_SECONDS } from './diff';

function edit(spec: StrategySpec, key: string, value: string | number): StrategySpec {
  const r = applyParamEdit(spec, key, value);
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}

describe('planAmendment', () => {
  it('reports no change for an identical spec', () => {
    expect(planAmendment(RULE_04, structuredClone(RULE_04)).kind).toBe('none');
  });

  it('loosening waits the full cooling-off period', () => {
    const plan = planAmendment(RULE_04, RULE_04_LOOSENED);
    expect(plan.kind).toBe('cooling_off');
    if (plan.kind === 'cooling_off') expect(plan.cooldownSeconds).toBe(COOLING_OFF_SECONDS);
  });

  it('tightening applies immediately', () => {
    const plan = planAmendment(RULE_04, edit(RULE_04, 'risk.riskPerTradeBps', 25));
    expect(plan.kind).toBe('immediate');
  });

  it('any swing lookback change waits: the chain only accepts a raised minimum gap or an appended predicate', () => {
    expect(planAmendment(RULE_04, edit(RULE_04, 'p1.swingLookbackCandles', 9)).kind).toBe('cooling_off');
    expect(planAmendment(RULE_04, edit(RULE_04, 'p1.swingLookbackCandles', 3)).kind).toBe('cooling_off');
  });

  it('a larger minimum gap applies at once; a smaller one waits', () => {
    const gap = RULE_04.predicates.find((p) => p.kind === 'fair_value_gap');
    const now = gap && gap.kind === 'fair_value_gap' ? gap.minGapBps.value : 0;
    expect(planAmendment(RULE_04, edit(RULE_04, 'p2.minGapBps', now + 10)).kind).toBe('immediate');
    expect(planAmendment(RULE_04, edit(RULE_04, 'p2.minGapBps', Math.max(1, now - 1))).kind).toBe('cooling_off');
  });

  it('a mix of tightening and loosening waits: the hash is one commitment', () => {
    let next = edit(RULE_04, 'risk.riskPerTradeBps', 25);
    next = edit(next, 'risk.stopDistanceBps', 90);
    expect(planAmendment(RULE_04, next).kind).toBe('cooling_off');
  });

  it('adding a predicate tightens, removing one loosens', () => {
    const fewer: StrategySpec = { ...RULE_04, predicates: RULE_04.predicates.slice(0, 2) };
    expect(planAmendment(RULE_04, fewer).kind).toBe('cooling_off');
    expect(planAmendment(fewer, RULE_04).kind).toBe('immediate');
  });

  it('a change diffSpec cannot order is treated as a loosening', () => {
    const flipped: StrategySpec = {
      ...RULE_04,
      direction: 'short',
      predicates: RULE_04.predicates.map((p) => ({ ...p, direction: 'short' as const })),
    };
    const plan = planAmendment(RULE_04, flipped);
    expect(plan.kind).toBe('cooling_off');
  });

  it('swapping the series is a loosening even if every parameter is equal', () => {
    const moved: StrategySpec = { ...RULE_04, series: { ...RULE_04.series, feed: 'pyth/eth-usd' } };
    expect(planAmendment(RULE_04, moved).kind).toBe('cooling_off');
  });

  it('a pure rename applies immediately: it admits nothing new', () => {
    expect(planAmendment(RULE_04, { ...RULE_04, name: 'RENAMED' }).kind).toBe('immediate');
  });
});

describe('planAmendment with the on-chain series address', () => {
  const A = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
  const B = '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707';

  it('a tightening stays immediate when the series address is unchanged, in any letter case', () => {
    const next = edit(RULE_04, 'risk.riskPerTradeBps', 25);
    expect(planAmendment(RULE_04, next, { currentSeries: A, nextSeries: A.toLowerCase() }).kind).toBe(
      'immediate',
    );
  });

  it('a tightening that also moves the series address waits', () => {
    const next = edit(RULE_04, 'risk.riskPerTradeBps', 25);
    expect(planAmendment(RULE_04, next, { currentSeries: A, nextSeries: B }).kind).toBe('cooling_off');
  });

  it('an identical spec on a different series address is a change, and it waits', () => {
    const plan = planAmendment(RULE_04, structuredClone(RULE_04), { currentSeries: A, nextSeries: B });
    expect(plan.kind).toBe('cooling_off');
  });

  it('without both addresses it behaves as before', () => {
    expect(planAmendment(RULE_04, structuredClone(RULE_04), { currentSeries: A }).kind).toBe('none');
  });
});

describe('cooldown clock', () => {
  const requested = Date.parse('2026-09-02T14:41:00Z');

  it('ends exactly one hold after the request', () => {
    expect(cooldownEndsAt(requested)).toBe(requested + 24 * 3600 * 1000);
  });

  it('counts down, never below zero', () => {
    const end = cooldownEndsAt(requested);
    expect(cooldownRemainingMs(end, requested)).toBe(24 * 3600 * 1000);
    expect(cooldownRemainingMs(end, end - 1000)).toBe(1000);
    expect(cooldownRemainingMs(end, end + 5000)).toBe(0);
  });

  it('is not elapsed one millisecond early', () => {
    const end = cooldownEndsAt(requested);
    expect(cooldownElapsed(end, end - 1)).toBe(false);
    expect(cooldownElapsed(end, end)).toBe(true);
  });
});
