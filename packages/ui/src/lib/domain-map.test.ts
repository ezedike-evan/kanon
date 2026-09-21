import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import {
  activityFromRows,
  behaviourFrom,
  followsFromRows,
  pairFromTicker,
  samePair,
  ruleHistory,
  type ActivityRow,
  type TickerRow,
} from './domain-map';
import type { LiveStrategy } from './live-map';
import { DEMO_ACTIVITY, DEMO_MARKETS, demoTicker } from './domain-demo';

const usd = (v: string) => parseDecimal(v, 2);

const tickerRow = (over: Partial<TickerRow> = {}): TickerRow => ({
  asset: 'BTC/USD',
  price: usd('64200.00'),
  publishTime: 100,
  open: usd('64000.00'),
  openTime: 40,
  changeBps: 31,
  ...over,
});

describe('pairFromTicker', () => {
  it('splits the asset and keeps the move as measured', () => {
    const p = pairFromTicker(tickerRow());
    expect(p).toMatchObject({ asset: 'BTC/USD', base: 'BTC', quote: 'USD', changeBps: 31, publishTime: 100 });
  });

  it('keeps a missing move as null, never 0', () => {
    expect(pairFromTicker(tickerRow({ open: null, openTime: null, changeBps: null })).changeBps).toBeNull();
  });
});

describe('samePair', () => {
  it('is equal when nothing a row draws has changed, whatever the object identity', () => {
    expect(samePair(pairFromTicker(tickerRow()), pairFromTicker(tickerRow()))).toBe(true);
  });

  it('differs on price, move and print time', () => {
    const base = pairFromTicker(tickerRow());
    expect(samePair(base, pairFromTicker(tickerRow({ price: usd('64200.01') })))).toBe(false);
    expect(samePair(base, pairFromTicker(tickerRow({ changeBps: 32 })))).toBe(false);
    expect(samePair(base, pairFromTicker(tickerRow({ publishTime: 101 })))).toBe(false);
  });
});

describe('activityFromRows', () => {
  const row = (over: Partial<ActivityRow>): ActivityRow => ({
    _id: 't1',
    strategyId: 's1',
    asset: 'BTC/USD',
    direction: 'long',
    status: 'executed',
    entry: usd('68000.00'),
    size: parseDecimal('0.05', 8),
    stop: usd('67000.00'),
    createdAt: 1_000,
    ...over,
  });

  it('names what refused a refused trade, and only then', () => {
    const [refused, taken] = activityFromRows([
      row({ status: 'refused', failedSymbol: 'bos_bullish' }),
      row({ _id: 't2', failedSymbol: 'bos_bullish' }),
    ]);
    expect(refused).toMatchObject({ id: 't1', kind: 'refused', refusedBy: 'bos_bullish' });
    expect(taken).toMatchObject({ id: 't2', kind: 'executed' });
    expect(taken).not.toHaveProperty('refusedBy');
  });

  it('dates an executed trade by when it executed', () => {
    expect(activityFromRows([row({ executedAt: 5_000 })])[0]?.at).toBe(5_000);
    expect(activityFromRows([row({})])[0]?.at).toBe(1_000);
  });
});

describe('behaviourFrom', () => {
  it('counts attempts and rounds adherence half up in basis points', () => {
    expect(behaviourFrom(24, 9)).toEqual({ taken: 24, blocked: 9, attempts: 33, adherenceBps: 7273 });
  });

  it('has no adherence to state before anything has been put to the rule', () => {
    expect(behaviourFrom(0, 0)).toEqual({ taken: 0, blocked: 0, attempts: 0, adherenceBps: 0 });
  });
});

describe('ruleHistory', () => {
  const strategy = (over: Partial<LiveStrategy> & { _id: string; _creationTime: number }): LiveStrategy => ({
    status: 'pinned',
    specHash: '0xabc',
    ...over,
  });

  it('lists newest first and marks the active rule', () => {
    const rules = ruleHistory(
      [strategy({ _id: 'a', _creationTime: 1 }), strategy({ _id: 'b', _creationTime: 2, status: 'draft' })],
      'a',
    );
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rules.map((r) => r.active)).toEqual([false, true]);
  });

  it('gives a rule whose stored spec no longer parses no name rather than a made-up one', () => {
    const [rule] = ruleHistory([strategy({ _id: 'a', _creationTime: 1, spec: { not: 'a spec' } })], undefined);
    expect(rule?.name).toBeNull();
    expect(rule?.asset).toBeNull();
    expect(rule?.pinnedAt).toBeNull();
  });

  it('is empty before the strategies have loaded', () => {
    expect(ruleHistory(undefined, undefined)).toEqual([]);
  });
});

describe('followsFromRows', () => {
  it('keeps a follow that was never signed as address null', () => {
    expect(followsFromRows([{ _id: 'f', leaderStrategyId: 's', allocationBps: 500, active: true }])).toEqual([
      { address: null, leaderStrategyId: 's', allocationBps: 500, active: true },
    ]);
  });
});

describe('the demo fixtures', () => {
  it('are marked demo, so a screen can say they are not live', () => {
    expect(DEMO_MARKETS.status).toBe('demo');
    expect(demoTicker('btc / usd')).toMatchObject({ status: 'demo' });
    expect(demoTicker('DOGE/USD')).toEqual({ status: 'empty' });
  });

  it('carry a move as integer basis points and never a P&L', () => {
    if (DEMO_MARKETS.status !== 'demo') throw new Error('unreachable');
    for (const p of DEMO_MARKETS.pairs) expect(Number.isInteger(p.changeBps)).toBe(true);
    expect(DEMO_ACTIVITY.every((a) => a.entry.atoms !== '')).toBe(true);
  });
});
