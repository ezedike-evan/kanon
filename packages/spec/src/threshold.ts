/**
 * Settlement for a simple binary threshold market — a separate "Predict"
 * feature, not a StrategySpec predicate. It reuses the same series and
 * Decimal arithmetic so the two features cannot disagree about a price.
 *
 * Settlement is a claim about recorded samples in the window, the same
 * honesty the canonical series makes for a swing high (docs/ARCHITECTURE.md):
 * "no hit" is only reported once the series has visibility past the window's
 * close. Short of that, the window is still open and the market cannot
 * settle "no" — silence before the window ends is not evidence of anything.
 */

import type { Series } from './candle';
import { Decimal, compareDecimal } from './decimal';

export interface ThresholdMarket {
  asset: string;
  direction: 'above' | 'below';
  thresholdPrice: Decimal;
  /** Unix seconds, inclusive. */
  windowStart: number;
  /** Unix seconds, inclusive. */
  windowEnd: number;
}

export interface ThresholdSettlement {
  settled: boolean;
  hit: boolean;
  decidingPrice?: Decimal;
  decidingAt?: number;
}

/**
 * Touching the threshold counts as a hit: `direction: 'above'` settles hit on
 * high >= thresholdPrice, `'below'` on low <= thresholdPrice. The first
 * in-window candle to cross decides it — later candles cannot un-hit it.
 */
export function settleThreshold(series: Series, market: ThresholdMarket): ThresholdSettlement {
  const inWindow = series.candles.filter(
    (c) => c.timestamp >= market.windowStart && c.timestamp <= market.windowEnd,
  );

  for (const candle of inWindow) {
    const hit =
      market.direction === 'above'
        ? compareDecimal(candle.high, market.thresholdPrice) >= 0
        : compareDecimal(candle.low, market.thresholdPrice) <= 0;
    if (hit) {
      return {
        settled: true,
        hit: true,
        decidingPrice: market.direction === 'above' ? candle.high : candle.low,
        decidingAt: candle.timestamp,
      };
    }
  }

  const hasCoverageThroughEnd = series.candles.some((c) => c.timestamp >= market.windowEnd);
  return { settled: hasCoverageThroughEnd, hit: false };
}
