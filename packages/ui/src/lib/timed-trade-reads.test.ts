import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConvexKanonSource } from './convex-source';
import { KanonDataProvider, demoDataSource, useKanonData, type KanonDataSource } from './data';
import { createFakeConvex } from './fake-convex.test-util';
import { unavailablePinClient } from './pin';
import { createHarness, settle } from './render-harness';
import {
  TIMED_CLOSE_UNKNOWN_SHAPE,
  TIMED_CLOSE_UNREAD,
  TIMED_OPEN_UNKNOWN_SHAPE,
  TIMED_OPEN_UNREAD,
  TIMED_STATE_UNKNOWN_SHAPE,
  TIMED_STATE_UNREAD,
} from './timed-trade';
import {
  TIMED_FRESH_MS,
  TIMED_REFRESH_MS,
  createTimedStateStore,
  createTimedTradeReads,
  type TimedSnapshot,
} from './timed-trade-reads';
import { SAMPLE_TIMED_STATE } from './timed-sample';
import type { TimedStateRead, TimedStateView, TimedTradeView, TimedTradesState } from './timed-types';
import { SIGN_IN_TO_TRADE } from './venue-trade';
import { TRADE_NOT_CONNECTED } from './venue-trade-client';
import type { VenueTradeActions, VenueTradeSession } from './venue-trade-reads';

/**
 * Predict's data seam: when the state is read (and when it must not be), what a
 * call that throws turns into, and which calls and which Convex function the
 * live source is bound to.
 */

const READY: Extract<TimedStateView, { status: 'ready' }> = {
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
  markets: [{ asset: 'BTC/USD', open: true, leverage: 5, busy: null }],
};

const TRADE: TimedTradeView = {
  id: 't1',
  asset: 'BTC/USD',
  direction: 'up',
  stakeUsd: 25,
  leverage: 5,
  seconds: 60,
  openedAt: 1_000,
  expiresAt: 61_000,
  size: { atoms: '204000', decimals: 8 },
  entryPrice: { atoms: '612345', decimals: 1 },
};

/** What the server throws at a caller with no valid token: an error carrying this. */
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

describe('createTimedStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads nothing until the screen subscribes, then reads once and holds the answer', async () => {
    const state = scripted();
    const store = createTimedStateStore({ read: state.call });
    expect(store.getSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: false });
    expect(store.getServerSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: false });
    await vi.advanceTimersByTimeAsync(TIMED_REFRESH_MS * 3);
    expect(state.calls).toHaveLength(0);

    const seen: TimedSnapshot[] = [];
    const stop = store.subscribe(() => seen.push(store.getSnapshot()));
    expect(state.calls).toHaveLength(1);
    expect(store.getSnapshot()).toEqual({ state: { status: 'loading' }, refreshing: true });

    state.calls[0]!.resolve(READY);
    await flush();
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: false });
    expect(seen).toEqual([
      { state: { status: 'loading' }, refreshing: true },
      { state: READY, refreshing: false },
    ]);
    stop();
  });

  it('reads again on a slow interval while mounted, and stops when the last subscriber leaves', async () => {
    const state = scripted();
    const store = createTimedStateStore({ read: state.call });
    const stopA = store.subscribe(() => {});
    const stopB = store.subscribe(() => {});
    // Two readers on screen are one read, not two.
    expect(state.calls).toHaveLength(1);

    // A tick that lands while a read is still out is skipped, not queued behind it.
    await vi.advanceTimersByTimeAsync(TIMED_REFRESH_MS);
    expect(state.calls).toHaveLength(1);
    state.calls[0]!.resolve(READY);
    await flush();

    await vi.advanceTimersByTimeAsync(TIMED_REFRESH_MS);
    expect(state.calls).toHaveLength(2);
    // The last answer stays on screen while the next read is out.
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: true });
    state.calls[1]!.resolve(READY);
    await flush();

    stopA();
    await vi.advanceTimersByTimeAsync(TIMED_REFRESH_MS);
    expect(state.calls).toHaveLength(3);
    state.calls[2]!.resolve(READY);
    await flush();

    stopB();
    await vi.advanceTimersByTimeAsync(TIMED_REFRESH_MS * 10);
    expect(state.calls).toHaveLength(3);
  });

  it('makes one read on mount and one per interval, never one per render', async () => {
    let reads = 0;
    const store = createTimedStateStore({
      read: () => {
        reads += 1;
        return Promise.resolve(READY);
      },
    });
    const stop = store.subscribe(() => {});
    for (let i = 0; i < 50; i += 1) store.getSnapshot();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    stop();
    expect(reads).toBe(1 + (60 * 60 * 1000) / TIMED_REFRESH_MS);
  });

  it('follows a refresh that lands during a read with exactly one more read', async () => {
    const state = scripted();
    const store = createTimedStateStore({ read: state.call });
    const stop = store.subscribe(() => {});
    store.refresh();
    store.refresh();
    store.refresh();
    expect(state.calls).toHaveLength(1);

    // The read that was already out answers with what was true before the trade opened: one more follows it.
    state.calls[0]!.resolve(READY);
    await flush();
    expect(state.calls).toHaveLength(2);
    expect(store.getSnapshot()).toEqual({ state: READY, refreshing: true });

    const taken = { ...READY, markets: [{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: 61_000 } }] };
    state.calls[1]!.resolve(taken);
    await flush();
    expect(store.getSnapshot()).toEqual({ state: taken, refreshing: false });
    expect(state.calls).toHaveLength(2);
    stop();
  });

  it('does not read again for a screen that mounts straight after an answer, and does once it is stale', async () => {
    let clock = 1_000_000;
    const state = scripted();
    const store = createTimedStateStore({ read: state.call, now: () => clock });
    store.subscribe(() => {})();
    state.calls[0]!.resolve(READY);
    await flush();

    clock += TIMED_FRESH_MS - 1;
    store.subscribe(() => {})();
    expect(state.calls).toHaveLength(1);

    clock += 1;
    const stop = store.subscribe(() => {});
    expect(state.calls).toHaveLength(2);
    stop();
  });

  it('turns a read that throws, or an answer it cannot read, into an unavailable state with a line a person can read', async () => {
    const state = scripted();
    const store = createTimedStateStore({ read: state.call });
    const stop = store.subscribe(() => {});

    state.calls[0]!.reject(SIGNED_OUT_ERROR);
    await flush();
    expect(store.getSnapshot()).toEqual({
      state: { status: 'unavailable', message: 'Sign in to continue.' },
      refreshing: false,
    });

    store.refresh();
    state.calls[1]!.reject(new Error('socket hang up'));
    await flush();
    expect(store.getSnapshot().state).toEqual({ status: 'unavailable', message: TIMED_STATE_UNREAD });

    store.refresh();
    state.calls[2]!.resolve({ outcomes: {} });
    await flush();
    expect(store.getSnapshot().state).toEqual({ status: 'unavailable', message: TIMED_STATE_UNKNOWN_SHAPE });
    stop();
  });

  it('never takes a sample from the server: the flag is not a field a read can set', async () => {
    const state = scripted();
    const store = createTimedStateStore({ read: state.call });
    const stop = store.subscribe(() => {});
    state.calls[0]!.resolve({ ...READY, sample: true });
    await flush();
    expect(store.getSnapshot().state).toEqual(READY);
    expect(store.getSnapshot().state).not.toHaveProperty('sample');
    stop();
  });

  it('survives a read that throws before it returns a promise', async () => {
    const store = createTimedStateStore({
      read: () => {
        throw new Error('no client');
      },
    });
    const stop = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toEqual({ state: { status: 'unavailable', message: TIMED_STATE_UNREAD }, refreshing: false });
    stop();
  });
});

const REF_TRADES = { __name: 'timedData.listMine' };

/** The reads under a session, with every call scripted and every query call recorded. */
function setup(session: VenueTradeSession, rows?: unknown) {
  const state = scripted();
  const open = scripted();
  const close = scripted();
  const queries: unknown[][] = [];
  const reads = createTimedTradeReads({
    useQuery: (ref, args) => {
      queries.push([ref, args]);
      return args === 'skip' ? undefined : rows;
    },
    listMine: REF_TRADES,
    actions: { timedState: () => state.call(), openTimed: open.call, closeTimed: close.call },
    session,
  });
  return { reads, state, open, close, queries };
}

/** Mounts `count` readers of the state and the trade list, the way the screen reads them. */
async function mount(reads: ReturnType<typeof setup>['reads'], count = 1) {
  const h = createHarness();
  const seen: { state: TimedStateRead[]; trades: TimedTradesState[] } = { state: [], trades: [] };
  function Predict(): null {
    seen.state.push(reads.useTimedState());
    seen.trades.push(reads.useTimedTrades());
    return null;
  }
  const screens: ReactElement[] = [];
  for (let i = 0; i < count; i += 1) screens.push(createElement(Predict, { key: i }));
  await h.render(createElement('section', null, ...screens));
  return { h, seen };
}

const REQUEST = { asset: 'BTC/USD', direction: 'up', stakeUsd: 25, seconds: 60 } as const;

describe('createTimedTradeReads', () => {
  it('while auth is unresolved: loading, and nothing is called', async () => {
    const t = setup({ pending: true, signedIn: false });
    const { h, seen } = await mount(t.reads);
    expect(last(seen.state).state).toEqual({ status: 'loading' });
    expect(last(seen.trades)).toEqual({ status: 'loading' });
    last(seen.state).refresh();
    expect(await t.reads.openTimedTrade(REQUEST)).toEqual({ status: 'unavailable', message: SIGN_IN_TO_TRADE });
    await settle();
    expect(t.state.calls).toHaveLength(0);
    expect(t.open.calls).toHaveLength(0);
    expect(t.queries.every(([, args]) => args === 'skip')).toBe(true);
    await h.unmount();
  });

  it('signed out: the labelled sample, no trades, and nothing is called', async () => {
    const t = setup({ pending: false, signedIn: false });
    const { h, seen } = await mount(t.reads);
    expect(last(seen.state)).toMatchObject({ state: SAMPLE_TIMED_STATE, refreshing: false });
    expect(last(seen.state).state).toMatchObject({ status: 'ready', sample: true });
    expect(last(seen.trades)).toEqual({ status: 'empty' });
    last(seen.state).refresh();
    expect(await t.reads.openTimedTrade(REQUEST)).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    expect(await t.reads.closeTimedTrade('t1')).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    await settle();
    expect(t.state.calls).toHaveLength(0);
    expect(t.open.calls).toHaveLength(0);
    expect(t.close.calls).toHaveLength(0);
    expect(t.queries.every(([, args]) => args === 'skip')).toBe(true);
    await h.unmount();
  });

  it('signed in: reads the state once for however many readers are mounted, and not again per render', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h, seen } = await mount(t.reads, 2);
    expect(t.state.calls).toHaveLength(1);
    expect(last(seen.state)).toMatchObject({ state: { status: 'loading' }, refreshing: true });

    t.state.calls[0]!.resolve(READY);
    await settle();
    expect(last(seen.state)).toMatchObject({ state: READY, refreshing: false });
    expect(seen.state.length).toBeGreaterThan(2);
    expect(t.state.calls).toHaveLength(1);
    expect(t.queries).toContainEqual([REF_TRADES, {}]);
    await h.unmount();
  });

  it('opens a trade with the four fields the route takes, then reads the state again', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h, seen } = await mount(t.reads);
    t.state.calls[0]!.resolve(READY);
    await settle();

    const opening = t.reads.openTimedTrade({ ...REQUEST, note: 'ignored' } as never);
    expect(t.open.args).toEqual([{ asset: 'BTC/USD', direction: 'up', stakeUsd: 25, seconds: 60 }]);
    // Not before the open answers: a read made now could still say the market is free.
    await settle();
    expect(t.state.calls).toHaveLength(1);

    t.open.calls[0]!.resolve({ status: 'opened', trade: TRADE });
    expect(await opening).toEqual({ status: 'opened', trade: TRADE });
    expect(t.state.calls).toHaveLength(2);
    await settle();
    expect(last(seen.state)).toMatchObject({ state: READY, refreshing: true });

    const taken = { ...READY, markets: [{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: 61_000 } }] };
    t.state.calls[1]!.resolve(taken);
    await settle();
    expect(last(seen.state)).toMatchObject({ state: taken, refreshing: false });
    await h.unmount();
  });

  it('ends a trade by its id, and reads the state again after a refusal too', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h } = await mount(t.reads);
    t.state.calls[0]!.resolve(READY);
    await settle();

    const ending = t.reads.closeTimedTrade('t1');
    expect(t.close.args).toEqual([{ tradeId: 't1' }]);
    t.close.calls[0]!.resolve({ status: 'refused', reason: 'That trade is not yours to end.' });
    expect(await ending).toEqual({ status: 'refused', reason: 'That trade is not yours to end.' });
    expect(t.state.calls).toHaveLength(2);
    t.state.calls[1]!.resolve(READY);
    await settle();

    const taken = t.reads.closeTimedTrade('t1');
    t.close.calls[1]!.resolve({ status: 'closing', tradeId: 't1' });
    expect(await taken).toEqual({ status: 'closing', tradeId: 't1' });
    t.state.calls[2]!.resolve(READY);
    await settle();
    await h.unmount();
  });

  it('never rejects: a call that throws comes back as a value, and the state is still read again', async () => {
    const t = setup({ pending: false, signedIn: true }, []);
    const { h } = await mount(t.reads);
    t.state.calls[0]!.resolve(READY);
    await settle();

    const lapsed = t.reads.openTimedTrade(REQUEST);
    t.open.calls[0]!.reject(SIGNED_OUT_ERROR);
    expect(await lapsed).toEqual({ status: 'unavailable', message: 'Sign in to continue.' });
    expect(t.state.calls).toHaveLength(2);
    t.state.calls[1]!.resolve(READY);
    await settle();

    // A dropped connection may or may not have reached the venue, so the line claims neither.
    const dropped = t.reads.openTimedTrade(REQUEST);
    t.open.calls[1]!.reject(new Error('the gateway answered 502'));
    expect(await dropped).toEqual({ status: 'unavailable', message: TIMED_OPEN_UNREAD });
    expect(TIMED_OPEN_UNREAD).not.toMatch(/nothing was (sent|opened)/i);
    t.state.calls[2]!.resolve(READY);
    await settle();

    const odd = t.reads.openTimedTrade(REQUEST);
    t.open.calls[2]!.resolve({ outcomes: {} });
    expect(await odd).toEqual({ status: 'unavailable', message: TIMED_OPEN_UNKNOWN_SHAPE });
    t.state.calls[3]!.resolve(READY);
    await settle();

    const lost = t.reads.closeTimedTrade('t1');
    t.close.calls[0]!.reject(new Error('aborted'));
    expect(await lost).toEqual({ status: 'unavailable', message: TIMED_CLOSE_UNREAD });
    t.state.calls[4]!.resolve(READY);
    await settle();

    const strange = t.reads.closeTimedTrade('t1');
    t.close.calls[1]!.resolve({ status: 'closed' });
    expect(await strange).toEqual({ status: 'unavailable', message: TIMED_CLOSE_UNKNOWN_SHAPE });
    t.state.calls[5]!.resolve(READY);
    await settle();
    await h.unmount();
  });

  it("lists the caller's trades: loading until the query answers, empty with none, unreadable rows left out", async () => {
    const waiting = setup({ pending: false, signedIn: true }, undefined);
    const a = await mount(waiting.reads);
    expect(last(a.seen.trades)).toEqual({ status: 'loading' });
    await a.h.unmount();

    const none = setup({ pending: false, signedIn: true }, []);
    const b = await mount(none.reads);
    expect(last(b.seen.trades)).toEqual({ status: 'empty' });
    await b.h.unmount();

    const row = {
      _id: 't1',
      _creationTime: 1,
      network: 'testnet',
      asset: 'BTC/USD',
      direction: 'down',
      stakeUsd: 10,
      leverage: 5,
      seconds: 300,
      status: 'closed',
      openedAt: 1_000,
      expiresAt: 301_000,
      closedAt: 120_000,
      endedBy: 'cut',
      size: { atoms: '81000', decimals: 8 },
      entryPrice: { atoms: '612345', decimals: 1 },
    };
    const some = setup({ pending: false, signedIn: true }, [row, { ...row, _id: 't0', direction: 'sideways' }]);
    const c = await mount(some.reads);
    const trades = last(c.seen.trades);
    expect(trades.status).toBe('ready');
    if (trades.status !== 'ready') return;
    expect(trades.trades).toEqual([
      {
        id: 't1',
        network: 'testnet',
        asset: 'BTC/USD',
        direction: 'down',
        stakeUsd: 10,
        leverage: 5,
        seconds: 300,
        status: 'closed',
        openedAt: 1_000,
        expiresAt: 301_000,
        closedAt: 120_000,
        endedBy: 'cut',
        size: { atoms: '81000', decimals: 8 },
        entryPrice: { atoms: '612345', decimals: 1 },
        exitPrice: null,
        result: null,
        fees: null,
        openTx: null,
        closeTx: null,
        reason: null,
      },
    ]);
    await c.h.unmount();

    // Rows that are all unreadable are an empty list, not a ready one with nothing in it.
    const junk = setup({ pending: false, signedIn: true }, [{ nope: true }]);
    const d = await mount(junk.reads);
    expect(last(d.seen.trades)).toEqual({ status: 'empty' });
    await d.h.unmount();
  });
});

describe('the demo source and Predict', () => {
  it('shows the labelled sample, lists no trade, and opens nothing', async () => {
    const h = createHarness();
    let state: TimedStateRead | undefined;
    let trades: TimedTradesState | undefined;
    function Predict(): null {
      state = demoDataSource.useTimedState();
      trades = demoDataSource.useTimedTrades();
      return null;
    }
    await h.render(createElement(Predict));
    expect(state).toMatchObject({ state: SAMPLE_TIMED_STATE, refreshing: false });
    expect(trades).toEqual({ status: 'empty' });
    state?.refresh();
    expect(await demoDataSource.openTimedTrade(REQUEST)).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    expect(await demoDataSource.closeTimedTrade('t1')).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    await h.unmount();
  });
});

describe('useConvexKanonSource and Predict', () => {
  const pinClient = unavailablePinClient({ registryAddress: undefined, hasWallet: false });

  /** `gateway` false is a build with no gateway address: no calls are handed to the source. */
  function app(signedIn: boolean, gateway = true) {
    const fake = createFakeConvex();
    const h = createHarness();
    const seen: TimedStateRead[] = [];
    let source: KanonDataSource | undefined;
    // The gateway's calls, counted. Each answers in a shape that is no state and no trade.
    const calls: Record<string, number> = {};
    const count = (name: string) => async (): Promise<unknown> => {
      calls[name] = (calls[name] ?? 0) + 1;
      return {};
    };
    const venueTrade: VenueTradeActions = {
      account: count('account'),
      placeOrder: count('placeOrder'),
      closePosition: count('closePosition'),
      timedState: count('timedState'),
      openTimed: count('openTimed'),
      closeTimed: count('closeTimed'),
    };

    function Predict(): null {
      const data = useKanonData();
      source = data;
      seen.push(data.useTimedState());
      data.useTimedTrades();
      return null;
    }
    function Bridge({ screen }: { screen: boolean }): ReactElement {
      const live = useConvexKanonSource({
        hooks: fake.hooks,
        api: fake.api,
        session: { pending: false, signedIn },
        pinClient,
        hasWallet: false,
        ...(gateway ? { venueTrade } : {}),
      });
      return createElement(KanonDataProvider, { source: live, children: screen ? createElement(Predict) : null });
    }
    return {
      fake,
      h,
      seen,
      calls,
      source: (): KanonDataSource => {
        if (!source) throw new Error('Predict is not mounted');
        return source;
      },
      render: (screen: boolean) => h.render(createElement(Bridge, { screen })),
    };
  }

  it('reads the state for a mounted Predict screen only: the root, and every other screen, calls nothing', async () => {
    const a = app(true);
    await a.render(false);
    expect(a.calls).toEqual({});
    expect(a.fake.subscribedQueries()).not.toContain('timedData.listMine');

    await a.render(true);
    // The order ticket's account is not Predict's to read.
    expect(a.calls).toEqual({ timedState: 1 });
    expect(a.fake.subscribedQueries()).toContain('timedData.listMine');
    // The fake answers in a shape that is no state: the screen says so and offers nothing.
    expect(last(a.seen)).toMatchObject({ state: { status: 'unavailable', message: TIMED_STATE_UNKNOWN_SHAPE }, refreshing: false });
    // Trades leave from the gateway. No Convex action is called, and no wallet is asked for anything.
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });

  it("is bound to the gateway's open and close calls, each followed by one read of the state", async () => {
    const a = app(true);
    await a.render(true);
    expect(a.calls).toEqual({ timedState: 1 });

    expect(await a.source().openTimedTrade({ asset: 'BTC/USD', direction: 'down', stakeUsd: 10, seconds: 60 })).toEqual({
      status: 'unavailable',
      message: TIMED_OPEN_UNKNOWN_SHAPE,
    });
    await settle();
    expect(a.calls).toEqual({ timedState: 2, openTimed: 1 });

    await a.source().closeTimedTrade('t1');
    await settle();
    expect(a.calls).toEqual({ timedState: 3, openTimed: 1, closeTimed: 1 });
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });

  it('signed out: Predict shows the sample, and nothing is called or subscribed', async () => {
    const a = app(false);
    await a.render(true);
    expect(last(a.seen).state).toBe(SAMPLE_TIMED_STATE);
    expect(await a.source().openTimedTrade({ asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 60 })).toEqual({
      status: 'unavailable',
      message: SIGN_IN_TO_TRADE,
    });
    await settle();
    expect(a.calls).toEqual({});
    expect(a.fake.actionCalls).toEqual({});
    expect(a.fake.subscribedQueries()).not.toContain('timedData.listMine');
    await a.h.unmount();
  });

  it('with no gateway address: Predict says trading is not connected, and sends nothing anywhere', async () => {
    const a = app(true, false);
    await a.render(true);
    expect(last(a.seen).state).toEqual({ status: 'unavailable', message: TRADE_NOT_CONNECTED });
    expect(await a.source().openTimedTrade({ asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 60 })).toEqual({
      status: 'unavailable',
      message: TRADE_NOT_CONNECTED,
    });
    expect(await a.source().closeTimedTrade('t1')).toEqual({ status: 'unavailable', message: TRADE_NOT_CONNECTED });
    await settle();
    expect(a.calls).toEqual({});
    expect(a.fake.actionCalls).toEqual({});
    await a.h.unmount();
  });
});
