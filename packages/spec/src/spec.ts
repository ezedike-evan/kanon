/**
 * The strategy spec.
 *
 * One versioned, Zod-validated AST shared by the compiler, the UI and the
 * contract encoder. Two rules from `docs/ARCHITECTURE.md` are enforced by the
 * shape of the type rather than by convention:
 *
 *   1. Every predicate binds every parameter explicitly. There is no implicit
 *      lookback and no default timeframe hidden in code.
 *   2. Every parameter records whether the compiler inferred it. Spec review
 *      renders that flag, so a default the user never stated cannot stay
 *      invisible.
 */

import { z } from 'zod';
import { Decimal } from './decimal';

export const SPEC_VERSION = 1 as const;

export const Direction = z.enum(['long', 'short']);
export type Direction = z.infer<typeof Direction>;

export const Timeframe = z.enum(['1m', '5m', '15m', '1h', '4h', '1d']);
export type Timeframe = z.infer<typeof Timeframe>;

/** Where a liquidity sweep measures from. Each resolves to one prior extreme. */
export const ReferenceExtreme = z.enum([
  'prev_day_low',
  'prev_day_high',
  'prev_session_low',
  'prev_session_high',
  'swing_low',
  'swing_high',
]);
export type ReferenceExtreme = z.infer<typeof ReferenceExtreme>;

export const Lookback = z.enum(['15m', '1h', '4h', '1D', '1W']);
export type Lookback = z.infer<typeof Lookback>;

/**
 * A bound parameter. `inferred` is true when the compiler chose the value
 * rather than reading it out of what the user wrote.
 */
export const param = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value, inferred: z.boolean() });

export type Param<T> = { value: T; inferred: boolean };

/** States a value the user gave. */
export const stated = <T>(value: T): Param<T> => ({ value, inferred: false });
/** States a value the compiler chose. Surfaces in spec review. */
export const inferred = <T>(value: T): Param<T> => ({ value, inferred: true });

// ---------------------------------------------------------------------------
// Predicates. Three, and only three. Each compiles to arithmetic over the
// canonical series; a fourth that cannot does not ship.
// ---------------------------------------------------------------------------

export const BreakOfStructure = z.object({
  kind: z.literal('break_of_structure'),
  id: z.string(),
  direction: Direction,
  /** How many candles back the prior swing extreme is measured over. */
  swingLookbackCandles: param(z.number().int().min(2).max(200)),
  timeframe: param(Timeframe),
});

export const FairValueGap = z.object({
  kind: z.literal('fair_value_gap'),
  id: z.string(),
  direction: Direction,
  /** Minimum three-candle imbalance, in basis points of price. */
  minGapBps: param(z.number().int().min(1).max(10_000)),
  timeframe: param(Timeframe),
});

export const LiquiditySweep = z.object({
  kind: z.literal('liquidity_sweep'),
  id: z.string(),
  direction: Direction,
  referenceExtreme: param(ReferenceExtreme),
  lookback: param(Lookback),
  timeframe: param(Timeframe),
});

export const Predicate = z.discriminatedUnion('kind', [
  BreakOfStructure,
  FairValueGap,
  LiquiditySweep,
]);
export type Predicate = z.infer<typeof Predicate>;
export type PredicateKind = Predicate['kind'];

/** The SMC name a predicate renders under. Verbatim, no glossary. */
export const PREDICATE_LABEL: Record<PredicateKind, string> = {
  break_of_structure: 'Break of structure',
  fair_value_gap: 'Fair value gap',
  liquidity_sweep: 'Liquidity sweep',
};

/** The identifier the contract and the evidence chain use. */
export function predicateSymbol(p: Predicate): string {
  switch (p.kind) {
    case 'break_of_structure':
      return p.direction === 'long' ? 'bos_bullish' : 'bos_bearish';
    case 'fair_value_gap':
      return 'fvg_present';
    case 'liquidity_sweep':
      return `sweep_${p.referenceExtreme.value}`;
  }
}

// ---------------------------------------------------------------------------
// Risk, series, spec
// ---------------------------------------------------------------------------

export const Risk = z.object({
  /** Account fraction at risk per trade, in basis points. */
  riskPerTradeBps: param(z.number().int().min(1).max(10_000)),
  /** Distance from entry to stop, in basis points of entry. */
  stopDistanceBps: param(z.number().int().min(1).max(10_000)),
});
export type Risk = z.infer<typeof Risk>;

/**
 * The canonical series a spec is defined against. Meaningless without all
 * four: a swing high is the maximum over *these* recorded samples.
 */
export const CanonicalSeries = z.object({
  asset: z.string(),
  feed: z.string(),
  /** Seconds between samples the contract takes from the feed. */
  cadenceSeconds: z.number().int().positive(),
  /** Seconds per bucket. Buckets may be empty; sparse is expected. */
  bucketSeconds: z.number().int().positive(),
});
export type CanonicalSeries = z.infer<typeof CanonicalSeries>;

export const StrategySpec = z.object({
  version: z.literal(SPEC_VERSION),
  id: z.string(),
  name: z.string(),
  direction: Direction,
  series: CanonicalSeries,
  predicates: z.array(Predicate).min(1),
  risk: Risk,
});
export type StrategySpec = z.infer<typeof StrategySpec>;

/**
 * Parses untrusted input — compiler output included. Compilation retries on
 * failure; a partially valid spec is never accepted.
 */
export function parseSpec(input: unknown): StrategySpec {
  return StrategySpec.parse(input);
}

/** Every parameter the compiler chose rather than read. */
export function inferredDefaults(
  spec: StrategySpec,
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const take = (path: string, p: Param<unknown>) => {
    if (p.inferred) out.push({ path, value: String(p.value) });
  };
  for (const p of spec.predicates) {
    switch (p.kind) {
      case 'break_of_structure':
        take('swing_lookback', p.swingLookbackCandles);
        take('timeframe', p.timeframe);
        break;
      case 'fair_value_gap':
        take('min_gap_size', p.minGapBps);
        take('timeframe', p.timeframe);
        break;
      case 'liquidity_sweep':
        take('reference_extreme', p.referenceExtreme);
        take('sweep_lookback', p.lookback);
        take('timeframe', p.timeframe);
        break;
    }
  }
  take('risk_per_trade', spec.risk.riskPerTradeBps);
  take('stop_distance', spec.risk.stopDistanceBps);
  return out;
}

export { Decimal };
