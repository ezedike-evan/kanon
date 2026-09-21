import { describe, expect, it } from 'vitest';
import { parseDecimal } from '@kanon/spec';
import { feedFromReads } from './predict-reads';
import type { MarketRow } from './predict-map';

const NOW = 1_800_000_000;
const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  _id: 'm1',
  asset: 'BTC/USD',
  assetClass: 'crypto',
  direction: 'above',
  thresholdPrice: { atoms: '68755', decimals: 0 },
  windowStart: NOW + 600,
  windowEnd: NOW + 15_000,
  bucketSeconds: 900,
  template: '4H',
  params: {
    offsetBps: 50,
    significantDigits: 5,
    windowSeconds: 14_400,
    bucketSeconds: 900,
    referencePrice: parseDecimal('68412.34', 8),
    referenceAt: NOW - 60,
    feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  },
  termsHash: `0x${'aa'.repeat(32)}`,
  status: 'open',
  latest: null,
  ...over,
});

describe('feedFromReads', () => {
  it('is loading while auth is pending, even if rows arrived', () => {
    expect(feedFromReads({ pending: true, rows: [row()], positions: [], nowSeconds: NOW })).toEqual({
      state: 'loading',
      markets: [],
    });
  });

  it('is loading while the query is, and never reads that as an empty feed', () => {
    expect(feedFromReads({ pending: false, rows: undefined, positions: undefined, nowSeconds: NOW }).state).toBe(
      'loading',
    );
  });

  it('is empty when the read came back with no market', () => {
    expect(feedFromReads({ pending: false, rows: [], positions: [], nowSeconds: NOW })).toEqual({
      state: 'empty',
      markets: [],
    });
  });

  it('is empty when every row is an asset without a Pyth feed', () => {
    const r = feedFromReads({ pending: false, rows: [row({ asset: 'AVAX/USD' })], positions: [], nowSeconds: NOW });
    expect(r.state).toBe('empty');
  });

  it('is ready with markets, before the positions query has answered', () => {
    const r = feedFromReads({ pending: false, rows: [row()], positions: undefined, nowSeconds: NOW });
    expect(r.state).toBe('ready');
    expect(r.markets).toHaveLength(1);
    expect(r.markets[0]!.positions).toEqual([]);
  });

  it('attaches stakes once the positions arrive', () => {
    const r = feedFromReads({
      pending: false,
      rows: [row()],
      positions: [{ marketId: 'm1', side: 'below', stake: { atoms: '1', decimals: 18 } }],
      nowSeconds: NOW,
    });
    expect(r.markets[0]!.positions[0]!.side).toBe('below');
  });
});
