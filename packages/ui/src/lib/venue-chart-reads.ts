import { useMemo, useSyncExternalStore } from 'react';
import type { Candle, Decimal, Series } from '@kanon/spec';
import { normalizeSymbol } from './chart-assets';
import { buildFixtureSeries } from './chart-fixtures';
import type { ChartSession } from './chart-reads';
import type { KanonDataSource, SeriesState } from './data';
import type { CandleSnapshot, FeedStore, MarketFeed, VenueCandle } from './market-feed';

/**
 * `KanonDataSource.useSeries` read from the venue through the market data
 * gateway (`market-feed.ts`) instead of from Convex. Used when an app is given
 * a gateway address; `chart-reads.ts` is the Convex one, and still supplies
 * the trade markers either way.
 *
 * Which state a viewer sees is the same as there:
 *   - auth still resolving -> `loading`
 *   - signed out           -> the demo fixture, and nothing is read from the venue
 *   - signed in            -> the venue's candles: `loading`, then `ready` or
 *                             `empty`. An asset the venue does not list is
 *                             `empty`, never the fixture.
 */
export interface VenueChartReadsDeps {
  feed: MarketFeed;
  session: ChartSession;
}

const LOADING: SeriesState = { status: 'loading' };
const EMPTY: SeriesState = { status: 'empty' };

const NOT_READING: CandleSnapshot = { status: 'loading' };
/** What a signed-out chart subscribes to: nothing. */
const IDLE: FeedStore<CandleSnapshot> = { subscribe: () => () => {}, getSnapshot: () => NOT_READING };
const serverSnapshot = (): CandleSnapshot => NOT_READING;

/**
 * Venue candles as the canonical `Series`. The venue's times are milliseconds
 * and its prices integers scaled by the market's `priceDecimals`, which is
 * exactly a `Decimal`'s atoms and decimals, so no price is ever a float here.
 * Open times sit on the bucket grid, so both divisions are exact.
 */
export function seriesFromVenue(
  asset: string,
  bucketSeconds: number,
  candles: readonly VenueCandle[],
  priceDecimals: number,
): Series {
  const price = (atoms: number): Decimal => ({ atoms: String(atoms), decimals: priceDecimals });
  return {
    asset: normalizeSymbol(asset),
    bucketSeconds,
    candles: candles.map((c): Candle => {
      const timestamp = c.t / 1000;
      return {
        bucketIndex: timestamp / bucketSeconds,
        timestamp,
        open: price(c.o),
        high: price(c.h),
        low: price(c.l),
        close: price(c.c),
        // Every venue candle is one the venue published. Nothing is carried forward here.
        synthetic: false,
      };
    }),
  };
}

/** A feed snapshot as the state a chart draws. */
export function seriesStateFromVenue(asset: string, bucketSeconds: number, snapshot: CandleSnapshot): SeriesState {
  if (snapshot.status === 'loading') return LOADING;
  if (snapshot.status === 'unlisted' || snapshot.candles.length === 0) return EMPTY;
  return {
    status: 'ready',
    series: seriesFromVenue(asset, bucketSeconds, snapshot.candles, snapshot.market.priceDecimals),
    // The list starts on a window boundary, which for 1W is also a week boundary: no candle is cut short.
    truncated: false,
  };
}

export function createVenueChartReads(deps: VenueChartReadsDeps): Pick<KanonDataSource, 'useSeries'> {
  const { feed, session } = deps;
  const { pending, signedIn } = session;

  return {
    useSeries(asset, bucketSeconds) {
      const store = signedIn ? feed.candles(asset, bucketSeconds) : IDLE;
      const live = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
      const demoNeeded = !pending && !signedIn;
      const fallback = useMemo<SeriesState | null>(
        () => (demoNeeded ? { status: 'demo', series: buildFixtureSeries(asset, bucketSeconds) } : null),
        [demoNeeded, asset, bucketSeconds],
      );
      return useMemo<SeriesState>(() => {
        if (pending) return LOADING;
        return signedIn ? seriesStateFromVenue(asset, bucketSeconds, live) : (fallback ?? LOADING);
      }, [pending, signedIn, asset, bucketSeconds, live, fallback]);
    },
  };
}
