/**
 * Small builders for candle-level tests. `fixtures.ts` stays untouched —
 * RULE_04 is a spec fixture, this is series-level test data.
 */

import type { Candle, Series } from './candle';
import { parseDecimal } from './decimal';

export const TEST_DECIMALS = 2;
export const TEST_BUCKET_SECONDS = 900; // 15m, matches BTC_15M_SERIES

export function p(value: string) {
  return parseDecimal(value, TEST_DECIMALS);
}

export function makeCandle(
  open: string,
  high: string,
  low: string,
  close: string,
  timestamp: number,
): Candle {
  return {
    bucketIndex: Math.floor(timestamp / TEST_BUCKET_SECONDS),
    timestamp,
    open: p(open),
    high: p(high),
    low: p(low),
    close: p(close),
    synthetic: false,
  };
}

export function makeSeries(asset: string, candles: Candle[]): Series {
  return { asset, bucketSeconds: TEST_BUCKET_SECONDS, candles };
}
