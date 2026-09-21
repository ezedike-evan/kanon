/**
 * The pinned rule's structure, drawn on the chart.
 *
 * For each predicate of the spec this finds where on the visible series it was
 * satisfied, using the same evaluators the refusal gate is checked against
 * (`evaluatePredicate` in `packages/spec/src/evaluate.ts`), so the chart shows
 * the rule's own reading of the tape and never a second opinion. Break of
 * structure becomes the swing level that broke, a fair value gap becomes its
 * box, a liquidity sweep becomes the reference level and the wick that ran it.
 *
 * Nothing here decides anything. It is a view over evaluator output: the
 * evaluators return the first satisfying candle after `scanFrom`, so walking
 * `scanFrom` forward enumerates every occurrence.
 */
import {
  evaluatePredicate,
  type Candle,
  type Predicate,
  type PredicateResult,
  type Series,
  type StrategySpec,
} from '@kanon/spec';
import { decimalToNumber } from './chart-series';
import type { StructureItem } from './chart-protocol';

/**
 * Only the most recent candles are scanned (with some history behind them for
 * lookbacks), and only the latest occurrences kept. The evaluators re-read
 * their history for every candle, so the input is bounded to stay cheap enough
 * to run beside a live tick.
 */
export const STRUCTURE_SCAN_CANDLES = 300;
export const STRUCTURE_HISTORY_CANDLES = 900;
export const STRUCTURE_MAX_PER_PREDICATE = 5;

function occurrences(series: Series, predicate: Predicate): PredicateResult[] {
  const candles = series.candles;
  const out: PredicateResult[] = [];
  let scanFrom = candles[Math.max(0, candles.length - STRUCTURE_SCAN_CANDLES)]?.timestamp;
  if (scanFrom === undefined) return out;
  // Each evaluator call scans forward from `scanFrom` and stops at the first
  // hit, so the loop is bounded by the number of occurrences, not squared.
  for (let guard = 0; guard < 400; guard++) {
    let result: PredicateResult;
    try {
      result = evaluatePredicate(series, predicate, { scanFrom });
    } catch {
      break; // Not enough history for this predicate: nothing to draw.
    }
    if (!result.satisfied) break;
    out.push(result);
    scanFrom = result.at + 1;
  }
  return out.slice(-STRUCTURE_MAX_PER_PREDICATE);
}

function indexAt(candles: readonly Candle[], timestamp: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candles[mid]!.timestamp;
    if (t === timestamp) return mid;
    if (t < timestamp) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function computeStructure(full: Series, spec: Pick<StrategySpec, 'predicates'>): StructureItem[] {
  const series: Series = { ...full, candles: full.candles.slice(-STRUCTURE_HISTORY_CANDLES) };
  const candles = series.candles;
  const items: StructureItem[] = [];

  for (const predicate of spec.predicates) {
    for (const r of occurrences(series, predicate)) {
      const i = indexAt(candles, r.at);
      if (i < 0) continue;
      const reference = decimalToNumber(r.referenceValue);

      if (predicate.kind === 'break_of_structure') {
        const long = predicate.direction === 'long';
        const lookback = predicate.swingLookbackCandles.value;
        // The swing is the candle in the lookback window that set the extreme.
        let swing = Math.max(0, i - lookback);
        for (let k = i - 1; k >= Math.max(0, i - lookback); k--) {
          const c = candles[k]!;
          if (decimalToNumber(long ? c.high : c.low) === reference) {
            swing = k;
            break;
          }
        }
        items.push({
          kind: 'swing',
          side: long ? 'high' : 'low',
          time: candles[swing]!.timestamp,
          endTime: r.at,
          price: reference,
        });
      } else if (predicate.kind === 'fair_value_gap') {
        const c1 = candles[i - 2];
        const c3 = candles[i];
        if (!c1 || !c3) continue;
        const long = predicate.direction === 'long';
        items.push({
          kind: 'fvg',
          side: long ? 'bull' : 'bear',
          time: c1.timestamp,
          endTime: c3.timestamp,
          top: decimalToNumber(long ? c3.low : c1.low),
          bottom: decimalToNumber(long ? c1.high : c3.high),
        });
      } else {
        const low = predicate.referenceExtreme.value.endsWith('low');
        const back = candles[Math.max(0, i - 24)]!;
        items.push({
          kind: 'sweep',
          side: low ? 'low' : 'high',
          time: r.at,
          price: decimalToNumber(r.decidingValue),
          refTime: back.timestamp,
          refPrice: reference,
        });
      }
    }
  }
  return items.sort((a, b) => a.time - b.time);
}
