import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The hook plays haptics through the platform, which is react-native's. Here it plays none.
const haptics = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../platform', () => ({
  isWeb: true,
  useHaptics: () => ({
    tap: () => haptics.played.push('tap'),
    select: () => haptics.played.push('select'),
    success: () => haptics.played.push('success'),
    warning: () => haptics.played.push('warning'),
    refusal: () => haptics.played.push('refusal'),
  }),
}));

import { KanonDataProvider, demoDataSource, type KanonDataSource } from './data';
import { createHarness, settle } from './render-harness';
import { NO_FILTER, reelSlides, slideMode } from './timed-reel';
import { BUSY_GRACE_MS, requestOf, timedTradeFromRow, timedView } from './timed-trade';
import { createTimedTradeReads } from './timed-trade-reads';
import type { TimedDirection, TimedRequest, TimedStateView, TimedTrade, TimedTradeRow, TimedTradeView } from './timed-types';
import { useTimedTicket, type TimedTicket } from './use-timed-ticket';

/**
 * Predict's state as the reel holds it, mounted under a real renderer over the
 * live reads: a press on a slide opens that slide's trade, an answer that is
 * not a trade is shown as it was said, and a trade is followed from its answer,
 * through its row, to its ending, on every slide of its pair.
 */

const READY: Extract<TimedStateView, { status: 'ready' }> = {
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
  markets: [
    { asset: 'BTC/USD', open: true, leverage: 5, busy: null },
    { asset: 'ETH/USD', open: true, leverage: 3, busy: null },
  ],
};

const taken = (until: number | null): TimedStateView => ({
  ...READY,
  markets: [{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until } }, READY.markets[1]!],
});

interface Deferred {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

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

const viewOf = (over: Partial<TimedTradeView> = {}): TimedTradeView => {
  const openedAt = Date.now();
  return {
    id: 't1',
    asset: 'BTC/USD',
    direction: 'up',
    stakeUsd: 10,
    leverage: 5,
    seconds: 60,
    openedAt,
    expiresAt: openedAt + 60_000,
    size: { atoms: '81000', decimals: 8 },
    entryPrice: { atoms: '612345', decimals: 1 },
    ...over,
  };
};

const rowOf = (view: TimedTradeView, over: Partial<TimedTradeRow> = {}): TimedTrade =>
  timedTradeFromRow({ _id: view.id, _creationTime: view.openedAt, network: 'testnet', status: 'live', ...view, ...over })!;

async function mount(signedIn = true) {
  const state = scripted();
  const open = scripted();
  const close = scripted();
  const reads = createTimedTradeReads({
    useQuery: () => undefined,
    listMine: {},
    actions: { timedState: () => state.call(), openTimed: open.call, closeTimed: close.call },
    session: { pending: false, signedIn },
  });
  const source: KanonDataSource = {
    ...demoDataSource,
    ...reads,
    session: { mode: signedIn ? 'live' : 'demo', pending: false, signedIn, hasWallet: false },
  };
  const h = createHarness();
  let latest: TimedTicket | undefined;
  function Probe(): null {
    latest = useTimedTicket();
    return null;
  }
  await h.render(createElement(KanonDataProvider, { source, children: createElement(Probe) }));
  const ticket = (): TimedTicket => {
    if (!latest) throw new Error('not mounted');
    return latest;
  };
  /** Answers the read of the state that is out, with what the server would say now. */
  const answerState = async (value: unknown = READY): Promise<void> => {
    state.calls[state.calls.length - 1]!.resolve(value);
    await settle();
  };
  /** A slide's own view: its pair and time, with the stake carried from slide to slide. */
  const viewOn = (asset: string, seconds: number) =>
    timedView(ticket().state, { asset, stakeUsd: ticket().stake, seconds });
  /** What a press of UP or DOWN on a slide asks for, or null when that slide is held. */
  const press = (asset: string, seconds: number, direction: TimedDirection): TimedRequest | null =>
    requestOf(viewOn(asset, seconds), direction);
  /** What the slide of a pair shows where its actions go. */
  const modeOn = (asset: string, seconds: number) =>
    slideMode({ asset }, viewOn(asset, seconds), ticket().running, ticket().ended);
  return { h, ticket, state, open, close, answerState, viewOn, press, modeOn };
}

describe('useTimedTicket', () => {
  it('shows the labelled sample and sends nothing while nobody is signed in', async () => {
    const t = await mount(false);
    // The reel can be seen: the sample's pairs and choices, with nothing read from anywhere.
    expect(t.ticket().base).toMatchObject({ status: 'ready', sample: true, hold: null, stakes: [10, 25, 50, 100] });
    expect(t.ticket().canRefresh).toBe(false);
    expect(t.ticket().listed).toBe(t.ticket().state);
    expect(reelSlides(t.ticket().listed, NO_FILTER).length).toBeGreaterThan(0);
    expect(t.state.calls).toHaveLength(0);
    // A stake can be tried, as on the real thing. It asks for nothing.
    t.ticket().chooseStake(50);
    await settle();
    expect(t.viewOn('BTC/USD', 60).stakeUsd).toBe(50);
    // And a press makes no request, so nothing can be sent with the sample's figures.
    expect(t.press('BTC/USD', 60, 'up')).toBeNull();
    t.ticket().open(t.press('BTC/USD', 60, 'up'));
    await settle();
    expect(t.open.calls).toHaveLength(0);
    expect(t.ticket().sending).toBeNull();
    expect(t.ticket().running).toEqual([]);
    expect(t.ticket().history).toEqual([]);
    await t.h.unmount();
  });

  it("builds its slides from the server's pairs and times, and carries the stake from slide to slide", async () => {
    const t = await mount();
    expect(t.ticket().base.status).toBe('loading');
    expect(reelSlides(t.ticket().state, NO_FILTER)).toEqual([]);
    await t.answerState();
    expect(reelSlides(t.ticket().state, NO_FILTER).map((slide) => slide.id)).toEqual([
      'BTC/USD|60',
      'BTC/USD|300',
      'BTC/USD|900',
      'BTC/USD|3600',
      'ETH/USD|60',
      'ETH/USD|300',
      'ETH/USD|900',
      'ETH/USD|3600',
    ]);
    // Nothing picked: the smallest stake the server offers.
    expect(t.ticket()).toMatchObject({ stake: null, base: { status: 'ready', stakes: [10, 25, 50, 100], stakeUsd: 10 } });
    expect(t.press('BTC/USD', 60, 'up')).toEqual({ asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 60 });

    t.ticket().chooseStake(50);
    await settle();
    // The same stake on every slide, each with its own pair, time and leverage.
    expect(t.ticket().base.stakeUsd).toBe(50);
    expect(t.viewOn('BTC/USD', 60)).toMatchObject({ asset: 'BTC/USD', stakeUsd: 50, seconds: 60, leverage: 5 });
    expect(t.press('ETH/USD', 900, 'down')).toEqual({ asset: 'ETH/USD', direction: 'down', stakeUsd: 50, seconds: 900 });
    expect(t.viewOn('ETH/USD', 900).leverage).toBe(3);
    await t.h.unmount();
  });

  it('opens a trade on one press: locked while it is out, then running from the answer, with no prompt in between', async () => {
    haptics.played.length = 0;
    const t = await mount();
    await t.answerState();

    expect(t.modeOn('BTC/USD', 60)).toEqual({ kind: 'actions' });
    t.ticket().open(t.press('BTC/USD', 60, 'up'));
    // A second press in the same frame is the same press.
    t.ticket().open(t.press('BTC/USD', 60, 'up'));
    t.ticket().open(t.press('BTC/USD', 60, 'down'));
    await settle();
    expect(t.open.args).toEqual([{ asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 60 }]);
    expect(t.ticket()).toMatchObject({
      sending: { action: 'open', asset: 'BTC/USD', direction: 'up', stakeUsd: 10, seconds: 60 },
      locked: true,
      outcome: null,
    });

    const view = viewOf();
    t.open.calls[0]!.resolve({ status: 'opened', trade: view });
    await settle();
    // The trade is on screen from its answer, before its row and before the state is read again.
    expect(t.ticket().sending).toBeNull();
    expect(t.ticket().locked).toBe(true);
    expect(t.ticket().running.map((trade) => [trade.id, trade.status])).toEqual([['t1', 'live']]);
    expect(t.ticket().outcome).toBeNull();
    expect(haptics.played).toContain('success');
    // Every slide of the pair shows the trade in place of its two actions. The other pair is untouched.
    expect(t.modeOn('BTC/USD', 60)).toMatchObject({ kind: 'running', trade: { id: 't1' } });
    expect(t.modeOn('BTC/USD', 3600)).toMatchObject({ kind: 'running', trade: { id: 't1' } });
    expect(t.modeOn('ETH/USD', 60)).toEqual({ kind: 'actions' });

    // The state read that followed the open says the market is taken, and unlocks the screen.
    expect(t.state.calls).toHaveLength(2);
    await t.answerState(taken(view.expiresAt));
    expect(t.ticket().locked).toBe(false);
    // A slide of the taken pair makes no request: a press there asks for nothing.
    expect(t.press('BTC/USD', 300, 'up')).toBeNull();
    t.ticket().open(t.press('BTC/USD', 300, 'up'));
    await settle();
    expect(t.open.calls).toHaveLength(1);

    // Its row lands: still one trade, now the row.
    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view, { openTx: '0xabc' })] });
    await settle();
    expect(t.ticket().running).toHaveLength(1);
    expect(t.ticket().running[0]).toMatchObject({ id: 't1', openTx: '0xabc' });
    expect(t.ticket().tradesStatus).toBe('ready');
    await t.h.unmount();
  });

  it("shows a refusal as the server said it, opens nothing, and is felt", async () => {
    haptics.played.length = 0;
    const t = await mount();
    await t.answerState();
    t.ticket().open(t.press('BTC/USD', 300, 'down'));
    await settle();
    t.open.calls[0]!.resolve({ status: 'refused', reason: 'BTC is in a timed trade on the shared account. It ends in about 12 seconds.' });
    await settle();
    expect(t.ticket().outcome).toEqual({
      status: 'refused',
      label: 'REFUSED',
      context: 'BTC/USD · DOWN · $10 · 5m',
      text: 'BTC is in a timed trade on the shared account. It ends in about 12 seconds.',
      // It is shown on the slide it was asked from.
      asset: 'BTC/USD',
      seconds: 300,
    });
    expect(t.ticket().running).toEqual([]);
    expect(t.modeOn('BTC/USD', 300)).toEqual({ kind: 'actions' });
    expect(haptics.played).toContain('refusal');

    await t.answerState();
    expect(t.ticket().locked).toBe(false);
    t.ticket().dismiss();
    await settle();
    expect(t.ticket().outcome).toBeNull();

    // The next request clears the last answer by itself.
    t.ticket().open(t.press('ETH/USD', 60, 'up'));
    await settle();
    expect(t.ticket().outcome).toBeNull();
    t.open.calls[1]!.resolve({ status: 'unfilled', message: 'Nothing filled. Nothing is left on the book.' });
    await settle();
    expect(t.ticket().outcome).toMatchObject({ label: 'NOT FILLED', text: 'Nothing filled. Nothing is left on the book.' });
    await t.h.unmount();
  });

  it('asks the server to end a running trade, and reads it as closing until its row says so', async () => {
    const t = await mount();
    await t.answerState();
    const view = viewOf();
    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view)] });
    await settle();

    t.ticket().end('nope');
    await settle();
    expect(t.close.calls).toHaveLength(0);

    t.ticket().end('t1');
    await settle();
    expect(t.close.args).toEqual([{ tradeId: 't1' }]);
    expect(t.ticket()).toMatchObject({ sending: { action: 'close', tradeId: 't1' }, locked: true });

    t.close.calls[0]!.resolve({ status: 'closing', tradeId: 't1' });
    await settle();
    expect(t.ticket().sending).toBeNull();
    expect([...t.ticket().asked]).toEqual(['t1']);
    expect(t.ticket().outcome).toBeNull();
    await t.answerState(taken(view.expiresAt));

    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view, { status: 'closing' })] });
    await settle();
    expect([...t.ticket().asked]).toEqual([]);
    expect(t.ticket().running.map((trade) => trade.status)).toEqual(['closing']);
    await t.h.unmount();
  });

  it('shows why a trade could not be ended, in the words it came with', async () => {
    const t = await mount();
    await t.answerState();
    const view = viewOf();
    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view)] });
    await settle();
    t.ticket().end('t1');
    await settle();
    t.close.calls[0]!.resolve({ status: 'refused', reason: 'That trade is already closing.' });
    await settle();
    expect(t.ticket().outcome).toEqual({
      status: 'refused',
      label: 'REFUSED',
      context: 'BTC/USD · UP · END NOW',
      text: 'That trade is already closing.',
      asset: 'BTC/USD',
      seconds: null,
    });
    expect([...t.ticket().asked]).toEqual([]);
    await t.h.unmount();
  });

  it('shows a trade that ends while it is watched where it ran, reads the state again, and files it under history', async () => {
    haptics.played.length = 0;
    const t = await mount();
    await t.answerState();
    const view = viewOf();
    const old = rowOf(viewOf({ id: 't0', openedAt: view.openedAt - 600_000, expiresAt: view.openedAt - 540_000 }), {
      status: 'closed',
      closedAt: view.openedAt - 540_000,
      endedBy: 'time',
    });
    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view), old] });
    await settle();
    expect(t.ticket().running.map((trade) => trade.id)).toEqual(['t1']);
    // Closed before the screen opened: history, not an ending.
    expect(t.ticket().ended).toEqual([]);
    expect(t.ticket().history.map((trade) => trade.id)).toEqual(['t0']);
    expect(t.state.calls).toHaveLength(1);

    const closed = rowOf(view, { status: 'closed', closedAt: view.expiresAt + 300, endedBy: 'time' });
    t.ticket().followTrades({ status: 'ready', trades: [closed, old] });
    await settle();
    expect(t.ticket().running).toEqual([]);
    expect(t.ticket().ended.map((trade) => trade.id)).toEqual(['t1']);
    expect(t.ticket().history.map((trade) => trade.id)).toEqual(['t1', 't0']);
    expect(haptics.played).toContain('tap');
    // The slide shows the ending where the trade ran, in place of its two actions.
    expect(t.modeOn('BTC/USD', 60)).toMatchObject({ kind: 'ended', trade: { id: 't1', endedBy: 'time' } });
    // A market was freed: what can be traded is read again.
    expect(t.state.calls).toHaveLength(2);
    await t.answerState();

    // The exit price arrives a few seconds later, on the same card.
    t.ticket().followTrades({ status: 'ready', trades: [{ ...closed, exitPrice: { atoms: '612500', decimals: 1 } }, old] });
    await settle();
    expect(t.ticket().ended[0]?.exitPrice).toEqual({ atoms: '612500', decimals: 1 });
    expect(t.state.calls).toHaveLength(2);

    // Put away, the slide returns to its two actions, and the trade is in the history.
    t.ticket().dismissEnded('t1');
    await settle();
    expect(t.ticket().ended).toEqual([]);
    expect(t.modeOn('BTC/USD', 60)).toEqual({ kind: 'actions' });
    expect(t.ticket().history.map((trade) => trade.id)).toEqual(['t1', 't0']);
    await t.h.unmount();
  });

  it('keeps trading when the trade list cannot be read: a trade still runs from its answer', async () => {
    const t = await mount();
    await t.answerState();
    expect(t.ticket().tradesStatus).toBe('loading');
    t.ticket().followTrades(null);
    await settle();
    expect(t.ticket().tradesStatus).toBe('unread');

    t.ticket().open(t.press('BTC/USD', 60, 'up'));
    await settle();
    t.open.calls[0]!.resolve({ status: 'opened', trade: viewOf() });
    await settle();
    expect(t.ticket().running.map((trade) => trade.id)).toEqual(['t1']);
    expect(t.ticket().tradesStatus).toBe('unread');
    await t.h.unmount();
  });

  it('keeps the slides in place when a read fails after one has succeeded, with their actions off', async () => {
    const t = await mount();
    await t.answerState();
    const view = viewOf();
    t.ticket().followTrades({ status: 'ready', trades: [rowOf(view)] });
    await settle();
    expect(t.ticket().listed).toBe(t.ticket().state);

    t.ticket().refresh();
    await t.answerState({ status: 'unavailable', message: 'The venue could not be read. Try again.' });
    // What the server last said is what the screen says...
    expect(t.ticket().state).toEqual({ status: 'unavailable', message: 'The venue could not be read. Try again.' });
    expect(t.ticket().base.hold).toBe('The venue could not be read. Try again.');
    // ...and the reel is still there, so the running trade keeps its slide.
    expect(reelSlides(t.ticket().listed, NO_FILTER)).toHaveLength(8);
    expect(t.modeOn('BTC/USD', 60)).toMatchObject({ kind: 'running', trade: { id: 't1' } });
    // A slide with nothing running offers nothing, and says why in the words that came.
    expect(t.modeOn('ETH/USD', 60)).toEqual({
      kind: 'held',
      tag: 'NOT OPEN',
      short: 'The venue could not be read. Try again.',
      line: 'The venue could not be read. Try again.',
    });
    expect(t.press('ETH/USD', 60, 'up')).toBeNull();

    t.ticket().refresh();
    await t.answerState();
    expect(t.ticket().listed).toBe(t.ticket().state);
    expect(t.modeOn('ETH/USD', 60)).toEqual({ kind: 'actions' });
    await t.h.unmount();
  });

  it('says the list is empty once it has loaded with nothing in it', async () => {
    const t = await mount();
    await t.answerState();
    t.ticket().followTrades({ status: 'empty' });
    await settle();
    expect(t.ticket()).toMatchObject({ tradesStatus: 'empty', running: [], history: [], ended: [] });
    await t.h.unmount();
  });

  it("reads the state again just after another person's trade is due to free a market", async () => {
    const t = await mount();
    // Due a moment ago: the grace runs out in about a second. A wide margin, so a loaded machine still sets the timer in time.
    await t.answerState(taken(Date.now() - BUSY_GRACE_MS + 1_000));
    // Somebody else's trade: the pair's slides say so and offer nothing. The other pair is open.
    expect(t.modeOn('BTC/USD', 60)).toMatchObject({ kind: 'held', tag: 'IN A TRADE' });
    expect(t.viewOn('BTC/USD', 60).hold).toMatch(/^BTC is in a trade until /);
    expect(t.modeOn('ETH/USD', 60)).toEqual({ kind: 'actions' });
    expect(t.state.calls).toHaveLength(1);

    // Nothing announces that trade ending to this screen: it reads again on its own, once.
    const deadline = Date.now() + 8_000;
    while (t.state.calls.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.state.calls).toHaveLength(2);
    await t.answerState();
    expect(t.modeOn('BTC/USD', 60)).toEqual({ kind: 'actions' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(t.state.calls).toHaveLength(2);
    await t.h.unmount();
  }, 15_000);
});
