/**
 * The proposer's pure half: given a spec and a series, decide whether the
 * setup is a proposal or a refusal, and name the number that decided it.
 *
 * Everything the model-free enforcement path needs lives here as arithmetic
 * over price data — evaluation is `@kanon/spec`'s `evaluatePredicate`, sizing
 * is integer division, the undo window is a comparison of two timestamps. No
 * model is called, nothing here reads a clock (callers pass `now`), and no
 * float touches a price.
 *
 * Three outcomes, and only one of them is a refusal:
 *
 *   proposal     every predicate satisfied
 *   refusal      a predicate evaluated false. It names the predicate and the
 *                exact number that failed. This is the product working.
 *   unavailable  the series cannot support an honest answer (no candles,
 *                too few, stale). Nothing is written and nothing is claimed:
 *                a gap in the data is not a rule failing.
 */

import {
  TIMEFRAME_SECONDS,
  compareDecimal,
  dec,
  evaluatePredicate,
  predicateSymbol,
  roundedBps,
  subDecimal,
  type Candle,
  type Decimal,
  type Predicate,
  type PredicateKind,
  type PredicateResult,
  type Series,
  type StrategySpec,
} from '@kanon/spec';

// ---------------------------------------------------------------------------
// Constants. Each one is surfaced in the row it produced, never hidden.
// ---------------------------------------------------------------------------

/** How long a valid setup can be undone before it executes on its own. */
export const UNDO_WINDOW_MS = 7_000;

/**
 * The number of most recent candles that may decide a predicate. Without it an
 * evaluator answers "did this ever happen in the window", not "is this setup
 * live". The contract's `evaluateOnChain` takes the same thing as an explicit
 * `fromBucketInclusive`; this is its off-chain twin, recorded on every row.
 */
export const SETUP_RECENCY_CANDLES = 4;

/** A series whose newest candle is older than this many buckets is not "now". */
export const MAX_STALE_BUCKETS = 3;

/** Sizing needs an account equity; when none is on file the demo account's paper equity is used and labelled as such. */
export const PAPER_EQUITY: Decimal = dec('2500000', 2);

/** Position sizes are integers at this many decimals. */
export const SIZE_DECIMALS = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One series, or several keyed by their bucket width in seconds. */
export type SeriesSource = Series | Record<number, Series>;

export interface PredicateOutcome {
  predicateId: string;
  kind: PredicateKind;
  symbol: string;
  satisfied: boolean;
  decidingValue: Decimal;
  referenceValue: Decimal;
  /** Unix seconds of the candle that decided it. */
  at: number;
}

export interface Setup {
  direction: 'long' | 'short';
  asset: string;
  entry: Decimal;
  stop: Decimal;
  size: Decimal;
  /** Account equity the size was risked against, and where that figure came from. */
  equity: Decimal;
  equitySource: 'account' | 'paper';
  riskBps: number;
  stopDistanceBps: number;
}

export interface Scan {
  /** Unix seconds. The evaluation window began here. */
  from: number;
  /** Unix seconds of the newest candle used. */
  to: number;
  /** Unix seconds of the latest price the entry came from. */
  asOf: number;
}

export interface TradeProposal {
  kind: 'proposal';
  setup: Setup;
  results: PredicateOutcome[];
  scan: Scan;
  /** Milliseconds. The trade executes on its own at this time unless undone. */
  undoExpiresAt: number;
}

export interface TradeRefusal {
  kind: 'refusal';
  /** The hypothetical setup that was refused, sized and stopped by the spec. */
  setup: Setup;
  /** The first failing predicate in spec order. */
  failed: PredicateOutcome;
  /** `decidingValue - referenceValue`, in the unit the predicate is decided in. */
  shortfall: Decimal;
  /** Shortfall as basis points of the reference. Equals `shortfall` for a bps-decided predicate. */
  shortfallBps: number;
  results: PredicateOutcome[];
  scan: Scan;
}

export type UnavailableReason = 'no_series' | 'insufficient_data' | 'stale' | 'bad_price';

export interface Unavailable {
  kind: 'unavailable';
  reason: UnavailableReason;
  message: string;
}

export type ProposalOutcome = TradeProposal | TradeRefusal | Unavailable;

export interface ProposeOptions {
  equity?: Decimal;
  equitySource?: 'account' | 'paper';
  recencyCandles?: number;
  maxStaleBuckets?: number;
}

// ---------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------

function scaleTo(d: Decimal, decimals: number): bigint {
  return BigInt(d.atoms) * 10n ** BigInt(decimals - d.decimals);
}

/**
 * Stop and size from the entry and the spec's two risk parameters. The stop is
 * rounded away from the entry (never inside the specified distance) and the
 * size is rounded down, so the risk taken never exceeds the risk stated.
 */
export function sizePosition(input: {
  direction: 'long' | 'short';
  entry: Decimal;
  stopDistanceBps: number;
  riskBps: number;
  equity: Decimal;
}): { stop: Decimal; size: Decimal } | null {
  const { direction, entry, stopDistanceBps, riskBps, equity } = input;
  const price = BigInt(entry.atoms);
  if (price <= 0n) return null;

  const raw = price * BigInt(stopDistanceBps);
  let distance = raw / 10_000n;
  if (raw % 10_000n !== 0n) distance += 1n; // ceil
  if (distance < 1n) distance = 1n;

  const stopAtoms = direction === 'long' ? price - distance : price + distance;
  if (stopAtoms <= 0n) return null;

  // size = equity * riskBps / 10_000 / (distance / 10^priceDecimals)
  const numerator =
    BigInt(equity.atoms) * BigInt(riskBps) * 10n ** BigInt(entry.decimals) * 10n ** BigInt(SIZE_DECIMALS);
  const denominator = 10n ** BigInt(equity.decimals) * 10_000n * distance;
  const size = numerator / denominator;

  return {
    stop: dec(stopAtoms, entry.decimals),
    size: dec(size, SIZE_DECIMALS),
  };
}

// ---------------------------------------------------------------------------
// Series requirements
// ---------------------------------------------------------------------------

const LOOKBACK_SECONDS = { '15m': 900, '1h': 3600, '4h': 14_400, '1D': 86_400, '1W': 604_800 } as const;

/** Distinct bucket widths the spec's predicates are written in. */
export function bucketsNeeded(spec: StrategySpec): number[] {
  const out = new Set<number>();
  for (const p of spec.predicates) out.add(TIMEFRAME_SECONDS[p.timeframe.value]);
  return [...out].sort((a, b) => a - b);
}

/**
 * How many candles of `bucketSeconds` the spec's predicates on that bucket
 * need behind them: the deepest lookback plus the recency window. Sweeps
 * against a previous day need that day in full, so two days back.
 */
export function requiredCandles(
  spec: StrategySpec,
  bucketSeconds: number,
  recency = SETUP_RECENCY_CANDLES,
): number {
  let need = 3 + recency;
  for (const p of spec.predicates) {
    if (TIMEFRAME_SECONDS[p.timeframe.value] !== bucketSeconds) continue;
    switch (p.kind) {
      case 'break_of_structure':
        need = Math.max(need, p.swingLookbackCandles.value + recency + 1);
        break;
      case 'fair_value_gap':
        need = Math.max(need, recency + 3);
        break;
      case 'liquidity_sweep': {
        const ref = p.referenceExtreme.value;
        const seconds = ref.startsWith('swing_')
          ? LOOKBACK_SECONDS[p.lookback.value]
          : 2 * 86_400;
        need = Math.max(need, Math.ceil(seconds / bucketSeconds) + recency + 1);
        break;
      }
    }
  }
  return need;
}

function pickSeries(source: SeriesSource, bucketSeconds: number): Series | undefined {
  if ('candles' in source && Array.isArray((source as Series).candles)) {
    const s = source as Series;
    return s.bucketSeconds === bucketSeconds ? s : undefined;
  }
  return (source as Record<number, Series>)[bucketSeconds];
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

function toOutcome(p: Predicate, r: PredicateResult): PredicateOutcome {
  return {
    predicateId: p.id,
    kind: p.kind,
    symbol: r.symbol,
    satisfied: r.satisfied,
    decidingValue: r.decidingValue,
    referenceValue: r.referenceValue,
    at: r.at,
  };
}

/**
 * Evaluates `spec` over `source` as of `nowMs`.
 *
 * Each predicate is evaluated over the series at its own timeframe. Only the
 * last `recencyCandles` candles can decide it. The entry is the latest close of
 * the finest series in use; the stop and size come from the spec's own risk
 * parameters and the account equity, both stated on the result.
 */
export function proposeTrade(
  spec: StrategySpec,
  source: SeriesSource,
  nowMs: number,
  opts: ProposeOptions = {},
): ProposalOutcome {
  const recency = opts.recencyCandles ?? SETUP_RECENCY_CANDLES;
  const maxStale = opts.maxStaleBuckets ?? MAX_STALE_BUCKETS;
  const nowSeconds = Math.floor(nowMs / 1000);

  const outcomes: PredicateOutcome[] = [];
  let scanFrom = Infinity;
  let scanTo = 0;
  let finest: Series | undefined;

  for (const p of spec.predicates) {
    const bucketSeconds = TIMEFRAME_SECONDS[p.timeframe.value];
    const series = pickSeries(source, bucketSeconds);
    if (!series) {
      return {
        kind: 'unavailable',
        reason: 'no_series',
        message: `${predicateSymbol(p)} is written on ${p.timeframe.value}; no ${bucketSeconds}s series was supplied.`,
      };
    }
    const last = series.candles[series.candles.length - 1];
    if (!last) {
      return {
        kind: 'unavailable',
        reason: 'no_series',
        message: `The ${p.timeframe.value} series for ${series.asset} has no candles yet.`,
      };
    }
    if (nowSeconds - last.timestamp > maxStale * bucketSeconds) {
      return {
        kind: 'unavailable',
        reason: 'stale',
        message: `The newest ${p.timeframe.value} candle is ${Math.floor((nowSeconds - last.timestamp) / 60)} minutes old. A setup is not judged against old prices.`,
      };
    }

    const from = last.timestamp - (recency - 1) * bucketSeconds;
    let result: PredicateResult;
    try {
      result = evaluatePredicate(series, p, { scanFrom: from });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: 'insufficient_data',
        message: err instanceof Error ? err.message : 'the series is too short to evaluate',
      };
    }
    outcomes.push(toOutcome(p, result));
    scanFrom = Math.min(scanFrom, from);
    scanTo = Math.max(scanTo, last.timestamp);
    if (!finest || series.bucketSeconds < finest.bucketSeconds) finest = series;
  }

  const latest = finest?.candles[finest.candles.length - 1];
  if (!finest || !latest) {
    return { kind: 'unavailable', reason: 'no_series', message: 'No candles to price an entry from.' };
  }

  const equity = opts.equity ?? PAPER_EQUITY;
  const sized = sizePosition({
    direction: spec.direction,
    entry: latest.close,
    stopDistanceBps: spec.risk.stopDistanceBps.value,
    riskBps: spec.risk.riskPerTradeBps.value,
    equity,
  });
  if (!sized) {
    return {
      kind: 'unavailable',
      reason: 'bad_price',
      message: 'The latest price cannot carry a stop at the specified distance.',
    };
  }

  const setup: Setup = {
    direction: spec.direction,
    asset: spec.series.asset,
    entry: latest.close,
    stop: sized.stop,
    size: sized.size,
    equity,
    equitySource: opts.equitySource ?? 'paper',
    riskBps: spec.risk.riskPerTradeBps.value,
    stopDistanceBps: spec.risk.stopDistanceBps.value,
  };
  const scan: Scan = { from: scanFrom, to: scanTo, asOf: latest.timestamp };

  const failed = outcomes.find((o) => !o.satisfied);
  if (!failed) {
    return { kind: 'proposal', setup, results: outcomes, scan, undoExpiresAt: nowMs + UNDO_WINDOW_MS };
  }

  const shortfall = subDecimal(failed.decidingValue, failed.referenceValue);
  const shortfallBps =
    failed.kind === 'fair_value_gap'
      ? safeIntegerFromAtoms(shortfall.atoms)
      : roundedBps(shortfall, failed.referenceValue);
  return { kind: 'refusal', setup, failed, shortfall, shortfallBps, results: outcomes, scan };
}

/** `Number(atoms)` only when it is exact; a figure past 2^53 must not become a rounded one. */
export function safeIntegerFromAtoms(atoms: string): number {
  const n = Number(atoms);
  if (!/^-?\d+$/.test(atoms) || !Number.isSafeInteger(n)) {
    throw new RangeError(`${atoms} does not fit a safe integer`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Undo window
// ---------------------------------------------------------------------------

type TradeStatus = 'proposed' | 'executed' | 'refused' | 'undone';

export interface UndoSubject {
  status: TradeStatus;
  undoExpiresAt?: number | undefined;
}

export type Transition =
  | { ok: true; status: TradeStatus }
  | { ok: false; reason: 'not_proposed' | 'window_closed' };

/** Undo works only on a proposed trade, and only strictly before the window closes. */
export function undoTransition(trade: UndoSubject, nowMs: number): Transition {
  if (trade.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
  if (trade.undoExpiresAt === undefined || nowMs >= trade.undoExpiresAt) {
    return { ok: false, reason: 'window_closed' };
  }
  return { ok: true, status: 'undone' };
}

/**
 * Confirming executes early. It cannot revive an undone trade and it cannot
 * touch a refused one: a refusal has nothing to confirm.
 */
export function confirmTransition(trade: UndoSubject, _nowMs: number): Transition {
  if (trade.status === 'executed') return { ok: true, status: 'executed' };
  if (trade.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
  return { ok: true, status: 'executed' };
}

/** The window has run out without an undo: the trade executes on its own. */
export function finalizeTransition(trade: UndoSubject, nowMs: number): Transition {
  if (trade.status === 'executed') return { ok: true, status: 'executed' };
  if (trade.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
  if (trade.undoExpiresAt === undefined || nowMs < trade.undoExpiresAt) {
    return { ok: false, reason: 'window_closed' };
  }
  return { ok: true, status: 'executed' };
}

export function undoSecondsLeft(trade: UndoSubject, nowMs: number): number {
  if (trade.status !== 'proposed' || trade.undoExpiresAt === undefined) return 0;
  return Math.max(0, Math.ceil((trade.undoExpiresAt - nowMs) / 1000));
}

// ---------------------------------------------------------------------------
// What a refusal would have cost
// ---------------------------------------------------------------------------

export interface RefusedSetup {
  direction: 'long' | 'short';
  entry: Decimal;
  stop: Decimal;
  size: Decimal;
  /** Milliseconds the refusal was written. */
  at: number;
}

export type ModelledOutcome =
  /** No candle has printed since the refusal, so there is nothing to say yet. */
  | { status: 'pending' }
  | { status: 'stopped'; exit: Decimal; pnl: Decimal; lost: true; at: number }
  | { status: 'open'; exit: Decimal; pnl: Decimal; lost: boolean; at: number };

/** Quote-currency P&L at the price's own decimals, truncated toward zero. */
function pnlOf(direction: 'long' | 'short', entry: Decimal, exit: Decimal, size: Decimal): Decimal {
  const decimals = Math.max(entry.decimals, exit.decimals);
  const e = scaleTo(entry, decimals);
  const x = scaleTo(exit, decimals);
  const move = direction === 'long' ? x - e : e - x;
  const atoms = (move * BigInt(size.atoms)) / 10n ** BigInt(size.decimals);
  return dec(atoms, decimals);
}

/**
 * Plays a refused setup forward over the candles that printed after it, to its
 * own stop. No target is pinned, so a setup that never touched its stop is
 * marked at the latest close. Candles that began at or before the refusal are
 * ignored: the one it landed inside was already partly written.
 */
export function modelRefusedOutcome(setup: RefusedSetup, candles: readonly Candle[]): ModelledOutcome {
  const later = candles.filter((c) => c.timestamp * 1000 > setup.at);
  if (later.length === 0) return { status: 'pending' };

  for (const c of later) {
    const hit =
      setup.direction === 'long'
        ? compareDecimal(c.low, setup.stop) <= 0
        : compareDecimal(c.high, setup.stop) >= 0;
    if (hit) {
      return {
        status: 'stopped',
        exit: setup.stop,
        pnl: pnlOf(setup.direction, setup.entry, setup.stop, setup.size),
        lost: true,
        at: c.timestamp,
      };
    }
  }

  const last = later[later.length - 1]!;
  const pnl = pnlOf(setup.direction, setup.entry, last.close, setup.size);
  return { status: 'open', exit: last.close, pnl, lost: BigInt(pnl.atoms) < 0n, at: last.timestamp };
}

export interface BlockedSummary {
  refused: number;
  /** Refusals with later data, i.e. the ones a verdict is possible for. */
  judged: number;
  pending: number;
  lostCount: number;
  /** Sum of the losing outcomes only. Zero or negative. */
  wouldHaveLost: Decimal;
}

export function summariseBlocked(outcomes: readonly ModelledOutcome[], decimals = 2): BlockedSummary {
  let judged = 0;
  let pending = 0;
  let lostCount = 0;
  let total = 0n;
  for (const o of outcomes) {
    if (o.status === 'pending') {
      pending += 1;
      continue;
    }
    judged += 1;
    if (o.lost) {
      lostCount += 1;
      total += BigInt(scaleTo(o.pnl, decimals));
    }
  }
  return {
    refused: outcomes.length,
    judged,
    pending,
    lostCount,
    wouldHaveLost: dec(total, decimals),
  };
}
