/**
 * Pure predicate evaluation over a canonical series. No I/O, no clock: given a
 * series and a predicate, decide it and name the number that decided it — the
 * "refusal names the predicate and the failing number" rule from
 * docs/SCOPE.md holds for a satisfied predicate too, not only a refused one.
 *
 * Boundary conventions (all satisfied checks use these, not a looser one):
 *   - Break of structure: price must trade *beyond* the prior extreme. A
 *     close equal to the swing extreme has not broken it.
 *   - Fair value gap: the gap in bps must be >= minGapBps. Equal to the
 *     threshold satisfies it.
 *   - Liquidity sweep: the wick must trade *beyond* the reference extreme,
 *     strictly, and the close must come back *inside* it, strictly. A wick
 *     that only touches the reference has not swept it.
 *
 * On refusal, each evaluator reports the most recent candle it could
 * evaluate — the live state of the series — rather than the closest historical
 * near-miss, so "the failing number" always answers "where do things stand now".
 */

import type { Lookback, Predicate, ReferenceExtreme, StrategySpec } from './spec';
import { predicateSymbol } from './spec';
import type { Candle, Series } from './candle';
import { maxDecimal, minDecimal } from './candle';
import { Decimal, compareDecimal, dec, subDecimal } from './decimal';

type BreakOfStructurePredicate = Extract<Predicate, { kind: 'break_of_structure' }>;
type FairValueGapPredicate = Extract<Predicate, { kind: 'fair_value_gap' }>;
type LiquiditySweepPredicate = Extract<Predicate, { kind: 'liquidity_sweep' }>;

export interface PredicateResult {
  predicateId: string;
  /** The evidence-chain identifier, e.g. `bos_bullish`. */
  symbol: string;
  satisfied: boolean;
  decidingValue: Decimal;
  referenceValue: Decimal;
  /** Timestamp of the candle that decided it. */
  at: number;
}

/**
 * A scan window, the off-chain twin of `fromBucketInclusive` in
 * `RefusalGate.PredicateDefinition`. Candles before `scanFrom` stay available
 * as history (a swing extreme still looks back past it) but cannot *decide*
 * the predicate. Without a window an evaluator returns the oldest satisfying
 * candle in the whole series, which answers "did this ever happen", not "is
 * this setup live now".
 */
export interface EvalOptions {
  /** Unix seconds. Only candles at or after this can decide the predicate. */
  scanFrom?: number;
}

const inScan = (timestamp: number, opts?: EvalOptions): boolean =>
  opts?.scanFrom === undefined || timestamp >= opts.scanFrom;

export interface SpecEvaluation {
  allSatisfied: boolean;
  results: PredicateResult[];
}

function alignAtoms(a: Decimal, b: Decimal): [bigint, bigint] {
  const decimals = Math.max(a.decimals, b.decimals);
  const scale = (d: Decimal) => BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
  return [scale(a), scale(b)];
}

/** Integer basis points of `numerator` relative to `denominator`. Truncates toward zero. */
function bpsOf(numerator: Decimal, denominator: Decimal): number {
  const [n, d] = alignAtoms(numerator, denominator);
  if (d === 0n) return 0;
  return Number((n * 10_000n) / d);
}

export function evaluateBreakOfStructure(
  series: Series,
  predicate: BreakOfStructurePredicate,
  opts?: EvalOptions,
): PredicateResult {
  const candles = series.candles;
  const lookback = predicate.swingLookbackCandles.value;
  if (candles.length < lookback + 1) {
    throw new Error(
      `break of structure needs at least ${lookback + 1} candles, series has ${candles.length}`,
    );
  }
  const symbol = predicateSymbol(predicate);

  let last: PredicateResult | null = null;
  for (let i = lookback; i < candles.length; i++) {
    if (!inScan(candles[i]!.timestamp, opts)) continue;
    const window = candles.slice(i - lookback, i);
    const extreme =
      predicate.direction === 'long'
        ? maxDecimal(window.map((c) => c.high))
        : minDecimal(window.map((c) => c.low));
    const current = candles[i]!.close;
    const crossed =
      predicate.direction === 'long'
        ? compareDecimal(current, extreme) > 0
        : compareDecimal(current, extreme) < 0;
    const result: PredicateResult = {
      predicateId: predicate.id,
      symbol,
      satisfied: crossed,
      decidingValue: current,
      referenceValue: extreme,
      at: candles[i]!.timestamp,
    };
    if (crossed) return result;
    last = result;
  }
  if (!last) throw new Error('break of structure: no candle falls inside the scan window');
  return last;
}

export function evaluateFairValueGap(
  series: Series,
  predicate: FairValueGapPredicate,
  opts?: EvalOptions,
): PredicateResult {
  const candles = series.candles;
  if (candles.length < 3) {
    throw new Error(`fair value gap needs at least 3 candles, series has ${candles.length}`);
  }
  const symbol = predicateSymbol(predicate);
  const minGapBps = predicate.minGapBps.value;

  let last: PredicateResult | null = null;
  for (let i = 0; i + 2 < candles.length; i++) {
    const c1 = candles[i]!;
    const c3 = candles[i + 2]!;
    if (!inScan(c3.timestamp, opts)) continue;
    const gap = predicate.direction === 'long' ? subDecimal(c3.low, c1.high) : subDecimal(c1.low, c3.high);
    const reference = predicate.direction === 'long' ? c1.high : c1.low;
    const gapPositive = compareDecimal(gap, dec('0', gap.decimals)) > 0;
    const gapBps = gapPositive ? bpsOf(gap, reference) : 0;
    const satisfied = gapPositive && gapBps >= minGapBps;
    const result: PredicateResult = {
      predicateId: predicate.id,
      symbol,
      satisfied,
      decidingValue: dec(String(gapBps), 0),
      referenceValue: dec(String(minGapBps), 0),
      at: c3.timestamp,
    };
    if (satisfied) return result;
    last = result;
  }
  if (!last) throw new Error('fair value gap: no candle falls inside the scan window');
  return last;
}

const LOOKBACK_SECONDS: Record<Lookback, number> = {
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1D': 86400,
  '1W': 604800,
};

const DAY_SECONDS = 86400;

function isLowReference(ref: ReferenceExtreme): boolean {
  return ref === 'prev_day_low' || ref === 'prev_session_low' || ref === 'swing_low';
}

/**
 * The reference extreme a sweep is measured against, as of `index`, using
 * only candles strictly before it. Returns null when there is not yet enough
 * history to establish one — the caller skips that candle rather than
 * inventing a reference.
 *
 * `prev_session_*` is treated as `prev_day_*`: nothing in docs/ARCHITECTURE.md
 * or packages/spec/src/spec.ts defines session boundaries (Asia/London/NY),
 * so a calendar day (UTC, floor(timestamp / 86400)) stands in. Flagged for
 * review if session boundaries are specified later.
 */
function referenceExtremeAt(
  candles: Candle[],
  index: number,
  referenceExtreme: ReferenceExtreme,
  lookbackSeconds: number,
): Decimal | null {
  const at = candles[index]!.timestamp;
  const low = isLowReference(referenceExtreme);

  if (referenceExtreme === 'swing_low' || referenceExtreme === 'swing_high') {
    const windowStart = at - lookbackSeconds;
    const window = candles.slice(0, index).filter((c) => c.timestamp >= windowStart);
    if (window.length === 0) return null;
    return low ? minDecimal(window.map((c) => c.low)) : maxDecimal(window.map((c) => c.high));
  }

  const currentDay = Math.floor(at / DAY_SECONDS);
  const prevDayCandles = candles
    .slice(0, index)
    .filter((c) => Math.floor(c.timestamp / DAY_SECONDS) === currentDay - 1);
  if (prevDayCandles.length === 0) return null;
  return low
    ? minDecimal(prevDayCandles.map((c) => c.low))
    : maxDecimal(prevDayCandles.map((c) => c.high));
}

export function evaluateLiquiditySweep(
  series: Series,
  predicate: LiquiditySweepPredicate,
  opts?: EvalOptions,
): PredicateResult {
  const candles = series.candles;
  if (candles.length < 2) {
    throw new Error(`liquidity sweep needs at least 2 candles, series has ${candles.length}`);
  }
  const symbol = predicateSymbol(predicate);
  const referenceExtreme = predicate.referenceExtreme.value;
  const lookbackSeconds = LOOKBACK_SECONDS[predicate.lookback.value];
  const low = isLowReference(referenceExtreme);

  let last: PredicateResult | null = null;
  for (let i = 1; i < candles.length; i++) {
    if (!inScan(candles[i]!.timestamp, opts)) continue;
    const reference = referenceExtremeAt(candles, i, referenceExtreme, lookbackSeconds);
    if (reference === null) continue;
    const candle = candles[i]!;
    const wick = low ? candle.low : candle.high;
    const sweptBeyond = low
      ? compareDecimal(wick, reference) < 0
      : compareDecimal(wick, reference) > 0;
    const closedBackInside = low
      ? compareDecimal(candle.close, reference) > 0
      : compareDecimal(candle.close, reference) < 0;
    const result: PredicateResult = {
      predicateId: predicate.id,
      symbol,
      satisfied: sweptBeyond && closedBackInside,
      decidingValue: wick,
      referenceValue: reference,
      at: candle.timestamp,
    };
    if (result.satisfied) return result;
    last = result;
  }
  if (!last) {
    throw new Error(
      'liquidity sweep: no candle in the series has enough history to establish a reference extreme',
    );
  }
  return last;
}

export function evaluatePredicate(
  series: Series,
  predicate: Predicate,
  opts?: EvalOptions,
): PredicateResult {
  switch (predicate.kind) {
    case 'break_of_structure':
      return evaluateBreakOfStructure(series, predicate, opts);
    case 'fair_value_gap':
      return evaluateFairValueGap(series, predicate, opts);
    case 'liquidity_sweep':
      return evaluateLiquiditySweep(series, predicate, opts);
  }
}

export function evaluateSpec(series: Series, spec: StrategySpec): SpecEvaluation {
  const results = spec.predicates.map((p) => evaluatePredicate(series, p));
  return { allSatisfied: results.every((r) => r.satisfied), results };
}
