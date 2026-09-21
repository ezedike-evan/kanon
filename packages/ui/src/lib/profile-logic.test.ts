import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from './app-info';
import { parseDecimal } from '@kanon/spec';
import type { ActivityItem } from './domain-types';
import type { PredictMarket } from './predict-types';
import {
  allocationLabel,
  compactDecimal,
  dayKey,
  dayLabel,
  explorerUrl,
  filterRecords,
  handleOf,
  loginLabel,
  memberSince,
  mergeRecords,
  orderRules,
  pinnedCount,
  priceLabel,
  recordTotals,
  ruleOrdinals,
  ruleSections,
  ruleState,
  shortAddress,
  shortId,
  stakeRecords,
  tableDayLabel,
  timeLabel,
  tradeRecords,
  withDayHeaders,
} from './profile-logic';
import { DEMO_RECORDS, DEMO_RULES, DEMO_TRADES } from './profile-demo';
import { behaviourFrom } from './domain-map';

const usd = (v: string) => parseDecimal(v, 2);
const trade = (id: string, kind: ActivityItem['kind'], at: string): ActivityItem => ({
  id,
  kind,
  asset: 'BTC/USD',
  direction: 'long',
  entry: usd('68000.00'),
  size: parseDecimal('0.05000000', 8),
  at: Date.parse(at),
});

describe('records', () => {
  const items = [
    trade('a', 'executed', '2026-09-02T09:00:00Z'),
    trade('b', 'refused', '2026-09-02T14:32:00Z'),
    trade('c', 'executed', '2026-09-01T10:00:00Z'),
    trade('d', 'proposed', '2026-09-01T08:00:00Z'),
    trade('e', 'undone', '2026-08-31T08:00:00Z'),
  ];
  const market = (over: Partial<PredictMarket>): PredictMarket =>
    ({
      id: 'm1',
      asset: 'ETH/USD',
      timeframe: '1H',
      direction: 'above',
      target: usd('3500.00'),
      windowStart: Date.parse('2026-09-01T12:00:00Z') / 1000,
      positions: [{ side: 'above', stake: usd('20.00'), result: 'won', txHash: null }],
      demo: false,
      ...over,
    }) as PredictMarket;

  it('merges newest first and keeps arrival order on a tie', () => {
    const merged = mergeRecords(tradeRecords(items));
    expect(merged.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
    const tie = mergeRecords(
      tradeRecords([trade('x', 'executed', '2026-09-02T09:00:00Z')]),
      tradeRecords([trade('y', 'executed', '2026-09-02T09:00:00Z')]),
    );
    expect(tie.map((r) => r.id)).toEqual(['x', 'y']);
  });

  it('turns only the person\'s own stakes on real markets into records', () => {
    const stakes = stakeRecords([market({}), market({ id: 'm2', positions: [] }), market({ id: 'm3', demo: true })]);
    expect(stakes).toHaveLength(1);
    expect(stakes[0]).toMatchObject({ type: 'stake', at: Date.parse('2026-09-01T12:00:00Z') });
  });

  it('keeps an unknown stake amount as null, never zero', () => {
    const [r] = stakeRecords([market({ positions: [{ side: 'below', stake: null, result: null, txHash: null }] })]);
    expect(r?.type === 'stake' && r.stake.stake).toBeNull();
  });

  it('filters by kind and counts every kind', () => {
    const all = mergeRecords(tradeRecords(items), stakeRecords([market({})]));
    expect(filterRecords(all, 'executed').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRecords(all, 'refused').map((r) => r.id)).toEqual(['b']);
    expect(filterRecords(all, 'predictions')).toHaveLength(1);
    expect(filterRecords(all, 'all')).toHaveLength(6);
    expect(recordTotals(all)).toEqual({ all: 6, executed: 2, refused: 1, predictions: 1 });
  });

  it('groups by UTC day with a header before each and the day\'s count on it', () => {
    const now = Date.parse('2026-09-02T18:00:00Z');
    const list = withDayHeaders(mergeRecords(tradeRecords(items)), now);
    expect(list.map((e) => (e.type === 'day' ? `${e.label}:${e.count}` : e.id))).toEqual([
      'Today:2',
      'b',
      'a',
      'Yesterday:2',
      'c',
      'd',
      '31 Aug 2026:1',
      'e',
    ]);
  });

  it('labels days and times in UTC', () => {
    expect(dayKey(Date.parse('2026-09-02T23:59:00Z'))).toBe('2026-09-02');
    expect(dayLabel('2026-01-05', Date.parse('2026-09-02T00:00:00Z'))).toBe('05 Jan 2026');
    expect(timeLabel(Date.parse('2026-09-02T09:05:00Z'))).toBe('09:05');
  });
});

describe('tableDayLabel', () => {
  const now = Date.parse('2026-09-21T10:00:00Z');
  it('says Today and Yesterday', () => {
    expect(tableDayLabel(Date.parse('2026-09-21T01:00:00Z'), now)).toBe('Today');
    expect(tableDayLabel(Date.parse('2026-09-20T23:59:00Z'), now)).toBe('Yesterday');
  });
  it('drops the year in the current year and keeps it otherwise', () => {
    expect(tableDayLabel(Date.parse('2026-09-02T14:32:00Z'), now)).toBe('02 Sep');
    expect(tableDayLabel(Date.parse('2025-12-30T14:32:00Z'), now)).toBe('30 Dec 2025');
  });
});

describe('demo record', () => {
  it('agrees with the demo behaviour stats on Home: 24 taken, 9 blocked', () => {
    const totals = recordTotals(tradeRecords(DEMO_TRADES));
    expect(totals.executed).toBe(24);
    expect(totals.refused).toBe(9);
    expect(behaviourFrom(totals.executed, totals.refused).attempts).toBe(33);
  });

  it('is newest first and carries stakes', () => {
    const times = DEMO_RECORDS.map((r) => r.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(recordTotals(DEMO_RECORDS).predictions).toBe(5);
  });

  it('every refused demo trade names the predicate that refused it', () => {
    for (const t of DEMO_TRADES) expect(t.kind === 'refused').toBe(Boolean(t.refusedBy));
  });
});

describe('rules', () => {
  it('reads a pinned rule that is no longer enforcing as superseded', () => {
    expect(ruleState({ status: 'pinned', active: true })).toBe('pinned');
    expect(ruleState({ status: 'pinned', active: false })).toBe('superseded');
    expect(ruleState({ status: 'cooling_off', active: true })).toBe('cooling_off');
    expect(ruleState({ status: 'cooling_off', active: false })).toBe('superseded');
    expect(ruleState({ status: 'draft', active: false })).toBe('draft');
  });

  it('puts the enforcing rule first, then drafts, then what it replaced', () => {
    const ordered = orderRules(DEMO_RULES);
    expect(ordered.map((r) => ruleState(r))).toEqual(['pinned', 'draft', 'superseded', 'superseded', 'superseded']);
  });

  it('groups rules under a header each, the enforcing one first', () => {
    const entries = ruleSections(DEMO_RULES);
    expect(entries.map((e) => (e.type === 'section' ? `${e.label}:${e.count}` : e.id))).toEqual([
      'Enforcing now:1',
      'demo-r4',
      'Drafts:1',
      'demo-r5',
      'Replaced by a newer rule:3',
      'demo-r3',
      'demo-r2',
      'demo-r1',
    ]);
  });

  it('keeps a rule cooling off in the same group as one that is pinned', () => {
    const entries = ruleSections([
      { id: 'a', status: 'cooling_off' as const, active: true },
      { id: 'b', status: 'pinned' as const, active: false },
    ]);
    expect(entries.filter((e) => e.type === 'section')).toHaveLength(2);
  });

  it('numbers rules oldest first from a newest-first list', () => {
    const map = ruleOrdinals(DEMO_RULES);
    expect(map.get('demo-r1')).toBe('RULE 01');
    expect(map.get('demo-r5')).toBe('RULE 05');
  });

  it('counts a rule as pinned once it has left draft', () => {
    expect(pinnedCount(DEMO_RULES)).toBe(4);
  });
});

describe('identity', () => {
  it('shortens an address keeping its case', () => {
    expect(shortAddress('0x9a4Fc02d18e3B76c5A0fE41d8b93C6a2E7d05f13')).toBe('0x9a4F…5f13');
  });
  it('writes a handle with exactly one @', () => {
    expect(handleOf('ada')).toBe('@ada');
    expect(handleOf('@@ada')).toBe('@ada');
    expect(handleOf('  ')).toBe('');
  });
  it('states the month and year an account was made, in UTC', () => {
    expect(memberSince(Date.parse('2026-06-11T09:00:00Z'))).toBe('Jun 2026');
    expect(memberSince(Date.parse('2026-12-31T23:59:59Z'))).toBe('Dec 2026');
  });
  it('writes an allocation without a needless decimal', () => {
    expect(allocationLabel(2500)).toBe('25%');
    expect(allocationLabel(1250)).toBe('12.5%');
  });
  it('names login methods, and does not lose an unknown one', () => {
    expect(loginLabel('google_oauth')).toBe('Google');
    expect(loginLabel('email')).toBe('Email');
    expect(loginLabel('telegram_oauth')).toBe('telegram');
  });
  it('builds explorer links without a doubled slash', () => {
    expect(explorerUrl('https://monadscan.com/', 'tx', '0xabc')).toBe('https://monadscan.com/tx/0xabc');
    expect(explorerUrl('https://monadscan.com', 'address', '0xdef')).toBe('https://monadscan.com/address/0xdef');
  });
});

describe('figures', () => {
  it('drops the trailing zeros of a size but never the digits', () => {
    expect(compactDecimal(parseDecimal('0.05000000', 8))).toBe('0.05');
    expect(compactDecimal(parseDecimal('12.00000000', 8))).toBe('12');
    expect(compactDecimal(parseDecimal('1000.00', 2))).toBe('1,000');
    expect(compactDecimal(parseDecimal('0.12345678', 8))).toBe('0.12345678');
    expect(compactDecimal(parseDecimal('5', 0))).toBe('5');
  });
  it('keeps a price at its own precision', () => {
    expect(priceLabel(parseDecimal('68207.30', 2))).toBe('68,207.30');
  });
  it('shortens only an id that would not fit', () => {
    expect(shortId('lead-k7d2x9')).toBe('lead-k7d2x9');
    expect(shortId('jh72xk4m9d0q2r7tqp8a9f3')).toBe('jh72xk…9f3'.replace('9f3', 'a9f3'));
  });
  it('states the version that was built', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});
