import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMIT } from '../../../backend/convex/seriesLogic';
import { MAX_CANDLES_PER_REQUEST as GATEWAY_MAX_CANDLES } from '../../../gateway/src/rest';
import { CANDLE_RESOLUTIONS } from '../../../gateway/src/streams';
import { CHART_TIMEFRAMES } from './chart-timeframes';
import {
  HISTORY_CANDLES,
  MAX_CANDLES_PER_REQUEST,
  VENUE_RESOLUTIONS,
  candlePlan,
  createMarketFeed,
  foldCandles,
  mergeCandles,
  parseCandles,
  parseContext,
  resolveMarketFeed,
  resolveVenueMarket,
  tickerFromState,
  type CandleSnapshot,
  type FeedStore,
  type MarketFeedOptions,
  type VenueCandle,
  type VenueMarket,
} from './market-feed';
import { BASE, CONTEXT, createFakeRest, createFakeSockets, venueCandle, venueRange } from './market-feed.test-util';

const M15 = 900_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** A 15m history window: 120 candles. */
const SPAN = 120 * M15;
/** The start of the window that holds the test's "now". */
const START = 16_588 * SPAN;
/** The 15m candle forming at "now": the 41st of its window. */
const FORMING = START + 40 * M15;
const NOW = FORMING + 120_000;

const BTC_15M = 'candles@16*900';
const BTC_1D = 'candles@16*86400';

const candle = (t: number, o: number, h: number, l: number, c: number): VenueCandle => ({ t, o, h, l, c });

describe('parseContext', () => {
  it('keeps the id, the names and the price scale of each market', () => {
    expect(parseContext(CONTEXT)).toEqual({
      chainId: 10143,
      markets: [
        { id: 16, symbol: 'BTC', name: 'BTC Perp', priceDecimals: 1 },
        { id: 32, symbol: 'ETH', name: 'ETH Perp', priceDecimals: 2 },
      ],
    });
  });

  it('skips a market it cannot price and refuses a body that is not a context', () => {
    const odd = { ...CONTEXT, markets: [{ id: 1, symbol: 'X', name: 'X', config: { price_decimals: 1.5 } }, { id: 2 }, CONTEXT.markets[0]] };
    expect(parseContext(odd)?.markets.map((m) => m.id)).toEqual([16]);
    expect(parseContext({ markets: [] })).toBeNull();
    expect(parseContext('nope')).toBeNull();
  });
});

describe('resolveVenueMarket', () => {
  const testnet = parseContext(CONTEXT)!.markets;
  // Mainnet leaves the symbol empty and puts the base in the name.
  const mainnet: VenueMarket[] = [
    { id: 1, symbol: '', name: 'BTC', priceDecimals: 1 },
    { id: 2, symbol: '', name: 'ETH Perp', priceDecimals: 2 },
  ];

  it('matches the base of a dollar pair, however it is spelt', () => {
    expect(resolveVenueMarket(testnet, 'BTC/USD')?.id).toBe(16);
    expect(resolveVenueMarket(testnet, 'btc / usd')?.id).toBe(16);
    expect(resolveVenueMarket(testnet, 'ETH')?.id).toBe(32);
  });

  it('falls back to the name when the symbol is empty, without its " Perp"', () => {
    expect(resolveVenueMarket(mainnet, 'BTC/USD')?.id).toBe(1);
    expect(resolveVenueMarket(mainnet, 'eth/usd')?.id).toBe(2);
  });

  it('has no market for another quote, an unlisted base or a malformed asset', () => {
    expect(resolveVenueMarket(testnet, 'BTC/EUR')).toBeNull();
    expect(resolveVenueMarket(testnet, 'BTC/USDT')).toBeNull();
    expect(resolveVenueMarket(testnet, 'DOGE/USD')).toBeNull();
    expect(resolveVenueMarket(testnet, '')).toBeNull();
    expect(resolveVenueMarket(testnet, 'BTC/USD/USD')).toBeNull();
  });
});

describe('parseCandles', () => {
  it('keeps whole-number rows on the candle grid and drops the rest', () => {
    const rows = [
      venueCandle(START, M15),
      { ...venueCandle(START + M15, M15), c: 1.5 },
      { ...venueCandle(START + 2 * M15, M15), t: START + 2 * M15 + 1 },
      { t: START + 3 * M15, o: '1', h: 1, l: 1, c: 1 },
      null,
      venueCandle(START + 4 * M15, M15),
    ];
    expect(parseCandles(rows, M15).map((c) => c.t)).toEqual([START, START + 4 * M15]);
    expect(parseCandles({ d: [] }, M15)).toEqual([]);
  });

  it('returns one candle per open time, oldest first, whatever order they came in', () => {
    const rows = [venueCandle(START + M15, M15), venueCandle(START, M15), venueCandle(START + M15, M15, 9)];
    const out = parseCandles(rows, M15);
    expect(out.map((c) => c.t)).toEqual([START, START + M15]);
    expect(out[1]!.c).toBe(venueCandle(START + M15, M15, 9).c);
  });
});

describe('mergeCandles', () => {
  const a = candle(1000, 1, 2, 0, 1);
  const b = candle(2000, 1, 2, 0, 1);
  const c = candle(3000, 1, 2, 0, 1);

  it('joins by open time, and the second list wins where both have a candle', () => {
    const b2 = candle(2000, 1, 9, 0, 8);
    const d = candle(4000, 5, 5, 5, 5);
    expect(mergeCandles([a, b, c], [b2, d])).toEqual([a, b2, c, d]);
    expect(mergeCandles([c], [a])).toEqual([a, c]);
  });

  it('keeps the object of a candle that did not change', () => {
    const merged = mergeCandles([a, b], [{ ...b }, c]);
    expect(merged[1]).toBe(b);
    expect(merged[2]).toBe(c);
  });
});

describe('foldCandles', () => {
  // 1970-01-01 was a Thursday, so an epoch-anchored week runs Thursday to Wednesday.
  const week0 = 2_962 * WEEK;
  const day = (n: number, o: number, h: number, l: number, c: number) => candle(week0 + n * DAY, o, h, l, c);

  it('makes a week of the first open, the last close, the highest high and the lowest low', () => {
    const days = [
      day(0, 100, 110, 95, 105),
      day(1, 105, 130, 101, 120),
      day(2, 120, 121, 80, 90),
      day(3, 90, 99, 85, 97),
      day(4, 97, 98, 96, 97),
      day(5, 97, 111, 97, 110),
      day(6, 110, 115, 108, 112),
    ];
    expect(foldCandles(days, WEEK)).toEqual([candle(week0, 100, 130, 80, 112)]);
  });

  it('anchors buckets to the epoch, so a week boundary splits the days either side of it', () => {
    const days = [day(5, 10, 12, 9, 11), day(6, 11, 14, 10, 13), day(7, 13, 20, 12, 19), day(8, 19, 21, 18, 20)];
    expect(foldCandles(days, WEEK)).toEqual([candle(week0, 10, 14, 9, 13), candle(week0 + WEEK, 13, 21, 12, 20)]);
    expect(new Date(week0).getUTCDay()).toBe(4);
  });

  it('leaves its input alone', () => {
    const days = [day(0, 1, 2, 0, 1), day(1, 1, 5, 0, 4)];
    const before = JSON.stringify(days);
    foldCandles(days, WEEK);
    expect(JSON.stringify(days)).toBe(before);
  });
});

describe('candlePlan', () => {
  it('reads every chart timeframe but 1W at the venue width of the same size', () => {
    for (const { bucketSeconds } of CHART_TIMEFRAMES) {
      if (bucketSeconds === 604_800) continue;
      expect(candlePlan(bucketSeconds), String(bucketSeconds)).toEqual({
        resolution: bucketSeconds,
        windowCandles: HISTORY_CANDLES,
        foldSeconds: null,
      });
    }
  });

  it('reads 1W as days folded into weeks, in windows that hold whole weeks and fit one request', () => {
    const plan = candlePlan(604_800)!;
    expect(plan).toEqual({ resolution: 86_400, windowCandles: 840, foldSeconds: 604_800 });
    expect(plan.windowCandles % 7).toBe(0);
    expect(plan.windowCandles).toBeLessThanOrEqual(MAX_CANDLES_PER_REQUEST);
  });

  it('has no plan for a width the venue does not serve', () => {
    expect(candlePlan(120)).toBeNull();
    expect(candlePlan(2_592_000)).toBeNull();
  });

  it('agrees with the gateway and with the depth Convex serves', () => {
    expect([...VENUE_RESOLUTIONS]).toEqual([...CANDLE_RESOLUTIONS]);
    expect(MAX_CANDLES_PER_REQUEST).toBe(GATEWAY_MAX_CANDLES);
    expect(HISTORY_CANDLES).toBe(DEFAULT_LIMIT);
  });
});

describe('tickerFromState', () => {
  const market: VenueMarket = { id: 16, symbol: 'BTC', name: 'BTC Perp', priceDecimals: 1 };

  it('reads the last price, the price a day earlier and the time of the state', () => {
    const state = { at: { b: 1, t: 1_791_587_479_000 }, mrk: 825_789, lst: 825_778, prv: 818_016 };
    expect(tickerFromState('BTC/USD', market, state)).toEqual({
      asset: 'BTC/USD',
      market,
      last: 825_778,
      dayAgo: 818_016,
      at: 1_791_587_479_000,
    });
  });

  it('reports no earlier price rather than a made-up one, and nothing at all without a last price or a time', () => {
    expect(tickerFromState('BTC/USD', market, { at: { t: 5_000 }, lst: 10 })?.dayAgo).toBeNull();
    expect(tickerFromState('BTC/USD', market, { at: { t: 5_000 }, lst: 10, prv: 0 })?.dayAgo).toBeNull();
    expect(tickerFromState('BTC/USD', market, { at: { t: 5_000 }, prv: 10 })).toBeNull();
    expect(tickerFromState('BTC/USD', market, { lst: 10, prv: 10 })).toBeNull();
  });
});

describe('resolveMarketFeed', () => {
  it('makes no feed without an address', () => {
    expect(resolveMarketFeed(undefined)).toBeUndefined();
    expect(resolveMarketFeed('  ')).toBeUndefined();
    expect(resolveMarketFeed('http://localhost:8787')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The feed against a fake gateway
// ---------------------------------------------------------------------------

function setup(options: Partial<MarketFeedOptions> = {}) {
  const rest = createFakeRest(() => Date.now());
  const sockets = createFakeSockets();
  const feed = createMarketFeed({ baseUrl: `${BASE}/`, fetch: rest.fetch, WebSocket: sockets.Socket, ...options });
  return { rest, sockets, feed };
}

/** Lets promises settle and runs every timer due within `ms`. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Subscribes and records every snapshot the store announces. */
function watch<T>(store: FeedStore<T>) {
  const seen: T[] = [];
  const stop = store.subscribe(() => seen.push(store.getSnapshot()));
  return { seen, stop };
}

/** The gateway's snapshot frame: the newest `count` candles, the last one still forming. */
function snapshot(stream: string, stepMs: number, count: number, lift = 7) {
  const forming = Math.floor(Date.now() / stepMs) * stepMs;
  const d = venueRange(forming - (count - 1) * stepMs, forming, stepMs, Date.now());
  d[d.length - 1] = venueCandle(forming, stepMs, lift);
  return { stream, mt: 11, sid: 1, r: stepMs / 1000, d };
}

const candlesOf = (s: CandleSnapshot): readonly VenueCandle[] => {
  if (s.status !== 'ready') throw new Error(`expected candles, got ${s.status}`);
  return s.candles;
};

/** Every step between neighbours is one candle: nothing missing, nothing twice. */
const contiguous = (candles: readonly VenueCandle[], stepMs: number): boolean =>
  candles.every((c, i) => i === 0 || c.t - candles[i - 1]!.t === stepMs);

const closedPath = `/v1/market-data/16/candles/900/${START - SPAN}-${START - M15}`;
const tailPath = `/v1/market-data/16/candles/900/${START}-${FORMING}`;

describe('createMarketFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A 15m BTC chart brought to its first paint: history loaded, socket open, snapshot in. */
  async function ready15m(options: Partial<MarketFeedOptions> = {}) {
    const env = setup(options);
    const store = env.feed.candles('BTC/USD', 900);
    const watched = watch(store);
    await tick();
    const socket = env.sockets.last;
    socket.open();
    socket.ack();
    socket.receive(snapshot(BTC_15M, M15, 60));
    return { ...env, store, socket, ...watched };
  }

  it('opens nothing until something subscribes', async () => {
    const { rest, sockets, feed } = setup();
    const store = feed.candles('BTC/USD', 900);
    await tick(60_000);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    expect(rest.paths).toEqual([]);
    expect(sockets.all).toHaveLength(0);
  });

  it('joins REST history and the socket snapshot into one list', async () => {
    const { rest, sockets, feed } = setup();
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick();

    // The market list, then the window before the current one: aligned, so everyone asks for this same URL.
    expect(rest.paths).toEqual(['/v1/pub/context', closedPath]);
    expect(sockets.last.url).toBe('ws://gateway.test/ws/v1/market-data');
    // History alone is not shown: its newest close is not the price.
    expect(store.getSnapshot().status).toBe('loading');

    sockets.last.open();
    expect(sockets.last.subs()).toEqual([[BTC_15M, true]]);
    sockets.last.ack();
    sockets.last.receive(snapshot(BTC_15M, M15, 60));

    const candles = candlesOf(store.getSnapshot());
    expect(candles).toHaveLength(120 + 41);
    expect(contiguous(candles, M15)).toBe(true);
    expect(candles[0]!.t).toBe(START - SPAN);
    expect(candles.at(-1)).toEqual(candle(FORMING, ...ohlc(venueCandle(FORMING, M15, 7))));
    // The snapshot reached back past the start of the current window, so nothing more was asked for.
    expect(rest.candlePaths()).toEqual([closedPath]);
  });

  it('is shown as soon as the newest candle is known, and history arriving later only extends the far end', async () => {
    const { rest, sockets, feed } = setup();
    rest.hold((path) => path.includes('/candles/'));
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick();
    sockets.last.open();
    sockets.last.receive(snapshot(BTC_15M, M15, 60));

    const first = candlesOf(store.getSnapshot());
    expect(first).toHaveLength(60);
    expect(first.at(-1)!.t).toBe(FORMING);

    rest.release();
    await tick();
    const second = candlesOf(store.getSnapshot());
    expect(second).toHaveLength(120 + 41);
    expect(second.slice(-41)).toEqual(first.slice(-41));
    expect(second.at(-1)).toBe(first.at(-1));
  });

  it('says nothing when late history only repeats candles the snapshot already gave', async () => {
    const { rest, sockets, feed } = setup();
    rest.hold((path) => path.includes('/candles/'));
    const store = feed.candles('BTC/USD', 900);
    const { seen } = watch(store);
    await tick();
    sockets.last.open();
    // A snapshot as deep as the venue's own: it reaches back past the whole previous window.
    sockets.last.receive(snapshot(BTC_15M, M15, 256));
    const shown = store.getSnapshot();
    expect(candlesOf(shown)).toHaveLength(120 + 41);
    seen.length = 0;

    rest.release();
    await tick();
    expect(seen).toHaveLength(0);
    expect(store.getSnapshot()).toBe(shown);
  });

  it('asks REST for the newest candles when the socket has not delivered them in time', async () => {
    const { rest, sockets, feed } = setup({ tailWaitMs: 2_000 });
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick(1_999);
    expect(rest.candlePaths()).toEqual([closedPath]);
    expect(store.getSnapshot().status).toBe('loading');

    await tick(1);
    // Up to the candle forming now and no further: the venue refuses a range that runs past it.
    expect(rest.candlePaths()).toEqual([closedPath, tailPath]);
    const candles = candlesOf(store.getSnapshot());
    expect(candles).toHaveLength(120 + 41);
    expect(contiguous(candles, M15)).toBe(true);

    // When the snapshot does come it takes over the candles it covers, and no third request is made.
    sockets.last.open();
    sockets.last.receive(snapshot(BTC_15M, M15, 60));
    await tick();
    expect(candlesOf(store.getSnapshot()).at(-1)!.c).toBe(venueCandle(FORMING, M15, 7).c);
    expect(candlesOf(store.getSnapshot())).toHaveLength(120 + 41);
    expect(rest.candlePaths()).toHaveLength(2);
  });

  it('an update replaces the forming candle and appends the next one', async () => {
    const { store, socket, seen } = await ready15m();
    await tick();
    const before = candlesOf(store.getSnapshot());
    seen.length = 0;

    // The candle that just closed, with its final values, and the one now forming.
    socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(FORMING, M15, 20), venueCandle(FORMING + M15, M15)] });
    const after = candlesOf(store.getSnapshot());
    expect(seen).toHaveLength(1);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-2)).toEqual(candle(FORMING, ...ohlc(venueCandle(FORMING, M15, 20))));
    expect(after.at(-1)!.t).toBe(FORMING + M15);
    // Everything older is the very same candles, so the chart patches its tail rather than redrawing.
    expect(after.slice(0, -2).every((c, i) => c === before[i])).toBe(true);

    socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(FORMING + M15, M15, 3)] });
    const moved = candlesOf(store.getSnapshot());
    expect(moved).toHaveLength(after.length);
    expect(moved.at(-1)!.c).toBe(venueCandle(FORMING + M15, M15, 3).c);

    // The same frame again changes nothing, and says nothing.
    seen.length = 0;
    socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(FORMING + M15, M15, 3)] });
    expect(seen).toHaveLength(0);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(candlesOf(store.getSnapshot())).toBe(moved);
  });

  it('after a reconnect it subscribes again, and the fresh snapshot replaces the held candles without doubling any', async () => {
    const { rest, sockets, store, socket } = await ready15m();
    await tick();
    // A last look at the forming candle before the connection goes.
    socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(FORMING, M15, 50)] });
    expect(candlesOf(store.getSnapshot()).at(-1)!.c).toBe(venueCandle(FORMING, M15, 50).c);

    socket.lose();
    // Three candles pass while it is away, so the held copy of that candle is out of date.
    vi.setSystemTime(NOW + 3 * M15);
    await tick(1_000);
    expect(sockets.all).toHaveLength(2);
    const next = sockets.last;
    expect(next).not.toBe(socket);
    next.open();
    expect(next.subs()).toEqual([[BTC_15M, true]]);
    next.ack();
    next.receive(snapshot(BTC_15M, M15, 60));

    const candles = candlesOf(store.getSnapshot());
    expect(candles).toHaveLength(120 + 44);
    expect(contiguous(candles, M15)).toBe(true);
    expect(new Set(candles.map((c) => c.t)).size).toBe(candles.length);
    expect(candles.find((c) => c.t === FORMING)).toEqual(candle(FORMING, ...ohlc(venueCandle(FORMING, M15))));
    expect(candles.at(-1)!.t).toBe(FORMING + 3 * M15);
    expect(rest.candlePaths()).toEqual([closedPath]);
  });

  it('backs off between attempts while the gateway cannot be reached', async () => {
    const { sockets, feed } = setup();
    watch(feed.candles('BTC/USD', 900));
    await tick();
    expect(sockets.all).toHaveLength(1);
    sockets.last.lose();
    await tick(1_000);
    expect(sockets.all).toHaveLength(2);
    sockets.last.lose();
    // The second wait is at least a second, where the first was at most one.
    await tick(999);
    expect(sockets.all).toHaveLength(2);
    await tick(1_001);
    expect(sockets.all).toHaveLength(3);
  });

  it('subscribes a stream once however many are listening, and lets it go after the last one leaves', async () => {
    const { sockets, feed } = setup({ lingerMs: 5_000 });
    const day = feed.candles('BTC/USD', 86_400);
    const a = watch(day);
    const b = watch(day);
    // 1W is read from the same daily stream.
    const week = watch(feed.candles('BTC/USD', 604_800));
    await tick();
    const socket = sockets.last;
    socket.open();
    await tick(1_000);
    expect(socket.subs()).toEqual([[BTC_1D, true]]);
    expect(sockets.all).toHaveLength(1);

    a.stop();
    week.stop();
    await tick(10_000);
    expect(socket.subs()).toEqual([[BTC_1D, true]]);

    // Gone and back inside the linger: the gateway hears nothing of it.
    b.stop();
    await tick(4_000);
    const c = watch(day);
    await tick(10_000);
    expect(socket.subs()).toEqual([[BTC_1D, true]]);

    c.stop();
    await tick(4_999);
    expect(socket.subs()).toEqual([[BTC_1D, true]]);
    await tick(10);
    expect(socket.subs()).toEqual([
      [BTC_1D, true],
      [BTC_1D, false],
    ]);
    expect(day.getSnapshot()).toEqual({ status: 'loading' });

    // And a socket nobody is reading is closed, not held open.
    expect(socket.closed).toBe(false);
    await tick(30_000);
    expect(socket.closed).toBe(true);
    expect(sockets.all).toHaveLength(1);
  });

  it('asks afresh for a stream it gave up and wants again before the gateway had been told', async () => {
    const { sockets, feed } = setup({ lingerMs: 0 });
    const store = feed.candles('BTC/USD', 900);
    const first = watch(store);
    await tick();
    const socket = sockets.last;
    socket.open();
    socket.receive(snapshot(BTC_15M, M15, 60));
    expect(store.getSnapshot().status).toBe('ready');

    // Left and back while the last frame is too recent for another to follow it.
    first.stop();
    await tick(10);
    expect(store.getSnapshot().status).toBe('loading');
    watch(store);
    expect(socket.subs()).toEqual([[BTC_15M, true]]);

    // The gateway only sends a snapshot for a new subscription, so the stream is left and joined again.
    await tick(600);
    expect(socket.subs()).toEqual([
      [BTC_15M, true],
      [BTC_15M, false],
      [BTC_15M, true],
    ]);
    expect(socket.sent.filter((f) => f.mt === 5)).toHaveLength(2);
    socket.receive(snapshot(BTC_15M, M15, 60));
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('sends streams that are wanted together as one frame', async () => {
    const { sockets, feed } = setup();
    watch(feed.candles('BTC/USD', 900));
    watch(feed.candles('ETH/USD', 900));
    watch(feed.candles('BTC/USD', 3_600));
    await tick();
    sockets.last.open();
    expect(sockets.last.sent).toHaveLength(1);
    expect(sockets.last.subs()).toEqual([
      [BTC_15M, true],
      ['candles@32*900', true],
      ['candles@16*3600', true],
    ]);
  });

  it('gives a store that joins a stream already flowing the candles it has delivered', async () => {
    const { rest, sockets, feed } = setup();
    const day = feed.candles('BTC/USD', 86_400);
    watch(day);
    await tick();
    const socket = sockets.last;
    socket.open();
    socket.ack();
    socket.receive(snapshot(BTC_1D, DAY, 256));
    await tick();
    expect(day.getSnapshot().status).toBe('ready');

    // The gateway sends a snapshot only once per socket and stream. 1W arrives after it.
    const week = feed.candles('BTC/USD', 604_800);
    watch(week);
    await tick(1_000);
    expect(socket.subs()).toEqual([[BTC_1D, true]]);

    const span = 840 * DAY;
    const k = Math.floor(NOW / span);
    const today = Math.floor(NOW / DAY) * DAY;
    // 256 days do not reach the start of an 840-day window, so the rest of it comes over REST.
    expect(rest.candlePaths().filter((p) => p.includes('/86400/')).slice(-2)).toEqual([
      `/v1/market-data/16/candles/86400/${(k - 1) * span}-${k * span - DAY}`,
      `/v1/market-data/16/candles/86400/${k * span}-${today}`,
    ]);

    const days = venueRange((k - 1) * span, today, DAY, NOW);
    days[days.length - 1] = venueCandle(today, DAY, 7);
    const weeks = candlesOf(week.getSnapshot());
    expect(weeks).toEqual(foldCandles(parseCandles(days, DAY), WEEK));
    expect(weeks.every((c) => c.t % WEEK === 0)).toBe(true);
    expect(contiguous(weeks, WEEK)).toBe(true);
    // 120 whole weeks, then the weeks of the window still forming.
    expect(weeks.length).toBe(120 + Math.ceil((today - k * span + DAY) / WEEK));
  });

  it('keeps only the candles inside the range it asked for', async () => {
    const { rest, sockets, feed } = setup();
    // Asked for a range it has nothing in, the venue answers with its nearest candle.
    const stray = venueCandle(START - SPAN - 500 * M15, M15);
    rest.respondWith((path) => (path === closedPath ? { status: 200, body: { d: [stray] } } : undefined));
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick();
    sockets.last.open();
    sockets.last.receive(snapshot(BTC_15M, M15, 60));
    await tick();
    const candles = candlesOf(store.getSnapshot());
    expect(candles).toHaveLength(60);
    expect(candles[0]!.t).toBe(FORMING - 59 * M15);
  });

  it('says a market with no candles is empty only once every answer is in', async () => {
    const { rest, sockets, feed } = setup();
    rest.hold((path) => path.includes('/candles/'));
    rest.respondWith((path) => (path.includes('/candles/') ? { status: 200, body: { d: [] } } : undefined));
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick();
    sockets.last.open();
    sockets.last.receive({ stream: BTC_15M, mt: 11, d: [] });
    await tick();
    expect(store.getSnapshot().status).toBe('loading');
    rest.release();
    await tick();
    expect(candlesOf(store.getSnapshot())).toEqual([]);
  });

  it('reports an asset the venue does not list as unlisted, and reads nothing for it', async () => {
    const { rest, sockets, feed } = setup();
    const doge = feed.candles('DOGE/USD', 900);
    const euro = feed.candles('BTC/EUR', 900);
    watch(doge);
    watch(euro);
    await tick(10_000);
    expect(doge.getSnapshot()).toEqual({ status: 'unlisted' });
    expect(euro.getSnapshot()).toEqual({ status: 'unlisted' });
    expect(rest.paths).toEqual(['/v1/pub/context']);
    expect(sockets.all).toHaveLength(0);

    // A width the venue has no candles for is known without asking anyone.
    const odd = feed.candles('BTC/USD', 120);
    watch(odd);
    expect(odd.getSnapshot()).toEqual({ status: 'unlisted' });
  });

  it('loads the market list once, retrying until it has it', async () => {
    const { rest, feed } = setup();
    let failures = 2;
    rest.respondWith((path) => (path === '/v1/pub/context' && failures-- > 0 ? { status: 502, body: {} } : undefined));
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    watch(feed.candles('ETH/USD', 900));
    await tick();
    expect(rest.paths).toEqual(['/v1/pub/context']);
    await tick(1_000);
    expect(rest.paths).toEqual(['/v1/pub/context', '/v1/pub/context']);
    await tick(2_000);
    expect(rest.paths.filter((p) => p === '/v1/pub/context')).toHaveLength(3);
    expect(rest.candlePaths()).toHaveLength(2);

    watch(feed.candles('BTC/USD', 3_600));
    await tick(60_000);
    expect(rest.paths.filter((p) => p === '/v1/pub/context')).toHaveLength(3);
  });

  it('retries a history request the gateway could not answer, and not one it refused', async () => {
    const { rest, sockets, feed } = setup({ tailWaitMs: 100 });
    let busy = 1;
    rest.respondWith((path) => {
      if (path === closedPath && busy-- > 0) return { status: 429, body: { error: 'gateway is busy, retry shortly' } };
      if (path === tailPath) return { status: 400, body: { error: 'bad request' } };
      return undefined;
    });
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick(100);
    expect(rest.candlePaths()).toEqual([closedPath, tailPath]);
    await tick(60_000);
    expect(rest.candlePaths()).toEqual([closedPath, tailPath, closedPath]);
    // Without the newest candles there is still nothing honest to show.
    expect(store.getSnapshot().status).toBe('loading');
    sockets.last.open();
    sockets.last.receive(snapshot(BTC_15M, M15, 60));
    expect(candlesOf(store.getSnapshot())).toHaveLength(120 + 41);
  });

  it('falls back to REST at once when the gateway refuses the stream, and asks again when it was only full', async () => {
    const { rest, sockets, feed } = setup({ tailWaitMs: 60_000 });
    const store = feed.candles('BTC/USD', 900);
    watch(store);
    await tick();
    const socket = sockets.last;
    socket.open();
    socket.receive({ mt: 6, subs: [{ stream: BTC_15M, status: { code: 429, error: 'gateway is at its stream capacity' } }] });
    await tick();
    expect(rest.candlePaths()).toEqual([closedPath, tailPath]);
    expect(candlesOf(store.getSnapshot())).toHaveLength(120 + 41);

    await tick(9_000);
    expect(socket.subs()).toEqual([[BTC_15M, true]]);
    await tick(1_010);
    expect(socket.subs()).toEqual([
      [BTC_15M, true],
      [BTC_15M, true],
    ]);
  });

  it('replaces a socket that has gone silent', async () => {
    const { sockets, socket } = await ready15m();
    await tick(20_000);
    expect(socket.sent.at(-1)).toEqual({ mt: 1 });
    socket.receive({ mt: 2 });
    await tick(20_000);
    expect(socket.closed).toBe(false);
    // No answer to this ping, nor anything else, by the time the next is due.
    await tick(20_000);
    expect(socket.closed).toBe(true);
    await tick(1_000);
    expect(sockets.all).toHaveLength(2);
  });

  it('moves on to the next window when the clock does, without asking REST for what the socket already gave it', async () => {
    const { rest, store, socket } = await ready15m();
    await tick();
    // Candle after candle arrives until the first of the next window opens.
    const end = START + SPAN;
    vi.setSystemTime(end + 1_000);
    for (let t = FORMING + M15; t <= end; t += M15) socket.receive({ stream: BTC_15M, mt: 12, d: [venueCandle(t, M15)] });
    await tick();
    const candles = candlesOf(store.getSnapshot());
    expect(candles[0]!.t).toBe(START);
    expect(candles.at(-1)!.t).toBe(end);
    expect(candles).toHaveLength(121);
    expect(contiguous(candles, M15)).toBe(true);
    expect(rest.candlePaths()).toEqual([closedPath]);
  });

  it('stops everything on close', async () => {
    const { rest, sockets, feed, socket, store } = await ready15m();
    feed.close();
    expect(socket.closed).toBe(true);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    const paths = rest.paths.length;
    watch(feed.candles('ETH/USD', 900));
    await tick(120_000);
    expect(rest.paths).toHaveLength(paths);
    expect(sockets.all).toHaveLength(1);
  });

  describe('tickers', () => {
    const STATE = 'market-state@10143';
    const state = (lst: number, prv: number, t: number) => ({ at: { b: 1, t }, orl: lst, mrk: lst + 3, lst, mid: lst, bid: lst - 1, ask: lst + 1, prv });

    it('reads every pair asked for off the one market-state stream', async () => {
      const { sockets, feed } = setup();
      const list = feed.tickers(['BTC/USD', 'ETH/USD', 'DOGE/USD']);
      const btc = feed.ticker('btc / usd');
      watch(list);
      watch(btc);
      await tick();
      const socket = sockets.last;
      socket.open();
      await tick(1_000);
      expect(socket.subs()).toEqual([[STATE, true]]);
      expect(list.getSnapshot()).toEqual({ status: 'loading' });

      // The first frame carries every market.
      socket.receive({ stream: STATE, mt: 9, d: { '16': state(825_778, 818_016, 1_000_000), '32': state(248_573, 247_545, 1_000_000), '48': state(1, 1, 1) } });
      const first = list.getSnapshot();
      if (first.status !== 'ready') throw new Error('expected tickers');
      expect(first.tickers.map((t) => [t.asset, t.market.id, t.last, t.dayAgo, t.at])).toEqual([
        ['BTC/USD', 16, 825_778, 818_016, 1_000_000],
        ['ETH/USD', 32, 248_573, 247_545, 1_000_000],
      ]);
      const btcFirst = btc.getSnapshot();
      expect(btcFirst).toEqual({ status: 'ready', ticker: first.tickers[0] });

      // Later frames carry only the markets that changed. BTC did not: it keeps its object.
      socket.receive({ stream: STATE, mt: 9, d: { '32': state(248_600, 247_545, 1_002_000) } });
      const second = list.getSnapshot();
      if (second.status !== 'ready') throw new Error('expected tickers');
      expect(second).not.toBe(first);
      expect(second.tickers[0]).toBe(first.tickers[0]);
      expect(second.tickers[1]!.last).toBe(248_600);
      expect(btc.getSnapshot()).toBe(btcFirst);
    });

    it('answers for an unlisted pair from the market list alone', async () => {
      const { sockets, feed } = setup();
      const doge = feed.ticker('DOGE/USD');
      watch(doge);
      await tick(5_000);
      expect(doge.getSnapshot()).toEqual({ status: 'unlisted' });
      expect(sockets.all).toHaveLength(0);
    });

    it('a second reader of the stream starts from everything it has delivered', async () => {
      const { sockets, feed } = setup();
      watch(feed.ticker('BTC/USD'));
      await tick();
      sockets.last.open();
      sockets.last.receive({ stream: STATE, mt: 9, d: { '16': state(10, 9, 1_000), '32': state(20, 19, 1_000) } });

      const eth = feed.ticker('ETH/USD');
      watch(eth);
      await tick(1_000);
      expect(eth.getSnapshot()).toMatchObject({ status: 'ready', ticker: { last: 20, dayAgo: 19 } });
      expect(sockets.last.subs()).toEqual([[STATE, true]]);
    });
  });
});

function ohlc(c: { o: number; h: number; l: number; c: number }): [number, number, number, number] {
  return [c.o, c.h, c.l, c.c];
}
