import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConvexKanonSource } from './convex-source';
import { KanonDataProvider, useKanonData, type KanonDataSource } from './data';
import { createFakeConvex } from './fake-convex.test-util';
import { unavailablePinClient } from './pin';
import { createHarness, settle } from './render-harness';
import {
  ACCOUNT_UNKNOWN_SHAPE,
  ACCOUNT_UNREAD,
  ORDER_UNKNOWN_SHAPE,
  ORDER_UNREAD,
  SIGN_IN_TO_TRADE,
} from './venue-trade';
import {
  ACCOUNT_FRESH_MS,
  ACCOUNT_REFRESH_MS,
  createAccountStore,
  createVenueTradeReads,
  type AccountSnapshot,
  type VenueTradeSession,
  type VenueTradeActions,
} from './venue-trade-reads';
import { TRADE_NOT_CONNECTED } from './venue-trade-client';
import type { VenueAccountRead, VenueAccountView, VenueOrderResult, VenueOrdersState } from './venue-types';

/**
 * The order ticket's data seam: when the account is read (and when it must not
 * be), what a call that throws turns into, and which Convex functions the live
 * source is bound to.
 */

const READY: Extract<VenueAccountView, { status: 'ready' }> = {
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  wallet: '0x9fE2000000000000000000000000000000041Ab',
  accountId: 7,
  balance: { atoms: '1234560000', decimals: 6 },
  canTrade: true,
  limits: { minNotionalUsd: 10, maxNotionalUsd: 100, maxLeverage: 5, slippageBps: 100, maxPositionUsd: 300 },
  markets: [{ asset: 'BTC/USD', maxLeverage: 5, open: true }],
  positions: [],
};

const FILLED: Extract<VenueOrderResult, { status: 'filled' }> = {
  status: 'filled',
  orderId: 'o1',
  asset: 'BTC/USD',
  action: 'open',
  side: 'long',
  size: { atoms: '41000', decimals: 8 },
  price: { atoms: '612345', decimals: 1 },
  fee: { atoms: '8750', decimals: 6 },
  block: 12_345_678,
  txHash: `0x${'ab'.repeat(32)}`,
};

/** What the server throws at a caller with no valid token: a `ConvexError` carrying this. */
const SIGNED_OUT_ERROR = { data: { code: 'unauthenticated', message: 'Sign in to continue.' } };

interface Deferred {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** A call whose answers the test hands out one at a time, in the order the calls were made. */
function scripted() {
  const calls: Deferred[] = [];
  const args: unknown[] = [];
  const call = (arg?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      args.push(arg);
      calls.push({ resolve, reject });
    });
  return { calls, args, call };
}

/** Lets a settled promise's chain run. Microtasks only, so it works under fake timers too. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const last = <T,>(list: T[]): T => list[list.length - 1]!;

describe('createAccountStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads nothing until a ticket subscribes, then reads once and holds the answer', async () => {
    const account = scripted();
    const store = createAccountStore({ read: account.call });
    expect(store.getSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: false });
    expect(store.getServerSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: false });
    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 3);
    expect(account.calls).toHaveLength(0);

    const seen: AccountSnapshot[] = [];
    const stop = store.subscribe(() => seen.push(store.getSnapshot()));
    expect(account.calls).toHaveLength(1);
    expect(store.getSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: true });

    account.calls[0]!.resolve(READY);
    await flush();
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: false });
    expect(seen).toEqual([
      { state: { status: 'loading' }, refreshing: true },
      { state: READY, refreshing: false },
    ]);
    stop();
  });

  it('reads again on a slow interval while a ticket is mounted, and stops when the last one leaves', async () => {
    const account = scripted();
    const store = createAccountStore({ read: account.call });
    const stopA = store.subscribe(() => {});
    const stopB = store.subscribe(() => {});
    // Two tickets on screen are one read, not two.
    expect(account.calls).toHaveLength(1);

    // A tick that lands while a read is still out is skipped, not queued behind it.
    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    expect(account.calls).toHaveLength(1);
    account.calls[0]!.resolve(READY);
    await flush();

    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    expect(account.calls).toHaveLength(2);
    // The last answer stays on screen while the next read is out.
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: true });
    account.calls[1]!.resolve(READY);
    await flush();

    stopA();
    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS);
    expect(account.calls).toHaveLength(3);
    account.calls[2]!.resolve(READY);
    await flush();

    stopB();
    await vi.advanceTimersByTimeAsync(ACCOUNT_REFRESH_MS * 10);
    expect(account.calls).toHaveLength(3);
  });

  it('stays far inside the 600 reads an hour the server allows one user', async () => {
    let reads = 0;
    const store = createAccountStore({
      read: () => {
        reads += 1;
        return Promise.resolve(READY);
      },
    });
    const stop = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    stop();
    // One on mount, then one every `ACCOUNT_REFRESH_MS`.
    expect(reads).toBe(1 + (60 * 60 * 1000) / ACCOUNT_REFRESH_MS);
    expect(reads).toBeLessThan(600 / 4);
  });

  it('follows a refresh that lands during a read with exactly one more read', async () => {
    const account = scripted();
    const store = createAccountStore({ read: account.call });
    const stop = store.subscribe(() => {});
    store.refresh();
    store.refresh();
    store.refresh();
    expect(account.calls).toHaveLength(1);

    // The read that was already out answers with what was true before the order: one more follows it.
    account.calls[0]!.resolve({ status: 'unavailable', message: 'The venue could not be read. Try again.' });
    await flush();
    expect(account.calls).toHaveLength(2);
    expect(store.getSnapshot()).toEqual({
      state: { status: 'unavailable', message: 'The venue could not be read. Try again.' },
      refreshing: true,
    });

    account.calls[1]!.resolve(READY);
    await flush();
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: false });
    expect(account.calls).toHaveLength(2);
    stop();
  });

  it('does not read again for a ticket that mounts straight after an answer, and does once it is stale', async () => {
    let clock = 1_000_000;
    const account = scripted();
    const store = createAccountStore({ read: account.call, now: () => clock });
    store.subscribe(() => {})();
    account.calls[0]!.resolve(READY);
    await flush();

    clock += ACCOUNT_FRESH_MS - 1;
    store.subscribe(() => {})();
    expect(account.calls).toHaveLength(1);

    clock += 1;
    const stop = store.subscribe(() => {});
    expect(account.calls).toHaveLength(2);
    stop();
  });

  it('does not start a second read for a ticket that subscribes twice in a row, as a strict render does', () => {
    const account = scripted();
    const store = createAccountStore({ read: account.call });
    store.subscribe(() => {})();
    const stop = store.subscribe(() => {});
    expect(account.calls).toHaveLength(1);
    stop();
  });

  it('turns a read that throws into an unavailable account with a line a person can read', async () => {
    const account = scripted();
    const store = createAccountStore({ read: account.call });
    const stop = store.subscribe(() => {});

    account.calls[0]!.reject(SIGNED_OUT_ERROR);
    await flush();
    expect(store.getSnapshot()).toEqual({
      state: { status: 'unavailable', message: 'Sign in to continue.' },
      refreshing: false,
    });

    store.refresh();
    account.calls[1]!.reject(new Error('[CONVEX A(venue:account)] [Request ID: 1] Server Error'));
    await flush();
    expect(store.getSnapshot().state).toEqual({ status: 'unavailable', message: ACCOUNT_UNREAD });

    store.refresh();
    account.calls[2]!.resolve({ outcomes: {} });
    await flush();
    expect(store.getSnapshot().state).toEqual({ status: 'unavailable', message: ACCOUNT_UNKNOWN_SHAPE });
    stop();
  });

  it('survives a read that throws before it returns a promise', async () => {
    const store = createAccountStore({
      read: () => {
        throw new Error('no client');
      },
    });
    const stop = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toEqual({ state: { status: 'unavailable', message: ACCOUNT_UNREAD }, refreshing: false });
    stop();
  });
});

const REF_ORDERS = { __name: 'venueData.listMyOrders' };

/** The reads under a session, with every action scripted and every query call recorded. */
function setup(session: VenueTradeSession, rows?: unknown) {
  const account = scripted();
  const place = scripted();
  const close = scripted();
  const queries: unknown[][] = [];
  const reads = createVenueTradeReads({
    useQuery: (ref, args) => {
      queries.push([ref, args]);
      return args === 'skip' ? undefined : rows;
    },
    listMyOrders: REF_ORDERS,
    actions: { account: () => account.call(), placeOrder: place.call, closePosition: close.call },
    session,
  });
  return { reads, account, place, close, queries };
}

/** Mounts `count` tickets that read the account and the order list the way a screen does. */
async function mount(reads: ReturnType<typeof setup>['reads'], count = 1) {
  const h = createHarness();
  const seen: { account: VenueAccountRead[]; orders: VenueOrdersState[] } = { account: [], orders: [] };
  function Ticket(): null {
    seen.account.push(reads.useVenueAccount());
    seen.orders.push(reads.useVenueOrders());
    return null;
  }
  const tickets: ReactElement[] = [];
  for (let i = 0; i < count; i += 1) tickets.push(createElement(Ticket, { key: i }));
  await h.render(createElement('section', null, ...tickets));
  return { h, seen };
}

const ORDER = { asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 } as const;

describe('createVenueTradeReads', () => {
  it('while auth is unresolved: loading, and nothing is called', async () => {
    const t = setup({ pending: true, signedIn: false });
    const { h, seen } = await mount(t.reads);
    expect(last(seen.account).state).toEqual({ status: 'loading' });
    expect(last(seen.orders)).toEqual({ status: 'loading' });
    last(seen.account).refresh();
    expect(await t.reads.placeVenueOrder(ORDER)).toEqual({ status: 'unavailable', message: SIGN_IN_TO_TRADE });
    await settle();
    expect(t.account.calls).toHaveLength(0);
    expect(t.place.calls).toHaveLength(0);
    expect(t.queries.every(([, args]) => args === 'skip')).toBe(true);
    await h.unmount();
  });

  it('signed out: "Sign in to trade.", no account, no orders, and nothing is called', async () => {
    const t = setup({ pending: false, signedIn: false });
    const { h, seen } = await mount(t.reads);
    expect(last(seen.account)).toMatchObject({
      state: { status: 'unavailable', message: 'Sign in to trade.' },
      refreshing: false,
    });
    expect(last(seen.orders)).toEqual({ status: 'empty' });
    last(seen.account).refresh();
    expect(await t.reads.placeVenueOrder(ORDER)).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    expect(await t.reads.closeVenuePosition('BTC/USD')).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    await settle();
    expect(t.account.calls).toHaveLength(0);
    expect(t.place.calls).toHaveLength(0);
    expect(t.close.calls).toHaveLength(0);
    expect(t.queries.every(([, args]) => args === 'skip')).toBe(true);
    await h.unmount();
  });

  it('signed in: reads the account once for however many tickets are mounted, and not again per render', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h, seen } = await mount(t.reads, 2);
    expect(t.account.calls).toHaveLength(1);
    expect(last(seen.account)).toMatchObject({ state: { status: 'loading' }, refreshing: true });

    t.account.calls[0]!.resolve(READY);
    await settle();
    expect(last(seen.account)).toMatchObject({ state: READY, refreshing: false });
    expect(seen.account.length).toBeGreaterThan(2);
    expect(t.account.calls).toHaveLength(1);
    expect(t.queries).toContainEqual([REF_ORDERS, {}]);
    await h.unmount();
  });

  it('places an order with the four fields the action takes, then reads the account again', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h, seen } = await mount(t.reads);
    t.account.calls[0]!.resolve(READY);
    await settle();

    const placing = t.reads.placeVenueOrder({ ...ORDER, note: 'ignored' } as never);
    expect(t.place.args).toEqual([{ asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 }]);
    // Not before the order answers: a read made now could still say there is no position.
    await settle();
    expect(t.account.calls).toHaveLength(1);

    t.place.calls[0]!.resolve(FILLED);
    expect(await placing).toBe(FILLED);
    expect(t.account.calls).toHaveLength(2);
    await settle();
    expect(last(seen.account)).toMatchObject({ state: READY, refreshing: true });

    const held = {
      ...READY,
      positions: [
        {
          asset: 'BTC/USD',
          side: 'long',
          size: FILLED.size,
          entryPrice: FILLED.price,
          leverage: 2,
          collateral: { atoms: '12500000', decimals: 6 },
          notional: { atoms: '2510', decimals: 2 },
          openedAt: null,
        },
      ],
    };
    t.account.calls[1]!.resolve(held);
    await settle();
    expect(last(seen.account)).toMatchObject({ state: held, refreshing: false });
    await h.unmount();
  });

  it('closes a position by asset, and reads the account again after a refusal too', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h } = await mount(t.reads);
    t.account.calls[0]!.resolve(READY);
    await settle();

    const closing = t.reads.closeVenuePosition('BTC/USD');
    expect(t.close.args).toEqual([{ asset: 'BTC/USD' }]);
    t.close.calls[0]!.resolve({ status: 'refused', reason: 'The account holds no BTC position.' });
    expect(await closing).toEqual({ status: 'refused', reason: 'The account holds no BTC position.' });
    expect(t.account.calls).toHaveLength(2);
    t.account.calls[1]!.resolve(READY);
    await settle();
    await h.unmount();
  });

  it('never rejects: an order that throws comes back as a value, and the account is still read again', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h } = await mount(t.reads);
    t.account.calls[0]!.resolve(READY);
    await settle();

    const lapsed = t.reads.placeVenueOrder(ORDER);
    t.place.calls[0]!.reject(SIGNED_OUT_ERROR);
    expect(await lapsed).toEqual({ status: 'unavailable', message: 'Sign in to continue.' });
    expect(t.account.calls).toHaveLength(2);
    t.account.calls[1]!.resolve(READY);
    await settle();

    // A dropped connection may or may not have reached the venue, so the line claims neither.
    const dropped = t.reads.closeVenuePosition('BTC/USD');
    t.close.calls[0]!.reject(new Error('[CONVEX A(venue:closePosition)] Connection lost while action was in flight'));
    expect(await dropped).toEqual({ status: 'unavailable', message: ORDER_UNREAD });
    expect(ORDER_UNREAD).not.toMatch(/nothing was sent/i);
    expect(t.account.calls).toHaveLength(3);
    t.account.calls[2]!.resolve(READY);
    await settle();

    const odd = t.reads.placeVenueOrder(ORDER);
    t.place.calls[1]!.resolve({ outcomes: {} });
    expect(await odd).toEqual({ status: 'unavailable', message: ORDER_UNKNOWN_SHAPE });
    t.account.calls[3]!.resolve(READY);
    await settle();
    await h.unmount();
  });

  it("lists the caller's orders: loading until the query answers, empty with none, absent fields null", async () => {
    const waiting = setup({ pending: false, signedIn: true }, undefined);
    const a = await mount(waiting.reads);
    expect(last(a.seen.orders)).toEqual({ status: 'loading' });
    await a.h.unmount();

    const none = setup({ pending: false, signedIn: true }, []);
    const b = await mount(none.reads);
    expect(last(b.seen.orders)).toEqual({ status: 'empty' });
    await b.h.unmount();

    const row = { _id: 'o1', _creationTime: 1, venue: 'perpl', network: 'testnet', asset: 'BTC/USD', action: 'close', status: 'refused', createdAt: 5, reason: 'The account holds no BTC position.' };
    const some = setup({ pending: false, signedIn: true }, [row]);
    const c = await mount(some.reads);
    const orders = last(c.seen.orders);
    expect(orders.status).toBe('ready');
    if (orders.status !== 'ready') return;
    expect(orders.orders).toEqual([
      {
        id: 'o1',
        network: 'testnet',
        asset: 'BTC/USD',
        action: 'close',
        side: null,
        status: 'refused',
        createdAt: 5,
        settledAt: null,
        notionalUsd: null,
        leverage: null,
        requestId: null,
        size: null,
        fillPrice: null,
        fee: null,
        block: null,
        txHash: null,
        reason: 'The account holds no BTC position.',
      },
    ]);
    await c.h.unmount();
  });
});

describe('useConvexKanonSource and the order ticket', () => {
  const pinClient = unavailablePinClient({ registryAddress: undefined, hasWallet: false });

  /** `gateway` false is a build with no gateway address: no trade calls are handed to the source. */
  function app(signedIn: boolean, gateway = true) {
    const fake = createFakeConvex();
    const h = createHarness();
    const seen: VenueAccountRead[] = [];
    let source: KanonDataSource | undefined;
    // The gateway's three calls, counted. Each answers in a shape that is no account and no order.
    const tradeCalls: Record<string, number> = {};
    const count = (name: string) => async (): Promise<unknown> => {
      tradeCalls[name] = (tradeCalls[name] ?? 0) + 1;
      return {};
    };
    const venueTrade: VenueTradeActions = {
      account: count('account'),
      placeOrder: count('placeOrder'),
      closePosition: count('closePosition'),
      // Predict's calls ride on the same object. A ticket makes none of them.
      timedState: count('timedState'),
      openTimed: count('openTimed'),
      closeTimed: count('closeTimed'),
    };

    function Ticket(): null {
      const data = useKanonData();
      source = data;
      seen.push(data.useVenueAccount());
      data.useVenueOrders();
      return null;
    }
    function Bridge({ ticket }: { ticket: boolean }): ReactElement {
      const live = useConvexKanonSource({
        hooks: fake.hooks,
        api: fake.api,
        session: { pending: false, signedIn },
        pinClient,
        hasWallet: false,
        ...(gateway ? { venueTrade } : {}),
      });
      return createElement(KanonDataProvider, { source: live, children: ticket ? createElement(Ticket) : null });
    }
    return {
      fake,
      h,
      seen,
      tradeCalls,
      source: (): KanonDataSource => {
        if (!source) throw new Error('no ticket mounted');
        return source;
      },
      render: (ticket: boolean) => h.render(createElement(Bridge, { ticket })),
    };
  }

  it('reads the account for a mounted ticket only: the root, and every other screen, calls nothing', async () => {
    const a = app(true);
    await a.render(false);
    expect(a.tradeCalls).toEqual({});
    expect(a.fake.subscribedQueries()).not.toContain('venueData.listMyOrders');

    await a.render(true);
    expect(a.tradeCalls).toEqual({ account: 1 });
    expect(a.fake.subscribedQueries()).toContain('venueData.listMyOrders');
    // The fake answers in a shape that is no account: the ticket says so and offers nothing.
    expect(last(a.seen)).toMatchObject({ state: { status: 'unavailable', message: ACCOUNT_UNKNOWN_SHAPE }, refreshing: false });
    // Orders leave from the gateway. No Convex action is called for the ticket.
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });

  it("is bound to the gateway's order and close calls, each followed by one read of the account", async () => {
    const a = app(true);
    await a.render(true);
    expect(a.tradeCalls).toEqual({ account: 1 });

    expect(await a.source().placeVenueOrder({ asset: 'BTC/USD', side: 'short', usd: 10, leverage: 1 })).toEqual({
      status: 'unavailable',
      message: ORDER_UNKNOWN_SHAPE,
    });
    await settle();
    expect(a.tradeCalls).toEqual({ account: 2, placeOrder: 1 });

    await a.source().closeVenuePosition('BTC/USD');
    await settle();
    expect(a.tradeCalls).toEqual({ account: 3, placeOrder: 1, closePosition: 1 });
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });

  it('signed out: the ticket says to sign in, and no venue function is called or subscribed', async () => {
    const a = app(false);
    await a.render(true);
    expect(last(a.seen).state).toEqual({ status: 'unavailable', message: SIGN_IN_TO_TRADE });
    expect(await a.source().placeVenueOrder({ asset: 'BTC/USD', side: 'long', usd: 10, leverage: 1 })).toEqual({
      status: 'unavailable',
      message: SIGN_IN_TO_TRADE,
    });
    await settle();
    expect(a.tradeCalls).toEqual({});
    expect(a.fake.actionCalls).toEqual({});
    expect(a.fake.subscribedQueries()).not.toContain('venueData.listMyOrders');
    await a.h.unmount();
  });

  it('with no gateway address: the ticket says trading is not connected, and sends nothing anywhere', async () => {
    const a = app(true, false);
    await a.render(true);
    expect(last(a.seen).state).toEqual({ status: 'unavailable', message: TRADE_NOT_CONNECTED });
    expect(await a.source().placeVenueOrder({ asset: 'BTC/USD', side: 'long', usd: 10, leverage: 1 })).toEqual({
      status: 'unavailable',
      message: TRADE_NOT_CONNECTED,
    });
    await settle();
    expect(a.tradeCalls).toEqual({});
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });
});
