import { useMemo, useRef } from 'react';
import type { KanonDataSource } from './data';
import {
  DEMO_ACTIVITY,
  DEMO_FOLLOWS,
  DEMO_MARKETS,
  demoTicker,
} from './domain-demo';
import {
  activityFromRows,
  followsFromRows,
  pairFromTicker,
  sameActivity,
  samePair,
  type ActivityRow,
  type FollowRow,
  type TickerRow,
} from './domain-map';
import type {
  ActivityItem,
  ActivityState,
  MarketsState,
  PairTicker,
  ProfileFollow,
  TickerState,
} from './domain-types';
import { shareStructure } from './store';

/**
 * The live implementation of the per-domain hooks that read Convex directly
 * (`useMarkets`, `useTicker`, `useActivity`, `useFollows`), shared by both
 * clients so web and mobile cannot drift apart.
 *
 * Every hook here is a *screen-scoped subscription*: it calls `useQuery` in
 * the component that shows the data, so the query exists exactly while that
 * component is mounted, and a new result re-renders that component and nothing
 * else. Nothing is subscribed at the app root. Convex de-duplicates identical
 * subscriptions, so two components that ask for the same query share one.
 *
 * Which state a viewer sees, as for the chart:
 *   - auth still resolving -> `loading`, so a signed-in user is never shown
 *                             fixtures for a moment first
 *   - signed out           -> the demo fixtures, and no Convex call at all
 *   - signed in            -> the live read: `loading`, then `ready` or `empty`
 */
export interface DomainSession {
  /** Privy has not yet said whether anyone is signed in. */
  pending: boolean;
  signedIn: boolean;
  /** The Convex `users` row. A gate only: it is never sent. */
  userId: string | undefined;
}

export interface DomainReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types
  // are stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  listTickers: unknown;
  getTicker: unknown;
  listRecentActivity: unknown;
  listFollows: unknown;
  session: DomainSession;
}

const LOADING = { status: 'loading' } as const;
const EMPTY = { status: 'empty' } as const;

export function createDomainReads(
  deps: DomainReadsDeps,
): Pick<KanonDataSource, 'useMarkets' | 'useTicker' | 'useActivity' | 'useFollows'> {
  const { useQuery, listTickers, getTicker, listRecentActivity, listFollows, session } = deps;
  const { pending, signedIn, userId } = session;

  return {
    useMarkets(): MarketsState {
      const rows = useQuery(listTickers, signedIn ? {} : 'skip') as TickerRow[] | undefined;
      const previous = useRef<PairTicker[] | undefined>(undefined);
      return useMemo<MarketsState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return DEMO_MARKETS;
        if (rows === undefined) return LOADING;
        if (rows.length === 0) return EMPTY;
        // A row whose price did not move keeps its reference, so a memoised row skips the render.
        const pairs = shareStructure(previous.current, rows.map(pairFromTicker), (p) => p.asset, samePair);
        previous.current = pairs;
        return { status: 'ready', pairs };
      }, [pending, signedIn, rows]);
    },

    useTicker(asset): TickerState {
      const row = useQuery(getTicker, signedIn ? { asset } : 'skip') as TickerRow | null | undefined;
      return useMemo<TickerState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return demoTicker(asset);
        if (row === undefined) return LOADING;
        if (row === null) return EMPTY;
        return { status: 'ready', ticker: pairFromTicker(row) };
      }, [pending, signedIn, asset, row]);
    },

    useActivity(limit = 10): ActivityState {
      const rows = useQuery(
        listRecentActivity,
        signedIn && userId ? { limit } : 'skip',
      ) as ActivityRow[] | undefined;
      const previous = useRef<ActivityItem[] | undefined>(undefined);
      return useMemo<ActivityState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return { status: 'demo', items: DEMO_ACTIVITY.slice(0, limit) };
        if (!userId || rows === undefined) return LOADING;
        if (rows.length === 0) return EMPTY;
        const items = shareStructure(previous.current, activityFromRows(rows), (i) => i.id, sameActivity);
        previous.current = items;
        return { status: 'ready', items };
      }, [pending, signedIn, userId, rows, limit]);
    },

    useFollows(): ProfileFollow[] | undefined {
      const rows = useQuery(listFollows, signedIn && userId ? {} : 'skip') as FollowRow[] | undefined;
      return useMemo(() => {
        if (pending) return undefined;
        if (!signedIn) return DEMO_FOLLOWS;
        return rows === undefined ? undefined : followsFromRows(rows);
      }, [pending, signedIn, rows]);
    },
  };
}
