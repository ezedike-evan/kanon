import { useEffect, useMemo, useState } from 'react';
import type { AnalyticsReport, AnalyticsState, NansenFlow, NansenState } from '@kanon/spec';
import type { KanonDataSource } from './data';

/**
 * The live implementation of `KanonDataSource.useAnalytics` / `useNansenFlow`,
 * shared by both clients so web and mobile cannot drift apart.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own
 * `useQuery` and `useAction` and the two function references
 * (`analytics.report`, `nansen.smartMoneyFlow`). Both clients call this once,
 * where they build their data source, and spread the result in:
 *
 *   ...createAnalyticsReads({
 *     useQuery, useAction,
 *     report: api.analytics.report,
 *     smartMoneyFlow: api.nansen.smartMoneyFlow,
 *     session: { pending: !ready, signedIn, strategyId, userId },
 *     demo: base,
 *   })
 *
 * Which state a viewer sees, as for the chart:
 *   - auth still resolving   -> `loading`, so a signed-in user is never shown
 *                               demo figures for a moment first
 *   - signed out             -> the demo source's own report
 *   - signed in, no strategy -> `empty`. Not a demo report dressed as theirs.
 *   - signed in              -> the live query, `loading` until it answers
 */
export interface AnalyticsSession {
  pending: boolean;
  signedIn: boolean;
  strategyId: string | undefined;
  /**
   * The Convex `users` row of the signed-in user, once it exists. A gate only:
   * it is never sent. The server derives the caller from the Privy token.
   */
  userId: string | undefined;
}

export interface AnalyticsReadsDeps {
  // Convex's hooks, typed loosely on purpose: the generated `api` types are
  // stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  useAction: (ref: any) => (args: any) => Promise<unknown>;
  report: unknown;
  smartMoneyFlow: unknown;
  session: AnalyticsSession;
  /** The demo source, for the signed-out fallback. */
  demo: Pick<KanonDataSource, 'useAnalytics' | 'useNansenFlow'>;
}

const LOADING_ANALYTICS: AnalyticsState = { status: 'loading' };
const EMPTY_ANALYTICS: AnalyticsState = { status: 'empty' };
const LOADING_FLOW: NansenState = { status: 'loading' };

const FLOW_STATUSES = ['not_connected', 'unsupported', 'no_data', 'error', 'ok'] as const;

/** A reply that is not one of Nansen's states is a failure to read, not a figure. */
function asFlow(result: unknown): NansenFlow {
  const status = (result as { status?: unknown } | null)?.status;
  if (typeof status === 'string' && (FLOW_STATUSES as readonly string[]).includes(status)) {
    return result as NansenFlow;
  }
  return {
    status: 'error',
    kind: 'invalid_response',
    message: 'The flow read came back in a shape this screen does not know.',
  };
}

export function createAnalyticsReads(
  deps: AnalyticsReadsDeps,
): Pick<KanonDataSource, 'useAnalytics' | 'useNansenFlow'> {
  const { useQuery, useAction, report, smartMoneyFlow, session, demo } = deps;
  const { pending, signedIn, strategyId, userId } = session;

  return {
    useAnalytics() {
      const live = useQuery(
        report,
        signedIn && strategyId && userId ? { strategyId } : 'skip',
      ) as AnalyticsReport | null | undefined;
      const fallback = demo.useAnalytics();
      return useMemo<AnalyticsState>(() => {
        if (pending) return LOADING_ANALYTICS;
        if (!signedIn) return fallback;
        if (!strategyId || !userId) return EMPTY_ANALYTICS;
        if (live === undefined) return LOADING_ANALYTICS;
        if (live === null) return EMPTY_ANALYTICS;
        return { status: 'ready', report: live };
      }, [pending, signedIn, strategyId, userId, live, fallback]);
    },

    useNansenFlow(asset) {
      const run = useAction(smartMoneyFlow);
      const fallback = demo.useNansenFlow(asset);
      const [state, setState] = useState<NansenState>(LOADING_FLOW);

      useEffect(() => {
        if (pending || !signedIn) return;
        let cancelled = false;
        setState(LOADING_FLOW);
        run({ asset })
          .then((result) => {
            if (!cancelled) setState(asFlow(result));
          })
          .catch(() => {
            if (!cancelled) {
              setState({ status: 'error', kind: 'network', message: 'Could not reach the server.' });
            }
          });
        return () => {
          cancelled = true;
        };
        // `run` is a fresh function each render; the asset and the session are what change the read.
      }, [asset, pending, signedIn]);

      if (pending) return LOADING_FLOW;
      return signedIn ? state : fallback;
    },
  };
}
