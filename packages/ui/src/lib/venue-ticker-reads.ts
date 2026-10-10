import { useMemo, useRef, useSyncExternalStore } from 'react';
import { marketAssets, roundedBps, subDecimal, type Decimal } from '@kanon/spec';
import type { KanonDataSource } from './data';
import { DEMO_MARKETS, demoTicker } from './domain-demo';
import { samePair } from './domain-map';
import type { MarketsState, PairTicker, TickerState } from './domain-types';
import type { FeedStore, MarketFeed, TickerSnapshot, TickersSnapshot, VenueTicker } from './market-feed';
import { shareStructure } from './store';

/**
 * `useMarkets` and `useTicker` read from the venue's `market-state` stream
 * through the market data gateway, instead of from Convex. Used when an app is
 * given a gateway address, so a pair row and the chart beside it state the same
 * price; `domain-reads.ts` is the Convex one, and still supplies activity and
 * follows either way.
 *
 * Which state a viewer sees is the same as there: `loading` while auth
 * resolves, the demo fixtures signed out (and nothing read from the venue),
 * and signed in `loading`, then `ready` or `empty`.
 */
export interface VenueTickerReadsDeps {
  feed: MarketFeed;
  session: { pending: boolean; signedIn: boolean };
}

const LOADING = { status: 'loading' } as const;
const EMPTY = { status: 'empty' } as const;

/** The pairs a list shows: the same ones `series.listTickers` reads on Convex. */
const LISTED: readonly string[] = marketAssets();

const idle = <T,>(snapshot: T): FeedStore<T> => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
const NO_LIST: TickersSnapshot = { status: 'loading' };
const NO_TICKER: TickerSnapshot = { status: 'loading' };
const IDLE_LIST = idle(NO_LIST);
const IDLE_TICKER = idle(NO_TICKER);
const serverList = (): TickersSnapshot => NO_LIST;
const serverTicker = (): TickerSnapshot => NO_TICKER;

/**
 * A venue ticker as a pair row.
 *
 *   - `price` is the last traded price, the number a candle closes on, so the
 *     row agrees with the chart to the last digit.
 *   - `changeBps` is that against the venue's own price 24 hours earlier, in
 *     integer basis points by the same rounding the Convex ticker uses. Null
 *     when the venue sent no earlier price: "no move known" is not 0%.
 *   - `publishTime` is the venue's time on the state the price was read from.
 */
export function pairFromVenue(ticker: VenueTicker): PairTicker {
  const [base = ticker.asset, quote = ''] = ticker.asset.split('/');
  const decimals = ticker.market.priceDecimals;
  const price: Decimal = { atoms: String(ticker.last), decimals };
  const earlier: Decimal | null = ticker.dayAgo === null ? null : { atoms: String(ticker.dayAgo), decimals };
  return {
    asset: ticker.asset,
    base,
    quote,
    price,
    changeBps: earlier ? roundedBps(subDecimal(price, earlier), earlier) : null,
    publishTime: Math.floor(ticker.at / 1000),
  };
}

export function createVenueTickerReads(deps: VenueTickerReadsDeps): Pick<KanonDataSource, 'useMarkets' | 'useTicker'> {
  const { feed, session } = deps;
  const { pending, signedIn } = session;

  return {
    useMarkets(): MarketsState {
      const store = signedIn ? feed.tickers(LISTED) : IDLE_LIST;
      const live = useSyncExternalStore(store.subscribe, store.getSnapshot, serverList);
      const previous = useRef<PairTicker[] | undefined>(undefined);
      return useMemo<MarketsState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return DEMO_MARKETS;
        if (live.status === 'loading') return LOADING;
        if (live.tickers.length === 0) return EMPTY;
        // A row whose price did not move keeps its reference, so a memoised row skips the render.
        const pairs = shareStructure(previous.current, live.tickers.map(pairFromVenue), (p) => p.asset, samePair);
        previous.current = pairs;
        return { status: 'ready', pairs };
      }, [pending, signedIn, live]);
    },

    useTicker(asset): TickerState {
      const store = signedIn ? feed.ticker(asset) : IDLE_TICKER;
      const live = useSyncExternalStore(store.subscribe, store.getSnapshot, serverTicker);
      return useMemo<TickerState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return demoTicker(asset);
        if (live.status === 'loading') return LOADING;
        if (live.status === 'unlisted') return EMPTY;
        return { status: 'ready', ticker: pairFromVenue(live.ticker) };
      }, [pending, signedIn, asset, live]);
    },
  };
}
