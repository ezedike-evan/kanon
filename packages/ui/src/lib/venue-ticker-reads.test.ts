import { describe, expect, it, vi } from 'vitest';
import { formatDecimal, marketAssets } from '@kanon/spec';
import { DEMO_MARKETS, demoTicker } from './domain-demo';
import type { MarketFeed, TickerSnapshot, TickersSnapshot, VenueMarket, VenueTicker } from './market-feed';
import { createVenueTickerReads, pairFromVenue } from './venue-ticker-reads';

// As in `venue-chart-reads.test.ts`: the hooks run inline over a stand-in store.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useMemo: (fn: () => unknown) => fn(),
  useRef: (value: unknown) => ({ current: value }),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
const renderHook = <T,>(fn: () => T): T => fn();

const BTC: VenueMarket = { id: 16, symbol: 'BTC', name: 'BTC Perp', priceDecimals: 1 };
const SOL: VenueMarket = { id: 48, symbol: 'SOL', name: 'SOL Perp', priceDecimals: 2 };
// Figures read off the testnet venue: BTC up on the day, SOL down.
const btc: VenueTicker = { asset: 'BTC/USD', market: BTC, last: 825_778, dayAgo: 818_016, at: 1_791_587_479_000 };
const sol: VenueTicker = { asset: 'SOL/USD', market: SOL, last: 10_900, dayAgo: 11_023, at: 1_791_587_483_500 };

describe('pairFromVenue', () => {
  it('states the last price at the market scale and the move from a day earlier in whole basis points', () => {
    expect(pairFromVenue(btc)).toEqual({
      asset: 'BTC/USD',
      base: 'BTC',
      quote: 'USD',
      price: { atoms: '825778', decimals: 1 },
      // (825778 - 818016) / 818016 = 94.89 bp
      changeBps: 95,
      publishTime: 1_791_587_479,
    });
    expect(formatDecimal(pairFromVenue(btc).price)).toBe('82,577.8');
  });

  it('rounds a fall the same way, away from zero at the half', () => {
    // (10900 - 11023) / 11023 = -111.58 bp
    expect(pairFromVenue(sol).changeBps).toBe(-112);
    expect(pairFromVenue({ ...sol, last: 20_001, dayAgo: 20_000 }).changeBps).toBe(1);
    expect(pairFromVenue({ ...sol, last: 19_999, dayAgo: 20_000 }).changeBps).toBe(-1);
    expect(pairFromVenue({ ...sol, last: 20_000, dayAgo: 20_000 }).changeBps).toBe(0);
  });

  it('says no move is known when the venue sent no earlier price', () => {
    expect(pairFromVenue({ ...btc, dayAgo: null }).changeBps).toBeNull();
  });

  it('gives the time of the state in whole seconds', () => {
    expect(pairFromVenue(sol).publishTime).toBe(1_791_587_483);
  });
});

function stubFeed(list: TickersSnapshot, one: TickerSnapshot) {
  const asked: unknown[] = [];
  const feed = {
    tickers(assets: readonly string[]) {
      asked.push([...assets]);
      return { subscribe: () => () => {}, getSnapshot: () => list };
    },
    ticker(asset: string) {
      asked.push(asset);
      return { subscribe: () => () => {}, getSnapshot: () => one };
    },
  } as unknown as MarketFeed;
  return { feed, asked };
}

const LIST: TickersSnapshot = { status: 'ready', tickers: [btc, sol] };
const ONE: TickerSnapshot = { status: 'ready', ticker: btc };

describe('createVenueTickerReads', () => {
  it('shows a skeleton, not fixtures, while auth is unresolved', () => {
    const { feed, asked } = stubFeed(LIST, ONE);
    const reads = createVenueTickerReads({ feed, session: { pending: true, signedIn: false } });
    expect(renderHook(() => reads.useMarkets())).toEqual({ status: 'loading' });
    expect(renderHook(() => reads.useTicker('BTC/USD'))).toEqual({ status: 'loading' });
    expect(asked).toEqual([]);
  });

  it('signed out: fixtures, and nothing read from the venue', () => {
    const { feed, asked } = stubFeed(LIST, ONE);
    const reads = createVenueTickerReads({ feed, session: { pending: false, signedIn: false } });
    expect(renderHook(() => reads.useMarkets())).toBe(DEMO_MARKETS);
    expect(renderHook(() => reads.useTicker('ETH/USD'))).toBe(demoTicker('ETH/USD'));
    expect(asked).toEqual([]);
  });

  it('signed in: loading until the venue answers, then its prices', () => {
    const waiting = stubFeed({ status: 'loading' }, { status: 'loading' });
    const before = createVenueTickerReads({ feed: waiting.feed, session: { pending: false, signedIn: true } });
    expect(renderHook(() => before.useMarkets())).toEqual({ status: 'loading' });
    expect(renderHook(() => before.useTicker('BTC/USD'))).toEqual({ status: 'loading' });
    // The list asks for the same pairs the Convex ticker list covers.
    expect(waiting.asked).toEqual([marketAssets(), 'BTC/USD']);

    const { feed } = stubFeed(LIST, ONE);
    const reads = createVenueTickerReads({ feed, session: { pending: false, signedIn: true } });
    expect(renderHook(() => reads.useMarkets())).toEqual({ status: 'ready', pairs: [pairFromVenue(btc), pairFromVenue(sol)] });
    expect(renderHook(() => reads.useTicker('BTC/USD'))).toEqual({ status: 'ready', ticker: pairFromVenue(btc) });
  });

  it('signed in: nothing listed is empty, never the fixture', () => {
    const { feed } = stubFeed({ status: 'ready', tickers: [] }, { status: 'unlisted' });
    const reads = createVenueTickerReads({ feed, session: { pending: false, signedIn: true } });
    expect(renderHook(() => reads.useMarkets())).toEqual({ status: 'empty' });
    expect(renderHook(() => reads.useTicker('AVAX/USD'))).toEqual({ status: 'empty' });
  });
});
