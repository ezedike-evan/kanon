import { useMemo, useSyncExternalStore } from 'react';
import type { KanonDataSource } from './data';
import { SAMPLE_TIMED_STATE } from './timed-sample';
import {
  TIMED_CLOSE_UNREAD,
  TIMED_OPEN_UNREAD,
  TIMED_STATE_UNREAD,
  asTimedCloseResult,
  asTimedOpenResult,
  asTimedState,
  timedTradesFromRows,
} from './timed-trade';
import type {
  TimedCloseResult,
  TimedOpenResult,
  TimedState,
  TimedStateRead,
  TimedStateView,
  TimedTradesState,
} from './timed-types';
import { SIGN_IN_TO_TRADE, thrownMessage } from './venue-trade';
import type { VenueTradeActions, VenueTradeSession } from './venue-trade-reads';

/**
 * The live implementation of Predict's four members of the data source
 * (`useTimedState`, `openTimedTrade`, `closeTimedTrade`, `useTimedTrades`),
 * shared by both clients so web and mobile cannot drift apart.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own
 * `useQuery` and the `timedData.listMine` reference. The three calls (the
 * state, open a trade, end one early) go to the gateway's `/predict` routes and
 * are handed in already bound (`venue-trade-client.ts`).
 *
 * The state is a request, not a subscription, so it is read on purpose and
 * never per render: when the screen mounts, after every open or close, on
 * `refresh()` and every `TIMED_REFRESH_MS` while the screen is mounted. One
 * store holds the answer for everything on screen that reads it. The caller's
 * trades are a live query, so a trade the server closes arrives by itself.
 *
 * Which state a viewer sees, as for the order ticket:
 *   - auth still resolving -> `loading`, and nothing is called
 *   - signed out           -> the labelled sample (`timed-sample.ts`): pairs and
 *                             choices to look at, and nothing is called. Opening
 *                             or ending a trade answers "Sign in to trade.".
 *                             There is no demo trade: the screen is never shown
 *                             a countdown or a result that is made up.
 *   - signed in            -> the live read
 *
 * A call that throws is caught here and comes back as an `unavailable` value
 * with a line a person can read. A screen never sees a rejection from these.
 */
export interface TimedTradeReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types
  // are stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  listMine: unknown;
  actions: Pick<VenueTradeActions, 'timedState' | 'openTimed' | 'closeTimed'>;
  session: VenueTradeSession;
  /** Milliseconds between reads of the state while the screen is mounted. Defaults to `TIMED_REFRESH_MS`. */
  refreshMs?: number | undefined;
  /** The clock, for tests. */
  now?: (() => number) | undefined;
}

/** The slow read that catches what nothing else announces: a market closing, a limit changing. */
export const TIMED_REFRESH_MS = 30_000;
/** A screen that mounts again this soon after an answer shows that answer and waits for the interval. */
export const TIMED_FRESH_MS = 5_000;

export interface TimedSnapshot {
  state: TimedState;
  refreshing: boolean;
}

export interface TimedStateStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TimedSnapshot;
  getServerSnapshot(): TimedSnapshot;
  refresh(): void;
}

const LOADING_SNAPSHOT: TimedSnapshot = { state: { status: 'loading' }, refreshing: false };
const SIGNED_OUT_SNAPSHOT: TimedSnapshot = { state: SAMPLE_TIMED_STATE, refreshing: false };

/** A store that reads nothing: what the screen subscribes to while nobody is signed in. */
const idle = (snapshot: TimedSnapshot): TimedStateStore => ({
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  getServerSnapshot: () => snapshot,
  refresh: () => {},
});
const PENDING_STORE = idle(LOADING_SNAPSHOT);
const SIGNED_OUT_STORE = idle(SIGNED_OUT_SNAPSHOT);

/**
 * What can be traded as an external store: the last answer, and the reads that
 * keep it current. It behaves as the order ticket's account store does.
 *
 *   - The first subscriber starts the interval and, unless an answer is fresh
 *     or a read is already out, reads at once. The last one to leave stops the
 *     interval. With nobody subscribed nothing is read at all.
 *   - One read is out at a time. `refresh()` while one is out is not dropped:
 *     exactly one more read follows, so the state read after a trade opens is
 *     never an answer that was already on its way before it did. An interval
 *     tick while one is out is simply skipped.
 *   - The last answer stays in `state` while a read is out. Whatever the read
 *     says replaces it, an `unavailable` included.
 */
export function createTimedStateStore(opts: {
  read: () => Promise<unknown>;
  refreshMs?: number | undefined;
  freshMs?: number | undefined;
  now?: (() => number) | undefined;
}): TimedStateStore {
  const refreshMs = opts.refreshMs ?? TIMED_REFRESH_MS;
  const freshMs = opts.freshMs ?? TIMED_FRESH_MS;
  const now = opts.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot = LOADING_SNAPSHOT;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading = false;
  let again = false;
  let answeredAt: number | null = null;

  const publish = (next: TimedSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const read = (): void => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    if (!snapshot.refreshing) publish({ state: snapshot.state, refreshing: true });
    let call: Promise<unknown>;
    try {
      call = opts.read();
    } catch (err) {
      call = Promise.reject(err);
    }
    void call
      .then(asTimedState, (err): TimedStateView => ({ status: 'unavailable', message: thrownMessage(err, TIMED_STATE_UNREAD) }))
      .then((state) => {
        reading = false;
        answeredAt = now();
        const more = again;
        again = false;
        publish({ state, refreshing: more });
        if (more) read();
      });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        timer = setInterval(() => {
          if (!reading) read();
        }, refreshMs);
        if (!reading && (answeredAt === null || now() - answeredAt >= freshMs)) read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => LOADING_SNAPSHOT,
    refresh: read,
  };
}

const LOADING_TRADES: TimedTradesState = { status: 'loading' };
const NO_TRADES: TimedTradesState = { status: 'empty' };
const SIGNED_OUT_OPEN: TimedOpenResult = { status: 'unavailable', message: SIGN_IN_TO_TRADE };
const SIGNED_OUT_CLOSE: TimedCloseResult = { status: 'unavailable', message: SIGN_IN_TO_TRADE };

export function createTimedTradeReads(
  deps: TimedTradeReadsDeps,
): Pick<KanonDataSource, 'useTimedState' | 'openTimedTrade' | 'closeTimedTrade' | 'useTimedTrades'> {
  const { useQuery, listMine, actions, session } = deps;
  const { pending, signedIn } = session;
  const live = !pending && signedIn;

  // One store per session: signing out drops the last state with it.
  const store = live
    ? createTimedStateStore({ read: () => actions.timedState(), refreshMs: deps.refreshMs, now: deps.now })
    : pending
      ? PENDING_STORE
      : SIGNED_OUT_STORE;

  return {
    useTimedState(): TimedStateRead {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
      return useMemo<TimedStateRead>(
        () => ({ state: snapshot.state, refreshing: snapshot.refreshing, refresh: store.refresh }),
        // The store is this session's: a new session is a new closure, and the same first snapshot.
        [snapshot, store],
      );
    },

    async openTimedTrade(request) {
      if (!live) return SIGNED_OUT_OPEN;
      // Only the four fields the route takes: an extra one would fail its validation.
      const { asset, direction, stakeUsd, seconds } = request;
      try {
        return asTimedOpenResult(await actions.openTimed({ asset, direction, stakeUsd, seconds }));
      } catch (err) {
        return { status: 'unavailable', message: thrownMessage(err, TIMED_OPEN_UNREAD) };
      } finally {
        // Whatever the answer, a market may have been taken: read which are free again.
        store.refresh();
      }
    },

    async closeTimedTrade(tradeId) {
      if (!live) return SIGNED_OUT_CLOSE;
      try {
        return asTimedCloseResult(await actions.closeTimed({ tradeId }));
      } catch (err) {
        return { status: 'unavailable', message: thrownMessage(err, TIMED_CLOSE_UNREAD) };
      } finally {
        store.refresh();
      }
    },

    useTimedTrades(): TimedTradesState {
      const rows = useQuery(listMine, live ? {} : 'skip') as unknown;
      return useMemo<TimedTradesState>(() => {
        if (pending) return LOADING_TRADES;
        if (!signedIn) return NO_TRADES;
        if (rows === undefined) return LOADING_TRADES;
        const trades = timedTradesFromRows(Array.isArray(rows) ? rows : []);
        return trades.length === 0 ? NO_TRADES : { status: 'ready', trades };
      }, [pending, signedIn, rows]);
    },
  };
}
