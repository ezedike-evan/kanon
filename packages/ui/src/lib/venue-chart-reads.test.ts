import { describe, expect, it, vi } from 'vitest';
import { Decimal, formatDecimal } from '@kanon/spec';
import { foldCandles, type CandleSnapshot, type MarketFeed, type VenueCandle, type VenueMarket } from './market-feed';
import { createVenueChartReads, seriesFromVenue, seriesStateFromVenue } from './venue-chart-reads';

// The hook is a plain function of the feed's store plus `useMemo`: with both run inline, a stand-in
// store returning a fixed snapshot is enough to read what it decides, with no renderer. The real
// subscription is exercised in `venue-source.test.ts`.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useMemo: (fn: () => unknown) => fn(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
const renderHook = <T,>(fn: () => T): T => fn();

const BTC: VenueMarket = { id: 16, symbol: 'BTC', name: 'BTC Perp', priceDecimals: 1 };
// A row as the venue sends it, less the fields a chart does not draw.
const ROW: VenueCandle = { t: 1_791_124_200_000, o: 851_752, c: 851_251, h: 852_052, l: 851_136 };

describe('seriesFromVenue', () => {
  it('turns milliseconds into seconds and scaled integers into decimals', () => {
    const series = seriesFromVenue('btc / usd', 900, [ROW], 1);
    expect(series).toEqual({
      asset: 'BTC/USD',
      bucketSeconds: 900,
      candles: [
        {
          bucketIndex: 1_990_138,
          timestamp: 1_791_124_200,
          open: { atoms: '851752', decimals: 1 },
          high: { atoms: '852052', decimals: 1 },
          low: { atoms: '851136', decimals: 1 },
          close: { atoms: '851251', decimals: 1 },
          synthetic: false,
        },
      ],
    });
    const candle = series.candles[0]!;
    expect(candle.bucketIndex * 900).toBe(candle.timestamp);
    expect(formatDecimal(candle.open)).toBe('85,175.2');
    expect(() => Decimal.parse(candle.close)).not.toThrow();
  });

  it('carries the market scale, whatever it is, and never a float', () => {
    const eth = seriesFromVenue('ETH/USD', 60, [{ t: 60_000, o: 248_599, h: 248_687, l: 248_587, c: 248_622 }], 2);
    expect(formatDecimal(eth.candles[0]!.close)).toBe('2,486.22');
    const whole = seriesFromVenue('X/USD', 60, [{ t: 0, o: 7, h: 7, l: 7, c: 7 }], 0);
    expect(whole.candles[0]!.open).toEqual({ atoms: '7', decimals: 0 });
    const big = seriesFromVenue('X/USD', 60, [{ t: 0, o: Number.MAX_SAFE_INTEGER, h: 1, l: 1, c: 1 }], 18);
    expect(big.candles[0]!.open.atoms).toBe('9007199254740991');
  });

  it('indexes a week folded from days by its own, wider bucket', () => {
    const DAY = 86_400_000;
    const week = 2_962 * 7 * DAY;
    const days: VenueCandle[] = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ t: week + n * DAY, o: 10 + n, h: 20 + n, l: 5 + n, c: 11 + n }));
    const series = seriesFromVenue('BTC/USD', 604_800, foldCandles(days, 7 * DAY), 1);
    expect(series.candles.map((c) => [c.bucketIndex, c.timestamp])).toEqual([
      [2_962, week / 1000],
      [2_963, week / 1000 + 604_800],
    ]);
    expect(series.candles[0]).toMatchObject({
      open: { atoms: '10', decimals: 1 },
      high: { atoms: '26', decimals: 1 },
      low: { atoms: '5', decimals: 1 },
      close: { atoms: '17', decimals: 1 },
    });
  });
});

describe('seriesStateFromVenue', () => {
  it('is loading until the feed has an answer', () => {
    expect(seriesStateFromVenue('BTC/USD', 900, { status: 'loading' })).toEqual({ status: 'loading' });
  });

  it('shows an asset the venue does not list, or a market with no candles yet, as empty', () => {
    expect(seriesStateFromVenue('DOGE/USD', 900, { status: 'unlisted' })).toEqual({ status: 'empty' });
    expect(seriesStateFromVenue('BTC/USD', 900, { status: 'ready', market: BTC, candles: [] })).toEqual({ status: 'empty' });
  });

  it('is ready with the series at the market scale', () => {
    const state = seriesStateFromVenue('BTC/USD', 900, { status: 'ready', market: BTC, candles: [ROW] });
    expect(state).toEqual({ status: 'ready', truncated: false, series: seriesFromVenue('BTC/USD', 900, [ROW], 1) });
  });
});

/** A feed whose every candle store holds `snapshot`, and which records what it was asked for. */
function stubFeed(snapshot: CandleSnapshot) {
  const asked: Array<[string, number]> = [];
  const feed = {
    candles(asset: string, bucketSeconds: number) {
      asked.push([asset, bucketSeconds]);
      return { subscribe: () => () => {}, getSnapshot: () => snapshot };
    },
  } as unknown as MarketFeed;
  return { feed, asked };
}

const READY: CandleSnapshot = { status: 'ready', market: BTC, candles: [ROW] };
const session = (pending: boolean, signedIn: boolean) => ({ pending, signedIn, strategyId: undefined });

describe('createVenueChartReads', () => {
  it('shows a skeleton, not fixtures, while auth is unresolved', () => {
    const { feed, asked } = stubFeed(READY);
    const reads = createVenueChartReads({ feed, session: session(true, false) });
    expect(renderHook(() => reads.useSeries('BTC/USD', 900))).toEqual({ status: 'loading' });
    expect(asked).toEqual([]);
    // Signed in but not yet confirmed: still a skeleton, though the read may already have started.
    const confirming = createVenueChartReads({ feed, session: session(true, true) });
    expect(renderHook(() => confirming.useSeries('BTC/USD', 900))).toEqual({ status: 'loading' });
  });

  it('signed out: the demo fixture, and nothing read from the venue', () => {
    const { feed, asked } = stubFeed(READY);
    const reads = createVenueChartReads({ feed, session: session(false, false) });
    const state = renderHook(() => reads.useSeries('ETH/USD', 3_600));
    expect(state.status).toBe('demo');
    if (state.status !== 'demo') return;
    expect(state.series.asset).toBe('ETH/USD');
    expect(state.series.bucketSeconds).toBe(3_600);
    expect(state.series.candles.length).toBeGreaterThan(0);
    expect(asked).toEqual([]);
  });

  it('signed in: loading, then the venue candles', () => {
    const waiting = stubFeed({ status: 'loading' });
    const before = createVenueChartReads({ feed: waiting.feed, session: session(false, true) });
    expect(renderHook(() => before.useSeries('BTC/USD', 900))).toEqual({ status: 'loading' });
    expect(waiting.asked).toEqual([['BTC/USD', 900]]);

    const { feed } = stubFeed(READY);
    const reads = createVenueChartReads({ feed, session: session(false, true) });
    const state = renderHook(() => reads.useSeries('BTC/USD', 900));
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.series.candles[0]!.close).toEqual({ atoms: '851251', decimals: 1 });
    expect(state.series.candles[0]!.timestamp).toBe(1_791_124_200);
  });

  it('signed in: an asset the venue does not list is empty, never the fixture', () => {
    const { feed } = stubFeed({ status: 'unlisted' });
    const reads = createVenueChartReads({ feed, session: session(false, true) });
    expect(renderHook(() => reads.useSeries('AVAX/USD', 900))).toEqual({ status: 'empty' });
  });
});
