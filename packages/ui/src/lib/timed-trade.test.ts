import { describe, expect, it } from 'vitest';
import {
  BUSY_GRACE_MS,
  CUT_NOTE,
  JUST_ENDED_MAX,
  OVERDUE_RECHECK_MS,
  TIMED_CLOSE_UNKNOWN_SHAPE,
  TIMED_OPEN_UNKNOWN_SHAPE,
  TIMED_STATE_UNKNOWN_SHAPE,
  TIME_IS_UP,
  accountNote,
  asTimedCloseResult,
  asTimedOpenResult,
  asTimedState,
  calledIt,
  calledLine,
  choiceFacts,
  closeOutcomeView,
  countdownText,
  directionAction,
  durationLabel,
  durationWords,
  elapsedFraction,
  finishedDetail,
  finishedTrades,
  finishedView,
  formatAusd,
  formatClockTime,
  formatRan,
  formatTimedPrice,
  justEnded,
  liveMove,
  marketHold,
  moveLine,
  openLabel,
  openOutcomeView,
  openedLine,
  priceMove,
  rateLimitedLine,
  requestOf,
  runningSignature,
  runningTrades,
  runningView,
  sendingLine,
  stateRecheck,
  termsLine,
  timedTradeFromRow,
  timedTradesFromRows,
  timedView,
  tradeFromOpened,
  watchRunning,
  withOpened,
} from './timed-trade';
import type { TimedRequest, TimedState, TimedStateView, TimedTrade, TimedTradeRow, TimedTradeView } from './timed-types';
import { NOT_REPORTED_YET } from './venue-trade';

/**
 * Predict's rules, pinned down: what the screen reads from the server and what
 * it refuses to read, what it offers, what it says while a trade runs and after
 * it ends, and where the money result may appear.
 */

const T0 = Date.UTC(2026, 9, 10, 12, 0, 5);
const price = (atoms: number | string, decimals = 1) => ({ atoms: String(atoms), decimals });

const READY: Extract<TimedStateView, { status: 'ready' }> = {
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
  markets: [
    { asset: 'BTC/USD', open: true, leverage: 5, busy: null },
    { asset: 'ETH/USD', open: true, leverage: 3, busy: null },
    { asset: 'SOL/USD', open: false, leverage: 5, busy: null },
  ],
};

const withMarkets = (markets: (typeof READY)['markets']): TimedState => ({ ...READY, markets });
const NOTHING = { asset: null, stakeUsd: null, seconds: null } as const;

const ROW: TimedTradeRow = {
  _id: 't1',
  _creationTime: T0,
  network: 'testnet',
  asset: 'BTC/USD',
  direction: 'up',
  stakeUsd: 25,
  leverage: 5,
  seconds: 60,
  status: 'live',
  openedAt: T0,
  expiresAt: T0 + 60_000,
  size: { atoms: '204000', decimals: 8 },
  entryPrice: price(612345),
};

const trade = (over: Partial<TimedTrade> = {}): TimedTrade => ({ ...timedTradeFromRow(ROW)!, ...over });

const CLOSED: TimedTradeRow = {
  ...ROW,
  status: 'closed',
  closedAt: T0 + 60_400,
  endedBy: 'time',
  exitPrice: price(612500),
  result: { atoms: '312500', decimals: 6 },
  fees: { atoms: '87500', decimals: 6 },
  openTx: `0x${'ab'.repeat(32)}`,
  closeTx: `0x${'cd'.repeat(32)}`,
};

describe('asTimedState', () => {
  it('reads a ready state, and puts the stakes and durations in ascending order', () => {
    const state = asTimedState({ ...READY, limits: { ...READY.limits, stakesUsd: [100, 10, 50, 25, 25], durations: [3600, 60] } });
    expect(state).toEqual({ ...READY, limits: { ...READY.limits, stakesUsd: [10, 25, 50, 100], durations: [60, 3600] } });
  });

  it('keeps a busy market as the server stated it, with or without a time', () => {
    const state = asTimedState({
      ...READY,
      markets: [
        { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: T0 + 60_000 } },
        { asset: 'ETH/USD', open: true, leverage: 3, busy: { until: null } },
      ],
    });
    expect(state.status === 'ready' && state.markets.map((m) => m.busy)).toEqual([{ until: T0 + 60_000 }, { until: null }]);
  });

  it("passes on the server's own sentence when it is unavailable", () => {
    expect(asTimedState({ status: 'unavailable', message: 'Timed trades run on testnet only.' })).toEqual({
      status: 'unavailable',
      message: 'Timed trades run on testnet only.',
    });
  });

  it('reads anything else as a failure to read, and offers nothing from it', () => {
    const unknown = { status: 'unavailable', message: TIMED_STATE_UNKNOWN_SHAPE };
    expect(asTimedState(undefined)).toEqual(unknown);
    expect(asTimedState({})).toEqual(unknown);
    expect(asTimedState({ status: 'unavailable' })).toEqual(unknown);
    expect(asTimedState({ ...READY, limits: { ...READY.limits, stakesUsd: ['10'] } })).toEqual(unknown);
    expect(asTimedState({ ...READY, limits: { ...READY.limits, durations: [0] } })).toEqual(unknown);
    expect(asTimedState({ ...READY, network: 'devnet' })).toEqual(unknown);
    expect(asTimedState({ ...READY, markets: [{ asset: 'BTC/USD', open: true, leverage: 5 }] })).toEqual(unknown);
    expect(asTimedState({ ...READY, markets: [{ asset: 'BTC/USD', open: true, leverage: 0, busy: null }] })).toEqual(unknown);
    expect(asTimedState({ ...READY, markets: [{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: 'soon' } }] })).toEqual(unknown);
  });
});

const VIEW: TimedTradeView = {
  id: 't1',
  asset: 'BTC/USD',
  direction: 'up',
  stakeUsd: 25,
  leverage: 5,
  seconds: 60,
  openedAt: T0,
  expiresAt: T0 + 60_000,
  size: { atoms: '204000', decimals: 8 },
  entryPrice: price(612345),
};

describe('asTimedOpenResult', () => {
  it('reads a trade that opened', () => {
    expect(asTimedOpenResult({ status: 'opened', trade: VIEW })).toEqual({ status: 'opened', trade: VIEW });
  });

  it("reads each answer that opened nothing, with the server's own words", () => {
    expect(asTimedOpenResult({ status: 'refused', reason: 'The BTC market is closed.' })).toEqual({
      status: 'refused',
      reason: 'The BTC market is closed.',
    });
    for (const status of ['busy', 'unfilled', 'pending', 'unavailable'] as const) {
      expect(asTimedOpenResult({ status, message: 'A sentence.', extra: 1 })).toEqual({ status, message: 'A sentence.' });
    }
    expect(asTimedOpenResult({ status: 'rate_limited', retryAfterMs: 4000, message: 'Slow down.' })).toEqual({
      status: 'rate_limited',
      retryAfterMs: 4000,
      message: 'Slow down.',
    });
  });

  it('says how long to wait when a rate limit came with no sentence', () => {
    expect(asTimedOpenResult({ status: 'rate_limited', retryAfterMs: 4200 })).toEqual({
      status: 'rate_limited',
      retryAfterMs: 4200,
      message: 'Too many requests. The next one can go in 5 seconds.',
    });
    expect(rateLimitedLine(0)).toBe('Too many requests. Wait a moment.');
  });

  it('reads anything else as unread, and does not say nothing was sent', () => {
    const unknown = { status: 'unavailable', message: TIMED_OPEN_UNKNOWN_SHAPE };
    expect(asTimedOpenResult(null)).toEqual(unknown);
    expect(asTimedOpenResult({ status: 'opened' })).toEqual(unknown);
    expect(asTimedOpenResult({ status: 'opened', trade: { ...VIEW, entryPrice: 61234.5 } })).toEqual(unknown);
    expect(asTimedOpenResult({ status: 'opened', trade: { ...VIEW, direction: 'long' } })).toEqual(unknown);
    expect(asTimedOpenResult({ status: 'refused' })).toEqual(unknown);
    expect(asTimedOpenResult({ status: 'filled' })).toEqual(unknown);
    expect(TIMED_OPEN_UNKNOWN_SHAPE).not.toMatch(/nothing was (sent|opened)/i);
  });
});

describe('asTimedCloseResult', () => {
  it('reads the three answers, and anything else as unread', () => {
    expect(asTimedCloseResult({ status: 'closing', tradeId: 't1' })).toEqual({ status: 'closing', tradeId: 't1' });
    expect(asTimedCloseResult({ status: 'refused', reason: 'That trade is not yours.' })).toEqual({
      status: 'refused',
      reason: 'That trade is not yours.',
    });
    expect(asTimedCloseResult({ status: 'unavailable', message: 'The venue could not be read.' })).toEqual({
      status: 'unavailable',
      message: 'The venue could not be read.',
    });
    expect(asTimedCloseResult({ status: 'closing' })).toEqual({ status: 'unavailable', message: TIMED_CLOSE_UNKNOWN_SHAPE });
    expect(asTimedCloseResult('closing')).toEqual({ status: 'unavailable', message: TIMED_CLOSE_UNKNOWN_SHAPE });
  });
});

describe('reading the trade list', () => {
  it('makes every absent field null', () => {
    expect(timedTradeFromRow(ROW)).toEqual({
      id: 't1',
      network: 'testnet',
      asset: 'BTC/USD',
      direction: 'up',
      stakeUsd: 25,
      leverage: 5,
      seconds: 60,
      status: 'live',
      openedAt: T0,
      expiresAt: T0 + 60_000,
      closedAt: null,
      endedBy: null,
      size: { atoms: '204000', decimals: 8 },
      entryPrice: price(612345),
      exitPrice: null,
      result: null,
      fees: null,
      openTx: null,
      closeTx: null,
      reason: null,
    });
  });

  it('carries what a closed row has gained', () => {
    expect(timedTradeFromRow(CLOSED)).toMatchObject({
      status: 'closed',
      closedAt: T0 + 60_400,
      endedBy: 'time',
      exitPrice: price(612500),
      result: { atoms: '312500', decimals: 6 },
      fees: { atoms: '87500', decimals: 6 },
      openTx: CLOSED.openTx,
      closeTx: CLOSED.closeTx,
    });
  });

  it('treats an optional field it cannot read as absent, and keeps the row', () => {
    const odd = { ...CLOSED, endedBy: 'boredom', exitPrice: 61250, result: '0.31', closeTx: '', closedAt: 'later' };
    expect(timedTradeFromRow(odd)).toMatchObject({
      status: 'closed',
      endedBy: null,
      exitPrice: null,
      result: null,
      closeTx: null,
      closedAt: null,
    });
  });

  it('drops a row it cannot draw, and keeps the order of the rest', () => {
    const rows = [
      { ...ROW, _id: 'a' },
      { ...ROW, _id: 'b', direction: 'long' },
      { ...ROW, _id: 'c', entryPrice: 61234.5 },
      { ...ROW, _id: 'd', status: 'open' },
      null,
      'row',
      { ...ROW, _id: 'e', asset: ' btc / usd ' },
    ];
    const trades = timedTradesFromRows(rows);
    expect(trades.map((t) => t.id)).toEqual(['a', 'e']);
    expect(trades[1]?.asset).toBe('BTC/USD');
  });
});

describe('the lists a screen draws', () => {
  const a = trade({ id: 'a', expiresAt: T0 + 300_000 });
  const b = trade({ id: 'b', asset: 'ETH/USD', expiresAt: T0 + 60_000, status: 'closing' });
  const c = trade({ id: 'c', status: 'closed', closedAt: T0 - 10_000 });
  const d = trade({ id: 'd', status: 'closed', closedAt: null, expiresAt: T0 - 5_000 });

  it('lists running trades the soonest to end first, a closing one among them', () => {
    expect(runningTrades([a, b, c, d]).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('lists finished trades the latest to end first', () => {
    expect(finishedTrades([c, a, d, b]).map((t) => t.id)).toEqual(['d', 'c']);
  });

  it('draws a trade from its answer until its row lands, and never twice', () => {
    const opened = tradeFromOpened({ ...VIEW, id: 'new', asset: 'btc/usd' }, 'testnet');
    expect(opened).toMatchObject({ id: 'new', asset: 'BTC/USD', status: 'live', exitPrice: null, result: null });
    expect(withOpened([a], opened).map((t) => t.id)).toEqual(['new', 'a']);
    const listed = [trade({ id: 'new' }), a];
    expect(withOpened(listed, opened)).toBe(listed);
    expect(withOpened(listed, null)).toBe(listed);
  });

  it('remembers what it saw running, and shows what ended while it watched', () => {
    const none: ReadonlySet<string> = new Set();
    const watched = watchRunning(none, [a, b, c]);
    expect([...watched].sort()).toEqual(['a', 'b']);
    // Nothing new: the same set, so a caller holding it in state does not render.
    expect(watchRunning(watched, [a, b, c])).toBe(watched);

    const later = [
      trade({ id: 'a', status: 'closed', closedAt: T0 + 300_100 }),
      trade({ id: 'b', status: 'closed', closedAt: T0 + 60_100 }),
      c,
    ];
    expect(justEnded(later, watched, none).map((t) => t.id)).toEqual(['a', 'b']);
    expect(justEnded(later, watched, new Set(['a'])).map((t) => t.id)).toEqual(['b']);
    // A trade that was already closed when the screen opened is history, not an ending.
    expect(justEnded([c], watched, none)).toEqual([]);
  });

  it('lets an ending go once a later trade opens on the same market, and keeps only the latest few', () => {
    const seen = new Set(['a', 'b', 'e1', 'e2', 'e3', 'e4']);
    const none: ReadonlySet<string> = new Set();
    const endedA = trade({ id: 'a', status: 'closed', closedAt: T0 + 60_100 });
    const endedB = trade({ id: 'b', asset: 'ETH/USD', status: 'closed', closedAt: T0 + 60_200 });
    const next = trade({ id: 'n', openedAt: T0 + 90_000, expiresAt: T0 + 150_000 });
    // A new BTC trade is running: the BTC ending steps aside, the ETH one stays.
    expect(justEnded([next, endedA, endedB], seen, none).map((t) => t.id)).toEqual(['b']);

    const many = ['SOL/USD', 'MON/USD', 'AVAX/USD', 'ETH/USD'].map((asset, i) =>
      trade({ id: `e${i + 1}`, asset, status: 'closed', closedAt: T0 + 1_000 * (i + 1) }),
    );
    expect(JUST_ENDED_MAX).toBe(3);
    expect(justEnded(many, seen, none).map((t) => t.id)).toEqual(['e4', 'e3', 'e2']);
  });

  it('changes its signature when a running trade starts closing or closes, and for nothing else', () => {
    const before = runningSignature([a, b, c]);
    expect(runningSignature([b, a, { ...c, exitPrice: price(1) }])).toBe(before);
    expect(runningSignature([{ ...a, status: 'closing' }, b, c])).not.toBe(before);
    expect(runningSignature([{ ...a, status: 'closed' }, b, c])).not.toBe(before);
    expect(runningSignature([])).toBe('');
  });
});

describe('figures', () => {
  it('spells a duration the way the server does, and in words for a screen reader', () => {
    expect([60, 300, 900, 3600, 7200, 45].map(durationLabel)).toEqual(['1m', '5m', '15m', '1h', '2h', '45s']);
    expect([60, 300, 3600, 7200, 1].map(durationWords)).toEqual(['1 minute', '5 minutes', '1 hour', '2 hours', '1 second']);
  });

  it("prints a time of day on the viewer's clock", () => {
    expect(formatClockTime(T0, 0)).toBe('12:00:05');
    expect(formatClockTime(T0, 60)).toBe('13:00:05');
    expect(formatClockTime(T0, -330)).toBe('06:30:05');
    expect(formatClockTime(T0)).toMatch(/^\d{2}:\d{2}:05$/);
  });

  it('prints how long a trade ran', () => {
    expect([400, 58_000, 60_400, 62_000, 3_600_000, 3_720_000].map(formatRan)).toEqual([
      '0s',
      '58s',
      '1m 00s',
      '1m 02s',
      '1h 00m',
      '1h 02m',
    ]);
  });

  it('prints a price at the places a terminal quotes it to, from its atoms', () => {
    expect(formatTimedPrice(price(612345))).toBe('61,234.5');
    expect(formatTimedPrice(price('6123451234567', 8))).toBe('61,234.51');
    expect(formatTimedPrice(price('3412', 5))).toBe('0.03412');
  });

  it('prints a signed amount of collateral, and a trade in one line', () => {
    expect(formatAusd({ atoms: '312500', decimals: 6 })).toBe('+0.31 AUSD');
    expect(formatAusd({ atoms: '-1200000', decimals: 6 })).toBe('−1.20 AUSD');
    expect(formatAusd({ atoms: '0', decimals: 6 })).toBe('0.00 AUSD');
    expect(termsLine({ stakeUsd: 25, leverage: 5, seconds: 60 })).toBe('$25 · 5x · 1m');
  });
});

describe('priceMove', () => {
  it('is a direction and a distance in price, to a thousandth of a percent', () => {
    expect(priceMove(price(612345), price(612500))).toEqual({ direction: 'up', diff: '15.5', percent: '0.025%', bps: 3 });
    expect(priceMove(price(612345), price(612300))).toEqual({ direction: 'down', diff: '4.5', percent: '0.007%', bps: -1 });
    expect(priceMove(price(612345), price(612345))).toEqual({ direction: 'flat', diff: '0.0', percent: '0.000%', bps: 0 });
  });

  it('lines up two prices held at different scales', () => {
    expect(priceMove(price(612345), price('6130000000000', 8))).toMatchObject({ direction: 'up', diff: '65.5', bps: 11 });
  });

  it('is nothing when there is no price to move from', () => {
    expect(priceMove(price(0), price(612345))).toBeNull();
  });

  it('never mentions money', () => {
    const move = priceMove(price(612345), price(612500))!;
    expect(moveLine(move)).toBe('Up 15.5 · 0.025%');
    expect(moveLine(priceMove(price(612345), price(612345))!)).toBe('No change');
    expect(JSON.stringify(move)).not.toMatch(/\$|AUSD|USD/);
  });

  it('says whether the price went the way that was called', () => {
    const up = priceMove(price(612345), price(612500))!;
    const flat = priceMove(price(612345), price(612345))!;
    expect(calledIt('up', up)).toBe('as_called');
    expect(calledIt('down', up)).toBe('against');
    expect(calledIt('up', flat)).toBe('flat');
    expect(calledLine('up', up)).toBe('Moved up, as called.');
    expect(calledLine('down', up)).toBe('Moved up, against the call.');
    expect(calledLine('down', flat)).toBe('The price did not move.');
    expect(calledLine('up', null)).toBe(NOT_REPORTED_YET);
  });
});

describe('timedView', () => {
  it('offers nothing until the state is read, and says why', () => {
    expect(timedView({ status: 'loading' }, NOTHING)).toMatchObject({
      status: 'loading',
      markets: [],
      stakes: [],
      durations: [],
      asset: null,
      stakeUsd: null,
      seconds: null,
      leverage: null,
      hold: 'Reading what can be traded.',
    });
    expect(timedView({ status: 'unavailable', message: 'Sign in to trade.' }, NOTHING)).toMatchObject({
      status: 'unavailable',
      message: 'Sign in to trade.',
      hold: 'Sign in to trade.',
      stakes: [],
    });
  });

  it("opens on the first market that can take a trade, the smallest stake and the shortest time, all the server's", () => {
    const view = timedView(READY, NOTHING);
    expect(view).toMatchObject({
      status: 'ready',
      venueLine: 'Perpl testnet · shared demo account',
      network: 'testnet',
      asset: 'BTC/USD',
      stakes: [10, 25, 50, 100],
      stakeUsd: 10,
      durations: [60, 300, 900, 3600],
      seconds: 60,
      leverage: 5,
      slippage: '1.00%',
      hold: null,
    });
    expect(view.markets.map((m) => [m.base, m.leverage, m.tag])).toEqual([
      ['BTC', 5, null],
      ['ETH', 3, null],
      ['SOL', 5, 'CLOSED'],
    ]);
  });

  it('skips a busy market when nothing is picked', () => {
    const state = withMarkets([
      { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: T0 } },
      { asset: 'ETH/USD', open: true, leverage: 3, busy: null },
    ]);
    expect(timedView(state, NOTHING)).toMatchObject({ asset: 'ETH/USD', leverage: 3, hold: null });
  });

  it('keeps what was picked, and uses the leverage of the market picked', () => {
    expect(timedView(READY, { asset: 'eth/usd', stakeUsd: 50, seconds: 900 })).toMatchObject({
      asset: 'ETH/USD',
      stakeUsd: 50,
      seconds: 900,
      leverage: 3,
      hold: null,
    });
  });

  it('falls back to what is offered when a pick no longer is', () => {
    expect(timedView(READY, { asset: 'DOGE/USD', stakeUsd: 40, seconds: 120 })).toMatchObject({
      asset: 'BTC/USD',
      stakeUsd: 25,
      seconds: 60,
    });
  });

  it('says why a busy market cannot take a trade, and when it frees', () => {
    const until = T0 + 60_000;
    const state = withMarkets([
      { asset: 'BTC/USD', open: true, leverage: 5, busy: { until } },
      { asset: 'ETH/USD', open: true, leverage: 3, busy: { until: null } },
      { asset: 'SOL/USD', open: false, leverage: 5, busy: null },
    ]);
    const btc = timedView(state, { ...NOTHING, asset: 'BTC/USD' });
    expect(btc.hold).toBe(`BTC is in a trade until ${formatClockTime(until)}. A market takes one timed trade at a time.`);
    expect(btc.markets.map((m) => [m.tag, m.busyLine])).toEqual([
      ['IN A TRADE', `In a trade until ${formatClockTime(until)}`],
      ['HELD', 'Holds a position from the chart'],
      ['CLOSED', 'The market is closed'],
    ]);
    expect(timedView(state, { ...NOTHING, asset: 'ETH/USD' }).hold).toBe(
      'ETH holds a position opened from the chart. A market holds one position at a time.',
    );
    expect(timedView(state, { ...NOTHING, asset: 'SOL/USD' }).hold).toBe('The SOL market is closed.');
    expect(marketHold(READY.markets[0]!)).toBeNull();
  });

  it('holds when the server offers no market, no stake or no duration', () => {
    expect(timedView(withMarkets([]), NOTHING)).toMatchObject({
      asset: null,
      leverage: null,
      hold: 'No market is listed for timed trades right now.',
    });
    expect(timedView({ ...READY, limits: { ...READY.limits, stakesUsd: [] } }, NOTHING).hold).toBe('No stake is on offer right now.');
    expect(timedView({ ...READY, limits: { ...READY.limits, durations: [] } }, NOTHING).hold).toBe('No duration is on offer right now.');
  });
});

describe('what a choice means before it is sent', () => {
  it('states the size, the most it can lose and the slippage bound, from the server figures', () => {
    expect(choiceFacts(timedView(READY, { asset: 'BTC/USD', stakeUsd: 25, seconds: 300 }))).toEqual([
      ['Size', '$125, 5x the stake'],
      ['Closes itself', 'after 5m'],
      ['Most it can lose', '$25, ended early at that loss'],
      ['Max slippage', '1.00% in and out'],
    ]);
    expect(choiceFacts(timedView(READY, { asset: 'ETH/USD', stakeUsd: 100, seconds: 60 }))[0]).toEqual(['Size', '$300, 3x the stake']);
    expect(choiceFacts(timedView({ status: 'loading' }, NOTHING))).toEqual([]);
  });

  it('says whose account it is, once, and what the stake rule does', () => {
    expect(accountNote('testnet')).toBe(
      'Every trade goes to one account that everyone signed in shares. It holds testnet funds, not yours.',
    );
    expect(accountNote('mainnet')).toMatch(/Its funds are not yours\.$/);
    expect(CUT_NOTE).toMatch(/reaches the stake/);
  });
});

describe('the two actions', () => {
  const view = timedView(READY, { asset: 'BTC/USD', stakeUsd: 25, seconds: 60 });
  const request: TimedRequest = { asset: 'BTC/USD', direction: 'up', stakeUsd: 25, seconds: 60 };

  it('say what a press sends', () => {
    expect(openLabel(request)).toBe('Open up on BTC, 25 dollars, 1 minute');
    expect(requestOf(view, 'up')).toEqual(request);
    expect(directionAction(view, 'up', null, false)).toEqual({
      direction: 'up',
      word: 'UP',
      accessibilityLabel: 'Open up on BTC, 25 dollars, 1 minute',
      disabled: false,
      sending: false,
    });
    expect(directionAction(view, 'down', null, false)).toMatchObject({
      word: 'DOWN',
      accessibilityLabel: 'Open down on BTC, 25 dollars, 1 minute',
      disabled: false,
    });
  });

  it('lock while an order is out, and say so on the side that is out', () => {
    const sending = { action: 'open', ...request } as const;
    expect(sendingLine(sending)).toBe('Opening BTC up, $25 for 1m…');
    expect(directionAction(view, 'up', sending, true)).toMatchObject({
      accessibilityLabel: 'Opening BTC up, $25 for 1m…',
      disabled: true,
      sending: true,
    });
    expect(directionAction(view, 'down', sending, true)).toMatchObject({ disabled: true, sending: false });
    expect(sendingLine({ action: 'close', tradeId: 't1' })).toBe('Asking the server to end the trade…');
  });

  it('are off with the reason when nothing can be opened, and make no request', () => {
    const off = timedView({ status: 'unavailable', message: 'Sign in to trade.' }, NOTHING);
    expect(requestOf(off, 'up')).toBeNull();
    expect(directionAction(off, 'up', null, false)).toMatchObject({ accessibilityLabel: 'Up. Sign in to trade.', disabled: true });

    const busy = timedView(withMarkets([{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: null } }]), NOTHING);
    expect(requestOf(busy, 'down')).toBeNull();
    expect(directionAction(busy, 'down', null, false).accessibilityLabel).toBe(
      'Down. BTC holds a position opened from the chart. A market holds one position at a time.',
    );
  });
});

describe('an answer that is not a trade', () => {
  const request: TimedRequest = { asset: 'btc/usd', direction: 'down', stakeUsd: 50, seconds: 300 };

  it("is the server's sentence, unchanged, under a plain label", () => {
    const reason = 'BTC is in a timed trade on the shared account. It ends in about 12 seconds.';
    expect(openOutcomeView({ status: 'refused', reason }, request)).toEqual({
      status: 'refused',
      label: 'REFUSED',
      context: 'BTC/USD · DOWN · $50 · 5m',
      text: 'BTC is in a timed trade on the shared account. It ends in about 12 seconds.',
      // Where it is shown: the slide it was asked from.
      asset: 'BTC/USD',
      seconds: 300,
    });
    expect(openOutcomeView({ status: 'unfilled', message: 'Nothing filled.' }, request)).toMatchObject({
      label: 'NOT FILLED',
      text: 'Nothing filled.',
    });
    expect(openOutcomeView({ status: 'pending', message: 'It may still fill.' }, request)).toMatchObject({ label: 'SENT' });
    expect(openOutcomeView({ status: 'busy', message: 'Another order is on its way.' }, request)).toMatchObject({ label: 'BUSY' });
    expect(openOutcomeView({ status: 'unavailable', message: 'Off.' }, request)).toMatchObject({ label: 'UNAVAILABLE' });
    expect(openOutcomeView({ status: 'rate_limited', retryAfterMs: 1, message: 'Slow down.' }, request)).toMatchObject({
      label: 'RATE LIMITED',
    });
  });

  it('is nothing for a trade that opened, or an end the server took', () => {
    expect(openOutcomeView({ status: 'opened', trade: VIEW }, request)).toBeNull();
    expect(closeOutcomeView({ status: 'closing', tradeId: 't1' }, trade())).toBeNull();
    expect(closeOutcomeView({ status: 'refused', reason: 'That trade is not yours.' }, trade())).toEqual({
      status: 'refused',
      label: 'REFUSED',
      context: 'BTC/USD · UP · END NOW',
      text: 'That trade is not yours.',
      // An end concerns every slide of the pair.
      asset: 'BTC/USD',
      seconds: null,
    });
  });

  it('announces a trade that opened', () => {
    expect(openedLine(trade())).toBe(`Opened up on BTC. It closes itself at ${formatClockTime(T0 + 60_000)}.`);
  });
});

describe('a running trade', () => {
  it('counts down to the second it ends on, and never below zero', () => {
    expect(countdownText(T0 + 60_000, T0)).toBe('01:00');
    expect(countdownText(T0 + 60_000, T0 + 200)).toBe('01:00');
    expect(countdownText(T0 + 60_000, T0 + 18_000)).toBe('00:42');
    expect(countdownText(T0 + 60_000, T0 + 59_100)).toBe('00:01');
    expect(countdownText(T0 + 60_000, T0 + 60_000)).toBe('00:00');
    expect(countdownText(T0 + 60_000, T0 + 90_000)).toBe('00:00');
    expect(countdownText(T0 + 3_600_000, T0)).toBe('1:00:00');
    // No clock yet: it states no time rather than a wrong one.
    expect(countdownText(T0 + 60_000, 0)).toBe('--:--');
  });

  it('knows how much of its time is used', () => {
    expect(elapsedFraction(T0, T0 + 60_000, T0 + 15_000)).toBe(0.25);
    expect(elapsedFraction(T0, T0 + 60_000, T0 - 5)).toBe(0);
    expect(elapsedFraction(T0, T0 + 60_000, T0 + 999_999)).toBe(1);
    expect(elapsedFraction(T0, T0, T0)).toBe(0);
    expect(elapsedFraction(T0, T0 + 60_000, 0)).toBe(0);
  });

  it('draws as direction, pair, terms, entry and a way to end it', () => {
    expect(runningView(trade(), { due: false, sending: null, locked: false })).toEqual({
      id: 't1',
      asset: 'BTC/USD',
      direction: 'up',
      word: 'UP',
      terms: '$25 · 5x · 1m',
      label: 'RUNNING',
      closing: false,
      closesAt: `Closes at ${formatClockTime(T0 + 60_000)}`,
      note: null,
      entry: '61,234.5',
      size: '0.00204 BTC',
      openTx: null,
      end: { label: 'END NOW', accessibilityLabel: 'End the BTC up trade now', disabled: false },
    });
  });

  it('links its opening transaction once the row carries it', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const view = runningView(trade({ openTx: hash }), { due: false, sending: null, locked: false });
    expect(view.openTx).toMatchObject({ hash, short: '0xababab…abab' });
    expect(view.openTx?.url).toContain(hash);
  });

  it('cannot be ended while something is out, and says which trade is ending', () => {
    const ending = runningView(trade(), { due: false, sending: { action: 'close', tradeId: 't1' }, locked: true });
    expect(ending.end).toMatchObject({ label: 'ENDING…', disabled: true });
    const other = runningView(trade({ id: 't2' }), { due: false, sending: { action: 'close', tradeId: 't1' }, locked: true });
    expect(other.end).toMatchObject({ label: 'END NOW', disabled: true });
  });

  it('reads as closing from the moment the server takes a request to end it', () => {
    const asked = runningView(trade(), { due: false, sending: null, locked: false, asked: true });
    expect(asked).toMatchObject({ label: 'CLOSING', closing: true, note: null });
    expect(asked.end).toMatchObject({ label: 'CLOSING…', disabled: true });
  });

  it('says its time is up once it is, and gives the server its say on a delay', () => {
    const due = runningView(trade(), { due: true, sending: null, locked: false });
    expect(due).toMatchObject({ label: 'CLOSING', closing: true, note: TIME_IS_UP });
    expect(due.end).toEqual({ label: 'CLOSING…', accessibilityLabel: 'The BTC up trade is closing', disabled: true });

    const closing = runningView(trade({ status: 'closing' }), { due: false, sending: null, locked: false });
    expect(closing).toMatchObject({ label: 'CLOSING', closing: true, note: null });

    const delayed = runningView(trade({ status: 'closing', reason: 'The venue has not filled the close. Trying again.' }), {
      due: true,
      sending: null,
      locked: false,
    });
    expect(delayed.note).toBe('The venue has not filled the close. Trying again.');
  });

  it('reads the price now against its entry, as a move and not as money', () => {
    expect(liveMove(trade(), null)).toBeNull();
    expect(liveMove(trade(), price(612400))).toEqual({
      price: '61,240.0',
      move: { direction: 'up', diff: '5.5', percent: '0.009%', bps: 1 },
    });
  });
});

describe('a finished trade', () => {
  const closed = timedTradeFromRow(CLOSED)!;

  it('leads with what was called and what the price did', () => {
    expect(finishedView(closed)).toEqual({
      id: 't1',
      asset: 'BTC/USD',
      direction: 'up',
      word: 'UP',
      terms: '$25 · 5x · 1m',
      ended: 'TIME UP',
      endedLine: 'Its time was up, so the server closed it.',
      entry: '61,234.5',
      exit: '61,250.0',
      move: { direction: 'up', diff: '15.5', percent: '0.025%', bps: 3 },
      called: 'Moved up, as called.',
      awaiting: false,
      at: T0 + 60_400,
      accessibilityLabel: 'Up on BTC/USD, time up. Moved up, as called. Open the details.',
    });
  });

  it('says how each ending came about', () => {
    const by = (endedBy: TimedTrade['endedBy']) => finishedView({ ...closed, endedBy });
    expect([by('time').ended, by('cut').ended, by('owner').ended, by('venue').ended, by(null).ended]).toEqual([
      'TIME UP',
      'CUT',
      'ENDED EARLY',
      'CLOSED ELSEWHERE',
      'CLOSED',
    ]);
    expect(by('cut').endedLine).toBe('It had lost its stake at the mark price, so the server ended it early.');
    expect(by('owner').endedLine).toBe('You ended it before its time.');
    expect(by('venue').endedLine).toBe('The position was already gone: closed from the chart, or liquidated by the venue.');
    expect(by(null).endedLine).toBe('It is closed.');
  });

  it('says a price moved against the call the same plain way', () => {
    expect(finishedView({ ...closed, direction: 'down' })).toMatchObject({ word: 'DOWN', called: 'Moved up, against the call.' });
  });

  it('says "Not reported yet" for the seconds before the exit price arrives', () => {
    const waiting = finishedView({ ...closed, exitPrice: null, result: null, fees: null, closeTx: null });
    expect(waiting).toMatchObject({ exit: NOT_REPORTED_YET, move: null, called: NOT_REPORTED_YET, awaiting: true });
    expect(waiting.accessibilityLabel).toBe('Up on BTC/USD, time up. The exit price is not reported yet. Open the details.');
    const detail = finishedDetail({ ...closed, exitPrice: null, result: null, fees: null, closeTx: null });
    expect(Object.fromEntries(detail.facts)).toMatchObject({
      Exit: NOT_REPORTED_YET,
      'Price move': NOT_REPORTED_YET,
      'Result after fees': NOT_REPORTED_YET,
      Fees: NOT_REPORTED_YET,
    });
    expect(detail.closeTx).toBeNull();
    expect(detail.openTx).not.toBeNull();
  });

  it('keeps the money result out of the row and the card', () => {
    const text = JSON.stringify(finishedView(closed));
    expect(text).not.toMatch(/AUSD/);
    expect(text).not.toContain('0.31');
  });

  it('states everything in its detail, the result as one row among rows, with both transactions', () => {
    const detail = finishedDetail(closed);
    expect(detail.facts).toEqual([
      ['Opened', formatClockTime(T0)],
      ['Closed', formatClockTime(T0 + 60_400)],
      ['Ran for', '1m 00s'],
      ['Stake', '$25'],
      ['Size', '0.00204 BTC · 5x'],
      ['Entry', '61,234.5'],
      ['Exit', '61,250.0'],
      ['Price move', 'Up 15.5 · 0.025%'],
      ['Result after fees', '+0.31 AUSD'],
      ['Fee', '0.0875 AUSD'],
    ]);
    expect(detail.openTx).toMatchObject({ hash: CLOSED.openTx, short: '0xababab…abab' });
    expect(detail.openTx?.url).toContain(CLOSED.openTx);
    expect(detail.closeTx?.url).toContain(CLOSED.closeTx);
  });

  it('uses the time it was due when the server gave no closing time', () => {
    const detail = finishedDetail({ ...closed, closedAt: null });
    expect(Object.fromEntries(detail.facts)).toMatchObject({ Closed: formatClockTime(T0 + 60_000), 'Ran for': '1m 00s' });
  });
});

describe('copy', () => {
  it('uses no exclamation mark, no em dash and no gambling word anywhere', () => {
    const closed = timedTradeFromRow(CLOSED)!;
    const said = JSON.stringify([
      TIME_IS_UP,
      CUT_NOTE,
      TIMED_STATE_UNKNOWN_SHAPE,
      TIMED_OPEN_UNKNOWN_SHAPE,
      TIMED_CLOSE_UNKNOWN_SHAPE,
      accountNote('testnet'),
      timedView(READY, NOTHING),
      timedView({ status: 'loading' }, NOTHING),
      choiceFacts(timedView(READY, NOTHING)),
      runningView(trade(), { due: true, sending: null, locked: false }),
      (['time', 'cut', 'owner', 'venue'] as const).map((endedBy) => finishedView({ ...closed, endedBy })),
      finishedDetail(closed),
      rateLimitedLine(4000),
    ]);
    expect(said).not.toMatch(/!|—/);
    expect(said).not.toMatch(/\b(bet|bets|win|wins|won|lose the bet|jackpot|gamble|payout|wager|odds)\b/i);
    expect(said).not.toMatch(/\b(sorry|oops|unfortunately|error|failed)\b/i);
  });
});

describe('stateRecheck', () => {
  it('has nothing to wait for while no market is in a timed trade', () => {
    expect(stateRecheck({ status: 'loading' }, T0)).toBeNull();
    expect(stateRecheck(READY, T0)).toBeNull();
    expect(stateRecheck(withMarkets([{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: null } }]), T0)).toBeNull();
  });

  it('reads again just after the soonest trade holding a market is due', () => {
    const state = withMarkets([
      { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: T0 + 300_000 } },
      { asset: 'ETH/USD', open: true, leverage: 3, busy: { until: T0 + 42_000 } },
    ]);
    expect(stateRecheck(state, T0)).toEqual({ delayMs: 42_000 + BUSY_GRACE_MS, overdue: false });
    expect(stateRecheck(state, T0 + 42_500)).toEqual({ delayMs: BUSY_GRACE_MS - 500, overdue: false });
  });

  it('reads again after a short wait when a market is still held past its time', () => {
    const state = withMarkets([{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until: T0 } }]);
    expect(stateRecheck(state, T0 + BUSY_GRACE_MS)).toEqual({ delayMs: OVERDUE_RECHECK_MS, overdue: true });
  });
});
