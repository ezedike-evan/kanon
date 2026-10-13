import { describe, expect, it } from 'vitest';
import {
  NO_FILTER,
  accountLine,
  assetOptions,
  indexOfItem,
  lineBucketSeconds,
  nextTime,
  reelItems,
  reelSlides,
  runningNote,
  runningTitle,
  sideClaim,
  slideBadge,
  slideForTrade,
  slideId,
  slideMode,
  slideQuestion,
  slideRowView,
  slideTitle,
  timeOptions,
  titleText,
} from './timed-reel';
import { DEMO_ASSETS, demoTicker } from './domain-demo';
import { SAMPLE_TIMED_STATE } from './timed-sample';
import { TIME_IS_UP, formatClockTime, timedTradeFromRow, timedView } from './timed-trade';
import type { TimedState, TimedStateView, TimedTrade } from './timed-types';

/**
 * The reel's rules, pinned down: a slide is a pair and a time, both the
 * server's; a filter narrows the slides and never reorders them; and a slide
 * shows the trade running on its pair before it offers anything.
 */

const T0 = Date.UTC(2026, 9, 10, 12, 0, 5);

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

const trade = (over: Partial<TimedTrade> = {}): TimedTrade => ({
  ...timedTradeFromRow({
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
    entryPrice: { atoms: '612345', decimals: 1 },
  })!,
  ...over,
});

describe('which slides there are', () => {
  it('is one slide per pair and time, every time of a pair before the next pair', () => {
    const slides = reelSlides(READY, NO_FILTER);
    expect(slides).toHaveLength(12);
    expect(slides.slice(0, 5).map((s) => s.id)).toEqual([
      'BTC/USD|60',
      'BTC/USD|300',
      'BTC/USD|900',
      'BTC/USD|3600',
      'ETH/USD|60',
    ]);
    expect(slides[0]).toEqual({ id: 'BTC/USD|60', asset: 'BTC/USD', base: 'BTC', seconds: 60 });
    expect(slideId(' btc / usd ', 60)).toBe('BTC/USD|60');
  });

  it("takes its pairs and its times from the server's state, and has none until that is read", () => {
    expect(assetOptions(READY)).toEqual(['BTC', 'ETH', 'SOL']);
    expect(timeOptions(READY)).toEqual([60, 300, 900, 3600]);
    for (const state of [{ status: 'loading' }, { status: 'unavailable', message: 'Sign in to trade.' }] as const) {
      expect(reelSlides(state, NO_FILTER)).toEqual([]);
      expect(assetOptions(state)).toEqual([]);
      expect(timeOptions(state)).toEqual([]);
    }
    // A state that offers other times offers other slides: none is written here.
    const odd: TimedState = { ...READY, limits: { ...READY.limits, durations: [30, 120] }, markets: [READY.markets[1]!] };
    expect(reelSlides(odd, NO_FILTER).map((s) => s.id)).toEqual(['ETH/USD|30', 'ETH/USD|120']);
  });

  it('narrows by pair, by time, or by both, and never reorders', () => {
    expect(reelSlides(READY, { asset: 'ETH', seconds: null }).map((s) => s.id)).toEqual([
      'ETH/USD|60',
      'ETH/USD|300',
      'ETH/USD|900',
      'ETH/USD|3600',
    ]);
    expect(reelSlides(READY, { asset: null, seconds: 300 }).map((s) => s.id)).toEqual(['BTC/USD|300', 'ETH/USD|300', 'SOL/USD|300']);
    expect(reelSlides(READY, { asset: 'SOL', seconds: 3600 }).map((s) => s.id)).toEqual(['SOL/USD|3600']);
    expect(reelSlides(READY, { asset: 'DOGE', seconds: null })).toEqual([]);
    expect(reelSlides(READY, { asset: null, seconds: 45 })).toEqual([]);
  });

  it('keeps the slides of a pair that cannot take a trade right now, and lists a pair once', () => {
    const state = withMarkets([
      { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: T0 } },
      { asset: 'btc/usd', open: true, leverage: 5, busy: null },
      { asset: 'SOL/USD', open: false, leverage: 5, busy: null },
    ]);
    expect(reelSlides(state, { asset: null, seconds: 60 }).map((s) => s.id)).toEqual(['BTC/USD|60', 'SOL/USD|60']);
    expect(assetOptions(state)).toEqual(['BTC', 'SOL']);
  });

  it('ends on a closing page, and has no pages for no slides', () => {
    const items = reelItems(reelSlides(READY, { asset: 'BTC', seconds: null }));
    expect(items.map((i) => i.id)).toEqual(['BTC/USD|60', 'BTC/USD|300', 'BTC/USD|900', 'BTC/USD|3600', 'end']);
    expect(items[4]).toEqual({ kind: 'end', id: 'end' });
    expect(indexOfItem(items, 'BTC/USD|900')).toBe(2);
    expect(indexOfItem(items, 'nope')).toBe(-1);
    expect(reelItems([])).toEqual([]);
  });

  it('cycles the time chip: any, each time in turn, then any again', () => {
    const times = [60, 300, 900];
    expect(nextTime(null, times)).toBe(60);
    expect(nextTime(60, times)).toBe(300);
    expect(nextTime(900, times)).toBeNull();
    expect(nextTime(45, times)).toBeNull();
    expect(nextTime(null, [])).toBeNull();
  });

  it("finds a trade's slide: its own pair and time, else any slide of its pair", () => {
    const all = reelSlides(READY, NO_FILTER);
    expect(slideForTrade(all, trade({ seconds: 300 }))?.id).toBe('BTC/USD|300');
    // The reel is filtered to another time: every slide of the pair shows the trade.
    const hours = reelSlides(READY, { asset: null, seconds: 3600 });
    expect(slideForTrade(hours, trade({ seconds: 60 }))?.id).toBe('BTC/USD|3600');
    expect(slideForTrade(reelSlides(READY, { asset: 'ETH', seconds: null }), trade())).toBeNull();
  });
});

describe('what a slide is doing', () => {
  const slide = { asset: 'BTC/USD', seconds: 300 };
  const free = timedView(READY, { asset: 'BTC/USD', stakeUsd: 25, seconds: 300 });

  it('offers its two actions when the pair is free', () => {
    expect(slideMode(slide, free, [], [])).toEqual({ kind: 'actions' });
    // Another pair's trade is none of this slide's business.
    expect(slideMode(slide, free, [trade({ asset: 'ETH/USD' })], [trade({ asset: 'ETH/USD', id: 'x' })])).toEqual({ kind: 'actions' });
  });

  it("shows the caller's running trade on every slide of its pair, whatever time the slide is for", () => {
    const running = trade({ seconds: 60 });
    for (const other of reelSlides(READY, { asset: 'BTC', seconds: null })) {
      expect(slideMode(other, free, [running], [])).toEqual({ kind: 'running', trade: running });
    }
  });

  it('puts a running trade before an ending, and an ending before a reason the pair is held', () => {
    const running = trade({ id: 'now' });
    const done = trade({ id: 'then', status: 'closed', closedAt: T0 + 60_000 });
    const until = T0 + 300_000;
    const busy = timedView(withMarkets([{ asset: 'BTC/USD', open: true, leverage: 5, busy: { until } }]), {
      asset: 'BTC/USD',
      stakeUsd: 25,
      seconds: 300,
    });
    expect(slideMode(slide, busy, [running], [done])).toEqual({ kind: 'running', trade: running });
    expect(slideMode(slide, busy, [], [done])).toEqual({ kind: 'ended', trade: done });
    expect(slideMode(slide, busy, [], [])).toEqual({
      kind: 'held',
      tag: 'IN A TRADE',
      short: `In a trade until ${formatClockTime(until)}`,
      line: `BTC is in a trade until ${formatClockTime(until)}. A market takes one timed trade at a time.`,
    });
  });

  it('says a pair holds a position from the chart, or is closed, and offers nothing', () => {
    const state = withMarkets([
      { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: null } },
      { asset: 'SOL/USD', open: false, leverage: 5, busy: null },
    ]);
    expect(slideMode(slide, timedView(state, { asset: 'BTC/USD', stakeUsd: 25, seconds: 300 }), [], [])).toEqual({
      kind: 'held',
      tag: 'HELD',
      short: 'Holds a position from the chart',
      line: 'BTC holds a position opened from the chart. A market holds one position at a time.',
    });
    expect(slideMode({ asset: 'SOL/USD' }, timedView(state, { asset: 'SOL/USD', stakeUsd: 25, seconds: 300 }), [], [])).toEqual({
      kind: 'held',
      tag: 'CLOSED',
      short: 'The market is closed',
      line: 'The SOL market is closed.',
    });
  });

  it('names where it stands in a word or two', () => {
    expect(slideBadge({ kind: 'actions' })).toBe('OPEN');
    expect(slideBadge({ kind: 'running', trade: trade() })).toBe('RUNNING');
    expect(slideBadge({ kind: 'running', trade: trade() }, true)).toBe('CLOSING');
    expect(slideBadge({ kind: 'ended', trade: trade() })).toBe('ENDED');
    expect(slideBadge({ kind: 'held', tag: 'IN A TRADE', short: '', line: '' })).toBe('IN A TRADE');
  });

  it('says SAMPLE, not OPEN, on the signed-out sample, and only where it would have said OPEN', () => {
    expect(slideBadge({ kind: 'actions' }, false, true)).toBe('SAMPLE');
    expect(slideBadge({ kind: 'running', trade: trade() }, false, true)).toBe('RUNNING');
    expect(slideBadge({ kind: 'held', tag: 'CLOSED', short: '', line: '' }, false, true)).toBe('CLOSED');
  });
});

describe('the signed-out sample', () => {
  it('is a reel of the demo pairs at every time, each free, with nothing running', () => {
    expect(SAMPLE_TIMED_STATE).toMatchObject({ status: 'ready', sample: true });
    expect(SAMPLE_TIMED_STATE.markets.map((m) => m.asset)).toEqual([...DEMO_ASSETS]);
    expect(SAMPLE_TIMED_STATE.markets.every((m) => m.open && m.busy === null)).toBe(true);
    expect(assetOptions(SAMPLE_TIMED_STATE)).toEqual(['BTC', 'ETH', 'SOL', 'MON']);

    const slides = reelSlides(SAMPLE_TIMED_STATE, NO_FILTER);
    expect(slides).toHaveLength(DEMO_ASSETS.length * SAMPLE_TIMED_STATE.limits.durations.length);
    expect(slides[0]).toEqual({ id: 'BTC/USD|60', asset: 'BTC/USD', base: 'BTC', seconds: 60 });
    // Every slide offers its two actions: no slide of the sample is held, running or ended.
    for (const slide of slides) {
      const view = timedView(SAMPLE_TIMED_STATE, { asset: slide.asset, stakeUsd: null, seconds: slide.seconds });
      expect(view.sample).toBe(true);
      expect(slideMode(slide, view, [], [])).toEqual({ kind: 'actions' });
    }
    // The pair filter and the time filter work on it as on the server's state.
    expect(reelSlides(SAMPLE_TIMED_STATE, { asset: 'ETH', seconds: 300 }).map((s) => s.id)).toEqual(['ETH/USD|300']);
  });

  it('has a demo price for every pair it lists, so no slide is drawn without one', () => {
    for (const market of SAMPLE_TIMED_STATE.markets) expect(demoTicker(market.asset).status).toBe('demo');
  });
});

describe('what a slide says', () => {
  it('asks which way the pair moves in its time, with the time as the figure', () => {
    const parts = slideTitle({ base: 'BTC', seconds: 60 });
    expect(parts.map((p) => p.mono)).toEqual([false, true, false]);
    expect(titleText(parts)).toBe('Which way does BTC move in the next 1 minute?');
    expect(slideQuestion({ base: 'ETH', seconds: 3600 })).toBe('Which way does ETH move in the next 1 hour?');
    // The figure and its unit stay together on one line.
    expect(parts[1]?.text).toBe('1 minute');
    // The market is the time: no price is named.
    expect(slideQuestion({ base: 'BTC', seconds: 900 })).not.toMatch(/\$|reach|above|below/);
  });

  it('says what a running trade is, in the place the question was', () => {
    expect(titleText(runningTitle(trade({ direction: 'down', seconds: 300 })))).toBe('BTC called down for 5 minutes.');
  });

  it('says what each press opens: a long or a short of the stake times the leverage', () => {
    const btc = timedView(READY, { asset: 'BTC/USD', stakeUsd: 25, seconds: 60 });
    const eth = timedView(READY, { asset: 'ETH/USD', stakeUsd: 100, seconds: 60 });
    expect(sideClaim(btc, 'up')).toBe('Long $125');
    expect(sideClaim(btc, 'down')).toBe('Short $125');
    expect(sideClaim(eth, 'up')).toBe('Long $300');
    expect(sideClaim(timedView({ status: 'loading' }, { asset: null, stakeUsd: null, seconds: null }), 'up')).toBeNull();
  });

  it('says whose account it is in one line', () => {
    expect(accountLine('testnet')).toBe('One testnet account that everyone signed in shares. Not your funds.');
    expect(accountLine(null)).toBe('One testnet account that everyone signed in shares. Not your funds.');
    expect(accountLine('mainnet')).toBe('One account that everyone signed in shares. Not your funds.');
  });

  it('says when a running trade closes itself, and on another time of its pair why that slide offers nothing', () => {
    const running = trade();
    const at = formatClockTime(running.expiresAt);
    expect(runningNote(running, { seconds: 60 }, false)).toBe(`Opened up on BTC. It closes itself at ${at}.`);
    expect(runningNote(running, { seconds: 300 }, false)).toBe(
      `BTC takes one timed trade at a time. This one closes itself at ${at}.`,
    );
  });

  it("says a trade's time is up, and gives the server its own words on a delay", () => {
    expect(runningNote(trade(), { seconds: 60 }, true)).toBe(TIME_IS_UP);
    const delayed = trade({ status: 'closing', reason: 'The venue has not filled the close. Trying again.' });
    expect(runningNote(delayed, { seconds: 300 }, true)).toBe('The venue has not filled the close. Trying again.');
    // Closing, with nothing said about a delay: it still says when it was due.
    expect(runningNote(trade({ status: 'closing' }), { seconds: 60 }, true)).toMatch(/^Opened up on BTC\./);
  });

  it('lists a slide as a row: its pair, its time and where it stands', () => {
    const slide = reelSlides(READY, NO_FILTER)[1]!;
    expect(slideRowView(slide, { kind: 'actions' })).toEqual({
      id: 'BTC/USD|300',
      base: 'BTC',
      time: '5m',
      state: 'Open',
      accessibilityLabel: 'Go to: Which way does BTC move in the next 5 minutes?',
    });
    expect(slideRowView(slide, { kind: 'running', trade: trade({ direction: 'down' }) }).state).toBe('DOWN running');
    expect(slideRowView(slide, { kind: 'ended', trade: trade() }).state).toBe('Just ended');
    const closed = { kind: 'held', tag: 'CLOSED', short: 'The market is closed', line: 'The BTC market is closed.' } as const;
    // A row has room for a few words, not the sentence the slide itself says.
    expect(slideRowView(slide, closed).state).toBe('The market is closed');
    // Signed out, a row that would say Open says what it is.
    expect(slideRowView(slide, { kind: 'actions' }, true).state).toBe('Sample');
    expect(slideRowView(slide, closed, true).state).toBe('The market is closed');
  });

  it('uses no exclamation mark, no em dash and no gambling word', () => {
    const said = JSON.stringify([
      slideQuestion({ base: 'BTC', seconds: 60 }),
      titleText(runningTitle(trade())),
      accountLine('testnet'),
      runningNote(trade(), { seconds: 300 }, false),
      sideClaim(timedView(READY, { asset: 'BTC/USD', stakeUsd: 25, seconds: 60 }), 'up'),
    ]);
    expect(said).not.toMatch(/!|—/);
    expect(said).not.toMatch(/\b(bet|bets|win|wins|won|jackpot|gamble|payout|wager|odds)\b/i);
  });
});

describe('the candles behind a slide', () => {
  it('are a minute wide up to a quarter of an hour, and five minutes beyond', () => {
    expect([60, 300, 900].map(lineBucketSeconds)).toEqual([60, 60, 60]);
    expect([3600, 14_400].map(lineBucketSeconds)).toEqual([300, 300]);
  });
});

describe('a trade autopilot opened, on a slide', () => {
  const auto = trade({ origin: 'autopilot', proposalId: 'p1', seconds: 900, expiresAt: T0 + 900_000 });
  const at = formatClockTime(auto.expiresAt);

  it('says who opened it in the line under the trade, on its own time and on another', () => {
    expect(runningNote(auto, { seconds: 900 }, false)).toBe(`Autopilot opened up on BTC. It closes itself at ${at}.`);
    expect(runningNote(auto, { seconds: 60 }, false)).toBe(
      `BTC takes one timed trade at a time. Autopilot opened this one. It closes itself at ${at}.`,
    );
  });

  it("still gives way to the server's own words, and to its time being up", () => {
    expect(runningNote({ ...auto, reason: 'The venue has not filled the close. Trying again.' }, { seconds: 900 }, false)).toBe(
      'The venue has not filled the close. Trying again.',
    );
    expect(runningNote(auto, { seconds: 900 }, true)).toBe(TIME_IS_UP);
  });

  it('takes its pair exactly as any running trade does: the slide shows it in place of the two actions', () => {
    const view = timedView(READY, { asset: 'BTC/USD', stakeUsd: 10, seconds: 60 });
    expect(slideMode({ asset: 'BTC/USD' }, view, [auto], [])).toEqual({ kind: 'running', trade: auto });
  });
});
