import { useMemo, useSyncExternalStore } from 'react';
import type { KanonDataSource } from './data';
import {
  ACCOUNT_UNREAD,
  ORDER_UNREAD,
  SIGN_IN_TO_TRADE,
  asAccount,
  asOrderResult,
  ordersFromRows,
  thrownMessage,
} from './venue-trade';
import type { TimedRequest } from './timed-types';
import type {
  VenueAccountRead,
  VenueAccountState,
  VenueAccountView,
  VenueOrderRequest,
  VenueOrderResult,
  VenueOrdersState,
} from './venue-types';

/**
 * The live implementation of the order ticket's four members of the data source
 * (`useVenueAccount`, `placeVenueOrder`, `closeVenuePosition`, `useVenueOrders`),
 * shared by both clients so web and mobile cannot drift apart.
 *
 * `packages/ui` has no dependency on Convex, so the app hands in its own
 * `useQuery` and the `venueData.listMyOrders` reference. The three calls
 * (account, place an order, close a position) go to the gateway's `/trade`
 * routes and are handed in already bound (`venue-trade-client.ts`).
 *
 * The account is a request, not a subscription, so it is read on purpose and
 * never per render: when the first ticket mounts, after every order, on
 * `refresh()` and every `ACCOUNT_REFRESH_MS` while a ticket is mounted. One
 * store holds the answer for every ticket on screen, so two of them (the
 * desktop panel and the phone bar are one tree) cost one read, not two.
 *
 * Which state a viewer sees, as for every other read:
 *   - auth still resolving -> `loading`, and nothing is called
 *   - signed out           -> `unavailable` with "Sign in to trade.", and nothing
 *                             is called. There is no demo account: a ticket is
 *                             never shown a balance or a fill that is made up.
 *   - signed in            -> the live read
 *
 * A call that throws (a token that lapsed, a dropped connection) is caught here
 * and comes back as an `unavailable` value with a line a person can read. A
 * screen never sees a rejection from any of these.
 */
export interface VenueTradeSession {
  /** Privy has not yet said whether anyone is signed in. */
  pending: boolean;
  signedIn: boolean;
}

/**
 * The calls to the gateway, bound by the app. Loosely typed on purpose: the
 * answers are read by shape. The first three are the order ticket's (`/trade`);
 * the last three are Predict's timed trades (`/predict`), read in
 * `timed-trade-reads.ts`. One object carries both because both go to the same
 * address with the same sign-in token.
 */
export interface VenueTradeActions {
  account(): Promise<unknown>;
  placeOrder(args: VenueOrderRequest): Promise<unknown>;
  closePosition(args: { asset: string }): Promise<unknown>;
  /** What can be traded on a timer, and whether each market is free. */
  timedState(): Promise<unknown>;
  openTimed(args: TimedRequest): Promise<unknown>;
  /** Ends the caller's own running trade before its time. */
  closeTimed(args: { tradeId: string }): Promise<unknown>;
  /**
   * One of the gateway's public market-data paths, as parsed JSON. No sign-in
   * token is sent, since the gateway serves these to anyone. Rejects when it
   * cannot be read. Absent when no gateway is connected.
   */
  publicGet?(path: string): Promise<unknown>;
}

export interface VenueTradeReadsDeps {
  // Convex's `useQuery`, typed loosely on purpose: the generated `api` types
  // are stale until codegen runs, and this package must not import Convex.
  useQuery: (ref: any, args: any) => unknown;
  listMyOrders: unknown;
  /** The order ticket's three calls. Predict's are no concern of these reads. */
  actions: Pick<VenueTradeActions, 'account' | 'placeOrder' | 'closePosition'>;
  session: VenueTradeSession;
  /** Milliseconds between reads of the account while a ticket is mounted. Defaults to `ACCOUNT_REFRESH_MS`. */
  refreshMs?: number | undefined;
  /** The clock, for tests. */
  now?: (() => number) | undefined;
}

/** The server allows a user 600 account reads an hour. A mounted ticket makes 120. */
export const ACCOUNT_REFRESH_MS = 30_000;
/** A ticket that mounts again this soon after an answer shows that answer and waits for the interval. */
export const ACCOUNT_FRESH_MS = 5_000;

export interface AccountSnapshot {
  state: VenueAccountState;
  refreshing: boolean;
}

export interface AccountStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AccountSnapshot;
  getServerSnapshot(): AccountSnapshot;
  refresh(): void;
}

const LOADING_SNAPSHOT: AccountSnapshot = { state: { status: 'loading' }, refreshing: false };
const SIGNED_OUT_SNAPSHOT: AccountSnapshot = {
  state: { status: 'unavailable', message: SIGN_IN_TO_TRADE },
  refreshing: false,
};

/** A store that reads nothing: what a ticket subscribes to while nobody is signed in. */
const idle = (snapshot: AccountSnapshot): AccountStore => ({
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  getServerSnapshot: () => snapshot,
  refresh: () => {},
});
const PENDING_STORE = idle(LOADING_SNAPSHOT);
const SIGNED_OUT_STORE = idle(SIGNED_OUT_SNAPSHOT);

/**
 * The trading account as an external store: the last answer, and the reads
 * that keep it current.
 *
 *   - The first subscriber starts the interval and, unless an answer is fresh
 *     or a read is already out, reads at once. The last one to leave stops the
 *     interval. With nobody subscribed nothing is read at all.
 *   - One read is out at a time. `refresh()` while one is out is not dropped:
 *     exactly one more read follows, so the account read after an order is
 *     never an answer that was already on its way before the order settled.
 *     An interval tick while one is out is simply skipped.
 *   - The last answer stays in `state` while a read is out. Whatever the read
 *     says replaces it, an `unavailable` included: the ticket shows what the
 *     server last said, not what it said before.
 */
export function createAccountStore(opts: {
  read: () => Promise<unknown>;
  refreshMs?: number | undefined;
  freshMs?: number | undefined;
  now?: (() => number) | undefined;
}): AccountStore {
  const refreshMs = opts.refreshMs ?? ACCOUNT_REFRESH_MS;
  const freshMs = opts.freshMs ?? ACCOUNT_FRESH_MS;
  const now = opts.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot = LOADING_SNAPSHOT;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading = false;
  let again = false;
  let answeredAt: number | null = null;

  const publish = (next: AccountSnapshot): void => {
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
      .then(asAccount, (err): VenueAccountView => ({ status: 'unavailable', message: thrownMessage(err, ACCOUNT_UNREAD) }))
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

const LOADING_ORDERS: VenueOrdersState = { status: 'loading' };
const NO_ORDERS: VenueOrdersState = { status: 'empty' };
const SIGNED_OUT_RESULT: VenueOrderResult = { status: 'unavailable', message: SIGN_IN_TO_TRADE };

export function createVenueTradeReads(
  deps: VenueTradeReadsDeps,
): Pick<KanonDataSource, 'useVenueAccount' | 'placeVenueOrder' | 'closeVenuePosition' | 'useVenueOrders'> {
  const { useQuery, listMyOrders, actions, session } = deps;
  const { pending, signedIn } = session;
  const live = !pending && signedIn;

  // One store per session: signing out drops the last account with it.
  const store = live
    ? createAccountStore({ read: () => actions.account(), refreshMs: deps.refreshMs, now: deps.now })
    : pending
      ? PENDING_STORE
      : SIGNED_OUT_STORE;

  /** Sends one order and reads the account again once it has answered, whatever the answer. */
  async function send(call: () => Promise<unknown>): Promise<VenueOrderResult> {
    if (!live) return SIGNED_OUT_RESULT;
    try {
      return asOrderResult(await call());
    } catch (err) {
      return { status: 'unavailable', message: thrownMessage(err, ORDER_UNREAD) };
    } finally {
      store.refresh();
    }
  }

  return {
    useVenueAccount(): VenueAccountRead {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
      return useMemo<VenueAccountRead>(
        () => ({ state: snapshot.state, refreshing: snapshot.refreshing, refresh: store.refresh }),
        // The store is this session's: a new session is a new closure, and the same first snapshot.
        [snapshot, store],
      );
    },

    placeVenueOrder(request) {
      // Only the four fields the action takes: an extra one would fail its argument validation.
      const { asset, side, usd, leverage } = request;
      return send(() => actions.placeOrder({ asset, side, usd, leverage }));
    },

    closeVenuePosition(asset) {
      return send(() => actions.closePosition({ asset }));
    },

    useVenueOrders(): VenueOrdersState {
      const rows = useQuery(listMyOrders, live ? {} : 'skip') as unknown;
      return useMemo<VenueOrdersState>(() => {
        if (pending) return LOADING_ORDERS;
        if (!signedIn) return NO_ORDERS;
        if (rows === undefined) return LOADING_ORDERS;
        const orders = ordersFromRows(Array.isArray(rows) ? rows : []);
        return orders.length === 0 ? NO_ORDERS : { status: 'ready', orders };
      }, [pending, signedIn, rows]);
    },
  };
}
