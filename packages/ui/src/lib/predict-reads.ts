import { useCallback, useMemo, useRef } from 'react';
import type { KanonDataSource } from './data';
import { DEMO_MARKET_AVAILABILITY, type MarketClient } from './market-client';
import { takeMarketSide, type PredictActions } from './predict-flow';
import { marketsFromRows, type MarketRow, type PositionRow } from './predict-map';
import type { PredictFeed, PredictFeedState, PredictMarket } from './predict-types';

/**
 * The live implementation of `KanonDataSource.usePredict`, shared by both
 * clients so web and mobile cannot drift apart.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own
 * `useQuery` and the two function references (`markets.list`,
 * `predictions.listMarketPositions`), the two writes a stake needs, and a
 * `MarketClient`. Both clients call this once, where they build their data
 * source, and spread the result in.
 *
 * Which state a viewer sees:
 *   - auth still resolving -> `loading`, so a signed-in user is never shown
 *                             demo cards for a moment first
 *   - signed out           -> the demo source's own cards. Nothing can be staked.
 *   - signed in            -> the live read: `loading`, then `ready` or `empty`.
 *                             Never the fixtures.
 */
export interface PredictSession {
  /** Privy has not yet said whether anyone is signed in. */
  pending: boolean;
  signedIn: boolean;
  /** The Convex `users` row. Reading markets does not need one; staking does. */
  userId: string | undefined;
}

export interface PredictReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types
  // are stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  listMarkets: unknown;
  listPositions: unknown;
  actions: PredictActions;
  marketClient: MarketClient;
  session: PredictSession;
  /** The demo source, for the signed-out fallback. */
  demo: Pick<KanonDataSource, 'usePredict'>;
}

export interface FeedRead {
  state: PredictFeedState;
  markets: PredictMarket[];
}

/**
 * The feed's state and cards from what the two queries returned. `undefined`
 * is what a Convex `useQuery` returns while it is still loading, and it is
 * never read as an empty feed.
 */
export function feedFromReads(input: {
  pending: boolean;
  rows: readonly MarketRow[] | undefined;
  positions: readonly PositionRow[] | undefined;
  nowSeconds: number;
}): FeedRead {
  if (input.pending || input.rows === undefined) return { state: 'loading', markets: [] };
  const markets = marketsFromRows(input.rows, input.positions ?? [], input.nowSeconds);
  return { state: markets.length === 0 ? 'empty' : 'ready', markets };
}

export function createPredictReads(deps: PredictReadsDeps): Pick<KanonDataSource, 'usePredict'> {
  const { useQuery, listMarkets, listPositions, actions, marketClient, session, demo } = deps;
  const { pending, signedIn, userId } = session;

  return {
    usePredict(): PredictFeed {
      const rows = useQuery(listMarkets, signedIn ? {} : 'skip') as MarketRow[] | undefined;
      const positions = useQuery(listPositions, signedIn && userId ? {} : 'skip') as
        | PositionRow[]
        | undefined;
      const fallback = demo.usePredict();

      const read = useMemo<FeedRead>(
        () =>
          feedFromReads({
            pending,
            rows,
            positions,
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
        [pending, rows, positions],
      );

      const marketsRef = useRef<PredictMarket[]>(read.markets);
      marketsRef.current = read.markets;

      const takeSide = useCallback<PredictFeed['takeSide']>(
        (marketId, side, stake) =>
          takeMarketSide({
            market: marketsRef.current.find((m) => m.id === marketId),
            side,
            stake,
            nowSeconds: Math.floor(Date.now() / 1000),
            userId,
            client: marketClient,
            actions,
          }),
        [userId, marketClient, actions],
      );

      const checkCrossed = useCallback<PredictFeed['checkCrossed']>(async (marketId) => {
        const market = marketsRef.current.find((m) => m.id === marketId);
        if (!market || market.demo || !market.chain) return null;
        if (marketClient.availability().state !== 'ready') return null;
        try {
          return await marketClient.hasCrossed(market.chain.marketId);
        } catch {
          return null;
        }
      }, [marketClient]);

      return useMemo<PredictFeed>(() => {
        if (!signedIn && !pending) return fallback;
        return {
          state: read.state,
          markets: read.markets,
          availability: signedIn ? marketClient.availability() : DEMO_MARKET_AVAILABILITY,
          nativeSymbol: marketClient.nativeSymbol,
          takeSide,
          checkCrossed,
        };
      }, [signedIn, pending, fallback, read, takeSide, checkCrossed]);
    },
  };
}
