/**
 * Perpl market-data streams: which names the gateway accepts, and the state it
 * keeps per stream so a client that joins late gets a snapshot at once instead
 * of waiting for the venue.
 *
 * Only streams whose frames were observed on the wire are supported. Every
 * shape here was captured from `wss://testnet.perpl.xyz/ws/v1/market-data` on
 * 2026-10-09 and matches PerplFoundation/api-docs `websocket.md`.
 */

export const CANDLE_RESOLUTIONS = [60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] as const;

export type StreamKind = 'heartbeat' | 'market-state' | 'funding' | 'candles' | 'order-book' | 'trades';

export interface ParsedStream {
  kind: StreamKind;
  /** Canonical name, safe to splice into JSON unescaped. */
  name: string;
  /** Present on the per-market kinds. */
  marketId?: number;
}

/** Perpl `mt` values for the frames the gateway relays. */
export const MT = {
  ping: 1,
  pong: 2,
  subscribe: 5,
  subscribeAck: 6,
  marketState: 9,
  funding: 10,
  candlesSnapshot: 11,
  candlesUpdate: 12,
  bookSnapshot: 15,
  bookUpdate: 16,
  tradesSnapshot: 17,
  tradesUpdate: 18,
  heartbeat: 100,
} as const;

const CHAIN_KINDS = new Set<StreamKind>(['heartbeat', 'market-state', 'funding']);

const KIND_BY_MT: Readonly<Record<number, StreamKind>> = {
  [MT.heartbeat]: 'heartbeat',
  [MT.marketState]: 'market-state',
  [MT.funding]: 'funding',
  [MT.candlesSnapshot]: 'candles',
  [MT.candlesUpdate]: 'candles',
  [MT.bookSnapshot]: 'order-book',
  [MT.bookUpdate]: 'order-book',
  [MT.tradesSnapshot]: 'trades',
  [MT.tradesUpdate]: 'trades',
};

/** The kind of stream a data frame belongs to, from its type alone. */
export const kindOfFrame = (mt: unknown): StreamKind | undefined =>
  typeof mt === 'number' ? KIND_BY_MT[mt] : undefined;

/** Chain-wide kinds have exactly one stream per chain, so a frame's type names its stream. */
export const isChainKind = (kind: StreamKind): boolean => CHAIN_KINDS.has(kind);
const MAX_MARKET_ID = 1_000_000;

/**
 * Parses a stream name. Returns null for anything that is not exactly one of
 * the supported forms on this chain, so a malformed name never reaches the
 * venue and never costs one of the connection's few requests.
 */
export function parseStream(raw: unknown, chainId: number): ParsedStream | null {
  if (typeof raw !== 'string' || raw.length > 48) return null;
  const m = /^([a-z-]+)@(\d{1,9})(?:\*(\d{1,6}))?$/.exec(raw);
  if (!m) return null;
  const kind = m[1] as StreamKind;
  const id = Number(m[2]);
  const resolution = m[3] === undefined ? undefined : Number(m[3]);

  if (CHAIN_KINDS.has(kind)) {
    if (resolution !== undefined || id !== chainId) return null;
    return { kind, name: `${kind}@${id}` };
  }
  if (id < 1 || id > MAX_MARKET_ID) return null;
  if (kind === 'candles') {
    if (resolution === undefined || !(CANDLE_RESOLUTIONS as readonly number[]).includes(resolution)) return null;
    return { kind, name: `candles@${id}*${resolution}`, marketId: id };
  }
  if (kind === 'order-book' || kind === 'trades') {
    if (resolution !== undefined) return null;
    return { kind, name: `${kind}@${id}`, marketId: id };
  }
  return null;
}

type Frame = Record<string, unknown>;
const isRecord = (v: unknown): v is Frame => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * What the gateway remembers about one stream. `apply` folds a venue frame in;
 * `snapshot` returns a frame a newly joined client can start from, or null if
 * the venue has not sent enough yet.
 */
export interface StreamState {
  apply(frame: Frame): void;
  snapshot(): Frame | null;
}

/** heartbeat: the latest frame is the whole state. */
class LastFrameState implements StreamState {
  private last: Frame | null = null;
  apply(frame: Frame): void {
    this.last = frame;
  }
  snapshot(): Frame | null {
    return this.last;
  }
}

/**
 * market-state and funding: the first frame carries every market, later ones
 * only the markets that changed. The state is the merge.
 */
class KeyedState implements StreamState {
  private readonly byMarket = new Map<string, unknown>();
  private head: Frame | null = null;
  apply(frame: Frame): void {
    if (!isRecord(frame.d)) return;
    for (const [id, value] of Object.entries(frame.d)) {
      if (value === undefined || value === null) this.byMarket.delete(id);
      else this.byMarket.set(id, value);
    }
    this.head = frame;
  }
  snapshot(): Frame | null {
    if (!this.head) return null;
    return { ...this.head, d: Object.fromEntries(this.byMarket) };
  }
}

/** Candles kept per stream. The venue's own snapshot is 256. */
export const MAX_CANDLES = 512;

/**
 * candles: a snapshot replaces the series; an update carries the candle that
 * just closed and the one now forming, matched to the series by open time.
 */
class CandleState implements StreamState {
  private head: Frame | null = null;
  private candles: Frame[] = [];
  apply(frame: Frame): void {
    const incoming = asArray(frame.d).filter(
      (c): c is Frame => isRecord(c) && typeof c.t === 'number',
    );
    if (frame.mt === MT.candlesSnapshot) {
      this.head = frame;
      this.candles = incoming.slice(-MAX_CANDLES);
      return;
    }
    if (frame.mt !== MT.candlesUpdate || !this.head) return;
    for (const candle of incoming) {
      const t = candle.t as number;
      const last = this.candles[this.candles.length - 1];
      if (!last || t > (last.t as number)) {
        this.candles.push(candle);
        continue;
      }
      // Usually the last or second-to-last; scan back a short way for it.
      for (let i = this.candles.length - 1; i >= 0 && i >= this.candles.length - 4; i--) {
        if (this.candles[i]!.t === t) {
          this.candles[i] = candle;
          break;
        }
      }
    }
    if (this.candles.length > MAX_CANDLES) this.candles = this.candles.slice(-MAX_CANDLES);
    if (isRecord(frame.at)) this.head = { ...this.head, at: frame.at, sn: frame.sn };
  }
  snapshot(): Frame | null {
    if (!this.head) return null;
    return { ...this.head, mt: MT.candlesSnapshot, d: this.candles };
  }
}

/** Trades kept per stream. The venue's own snapshot is 32. */
export const MAX_TRADES = 64;

class TradeState implements StreamState {
  private head: Frame | null = null;
  private trades: unknown[] = [];
  apply(frame: Frame): void {
    if (frame.mt === MT.tradesSnapshot) {
      this.head = frame;
      this.trades = asArray(frame.d).slice(-MAX_TRADES);
      return;
    }
    if (frame.mt !== MT.tradesUpdate || !this.head) return;
    this.trades.push(...asArray(frame.d));
    if (this.trades.length > MAX_TRADES) this.trades = this.trades.slice(-MAX_TRADES);
    this.head = { ...this.head, sn: frame.sn };
  }
  snapshot(): Frame | null {
    if (!this.head) return null;
    return { ...this.head, mt: MT.tradesSnapshot, d: this.trades };
  }
}

interface Level {
  p: number;
  s: number;
  o: number;
}
const isLevel = (v: unknown): v is Level =>
  isRecord(v) && typeof v.p === 'number' && typeof v.s === 'number' && typeof v.o === 'number';

/**
 * order-book: a snapshot replaces both sides; an update replaces the levels it
 * names and removes those it reports with no orders.
 */
class BookState implements StreamState {
  private head: Frame | null = null;
  private readonly bid = new Map<number, Level>();
  private readonly ask = new Map<number, Level>();
  apply(frame: Frame): void {
    if (frame.mt === MT.bookSnapshot) {
      this.head = frame;
      this.bid.clear();
      this.ask.clear();
    } else if (frame.mt !== MT.bookUpdate || !this.head) {
      return;
    } else {
      this.head = { ...this.head, at: frame.at, sn: frame.sn };
    }
    this.fold(this.bid, frame.bid);
    this.fold(this.ask, frame.ask);
  }
  private fold(side: Map<number, Level>, levels: unknown): void {
    for (const level of asArray(levels)) {
      if (!isLevel(level)) continue;
      if (level.o === 0 || level.s === 0) side.delete(level.p);
      else side.set(level.p, level);
    }
  }
  snapshot(): Frame | null {
    if (!this.head) return null;
    return {
      ...this.head,
      mt: MT.bookSnapshot,
      // Best first on both sides, as the venue sends them.
      bid: [...this.bid.values()].sort((a, b) => b.p - a.p),
      ask: [...this.ask.values()].sort((a, b) => a.p - b.p),
    };
  }
}

export function createStreamState(kind: StreamKind): StreamState {
  switch (kind) {
    case 'heartbeat':
      return new LastFrameState();
    case 'market-state':
    case 'funding':
      return new KeyedState();
    case 'candles':
      return new CandleState();
    case 'trades':
      return new TradeState();
    case 'order-book':
      return new BookState();
  }
}

/**
 * Adds `"stream"` to a venue frame without re-serialising it. Clients key on
 * the name; the venue's `sid` is left in place. `name` must be canonical (from
 * `parseStream`), which guarantees it needs no escaping.
 */
export function tagFrame(name: string, rawJson: string): string {
  return `{"stream":"${name}",${rawJson.slice(1)}`;
}

/** Serialises a synthesised snapshot in the same tagged form. */
export function tagSnapshot(name: string, frame: Frame): string {
  return JSON.stringify({ stream: name, ...frame });
}
