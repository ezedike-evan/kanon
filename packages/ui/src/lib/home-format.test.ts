import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import { DEMO_ACTIVITY } from './domain-demo';
import {
  activityCopy,
  baseOf,
  dayLabel,
  formatSize,
  greetingName,
  groupByDay,
  relativeTime,
  shortAddress,
  shortDate,
  walletChip,
} from './home-format';
import { chartRoute, parseChartAsset } from './routes';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('walletChip', () => {
  const ADDRESS = '0x9fE2aB0c1d3E4f5a6B7c8D9e0F1a2B3c4D5e41Ab';

  it('says nothing while auth is still resolving', () => {
    expect(walletChip({ pending: true, signedIn: false, hasWallet: false, address: null })).toBeNull();
    expect(walletChip({ pending: true, signedIn: true, hasWallet: true, address: ADDRESS })).toBeNull();
  });

  it('signed out is the way to sign in, and never reports a wallet as failed', () => {
    const chip = walletChip({ pending: false, signedIn: false, hasWallet: false, address: null });
    expect(chip).toEqual({ label: 'Sign in', to: 'signin', connected: false, accessibilityLabel: 'Sign in' });
    expect(JSON.stringify(chip)).not.toMatch(/not connected|failed|error/i);
  });

  it('signed in states the wallet and opens Profile', () => {
    expect(walletChip({ pending: false, signedIn: true, hasWallet: true, address: ADDRESS })).toEqual({
      label: '0x9fE2…41Ab',
      to: 'profile',
      connected: true,
      accessibilityLabel: `Wallet ${ADDRESS}. Open profile.`,
    });
    expect(walletChip({ pending: false, signedIn: true, hasWallet: true, address: null })).toMatchObject({
      label: 'Wallet ready',
      to: 'profile',
      connected: true,
    });
    expect(walletChip({ pending: false, signedIn: true, hasWallet: false, address: null })).toMatchObject({
      label: 'No wallet',
      to: 'profile',
      connected: false,
    });
  });
});

describe('shortAddress', () => {
  it('keeps the two ends', () => {
    expect(shortAddress('0x9fE2aB0c1d3E4f5a6B7c8D9e0F1a2B3c4D5e41Ab')).toBe('0x9fE2…41Ab');
  });
  it('leaves a short string alone', () => {
    expect(shortAddress('0x12')).toBe('0x12');
  });
});

describe('greetingName', () => {
  it('uses the first word of the name', () => {
    expect(greetingName({ name: 'Ada Lovelace', username: 'ada' })).toBe('Ada');
  });
  it('falls back to the handle without its @', () => {
    expect(greetingName({ name: ' ', username: '@ada' })).toBe('ada');
  });
  it('has nothing to say when it has neither', () => {
    expect(greetingName({ name: '', username: '' })).toBeNull();
    expect(greetingName(null)).toBeNull();
  });
});

describe('relativeTime', () => {
  it('is now under a minute, then minutes, hours and days', () => {
    expect(relativeTime(ago(30_000), NOW)).toBe('now');
    expect(relativeTime(ago(5 * MIN), NOW)).toBe('5m');
    expect(relativeTime(ago(59 * MIN + 59_000), NOW)).toBe('59m');
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h');
    expect(relativeTime(ago(2 * DAY + HOUR), NOW)).toBe('2d');
  });
  it('is the UTC date from a week on', () => {
    expect(relativeTime(Date.parse('2026-09-02T14:32:00Z'), NOW)).toBe('Sep 02');
    expect(relativeTime(ago(7 * DAY), NOW)).toBe(shortDate(ago(7 * DAY)));
  });
  it('never goes negative when a clock runs ahead', () => {
    expect(relativeTime(NOW + HOUR, NOW)).toBe('now');
  });
  it('is the date with no clock yet, so a server render and its hydration agree', () => {
    expect(relativeTime(Date.parse('2026-09-02T14:32:00Z'), 0)).toBe('Sep 02');
  });
});

describe('formatSize', () => {
  it('drops the padding zeros and keeps two decimals', () => {
    expect(formatSize(parseDecimal('0.05000000', 8))).toBe('0.05');
    expect(formatSize(parseDecimal('1.00000000', 8))).toBe('1.00');
    expect(formatSize(parseDecimal('0.12345000', 8))).toBe('0.12345');
  });
  it('leaves a two-decimal size as it is', () => {
    expect(formatSize(parseDecimal('1250.50', 2))).toBe('1,250.50');
  });
});

describe('baseOf', () => {
  it('takes the base of a pair', () => {
    expect(baseOf('MON/USD')).toBe('MON');
    expect(baseOf('BTC')).toBe('BTC');
  });
});

describe('activityCopy', () => {
  const byKind = (kind: string) => DEMO_ACTIVITY.find((a) => a.kind === kind)!;

  it('names the predicate that held a refused entry, in plain words and never as an error', () => {
    const c = activityCopy(byKind('refused'));
    expect(c.sub).toContain('bos_bullish');
    expect(`${c.title} ${c.sub} ${c.badge}`.toLowerCase()).not.toMatch(/error|fail|sorry|denied|rejected/);
  });

  it('states the side, the entry and the size of an executed trade', () => {
    const c = activityCopy(byKind('executed'));
    expect(c.title).toBe('BTC/USD · Long');
    expect(c.sub).toContain('67,940.10');
    expect(c.sub).toContain('0.05 BTC');
  });

  it('writes a refusal with no named predicate without inventing one', () => {
    const c = activityCopy({ ...byKind('refused'), refusedBy: undefined } as never);
    expect(c.sub).toBe('Your rule held this entry');
  });

  it('has words for every kind', () => {
    for (const kind of ['executed', 'refused', 'proposed', 'undone'] as const) {
      expect(activityCopy({ ...byKind('executed'), kind }).badge).not.toBe('');
    }
  });
});

describe('chartRoute', () => {
  it('carries the asset in the query and round-trips it', () => {
    const href = chartRoute('BTC/USD');
    expect(href).toBe('/chart?asset=BTC%2FUSD');
    expect(parseChartAsset(href.split('?')[1] ?? '')).toBe('BTC/USD');
  });
  it('reads nothing from a query with no asset', () => {
    expect(parseChartAsset('')).toBeNull();
    expect(parseChartAsset('tf=1h')).toBeNull();
  });
  it('normalises the way the series does', () => {
    expect(parseChartAsset('asset=btc%20%2F%20usd')).toBe('BTC/USD');
  });
});

describe('dayLabel and groupByDay', () => {
  const at = (iso: string) => Date.parse(iso);

  it('says Today and Yesterday by UTC day, then the date', () => {
    expect(dayLabel(at('2026-09-21T00:01:00Z'), NOW)).toBe('Today');
    expect(dayLabel(at('2026-09-20T23:59:00Z'), NOW)).toBe('Yesterday');
    expect(dayLabel(at('2026-09-18T10:00:00Z'), NOW)).toBe('Sep 18');
  });

  it('is always the date before there is a clock', () => {
    expect(dayLabel(at('2026-09-21T00:01:00Z'), 0)).toBe('Sep 21');
  });

  it('groups consecutive items by day and keeps their order', () => {
    const items = [
      { id: 'a', at: at('2026-09-21T09:00:00Z') },
      { id: 'b', at: at('2026-09-21T01:00:00Z') },
      { id: 'c', at: at('2026-09-20T22:00:00Z') },
      { id: 'd', at: at('2026-09-02T10:00:00Z') },
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Sep 02']);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('has no groups for no items', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});
