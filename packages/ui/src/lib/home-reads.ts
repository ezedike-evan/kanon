import { useMemo } from 'react';
import type { KanonDataSource } from './data';
import { DEMO_COPY_LEADS, demoSparkline } from './home-demo';
import type { CopyLeadSummary, CopyLeadsState, SparklineState } from './home-types';

/**
 * The live implementation of Home's two own hooks, shared by both clients so web
 * and mobile cannot drift apart. The same shape as `domain-reads.ts`: the app
 * hands in its `useQuery` and the function references, and each hook is a
 * screen-scoped subscription that exists only while its component is mounted.
 *
 *   - auth still resolving -> `loading` (a signed-in user never sees fixtures first)
 *   - signed out           -> the demo fixtures, and no Convex call at all
 *   - signed in            -> the live read: `loading`, then `ready` or `empty`
 *
 * Both are market data, not per-user rows, so a signed-in read sends no user id.
 */
export interface HomeSession {
  pending: boolean;
  signedIn: boolean;
}

export interface HomeReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types are
  // stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  sparkline: unknown;
  leadSummaries: unknown;
  session: HomeSession;
}

const LOADING = { status: 'loading' } as const;
const EMPTY = { status: 'empty' } as const;

export function createHomeReads(
  deps: HomeReadsDeps,
): Pick<KanonDataSource, 'useSparkline' | 'useCopyLeads'> {
  const { useQuery, sparkline, leadSummaries, session } = deps;
  const { pending, signedIn } = session;

  return {
    useSparkline(asset): SparklineState {
      const row = useQuery(sparkline, signedIn ? { asset } : 'skip') as
        | { asset: string; points: number[] }
        | undefined;
      return useMemo<SparklineState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return demoSparkline(asset);
        if (row === undefined) return LOADING;
        if (row.points.length < 2) return EMPTY;
        return { status: 'ready', points: row.points };
      }, [pending, signedIn, asset, row]);
    },

    useCopyLeads(): CopyLeadsState {
      const rows = useQuery(leadSummaries, signedIn ? {} : 'skip') as CopyLeadSummary[] | undefined;
      return useMemo<CopyLeadsState>(() => {
        if (pending) return LOADING;
        if (!signedIn) return DEMO_COPY_LEADS;
        if (rows === undefined) return LOADING;
        if (rows.length === 0) return EMPTY;
        return { status: 'ready', leads: rows };
      }, [pending, signedIn, rows]);
    },
  };
}
