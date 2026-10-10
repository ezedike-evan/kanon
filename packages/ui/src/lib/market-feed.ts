/**
 * A client for the market data gateway (`packages/gateway`): the venue's
 * candles and prices, for the browser and the phone alike.
 *
 * Framework-free on purpose. It uses `fetch` and `WebSocket` and nothing else,
 * so the same file runs under Next, under React Native and in a test. The React
 * side is `venue-chart-reads.ts` and `venue-ticker-reads.ts`.
 *
 * What it holds:
 *   - the venue's market list (`/v1/pub/context`), read once, which turns an
 *     app asset (`BTC/USD`) into a venue market and its price scale;
 *   - one socket for the whole app, opened by the first subscription. A stream
 *     is subscribed once however many stores read it, and its state is shared,
 *     because the gateway sends a snapshot only to a socket that is new to the
 *     stream;
 *   - a store per thing a screen shows (an asset's candles at a timeframe, a
 *     pair's price), shaped for `useSyncExternalStore`.
 *
 * Creating a feed opens nothing. A store does its work while something is
 * subscribed to it, and lets go a few seconds after the last listener leaves.
 *
 * Prices stay the venue's integers, scaled by the market's `priceDecimals`.
 * Nothing in this file divides one.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One venue candle. `t` is its open time in milliseconds; prices are scaled integers. */
export interface VenueCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface VenueMarket {
  id: number;
  /** `BTC` on testnet; empty on mainnet, where `name` carries it. */
  symbol: string;
  name: string;
  /** Every price of this market is an integer scaled by this many places. */
  priceDecimals: number;
}

export interface VenueContext {
  chainId: number;
  markets: VenueMarket[];
}

/** A market's newest state, as far as a pair row needs it. Prices are scaled integers. */
export interface VenueTicker {
  /** The app asset it was asked for as, e.g. `BTC/USD`. */
  asset: string;
  market: VenueMarket;
  /** The last traded price. A candle's close is this same number. */
  last: number;
  /** The price 24 hours earlier, or null when the venue sent none. */
  dayAgo: number | null;
  /** Milliseconds: the venue's own time on the state these were read from. */
  at: number;
}

/** Candle widths the venue serves, in seconds. */
export const VENUE_RESOLUTIONS = [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400] as const;

/** The venue's limit on one REST candle request. */
export const MAX_CANDLES_PER_REQUEST = 1024;

/**
 * Candles in one history window. `series.getSeries` on Convex returns 120
 * (`DEFAULT_LIMIT`), so a chart read from the venue opens about as deep: the
 * window before the one that holds now, plus what has formed since, which is
 * 120 to 239 candles.
 */
export const HISTORY_CANDLES = 120;

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;

const WS_PATH = '/ws/v1/market-data';
const MT = { ping: 1, subscribe: 5, subscribeAck: 6, marketState: 9, candlesSnapshot: 11, candlesUpdate: 12 } as const;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
/** The gateway closes a socket that sends more than 20 frames in 10 seconds. */
const FRAME_GAP_MS = 600;
/** The most subscriptions the gateway takes in one frame, and holds for one socket. */
const MAX_SUBS_PER_FRAME = 32;
const PING_MS = 20_000;
/** A socket no store is reading is closed after this long. */
const IDLE_CLOSE_MS = 30_000;
/** How long before a stream the gateway had no room for is asked for again. */
const REFUSED_RETRY_MS = 10_000;
/** Live candles kept per stream. The oldest go first; REST fills in behind them if a store needs it. */
const LIVE_CANDLES_KEPT = 1024;

type Timer = ReturnType<typeof setTimeout>;
type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const backoff = (attempt: number): number => Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 10));
const NONE: readonly VenueCandle[] = [];

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/** `/v1/pub/context`, reduced to what the feed uses. Null when the body is not a context at all. */
export function parseContext(body: unknown): VenueContext | null {
  if (!isRecord(body) || !isRecord(body.chain) || !isInt(body.chain.chain_id) || !Array.isArray(body.markets)) {
    return null;
  }
  const markets: VenueMarket[] = [];
  for (const m of body.markets) {
    if (!isRecord(m) || !isRecord(m.config)) continue;
    const { id, symbol, name } = m;
    const decimals = m.config.price_decimals;
    // A `Decimal` carries at most 18 places; a market outside that cannot be priced here.
    if (!isInt(id) || id < 1 || typeof symbol !== 'string' || typeof name !== 'string') continue;
    if (!isInt(decimals) || decimals < 0 || decimals > 18) continue;
    markets.push({ id, symbol, name, priceDecimals: decimals });
  }
  return { chainId: body.chain.chain_id, markets };
}

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same asset. */
const normalizeAsset = (asset: string): string => asset.replace(/\s+/g, '').toUpperCase();

/** What the venue calls a market's base: its symbol, or on mainnet its name (`BTC`, `BTC Perp`). */
const venueBase = (m: VenueMarket): string =>
  (m.symbol.trim() || m.name.trim().replace(/\s+perp$/i, '')).toUpperCase();

/**
 * The venue market for an app asset (`BTC/USD`, or the bare base `BTC`), or
 * null when the venue lists none. Every venue market is quoted in dollars, so
 * any other quote has no market here.
 */
export function resolveVenueMarket(markets: readonly VenueMarket[], asset: string): VenueMarket | null {
  const [base, quote, ...rest] = normalizeAsset(asset).split('/');
  if (!base || rest.length > 0) return null;
  if (quote !== undefined && quote !== 'USD') return null;
  return markets.find((m) => venueBase(m) === base) ?? null;
}

/**
 * The usable rows of a candle frame or REST body: oldest first, one per open
 * time. A row that is not whole numbers on this candle width's grid is dropped
 * rather than repaired.
 */
export function parseCandles(rows: unknown, stepMs: number): VenueCandle[] {
  if (!Array.isArray(rows)) return [];
  const out: VenueCandle[] = [];
  let ordered = true;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const { t, o, h, l, c } = row;
    if (!isInt(t) || t < 0 || t % stepMs !== 0 || !isInt(o) || !isInt(h) || !isInt(l) || !isInt(c)) continue;
    const last = out[out.length - 1];
    if (last && t <= last.t) ordered = false;
    out.push({ t, o, h, l, c });
  }
  if (ordered) return out;
  const byTime = new Map<number, VenueCandle>();
  for (const candle of out) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

const sameCandle = (a: VenueCandle, b: VenueCandle): boolean =>
  a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c;

const sameCandles = (a: readonly VenueCandle[], b: readonly VenueCandle[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i] || (c.t === b[i]!.t && sameCandle(c, b[i]!)));

/**
 * Two candle lists as one, by open time, both oldest first. Where both hold a
 * candle, `over` wins. A candle that did not change keeps the object it had,
 * so a caller can tell "nothing moved" by identity.
 */
export function mergeCandles(base: readonly VenueCandle[], over: readonly VenueCandle[]): readonly VenueCandle[] {
  if (over.length === 0) return base;
  if (base.length === 0) return over;
  const out: VenueCandle[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < over.length) {
    const a = base[i]!;
    const b = over[j]!;
    if (a.t < b.t) {
      out.push(a);
      i += 1;
    } else if (a.t > b.t) {
      out.push(b);
      j += 1;
    } else {
      out.push(sameCandle(a, b) ? a : b);
      i += 1;
      j += 1;
    }
  }
  while (i < base.length) out.push(base[i++]!);
  while (j < over.length) out.push(over[j++]!);
  return out;
}

/**
 * Folds candles into wider, epoch-anchored buckets: the open of the first, the
 * close of the last, the highest high and the lowest low. This is how a 1W
 * candle is made from the venue's 1D candles; like the contract's buckets, a
 * week starts on a Thursday.
 */
export function foldCandles(candles: readonly VenueCandle[], bucketMs: number): VenueCandle[] {
  const out: VenueCandle[] = [];
  for (const candle of candles) {
    const t = Math.floor(candle.t / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      if (candle.h > last.h) last.h = candle.h;
      if (candle.l < last.l) last.l = candle.l;
      last.c = candle.c;
    } else {
      out.push({ t, o: candle.o, h: candle.h, l: candle.l, c: candle.c });
    }
  }
  return out;
}

export interface CandlePlan {
  /** The venue candle width to read, in seconds. */
  resolution: number;
  /** Candles per history window. Windows are aligned to this many candles from the epoch. */
  windowCandles: number;
  /** Set when the venue has no candle this wide: fold what is read into buckets of this many seconds. */
  foldSeconds: number | null;
}

/**
 * How a chart timeframe is read from the venue, or null when it cannot be.
 * Every timeframe but 1W is a venue width. 1W is folded from 1D: 120 weeks of
 * days is 840 candles, inside one request, and a multiple of seven, so a window
 * never splits a week.
 */
export function candlePlan(bucketSeconds: number): CandlePlan | null {
  if (bucketSeconds === WEEK_SECONDS) {
    const days = Math.min(HISTORY_CANDLES * 7, MAX_CANDLES_PER_REQUEST);
    return { resolution: DAY_SECONDS, windowCandles: days - (days % 7), foldSeconds: WEEK_SECONDS };
  }
  if ((VENUE_RESOLUTIONS as readonly number[]).includes(bucketSeconds)) {
    return { resolution: bucketSeconds, windowCandles: HISTORY_CANDLES, foldSeconds: null };
  }
  return null;
}

/**
 * One market's entry in a `market-state` frame, as a ticker. Null when the
 * venue has sent no last price or no time for it: there is then nothing to
 * show, and nothing is made up in its place.
 */
export function tickerFromState(asset: string, market: VenueMarket, state: Json): VenueTicker | null {
  const { lst, prv, at } = state;
  if (!isInt(lst) || lst <= 0 || !isRecord(at) || !isInt(at.t)) return null;
  return { asset, market, last: lst, dayAgo: isInt(prv) && prv > 0 ? prv : null, at: at.t };
}

const sameTicker = (a: VenueTicker, b: VenueTicker): boolean =>
  a.last === b.last && a.dayAgo === b.dayAgo && a.at === b.at && a.market === b.market;

function firstAtOrAfter(candles: readonly VenueCandle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// What a caller injects
// ---------------------------------------------------------------------------

/** As much of `fetch` as the feed uses. */
export type FeedFetch = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

/** As much of a `WebSocket` as the feed uses. The browser's and React Native's both fit. */
export interface FeedSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}

export type FeedSocketConstructor = new (url: string) => FeedSocket;

export interface MarketFeedOptions {
  /** The gateway's address, e.g. `http://localhost:8787`. */
  baseUrl: string;
  /** Defaults to the global `fetch`. */
  fetch?: FeedFetch | undefined;
  /** Defaults to the global `WebSocket`. */
  WebSocket?: FeedSocketConstructor | undefined;
  /** Milliseconds since the epoch. History windows are aligned against it. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** How long a store nobody is reading keeps its data and its stream. */
  lingerMs?: number | undefined;
  /** How long a chart waits for the socket's snapshot before asking REST for the newest candles. */
  tailWaitMs?: number | undefined;
}

/** What `useSyncExternalStore` needs. `getSnapshot` returns the same object until the data changes. */
export interface FeedStore<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

export type CandleSnapshot =
  | { status: 'loading' }
  /** The venue lists no market for the asset, or has no candles this wide. Definite, not a failure. */
  | { status: 'unlisted' }
  /** Oldest first, at the width that was asked for. May be empty: a listed market with no candles yet. */
  | { status: 'ready'; market: VenueMarket; candles: readonly VenueCandle[] };

export type TickersSnapshot =
  | { status: 'loading' }
  /** The assets that were asked for and that the venue has a price for, in the order asked. */
  | { status: 'ready'; tickers: readonly VenueTicker[] };

export type TickerSnapshot =
  | { status: 'loading' }
  /** The venue lists no market for the asset, or has sent no price for it. */
  | { status: 'unlisted' }
  | { status: 'ready'; ticker: VenueTicker };

export interface MarketFeed {
  /** Candles of `asset` at a chart timeframe, history and live as one list. */
  candles(asset: string, bucketSeconds: number): FeedStore<CandleSnapshot>;
  /** The newest price of each of `assets` the venue lists. */
  tickers(assets: readonly string[]): FeedStore<TickersSnapshot>;
  /** One pair's newest price. */
  ticker(asset: string): FeedStore<TickerSnapshot>;
  /** Closes the socket and stops every store. For tests and teardown. */
  close(): void;
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

interface StreamWatcher {
  onFrame(frame: Json): void;
  /** The gateway will not serve the stream: 404 for one it does not have, 429 while it is full. */
  onRefused(code: number): void;
}

/**
 * The one connection. It is told which streams are wanted and keeps the
 * gateway's idea of that in step with it: after a reconnect everything wanted
 * is asked for again, and changes made close together go out as one frame.
 */
class StreamSocket {
  private socket: FeedSocket | null = null;
  private open = false;
  private shut = false;
  private readonly watchers = new Map<string, Set<StreamWatcher>>();
  /** What this connection has been asked for. Forgotten with the connection. */
  private readonly asked = new Set<string>();
  /**
   * Streams given up while the gateway still thinks them wanted. If one is wanted again before
   * it has been told, it is asked for afresh: whoever read it dropped its state on leaving, and
   * only a new subscription brings a snapshot.
   */
  private readonly lapsed = new Set<string>();
  private readonly refused = new Set<string>();
  /** Something arrived since the last ping. A socket that stays silent through one is dead. */
  private heard = false;
  private attempts = 0;
  private cooling = false;
  private syncTimer: Timer | null = null;
  private coolTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly constructorOf: () => FeedSocketConstructor | undefined,
  ) {}

  watch(stream: string, watcher: StreamWatcher): () => void {
    let set = this.watchers.get(stream);
    if (!set) {
      set = new Set();
      this.watchers.set(stream, set);
    }
    set.add(watcher);
    this.wake();
    return () => {
      const current = this.watchers.get(stream);
      if (!current?.delete(watcher) || current.size > 0) return;
      this.watchers.delete(stream);
      if (this.asked.has(stream)) this.lapsed.add(stream);
      // Forgotten with its last watcher, so the next one to want it asks afresh.
      this.refused.delete(stream);
      this.wake();
    };
  }

  /** What is wanted changed: connect, tell the gateway, or start letting an unused connection go. */
  private wake(): void {
    if (this.shut) return;
    if (this.watchers.size > 0) {
      if (this.idleTimer !== null) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      if (!this.socket && this.reconnectTimer === null) this.connect();
    } else {
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.socket && this.idleTimer === null) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.watchers.size === 0) this.drop();
        }, IDLE_CLOSE_MS);
      }
    }
    if (this.open && !this.cooling && this.syncTimer === null) {
      // On the next tick, so stores that mount together share one frame.
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null;
        this.sync();
      }, 0);
    }
  }

  private connect(): void {
    const Socket = this.constructorOf();
    // No WebSocket here (a server render). History still loads over REST.
    if (!Socket) return;
    let socket: FeedSocket;
    try {
      socket = new Socket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.open = true;
      this.heard = true;
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
      this.sync();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive((event as { data?: unknown } | null)?.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.forget();
      if (this.watchers.size > 0) this.retry();
    };
    // A failed connection closes as well, and `onclose` is where that is handled.
    socket.onerror = () => {};
  }

  private retry(): void {
    if (this.shut || this.reconnectTimer !== null) return;
    // Spread out, so every client of a restarted gateway does not return in the same instant.
    const delay = backoff(this.attempts++) * (0.5 + Math.random() / 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.watchers.size > 0 && !this.socket) this.connect();
    }, delay);
  }

  /** Clears everything that belonged to the current connection. */
  private forget(): void {
    const socket = this.socket;
    if (socket) socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    this.socket = null;
    this.open = false;
    this.cooling = false;
    this.asked.clear();
    this.lapsed.clear();
    this.refused.clear();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    if (this.coolTimer !== null) clearTimeout(this.coolTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.pingTimer = this.syncTimer = this.coolTimer = this.idleTimer = null;
  }

  private drop(): void {
    const socket = this.socket;
    this.forget();
    try {
      socket?.close();
    } catch {
      // Already gone.
    }
  }

  /**
   * A phone that slept, or a network that changed, can leave a socket that
   * never reports closing. The gateway answers a ping (`mt: 1`) with a pong,
   * so silence since the last one means the connection is dead and is replaced.
   */
  private ping(): void {
    if (!this.heard) {
      this.drop();
      if (this.watchers.size > 0) this.retry();
      return;
    }
    this.heard = false;
    this.send(`{"mt":${MT.ping}}`);
  }

  private send(text: string): void {
    try {
      this.socket?.send(text);
    } catch {
      // The socket is closing; `onclose` follows and everything is asked for again.
    }
  }

  /** Sends the difference between what is wanted and what this connection has asked for. */
  private sync(): void {
    if (!this.open || this.cooling) return;
    const subs: Array<{ stream: string; subscribe: boolean }> = [];
    for (const stream of this.asked) {
      // Left and wanted again: unsubscribing first makes the subscribe below a new one.
      if (!this.watchers.has(stream) || this.lapsed.has(stream)) subs.push({ stream, subscribe: false });
    }
    for (const stream of this.watchers.keys()) {
      if (this.refused.has(stream)) continue;
      if (!this.asked.has(stream) || this.lapsed.has(stream)) subs.push({ stream, subscribe: true });
    }
    if (subs.length === 0) return;
    const batch = subs.slice(0, MAX_SUBS_PER_FRAME);
    for (const { stream, subscribe } of batch) {
      if (subscribe) this.asked.add(stream);
      else this.asked.delete(stream);
      this.lapsed.delete(stream);
    }
    this.send(JSON.stringify({ mt: MT.subscribe, subs: batch }));
    // Whatever changes before the gap is over goes in the next frame.
    this.cooling = true;
    this.coolTimer = setTimeout(() => {
      this.coolTimer = null;
      this.cooling = false;
      this.sync();
    }, FRAME_GAP_MS);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    this.heard = true;
    // A connection that delivers is a good one; the next loss starts the backoff over.
    this.attempts = 0;
    if (frame.mt === MT.subscribeAck) {
      this.acknowledge(frame.subs);
      return;
    }
    if (typeof frame.stream !== 'string') return;
    const set = this.watchers.get(frame.stream);
    if (set) for (const watcher of [...set]) watcher.onFrame(frame);
  }

  private acknowledge(subs: unknown): void {
    if (!Array.isArray(subs)) return;
    for (const sub of subs) {
      if (!isRecord(sub) || typeof sub.stream !== 'string' || !isRecord(sub.status)) continue;
      const { stream } = sub;
      const code = sub.status.code;
      if (!isInt(code) || code === 0 || !this.asked.delete(stream)) continue;
      this.refused.add(stream);
      if (code === 429) {
        // No room for it right now. A stream the gateway does not have (404) is not asked for again.
        setTimeout(() => {
          if (this.refused.delete(stream)) this.wake();
        }, REFUSED_RETRY_MS);
      }
      for (const watcher of [...(this.watchers.get(stream) ?? [])]) watcher.onRefused(code);
    }
  }

  close(): void {
    this.shut = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.drop();
  }
}

// ---------------------------------------------------------------------------
// Stream state, shared by the stores that read a stream
// ---------------------------------------------------------------------------

/**
 * What one stream has delivered, kept once for every store reading it. The
 * gateway sends a snapshot only when a socket first subscribes, so a store that
 * arrives later has to find the state already here.
 */
abstract class StreamState {
  /** The gateway said it will not serve this stream, and nothing has arrived since. */
  refused = false;
  private readonly users = new Set<() => void>();
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly socket: StreamSocket,
    private readonly stream: string,
  ) {}

  /** Starts reading with the first user and stops with the last. `onChange` runs after every frame that changed something. */
  join(onChange: () => void): () => void {
    this.users.add(onChange);
    if (!this.unwatch) {
      this.unwatch = this.socket.watch(this.stream, {
        onFrame: (frame) => {
          if (!this.apply(frame)) return;
          this.refused = false;
          this.emit();
        },
        onRefused: () => {
          this.refused = true;
          this.emit();
        },
      });
    }
    return () => {
      if (!this.users.delete(onChange) || this.users.size > 0) return;
      this.unwatch?.();
      this.unwatch = null;
      this.refused = false;
      this.reset();
    };
  }

  private emit(): void {
    for (const user of [...this.users]) user();
  }

  /** Folds a frame in. False when it changed nothing worth telling anyone. */
  protected abstract apply(frame: Json): boolean;
  protected abstract reset(): void;
}

/** The live end of one candle stream: the last snapshot, and every update since. */
class LiveCandles extends StreamState {
  candles: readonly VenueCandle[] = NONE;
  /** The open time these are complete from, or null while nothing has arrived. */
  from: number | null = null;
  /** A snapshot has arrived, so the newest candle is known even if there is none. */
  known = false;
  /** How many snapshots have arrived. Each one starts the live candles over. */
  snapshots = 0;

  constructor(
    socket: StreamSocket,
    stream: string,
    private readonly stepMs: number,
  ) {
    super(socket, stream);
  }

  protected apply(frame: Json): boolean {
    if (frame.mt === MT.candlesSnapshot) {
      // A snapshot replaces what is held: it is sent on subscribing and again after any
      // reconnect, when candles that closed in the meantime may have been missed.
      this.candles = parseCandles(frame.d, this.stepMs);
      this.from = this.candles[0]?.t ?? null;
      this.known = true;
      this.snapshots += 1;
      return true;
    }
    // An update before any snapshot has nothing to be matched against.
    if (frame.mt !== MT.candlesUpdate || !this.known) return false;
    const rows = parseCandles(frame.d, this.stepMs);
    if (rows.length === 0) return false;
    let next = mergeCandles(this.candles, rows);
    if (next.length > LIVE_CANDLES_KEPT) next = next.slice(-LIVE_CANDLES_KEPT);
    if (next.length === this.candles.length && next.every((c, i) => c === this.candles[i])) return false;
    this.candles = next;
    const first = next[0]!.t;
    if (this.from === null || first > this.from) this.from = first;
    return true;
  }

  protected reset(): void {
    this.candles = NONE;
    this.from = null;
    this.known = false;
    this.snapshots = 0;
  }
}

/** `market-state`: the first frame carries every market, later ones only those that changed. */
class MarketStates extends StreamState {
  readonly byMarket = new Map<number, Json>();
  received = false;

  protected apply(frame: Json): boolean {
    if (frame.mt !== MT.marketState || !isRecord(frame.d)) return false;
    for (const [id, state] of Object.entries(frame.d)) {
      if (isRecord(state)) this.byMarket.set(Number(id), state);
      else this.byMarket.delete(Number(id));
    }
    this.received = true;
    return true;
  }

  protected reset(): void {
    this.byMarket.clear();
    this.received = false;
  }
}

// ---------------------------------------------------------------------------
// What every store shares
// ---------------------------------------------------------------------------

type RestResult = { ok: true; body: unknown } | { ok: false; final: boolean };

class FeedCore {
  readonly now: () => number;
  readonly lingerMs: number;
  readonly tailWaitMs: number;
  readonly socket: StreamSocket;
  closed = false;

  private readonly baseUrl: string;
  private readonly fetchImpl: FeedFetch;
  private context: VenueContext | null = null;
  private readonly contextWaiters = new Set<(context: VenueContext) => void>();
  private contextBusy = false;
  private contextAttempts = 0;
  private contextTimer: Timer | null = null;
  private readonly liveCandles = new Map<string, LiveCandles>();
  private states: MarketStates | null = null;

  constructor(options: MarketFeedOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    // The globals are looked up when first used, not here: a feed is created at module load,
    // which also happens on a server that renders the page and never subscribes to anything.
    this.fetchImpl = options.fetch ?? ((url) => fetch(url));
    this.now = options.now ?? (() => Date.now());
    this.lingerMs = options.lingerMs ?? 5_000;
    this.tailWaitMs = options.tailWaitMs ?? 2_000;
    this.socket = new StreamSocket(
      `${this.baseUrl.replace(/^http/i, 'ws')}${WS_PATH}`,
      () => options.WebSocket ?? (globalThis as { WebSocket?: FeedSocketConstructor }).WebSocket,
    );
  }

  /** One GET. `final` means asking again would get the same refusal. */
  async get(path: string): Promise<RestResult> {
    try {
      const response = await new Promise<Awaited<ReturnType<FeedFetch>>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), REQUEST_TIMEOUT_MS);
        this.fetchImpl(`${this.baseUrl}${path}`).then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      if (response.status === 200) return { ok: true, body: await response.json() };
      // 429 is the gateway's own request budget and passes. Any other 4xx is about the request itself.
      const { status } = response;
      return { ok: false, final: status >= 400 && status < 500 && status !== 429 };
    } catch {
      return { ok: false, final: false };
    }
  }

  /**
   * Hands over the venue's market list: at once if it is loaded, otherwise when
   * it is. It is fetched once, and retried for as long as somebody is waiting.
   * Returns a way to stop waiting.
   */
  withContext(use: (context: VenueContext) => void): () => void {
    if (this.context) {
      use(this.context);
      return () => {};
    }
    this.contextWaiters.add(use);
    this.loadContext();
    return () => {
      this.contextWaiters.delete(use);
    };
  }

  private loadContext(): void {
    if (this.contextBusy || this.contextTimer !== null || this.closed) return;
    this.contextBusy = true;
    void this.get('/v1/pub/context').then((result) => {
      this.contextBusy = false;
      if (this.closed) return;
      const context = result.ok ? parseContext(result.body) : null;
      if (context) {
        this.context = context;
        const waiters = [...this.contextWaiters];
        this.contextWaiters.clear();
        for (const use of waiters) use(context);
        return;
      }
      // Nobody is waiting any more: the next store to ask starts a fresh attempt.
      if (this.contextWaiters.size === 0) {
        this.contextAttempts = 0;
        return;
      }
      this.contextTimer = setTimeout(() => {
        this.contextTimer = null;
        this.loadContext();
      }, backoff(this.contextAttempts++));
    });
  }

  live(marketId: number, resolution: number): LiveCandles {
    const stream = `candles@${marketId}*${resolution}`;
    let live = this.liveCandles.get(stream);
    if (!live) {
      live = new LiveCandles(this.socket, stream, resolution * 1000);
      this.liveCandles.set(stream, live);
    }
    return live;
  }

  marketStates(chainId: number): MarketStates {
    this.states ??= new MarketStates(this.socket, `market-state@${chainId}`);
    return this.states;
  }

  close(): void {
    this.closed = true;
    if (this.contextTimer !== null) clearTimeout(this.contextTimer);
    this.contextTimer = null;
    this.contextWaiters.clear();
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/**
 * A store that works only while it is read: it starts with its first listener
 * and stops a little after its last, so a timeframe flipped and flipped back,
 * or a remount, finds the data still there.
 */
abstract class LazyStore<T> implements FeedStore<T> {
  private readonly listeners = new Set<{ notify: () => void }>();
  private lingering: Timer | null = null;
  private running = false;
  private current: T;

  constructor(
    protected readonly core: FeedCore,
    private readonly idle: T,
  ) {
    this.current = idle;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    const entry = { notify: listener };
    this.listeners.add(entry);
    if (this.lingering !== null) clearTimeout(this.lingering);
    this.lingering = null;
    if (!this.running && !this.core.closed) {
      this.running = true;
      this.start();
    }
    return () => {
      if (!this.listeners.delete(entry) || this.listeners.size > 0 || !this.running) return;
      this.lingering = setTimeout(() => {
        this.lingering = null;
        this.halt();
      }, this.core.lingerMs);
    };
  };

  readonly getSnapshot = (): T => this.current;

  protected set(next: T): void {
    if (next === this.current) return;
    this.current = next;
    for (const entry of [...this.listeners]) entry.notify();
  }

  halt(): void {
    if (this.lingering !== null) clearTimeout(this.lingering);
    this.lingering = null;
    if (!this.running) return;
    this.running = false;
    this.stop();
    this.current = this.idle;
  }

  protected abstract start(): void;
  protected abstract stop(): void;
}

const LOADING = { status: 'loading' } as const;
const UNLISTED = { status: 'unlisted' } as const;
const NO_TICKERS: TickersSnapshot = { status: 'ready', tickers: [] };

interface Slot {
  /** A request is in flight, or a failed one is waiting to be retried. */
  busy: boolean;
  attempts: number;
  timer: Timer | null;
  /** The window the gateway refused outright, if it did. Not asked for again. */
  refused: number | null;
}
const newSlot = (): Slot => ({ busy: false, attempts: 0, timer: null, refused: null });

/**
 * One asset's candles at one chart timeframe.
 *
 * History is asked for in windows of `windowCandles` candles aligned to the
 * epoch, so everyone looking at the same chart asks the gateway for the same
 * URL and a window whose candles have all closed is fetched from the venue
 * once. What is shown is the window before the one that holds now, plus
 * everything since:
 *
 *   - the previous window: one REST request, asked for at once;
 *   - the current window: the socket's snapshot, which reaches back far enough
 *     for every native timeframe. When it does not (1W, read as up to 840
 *     days), or the socket is slow or refused, a second REST request covers
 *     it, up to the candle now forming. The gateway keeps that answer for a
 *     second only.
 *
 * The chart is shown as soon as the newest candle is known, from either source,
 * and never before: older history without it would present an old close as the
 * price. So the first paint waits on the socket's snapshot or on one REST
 * request, whichever lands first, and older candles arriving later only extend
 * the list at its far end.
 *
 * Without a socket the list is as REST last had it: it is not polled. The
 * socket keeps reconnecting, and its snapshot brings the chart up to date.
 */
class CandleStore extends LazyStore<CandleSnapshot> {
  private readonly plan: CandlePlan | null;
  private market: VenueMarket | null = null;
  private live: LiveCandles | null = null;
  private cancelContext: (() => void) | null = null;
  private leaveLive: (() => void) | null = null;
  /** Bumped on stop, so an answer to a request made before it is ignored. */
  private run = 0;
  /** Index of the window that holds now, as of the last look at the clock. */
  private window = Number.NaN;
  private closed: { k: number; candles: readonly VenueCandle[] } | null = null;
  /** The current window as REST had it, and how many live snapshots had arrived by then. */
  private tail: { k: number; candles: readonly VenueCandle[]; snapshots: number } | null = null;
  private base: readonly VenueCandle[] = NONE;
  private view: readonly VenueCandle[] = NONE;
  private readonly slots = { closed: newSlot(), tail: newSlot() };
  /** The socket has had its chance; ask REST for the newest candles. */
  private tailDue = false;
  private tailTimer: Timer | null = null;

  constructor(
    core: FeedCore,
    private readonly asset: string,
    bucketSeconds: number,
  ) {
    super(core, LOADING);
    this.plan = candlePlan(bucketSeconds);
  }

  protected start(): void {
    const { plan } = this;
    if (!plan) {
      this.set(UNLISTED);
      return;
    }
    this.cancelContext = this.core.withContext((context) => {
      const market = resolveVenueMarket(context.markets, this.asset);
      if (!market) {
        this.set(UNLISTED);
        return;
      }
      this.market = market;
      this.live = this.core.live(market.id, plan.resolution);
      this.leaveLive = this.live.join(this.reconcile);
      this.tailTimer = setTimeout(() => {
        this.tailTimer = null;
        this.tailDue = true;
        this.reconcile();
      }, this.core.tailWaitMs);
      this.reconcile();
    });
  }

  protected stop(): void {
    this.run += 1;
    this.cancelContext?.();
    this.leaveLive?.();
    this.cancelContext = this.leaveLive = null;
    if (this.tailTimer !== null) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    for (const slot of [this.slots.closed, this.slots.tail]) {
      if (slot.timer !== null) clearTimeout(slot.timer);
      Object.assign(slot, newSlot());
    }
    this.market = this.live = this.closed = this.tail = null;
    this.base = this.view = NONE;
    this.window = Number.NaN;
    this.tailDue = false;
  }

  /**
   * Looks at the clock and at what is held, asks for whatever is missing, and
   * publishes. Safe to call at any time; it runs after every live frame, every
   * REST answer and every retry timer.
   */
  private readonly reconcile = (): void => {
    const { plan, market, live } = this;
    if (!plan || !market || !live) return;
    const spanMs = plan.windowCandles * plan.resolution * 1000;
    // The venue closes a candle every interval, traded in or not, so once one is known its newest
    // candle says which window is current. The device clock, which may be wrong, only decides
    // what to ask for before that.
    const newest = live.candles[live.candles.length - 1];
    const k = Math.floor((newest ? newest.t : this.core.now()) / spanMs);
    if (k !== this.window) {
      // Time crossed into a new window. What was fetched for older ones is no longer shown.
      this.window = k;
      if (this.closed && this.closed.k !== k - 1) this.closed = null;
      if (this.tail && this.tail.k !== k) this.tail = null;
      this.base = mergeCandles(this.closed?.candles ?? NONE, this.tail?.candles ?? NONE);
    }
    const start = (k - 1) * spanMs;
    const covers = (t: number): boolean => live.from !== null && live.from <= t;

    if (!this.closed && !covers(start)) this.load('closed', k - 1);
    // A snapshot starts the live candles over, possibly after a long silence. A REST copy of
    // the current window read before it may stop short of where they now begin.
    const tailJoins = this.tail !== null && this.tail.snapshots === live.snapshots;
    const tailWanted = live.known ? !covers(k * spanMs) : this.tailDue || live.refused;
    if (tailWanted && !tailJoins) this.load('tail', k);

    // Nothing is shown until the newest candle is known, and "no candles" is not said while a request is still out.
    if (!live.known && !this.tail) return;
    const from = firstAtOrAfter(live.candles, start);
    const view = mergeCandles(this.base, from === 0 ? live.candles : live.candles.slice(from));
    if (view.length === 0 && (this.slots.closed.busy || this.slots.tail.busy)) return;
    // By value: history that lands after the snapshot brings its own copies of candles already
    // shown, and that is not a change.
    if (this.getSnapshot().status === 'ready' && sameCandles(view, this.view)) return;
    this.view = view;
    this.set({
      status: 'ready',
      market,
      candles: plan.foldSeconds === null ? view : foldCandles(view, plan.foldSeconds * 1000),
    });
  };

  private load(kind: 'closed' | 'tail', k: number): void {
    const { plan, market, live } = this;
    const slot = this.slots[kind];
    if (!plan || !market || !live || slot.busy || slot.refused === k) return;
    const stepMs = plan.resolution * 1000;
    const from = k * plan.windowCandles * stepMs;
    // The venue refuses a range that runs far past now, so the window still forming is asked for
    // up to its newest candle. Both ends stay on the candle grid either way.
    const to =
      kind === 'closed'
        ? from + (plan.windowCandles - 1) * stepMs
        : Math.max(Math.floor(this.core.now() / stepMs) * stepMs, from + stepMs);
    const { run } = this;
    slot.busy = true;
    void this.core.get(`/v1/market-data/${market.id}/candles/${plan.resolution}/${from}-${to}`).then((result) => {
      if (run !== this.run) return;
      if (!result.ok && !result.final) {
        slot.timer = setTimeout(() => {
          slot.timer = null;
          slot.busy = false;
          this.reconcile();
        }, backoff(slot.attempts++));
        return;
      }
      slot.busy = false;
      slot.attempts = 0;
      // An answer for a window the clock has since left is dropped; `reconcile` asks for the right one.
      if (k === (kind === 'closed' ? this.window - 1 : this.window)) {
        if (!result.ok) {
          slot.refused = k;
        } else {
          // Asked for a range it holds nothing in, the venue answers with its nearest candle
          // instead of none. Only what lies inside the range is kept.
          const candles = parseCandles(isRecord(result.body) ? result.body.d : null, stepMs).filter(
            (c) => c.t >= from && c.t <= to,
          );
          if (kind === 'closed') this.closed = { k, candles };
          else this.tail = { k, candles, snapshots: live.snapshots };
          this.base = mergeCandles(this.closed?.candles ?? NONE, this.tail?.candles ?? NONE);
        }
      }
      this.reconcile();
    });
  }
}

/** The newest price of each of a list of assets, from the one `market-state` stream. */
class TickersStore extends LazyStore<TickersSnapshot> {
  private wanted: Array<{ asset: string; market: VenueMarket }> = [];
  private states: MarketStates | null = null;
  private cancelContext: (() => void) | null = null;
  private leaveStates: (() => void) | null = null;
  /** The ticker made from each asset's state, kept so an unchanged pair keeps its object. */
  private readonly made = new Map<string, { state: Json; ticker: VenueTicker | null }>();

  constructor(
    core: FeedCore,
    private readonly assets: readonly string[],
  ) {
    super(core, LOADING);
  }

  protected start(): void {
    this.cancelContext = this.core.withContext((context) => {
      this.wanted = [];
      for (const asset of this.assets) {
        const market = resolveVenueMarket(context.markets, asset);
        if (market) this.wanted.push({ asset, market });
      }
      // Nothing asked for is listed. That is the whole answer, and it needs no stream.
      if (this.wanted.length === 0) {
        this.set(NO_TICKERS);
        return;
      }
      this.states = this.core.marketStates(context.chainId);
      this.leaveStates = this.states.join(this.publish);
      this.publish();
    });
  }

  protected stop(): void {
    this.cancelContext?.();
    this.leaveStates?.();
    this.cancelContext = this.leaveStates = this.states = null;
    this.wanted = [];
    this.made.clear();
  }

  private readonly publish = (): void => {
    const { states } = this;
    if (!states || !states.received) return;
    const tickers: VenueTicker[] = [];
    for (const { asset, market } of this.wanted) {
      const state = states.byMarket.get(market.id);
      if (!state) continue;
      let entry = this.made.get(asset);
      if (!entry || entry.state !== state) {
        const ticker = tickerFromState(asset, market, state);
        const before = entry?.ticker;
        entry = { state, ticker: before && ticker && sameTicker(before, ticker) ? before : ticker };
        this.made.set(asset, entry);
      }
      if (entry.ticker) tickers.push(entry.ticker);
    }
    const shown = this.getSnapshot();
    if (shown.status === 'ready' && shown.tickers.length === tickers.length && tickers.every((t, i) => t === shown.tickers[i])) {
      return;
    }
    this.set({ status: 'ready', tickers });
  };
}

/** One pair, read off a one-asset list: the same stream, and the same object until that pair moves. */
function oneTicker(list: FeedStore<TickersSnapshot>): FeedStore<TickerSnapshot> {
  let seen: TickersSnapshot | null = null;
  let made: TickerSnapshot = LOADING;
  return {
    subscribe: list.subscribe,
    getSnapshot() {
      const now = list.getSnapshot();
      if (now !== seen) {
        seen = now;
        const first = now.status === 'ready' ? now.tickers[0] : undefined;
        made = now.status === 'loading' ? LOADING : first ? { status: 'ready', ticker: first } : UNLISTED;
      }
      return made;
    },
  };
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

export function createMarketFeed(options: MarketFeedOptions): MarketFeed {
  const core = new FeedCore(options);
  // A store per key, made once: `useSyncExternalStore` needs the same `subscribe` every render.
  const candleStores = new Map<string, CandleStore>();
  const tickerLists = new Map<string, TickersStore>();
  const tickerStores = new Map<string, FeedStore<TickerSnapshot>>();

  const tickers = (assets: readonly string[]): TickersStore => {
    const wanted = assets.map(normalizeAsset);
    const key = wanted.join(',');
    let store = tickerLists.get(key);
    if (!store) {
      store = new TickersStore(core, wanted);
      tickerLists.set(key, store);
    }
    return store;
  };

  return {
    candles(asset, bucketSeconds) {
      const symbol = normalizeAsset(asset);
      const key = `${symbol}|${bucketSeconds}`;
      let store = candleStores.get(key);
      if (!store) {
        store = new CandleStore(core, symbol, bucketSeconds);
        candleStores.set(key, store);
      }
      return store;
    },
    tickers,
    ticker(asset) {
      const symbol = normalizeAsset(asset);
      let store = tickerStores.get(symbol);
      if (!store) {
        store = oneTicker(tickers([symbol]));
        tickerStores.set(symbol, store);
      }
      return store;
    },
    close() {
      for (const store of candleStores.values()) store.halt();
      for (const store of tickerLists.values()) store.halt();
      core.close();
    },
  };
}

/**
 * The feed for a configured gateway address, or `undefined` when none is set,
 * in which case the app keeps reading its candles from Convex. Each app passes
 * its own `*_PUBLIC_GATEWAY_URL`, already checked by `assertPublicEnv`.
 */
export function resolveMarketFeed(gatewayUrl: string | undefined): MarketFeed | undefined {
  const baseUrl = gatewayUrl?.trim();
  return baseUrl ? createMarketFeed({ baseUrl }) : undefined;
}
