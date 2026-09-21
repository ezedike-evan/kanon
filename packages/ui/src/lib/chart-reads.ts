import { useMemo } from 'react';
import type { Series } from '@kanon/spec';
import type { TradeMarker } from '../components/chart/markers';
import { seriesStateFromQuery, type KanonDataSource, type SeriesState } from './data';
import { buildFixtureMarkers, buildFixtureSeries } from './chart-fixtures';

/**
 * The live implementation of `KanonDataSource.useSeries` / `useChartMarkers`,
 * shared by both clients so web and mobile cannot drift apart.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own
 * `useQuery` and the two function references (`series.getSeries`,
 * `series.getChartMarkers`). Both clients call it once, where they build their
 * data source, and spread the result in.
 *
 * Which of the three chart states a viewer sees:
 *   - auth still resolving      -> `loading`, so a signed-in user is never shown
 *                                  demo candles for a moment first
 *   - signed out                -> the demo source's own fixture (`demo`)
 *   - signed in                 -> the live query: `loading`, then `ready` or
 *                                  `empty`. Never the fixture.
 */
export interface ChartSession {
  /** Privy has not yet said whether anyone is signed in. */
  pending: boolean;
  signedIn: boolean;
  /** The user's active strategy, whose trades supply the markers. */
  strategyId: string | undefined;
}

export interface ChartReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types
  // are stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  getSeries: unknown;
  getChartMarkers: unknown;
  session: ChartSession;
  /**
   * Formerly the demo source, called on every render even when signed in, which built a
   * fixture tape (about 30,000 ticks bucketed) that a signed-in chart never shows. The
   * fixtures are now built here, only when signed out, so this is no longer read.
   */
  demo?: Pick<KanonDataSource, 'useSeries' | 'useChartMarkers'>;
}

const LOADING: SeriesState = { status: 'loading' };
const NO_MARKERS: TradeMarker[] = [];

export function createChartReads(
  deps: ChartReadsDeps,
): Pick<KanonDataSource, 'useSeries' | 'useChartMarkers'> {
  const { useQuery, getSeries, getChartMarkers, session } = deps;
  const { pending, signedIn, strategyId } = session;

  return {
    useSeries(asset, bucketSeconds) {
      const live = useQuery(getSeries, signedIn ? { asset, bucketSeconds } : 'skip') as
        | (Series & { truncated?: boolean })
        | undefined;
      const demoNeeded = !pending && !signedIn;
      const fallback = useMemo<SeriesState | null>(
        () => (demoNeeded ? { status: 'demo', series: buildFixtureSeries(asset, bucketSeconds) } : null),
        [demoNeeded, asset, bucketSeconds],
      );
      return useMemo<SeriesState>(() => {
        if (pending) return LOADING;
        return signedIn ? seriesStateFromQuery(live) : (fallback ?? LOADING);
      }, [pending, signedIn, live, fallback]);
    },

    useChartMarkers(asset, bucketSeconds) {
      const live = useQuery(
        getChartMarkers,
        signedIn && strategyId ? { strategyId, asset, bucketSeconds } : 'skip',
      ) as TradeMarker[] | undefined;
      const demoNeeded = !pending && !signedIn;
      const fallback = useMemo(
        () => (demoNeeded ? buildFixtureMarkers(buildFixtureSeries(asset, bucketSeconds)) : NO_MARKERS),
        [demoNeeded, asset, bucketSeconds],
      );
      return useMemo(() => {
        if (pending) return NO_MARKERS;
        return signedIn ? (live ?? NO_MARKERS) : fallback;
      }, [pending, signedIn, live, fallback]);
    },
  };
}
