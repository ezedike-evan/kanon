/**
 * Candles bucketed from a price feed.
 *
 * The feed is event-driven, not evenly spaced (docs/ARCHITECTURE.md: a 0.02%
 * deviation threshold means updates are sparse). A bucket with no ticks is
 * either absent from `candles` or, when explicitly asked, carried forward
 * flat from the prior close. Never fabricate a high or low nobody printed.
 */

import { Decimal, compareDecimal } from './decimal';

export interface Candle {
  /** Bucket index at `bucketSeconds` cadence, anchored at `originSeconds`. */
  bucketIndex: number;
  /** Bucket start, unix seconds. */
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** True when this candle carries the prior close forward with no ticks of its own. */
  synthetic: boolean;
}

export interface Series {
  asset: string;
  bucketSeconds: number;
  /** Ordered by bucketIndex, ascending. May have gaps: an absent index is an empty bucket. */
  candles: Candle[];
}

export interface PriceTick {
  timestamp: number;
  price: Decimal;
}

export interface BucketOptions {
  asset: string;
  bucketSeconds: number;
  /** Bucket boundary anchor. Default 0 (epoch-aligned). */
  originSeconds?: number;
  /**
   * When true, an empty bucket between two ticked buckets is filled with a
   * synthetic candle carrying the prior close flat (open = high = low =
   * close). It never invents a new extreme. Default false: gaps are absent.
   */
  fillGaps?: boolean;
}

export function maxDecimal(values: Decimal[]): Decimal {
  if (values.length === 0) throw new Error('maxDecimal: empty list');
  return values.reduce((m, v) => (compareDecimal(v, m) > 0 ? v : m));
}

export function minDecimal(values: Decimal[]): Decimal {
  if (values.length === 0) throw new Error('minDecimal: empty list');
  return values.reduce((m, v) => (compareDecimal(v, m) < 0 ? v : m));
}

function bucketIndexFor(timestamp: number, bucketSeconds: number, originSeconds: number): number {
  return Math.floor((timestamp - originSeconds) / bucketSeconds);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** Buckets raw timestamped ticks into candles. Pure: no clock, no I/O. */
export function bucketTicks(ticks: PriceTick[], opts: BucketOptions): Series {
  const { asset, bucketSeconds, originSeconds = 0, fillGaps = false } = opts;
  const sorted = [...ticks].sort((a, b) => a.timestamp - b.timestamp);

  const byIndex = new Map<number, PriceTick[]>();
  for (const tick of sorted) {
    const index = bucketIndexFor(tick.timestamp, bucketSeconds, originSeconds);
    const bucket = byIndex.get(index);
    if (bucket) bucket.push(tick);
    else byIndex.set(index, [tick]);
  }

  const tickedIndices = [...byIndex.keys()].sort((a, b) => a - b);
  if (tickedIndices.length === 0) return { asset, bucketSeconds, candles: [] };

  const first = tickedIndices[0]!;
  const last = tickedIndices[tickedIndices.length - 1]!;
  const span = fillGaps ? range(first, last) : tickedIndices;

  const candles: Candle[] = [];
  let priorClose: Decimal | null = null;
  for (const index of span) {
    const bucketTicksAt = byIndex.get(index);
    if (bucketTicksAt && bucketTicksAt.length > 0) {
      const prices = bucketTicksAt.map((t) => t.price);
      const close = bucketTicksAt[bucketTicksAt.length - 1]!.price;
      candles.push({
        bucketIndex: index,
        timestamp: index * bucketSeconds + originSeconds,
        open: bucketTicksAt[0]!.price,
        high: maxDecimal(prices),
        low: minDecimal(prices),
        close,
        synthetic: false,
      });
      priorClose = close;
    } else if (fillGaps && priorClose) {
      // No ticks landed in this bucket. Carry the last known close flat
      // rather than guessing at a high or low — an empty bucket has no range.
      candles.push({
        bucketIndex: index,
        timestamp: index * bucketSeconds + originSeconds,
        open: priorClose,
        high: priorClose,
        low: priorClose,
        close: priorClose,
        synthetic: true,
      });
    }
    // fillGaps but no priorClose yet (a gap before the first tick): nothing to
    // carry forward, so the bucket stays absent rather than fabricated.
  }

  return { asset, bucketSeconds, candles };
}
