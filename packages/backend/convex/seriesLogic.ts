/**
 * The pure half of the price-data pipeline: turning stored ticks into a
 * `Series`, and stored trades into chart markers. No `ctx`, no clock, no I/O,
 * so every bucket boundary can be pinned down in `seriesLogic.test.ts`.
 *
 * Buckets are epoch-anchored (`originSeconds` 0), exactly like the contract's
 * `bucketIndex = publishTime / bucketSeconds` in `CanonicalSeries.sol`. That
 * is what makes the off-chain series and the on-chain one describe the same
 * candles. A consequence worth knowing: a 1W bucket starts on a Thursday,
 * because the unix epoch was one.
 */

import {
  bucketTicks,
  compareDecimal,
  roundedBps,
  subDecimal,
  type Candle,
  type Decimal,
  type PriceTick,
  type Series,
} from '@kanon/spec';

/** Candle widths a client may ask for. Anything else is refused rather than computed. */
export const ALLOWED_BUCKET_SECONDS = [60, 300, 900, 3600, 14_400, 86_400, 604_800] as const;

export const DEFAULT_LIMIT = 120;
export const MAX_LIMIT = 500;

/**
 * The most ticks one `getSeries` call reads. Ticks are event-driven (a row per
 * distinct Pyth publish time), so the horizon depends on how often the feed
 * updates: about 5.5 days at one a minute, far longer at the sponsored feeds'
 * usual pace. Past the ceiling the oldest bucket in the window is incomplete,
 * which `ticksToSeries` says out loud instead of hiding. A rolled-up candles
 * table would lift it.
 */
export const MAX_TICKS_READ = 8000;

export function isAllowedBucketSeconds(n: number): boolean {
  return (ALLOWED_BUCKET_SECONDS as readonly number[]).includes(n);
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same asset. */
export function normalizeAsset(asset: string): string {
  return asset.replace(/\s+/g, '').toUpperCase();
}

/** Start of the bucket holding `timestampSeconds`. Floors, so a boundary tick belongs to the bucket it opens. */
export function bucketStart(timestampSeconds: number, bucketSeconds: number): number {
  return Math.floor(timestampSeconds / bucketSeconds) * bucketSeconds;
}

/**
 * Where the tick read should begin so that it covers `limit` buckets ending
 * with the one that holds the latest tick.
 */
export function windowStartSeconds(
  latestPublishTime: number,
  bucketSeconds: number,
  limit: number,
): number {
  return bucketStart(latestPublishTime, bucketSeconds) - (limit - 1) * bucketSeconds;
}

export interface StoredTick {
  price: Decimal;
  publishTime: number;
}

/** A `Series` plus whether the tick read hit its ceiling. Plain data: Convex can return it as is. */
export type SeriesResult = Series & { truncated: boolean };

/**
 * Buckets stored ticks into candles.
 *
 * Empty buckets between two ticked ones are carried forward flat and flagged
 * `synthetic` by `bucketTicks`; they never invent a high or low.
 *
 * When `truncated`, the oldest tick read sits somewhere inside the oldest
 * bucket, so that candle's open, high and low are from a partial view of it.
 * It is dropped, unless it is the only candle there is.
 */
export function ticksToSeries(input: {
  asset: string;
  bucketSeconds: number;
  ticks: readonly StoredTick[];
  truncated: boolean;
}): SeriesResult {
  const { asset, bucketSeconds, ticks, truncated } = input;
  const priceTicks: PriceTick[] = ticks.map((t) => ({ timestamp: t.publishTime, price: t.price }));
  const series = bucketTicks(priceTicks, { asset, bucketSeconds, fillGaps: true });
  const candles = truncated && series.candles.length > 1 ? series.candles.slice(1) : series.candles;
  return { asset, bucketSeconds, candles, truncated };
}

// ---------------------------------------------------------------------------
// Pre-aggregated candles.
// ---------------------------------------------------------------------------

/** One stored candle: a bucket's OHLC plus the publish times of its first and last tick. */
export interface CandleRow {
  /** Bucket start, unix seconds. */
  start: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  openTime: number;
  closeTime: number;
}

/**
 * Folds one tick into the candle of its bucket. Idempotent (re-applying a tick
 * changes nothing) and order-independent (the earliest tick sets `open`, the
 * latest `close`, so a backfill may overlap live writes). Equal to what
 * `bucketTicks` computes for the same ticks.
 */
export function foldTickIntoCandle(
  row: CandleRow | null,
  tick: StoredTick,
  bucketSeconds: number,
): CandleRow {
  if (!row) {
    return {
      start: bucketStart(tick.publishTime, bucketSeconds),
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      openTime: tick.publishTime,
      closeTime: tick.publishTime,
    };
  }
  const next = { ...row };
  if (tick.publishTime < row.openTime) {
    next.open = tick.price;
    next.openTime = tick.publishTime;
  }
  if (tick.publishTime >= row.closeTime) {
    next.close = tick.price;
    next.closeTime = tick.publishTime;
  }
  if (compareDecimal(tick.price, row.high) > 0) next.high = tick.price;
  if (compareDecimal(tick.price, row.low) < 0) next.low = tick.price;
  return next;
}

/** Merges two aggregates of the same bucket. Same result as folding both tick sets into one candle. */
export function mergeCandles(a: CandleRow, b: CandleRow): CandleRow {
  const first = b.openTime < a.openTime ? b : a;
  const last = b.closeTime >= a.closeTime ? b : a;
  return {
    start: a.start,
    open: first.open,
    openTime: first.openTime,
    close: last.close,
    closeTime: last.closeTime,
    high: compareDecimal(b.high, a.high) > 0 ? b.high : a.high,
    low: compareDecimal(b.low, a.low) < 0 ? b.low : a.low,
  };
}

export function sameCandle(a: CandleRow, b: CandleRow): boolean {
  const eq = (x: Decimal, y: Decimal) => x.atoms === y.atoms && x.decimals === y.decimals;
  return (
    a.start === b.start &&
    a.openTime === b.openTime &&
    a.closeTime === b.closeTime &&
    eq(a.open, b.open) &&
    eq(a.high, b.high) &&
    eq(a.low, b.low) &&
    eq(a.close, b.close)
  );
}

/**
 * Candles from stored rows, ascending by `start`. Empty buckets between two
 * stored ones are carried forward flat and flagged `synthetic`, exactly as
 * `bucketTicks` with `fillGaps` does, so this returns what `ticksToSeries`
 * returns for the same window of ticks.
 */
export function candlesToSeries(input: {
  asset: string;
  bucketSeconds: number;
  rows: readonly CandleRow[];
}): SeriesResult {
  const { asset, bucketSeconds, rows } = input;
  const candles: Candle[] = [];
  let prior: CandleRow | null = null;
  for (const row of rows) {
    if (prior) {
      for (let s = prior.start + bucketSeconds; s < row.start; s += bucketSeconds) {
        candles.push({
          bucketIndex: s / bucketSeconds,
          timestamp: s,
          open: prior.close,
          high: prior.close,
          low: prior.close,
          close: prior.close,
          synthetic: true,
        });
      }
    }
    candles.push({
      bucketIndex: row.start / bucketSeconds,
      timestamp: row.start,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      synthetic: false,
    });
    prior = row;
  }
  return { asset, bucketSeconds, candles, truncated: false };
}

/** Ticks older than this are pruned daily. Covers the longest market window (1D) and its settlement lag many times over. */
export const TICK_RETENTION_DAYS = 14;
export const PRUNE_BATCH = 500;
/** Ticks folded into candles per backfill mutation. */
export const BACKFILL_BATCH = 200;

/** The shape `packages/ui`'s `TradeMarker` has. Restated here because the backend does not depend on the UI. */
export interface ChartMarker {
  timestamp: number;
  side: 'long' | 'short';
  kind: 'executed' | 'blocked';
}

export interface MarkableTrade {
  asset: string;
  direction: 'long' | 'short';
  status: 'proposed' | 'executed' | 'refused' | 'undone';
  /** Milliseconds, as Convex stores it. */
  createdAt: number;
}

/**
 * Executed and refused trades for one asset, each pinned to the start of the
 * candle it landed in. A proposal that was never confirmed, and one that was
 * undone, are not events on the tape and get no marker. Identical markers on
 * one bar collapse to a single mark, and the result is ascending by time.
 */
export function tradesToMarkers(
  trades: readonly MarkableTrade[],
  opts: { asset: string; bucketSeconds: number },
): ChartMarker[] {
  const asset = normalizeAsset(opts.asset);
  const seen = new Set<string>();
  const out: ChartMarker[] = [];

  for (const t of trades) {
    if (normalizeAsset(t.asset) !== asset) continue;
    let kind: ChartMarker['kind'];
    if (t.status === 'executed') kind = 'executed';
    else if (t.status === 'refused') kind = 'blocked';
    else continue;

    const timestamp = bucketStart(Math.floor(t.createdAt / 1000), opts.bucketSeconds);
    const key = `${timestamp}:${t.direction}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ timestamp, side: t.direction, kind });
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------------------------------------------------------------------------
// Tickers: the latest print and its move, for a pair list.
// ---------------------------------------------------------------------------

/** The look-back a ticker's change is measured over. */
export const TICKER_WINDOW_SECONDS = 86_400;

/**
 * What a pair row shows: the newest recorded print and how far it is from the
 * first print inside the last 24 hours. Ticks are event-driven, so "the first
 * print in the window" can be later than 24 hours ago; `openTime` says exactly
 * which print the change is measured from rather than implying a 24-hour candle.
 */
export interface TickerResult {
  asset: string;
  price: Decimal;
  /** Unix seconds of the newest print. */
  publishTime: number;
  /** The first print in the look-back window. Null when the latest print is the only one. */
  open: Decimal | null;
  openTime: number | null;
  /** Integer basis points, `(price - open) / open`. Null when there is no earlier print to compare. */
  changeBps: number | null;
}

export function tickerFrom(input: {
  asset: string;
  latest: StoredTick;
  /** The first tick at or after `latest.publishTime - TICKER_WINDOW_SECONDS`. May be `latest` itself. */
  open: StoredTick | null;
}): TickerResult {
  const { asset, latest, open } = input;
  const earlier = open && open.publishTime < latest.publishTime ? open : null;
  return {
    asset,
    price: latest.price,
    publishTime: latest.publishTime,
    open: earlier ? earlier.price : null,
    openTime: earlier ? earlier.publishTime : null,
    changeBps: earlier ? roundedBps(subDecimal(latest.price, earlier.price), earlier.price) : null,
  };
}
