import { describe, expect, it } from 'vitest';
import { dec, RULE_04 } from '@kanon/spec';
import {
  SPARK_STEP_SECONDS,
  SPARK_WINDOWS,
  assembleSpark,
  leadSummary,
  rankLeads,
  sparkSampleTimes,
  type LeadSummary,
  type SparkSample,
} from './homeFeedLogic';

const STEP = SPARK_STEP_SECONDS;
const px = (atoms: number) => dec(BigInt(atoms), 2);
const s = (publishTime: number, atoms: number): SparkSample => ({ publishTime, price: px(atoms) });

describe('sparkSampleTimes', () => {
  it('lands on the step grid, oldest first, ending at the window holding the newest print', () => {
    const latest = 10 * STEP + 1234;
    const times = sparkSampleTimes(latest);
    expect(times).toHaveLength(SPARK_WINDOWS);
    expect(times.at(-1)).toBe(10 * STEP);
    expect(times[0]).toBe((10 - (SPARK_WINDOWS - 1)) * STEP);
    for (const t of times) expect(t % STEP).toBe(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('does not move while the newest print stays in the same window', () => {
    expect(sparkSampleTimes(10 * STEP + 1)).toEqual(sparkSampleTimes(10 * STEP + STEP - 1));
    expect(sparkSampleTimes(11 * STEP)).not.toEqual(sparkSampleTimes(10 * STEP));
  });
});

describe('assembleSpark', () => {
  const instants = [0, STEP, 2 * STEP];

  it('draws each sample and closes on the newest print', () => {
    const line = assembleSpark(instants, [s(10, 100), s(STEP + 5, 110), s(2 * STEP + 9, 90)], s(2 * STEP + 700, 95));
    expect(line).toEqual([100, 110, 90, 95]);
  });

  it('does not count the newest print twice when it is also the last sample', () => {
    const latest = s(2 * STEP + 9, 90);
    expect(assembleSpark(instants, [s(10, 100), s(STEP + 5, 110), latest], latest)).toEqual([100, 110, 90]);
  });

  it('drops a window with no print of its own instead of drawing a flat run', () => {
    // The middle window printed nothing: its "first print at or after" is the next window's.
    const line = assembleSpark(instants, [s(10, 100), s(2 * STEP + 9, 90), s(2 * STEP + 9, 90)], s(2 * STEP + 700, 95));
    expect(line).toEqual([100, 90, 95]);
  });

  it('drops a print that stands in from a whole step later, and a missing one', () => {
    const line = assembleSpark(instants, [null, s(STEP + 5, 110), s(2 * STEP + 9, 90)], s(2 * STEP + 700, 95));
    expect(line).toEqual([110, 90, 95]);
  });

  it('draws nothing rather than one dot', () => {
    expect(assembleSpark(instants, [null, null, null], s(5, 100))).toEqual([]);
    expect(assembleSpark([], [], s(5, 100))).toEqual([]);
  });
});

describe('leadSummary', () => {
  const base = { leadId: 'l1', strategyId: 's1', taken: 24, blocked: 6, followers: 12, profitShareBps: 1000 };

  it('names a lead by its predicates in SMC language and states its adherence', () => {
    const lead = leadSummary({ ...base, spec: RULE_04 });
    expect(lead.name).toMatch(/bos_bullish/);
    expect(lead.asset).toBe(RULE_04.series.asset);
    expect(lead.timeframe).not.toBe('');
    expect(lead.adherenceBps).toBe(8000);
    expect(lead.followers).toBe(12);
  });

  it('lists a spec that no longer parses by a placeholder and invents no asset', () => {
    const lead = leadSummary({ ...base, spec: { nonsense: true } });
    expect(lead.name).toBe('STRATEGY');
    expect(lead.asset).toBe('');
  });

  it('has no adherence before there is a setup to divide by', () => {
    expect(leadSummary({ ...base, spec: null, taken: 0, blocked: 0 }).adherenceBps).toBeNull();
  });
});

describe('rankLeads', () => {
  const lead = (id: string, adherenceBps: number | null, followers: number, taken = 1, blocked = 0): LeadSummary => ({
    leadId: id, strategyId: id, name: id, asset: 'BTC/USD', timeframe: '15M',
    taken, blocked, adherenceBps, followers, profitShareBps: 0,
  });

  it('orders by adherence, then followers, and puts an untested lead last', () => {
    const out = rankLeads([lead('none', null, 99), lead('low', 7000, 5), lead('high-few', 9500, 1), lead('high-many', 9500, 9)]);
    expect(out.map((l) => l.leadId)).toEqual(['high-many', 'high-few', 'low', 'none']);
  });

  it('does not reorder its input', () => {
    const input = [lead('a', 1, 1), lead('b', 2, 1)];
    rankLeads(input);
    expect(input.map((l) => l.leadId)).toEqual(['a', 'b']);
  });
});
