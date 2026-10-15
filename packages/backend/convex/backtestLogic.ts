/**
 * The backtester's pure half: walk a rule over recorded candles, oldest first,
 * and count what its stated stop and target would have done.
 *
 * The verdict on each candle is `proposeTrade`'s, the same arithmetic a button
 * press and autopilot run, over the same window of candles, at the same moment
 * (the candle's close). Nothing here reads a clock or a database, so a run is a
 * function of the spec and the series alone and can be replayed exactly.
 *
 * It never guesses. Where the recorded prices cannot say what happened, the
 * answer is `cannot_tell`, with the reason:
 *
 *   - a candle the series carried forward flat (`synthetic`, no tick of its
 *     own) or a bucket with no candle at all never decides a predicate and
 *     never decides an exit;
 *   - a candle that touched both the stop and the target says nothing about
 *     which came first;
 *   - a rule it cannot walk honestly (no stated exits, more than one candle
 *     width, too little history) is not run at all: it halts, with a sentence,
 *     and no win rate.
 *
 * Every constant that shaped a run is echoed in its `params`, fees included as
 * `not_included`, so nothing that moved the number is hidden.
 */

import {
  TIMEFRAME_SECONDS,
  compareDecimal,
  exitsSentence,
  missingExits,
  ratioBps,
  type Candle,
  type Decimal,
  type Series,
  type StrategySpec,
} from '@kanon/spec';
import {
  PAPER_EQUITY,
  SETUP_RECENCY_CANDLES,
  bucketsNeeded,
  proposeTrade,
  requiredCandles,
  targetPrice,
  type PredicateOutcome,
} from './proposerLogic';

// ---------------------------------------------------------------------------
// Constants. Each one is echoed in `params`, never hidden.
// ---------------------------------------------------------------------------

/** Bumped whenever a rule below changes, so a stored run from older rules is never served as current. */
export const ENGINE_VERSION = 1;

/** Fewer decided trades than this and the win rate is shown, but no verdict is drawn from it. */
export const MIN_DECIDED_TRADES = 30;

/** The most candles one run reads: the newest this many buckets of history. */
export const MAX_BACKTEST_CANDLES = 20_000;

// ---------------------------------------------------------------------------
// Types. Plain data: Convex can store and return every one of them as is.
// ---------------------------------------------------------------------------

export type BacktestHaltReason =
  | 'exits_not_stated'
  | 'mixed_timeframes'
  | 'no_candles'
  | 'insufficient_history'
  | 'history_not_ready';

export type TradeOutcome = 'win' | 'loss' | 'cannot_tell' | 'open_at_end';

/**
 * Why a trade's result is unknown.
 *
 *   both_touched       one candle reached the stop and the target; which came first is not recorded
 *   gap                a candle after entry was carried forward flat or never recorded
 *   target_not_priced  a short whose target would sit at or below zero
 */
export type CannotTellReason = 'both_touched' | 'gap' | 'target_not_priced';

export type Verdict = 'above_break_even' | 'below_break_even' | 'at_break_even' | 'too_few_trades';

/** One comparison an exit was decided by, e.g. `low 63,912.40 <= stop 64,000.00`. */
export interface ExitComparison {
  field: 'low' | 'high';
  value: Decimal;
  op: '<=' | '>=';
  level: 'stop' | 'target';
  against: Decimal;
}

export interface TradeExit {
  /** Unix seconds: the start of the candle the trade ended in. */
  at: number;
  /** That candle as recorded. Null when it was carried forward flat or never recorded. */
  candle: { open: Decimal; high: Decimal; low: Decimal; close: Decimal } | null;
  /** True when no tick of its own was recorded for that candle. */
  synthetic: boolean;
  /** The comparisons that decided it. Empty for a gap. */
  comparisons: ExitComparison[];
}

export interface BacktestTrade {
  /** 1-based, in the order the trades opened. */
  n: number;
  /** Unix seconds: the start of the candle whose close passed the rule. Entry is that close. */
  setupAt: number;
  entry: Decimal;
  stop: Decimal;
  /** Null only for `target_not_priced`. */
  target: Decimal | null;
  /** Every predicate's value at the setup: the evidence the rule passed. */
  results: PredicateOutcome[];
  outcome: TradeOutcome;
  reason?: CannotTellReason;
  /** Absent while still open at the end of the data. */
  exit?: TradeExit;
  /** Candles after entry the trade was checked against. */
  heldCandles: number;
}

/** A run of buckets with no recorded candle of their own. */
export interface BacktestGap {
  /** Unix seconds: the first such bucket's start. */
  from: number;
  /** Unix seconds: the last such bucket's start. */
  to: number;
  buckets: number;
}

export interface BacktestParams {
  engineVersion: number;
  asset: string;
  /** Long: the stop is below the entry and the target above. Short: the other way up. */
  direction: 'long' | 'short';
  /** The candle width walked, in seconds. */
  bucketSeconds: number;
  /** Candles each judgment reads, ending at the judged one: the deepest lookback plus the recency window. */
  windowCandles: number;
  /** How many of the newest candles in that window may decide a predicate. */
  recencyCandles: number;
  minDecidedTrades: number;
  maxCandles: number;
  stopDistanceBps: number;
  /** Null when the rule states no target. */
  targetDistanceBps: number | null;
  entry: 'setup_close';
  judgedAt: 'candle_close';
  /** A candle that reaches a level exactly has touched it. */
  touch: 'inclusive';
  /** Stop and target are rounded away from the entry, never inside the stated distance. */
  levelRounding: 'away_from_entry';
  bothTouched: 'cannot_tell';
  gapMidTrade: 'cannot_tell';
  /** A window holding a synthetic or missing candle is not judged. */
  syntheticCandles: 'never_judged';
  oneTradeAtATime: true;
  /** A setup is its predicates' deciding candles. The same ones never open a second trade. */
  setupTradedOnce: true;
  fees: 'not_included';
  slippage: 'not_included';
  funding: 'not_included';
}

export interface BacktestCounts {
  /** Candles the rule was put to: a whole recorded window behind them, and no trade open. */
  judged: number;
  /** Of those, the ones the rule passed. */
  passed: number;
  /** Passes on a setup that had already been traded. Not traded again. */
  repeats: number;
  /** Candles not judged because their window held a synthetic or missing candle, with no trade open. */
  notJudged: number;
  /** Candles the window could not support an answer for (`proposeTrade` said unavailable). */
  unavailable: number;
  trades: number;
  wins: number;
  losses: number;
  cannotTell: number;
  openAtEnd: number;
  /** Wins plus losses: the only trades a win rate is taken over. */
  decided: number;
}

export interface BacktestRange {
  /** Unix seconds: the first candle's start. */
  from: number;
  /** Unix seconds: the end of the last candle (its start plus one width). */
  to: number;
  candles: number;
  recorded: number;
  synthetic: number;
}

export interface BacktestResult {
  kind: 'result';
  range: BacktestRange;
  counts: BacktestCounts;
  /** `ratioBps(wins, wins + losses)`. Null before anything was decided. */
  winRateBps: number | null;
  /** `ratioBps(stop, stop + target)`: the win rate at which stated stops and targets break even, before fees. */
  breakEvenBps: number;
  verdict: Verdict;
  trades: BacktestTrade[];
  gaps: BacktestGap[];
  params: BacktestParams;
}

export interface BacktestHalt {
  kind: 'halted';
  reason: BacktestHaltReason;
  /** One sentence, shown as it is. */
  message: string;
  params: BacktestParams;
}

export type BacktestOutcome = BacktestResult | BacktestHalt;

// ---------------------------------------------------------------------------
// What a run of this spec is
// ---------------------------------------------------------------------------

const WIDTH_LABEL: Record<number, string> = Object.fromEntries(
  Object.entries(TIMEFRAME_SECONDS).map(([label, seconds]) => [seconds, label]),
);

/** `15m`, or the width in seconds when it has no timeframe name. */
export function widthLabel(seconds: number): string {
  return WIDTH_LABEL[seconds] ?? `${seconds}s`;
}

/** The one candle width the spec's predicates read, or null when they read more than one. */
export function walkWidth(spec: StrategySpec): number | null {
  const widths = bucketsNeeded(spec);
  return widths.length === 1 ? widths[0]! : null;
}

/** Every constant a run of `spec` is shaped by. Known before a single candle is read. */
export function backtestParams(spec: StrategySpec): BacktestParams {
  const width = walkWidth(spec) ?? spec.series.bucketSeconds;
  return {
    engineVersion: ENGINE_VERSION,
    asset: spec.series.asset,
    direction: spec.direction,
    bucketSeconds: width,
    windowCandles: requiredCandles(spec, width),
    recencyCandles: SETUP_RECENCY_CANDLES,
    minDecidedTrades: MIN_DECIDED_TRADES,
    maxCandles: MAX_BACKTEST_CANDLES,
    stopDistanceBps: spec.risk.stopDistanceBps.value,
    targetDistanceBps: spec.risk.targetDistanceBps?.value ?? null,
    entry: 'setup_close',
    judgedAt: 'candle_close',
    touch: 'inclusive',
    levelRounding: 'away_from_entry',
    bothTouched: 'cannot_tell',
    gapMidTrade: 'cannot_tell',
    syntheticCandles: 'never_judged',
    oneTradeAtATime: true,
    setupTradedOnce: true,
    fees: 'not_included',
    slippage: 'not_included',
    funding: 'not_included',
  };
}

export function halt(spec: StrategySpec, reason: BacktestHaltReason, message: string): BacktestHalt {
  return { kind: 'halted', reason, message, params: backtestParams(spec) };
}

/**
 * The halts that need no data: a rule with no stated stop or target has no
 * definition of a win, and a rule that reads more than one candle width, or
 * reads a width other than the one it is judged at, cannot be walked as one
 * series without inventing what a coarser candle looked like mid-way. Null when
 * the rule can be walked.
 */
export function precheckBacktest(spec: StrategySpec): BacktestHalt | null {
  const missing = missingExits(spec);
  if (missing.length > 0) return halt(spec, 'exits_not_stated', exitsSentence(missing));

  const widths = bucketsNeeded(spec);
  if (widths.length > 1) {
    return halt(
      spec,
      'mixed_timeframes',
      `This rule reads ${widths.map(widthLabel).join(' and ')} candles. A test walks one series of candles, so a rule written on more than one timeframe is not tested.`,
    );
  }
  const width = widths[0]!;
  if (width !== spec.series.bucketSeconds) {
    return halt(
      spec,
      'mixed_timeframes',
      `This rule reads ${widthLabel(width)} candles but is judged at every ${widthLabel(spec.series.bucketSeconds)} close. A test walks one series of candles, so it is not run.`,
    );
  }
  return null;
}

/** The fewest candles a run can do anything with: one whole window, and one candle after it. */
export function minimumCandles(spec: StrategySpec): number {
  const width = walkWidth(spec) ?? spec.series.bucketSeconds;
  return requiredCandles(spec, width) + 1;
}

export function insufficientHistory(spec: StrategySpec, candles: number): BacktestHalt | null {
  const need = minimumCandles(spec);
  if (candles >= need) return null;
  const width = widthLabel(walkWidth(spec) ?? spec.series.bucketSeconds);
  return halt(
    spec,
    'insufficient_history',
    `A test of this rule needs at least ${need} ${width} candles of ${spec.series.asset}: ${need - 1} to judge a setup and one after it. ${candles} ${candles === 1 ? 'is' : 'are'} recorded.`,
  );
}

export function noCandles(spec: StrategySpec): BacktestHalt {
  const width = widthLabel(walkWidth(spec) ?? spec.series.bucketSeconds);
  return halt(spec, 'no_candles', `No ${width} candles of ${spec.series.asset} are recorded yet, so there is nothing to test on.`);
}

export function historyNotReady(spec: StrategySpec): BacktestHalt {
  return halt(
    spec,
    'history_not_ready',
    `${spec.series.asset}'s candle history is still being built from its recorded prices. Nothing was tested; try again in a few minutes.`,
  );
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface OpenTrade {
  trade: BacktestTrade;
  /** The candle the next exit check expects: one width after the last one checked. */
  expectAt: number;
}

const ohlc = (c: Candle) => ({ open: c.open, high: c.high, low: c.low, close: c.close });

/** The setup a pass rests on: its predicates' deciding candles. */
const setupKey = (results: readonly PredicateOutcome[]): string =>
  results.map((r) => `${r.predicateId}@${r.at}`).sort().join('|');

/**
 * The comparisons a recorded candle makes against an open trade's levels.
 * Touching a level counts: a low equal to a long's stop has reached it.
 */
function exitComparisons(trade: BacktestTrade, direction: 'long' | 'short', c: Candle): ExitComparison[] {
  const out: ExitComparison[] = [];
  const target = trade.target!;
  if (direction === 'long') {
    if (compareDecimal(c.low, trade.stop) <= 0) {
      out.push({ field: 'low', value: c.low, op: '<=', level: 'stop', against: trade.stop });
    }
    if (compareDecimal(c.high, target) >= 0) {
      out.push({ field: 'high', value: c.high, op: '>=', level: 'target', against: target });
    }
  } else {
    if (compareDecimal(c.high, trade.stop) >= 0) {
      out.push({ field: 'high', value: c.high, op: '>=', level: 'stop', against: trade.stop });
    }
    if (compareDecimal(c.low, target) <= 0) {
      out.push({ field: 'low', value: c.low, op: '<=', level: 'target', against: target });
    }
  }
  return out;
}

/** Runs of synthetic candles, and buckets missing between two candles, oldest first. */
function findGaps(candles: readonly Candle[], width: number): BacktestGap[] {
  const gaps: BacktestGap[] = [];
  const add = (from: number, to: number) => {
    const last = gaps[gaps.length - 1];
    if (last && last.to + width === from) {
      last.to = to;
      last.buckets = (to - last.from) / width + 1;
    } else {
      gaps.push({ from, to, buckets: (to - from) / width + 1 });
    }
  };
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1];
    if (prev && c.timestamp - prev.timestamp > width) add(prev.timestamp + width, c.timestamp - width);
    if (c.synthetic) add(c.timestamp, c.timestamp);
  }
  return gaps;
}

/**
 * Walks `spec` over `series`, oldest candle first.
 *
 * At each candle's close, with no trade open and a whole recorded window behind
 * it, the rule is put to the window exactly as `proposeTrade` puts it to the
 * market. A pass opens a trade at that close, at the spec's own stop and
 * target. Each later candle is checked against them in turn: the stop touched
 * is a loss, the target touched a win, both in one candle cannot be told, and a
 * candle that was not recorded ends the trade as `cannot_tell`, after which the
 * window has to fill with recorded candles again before anything is judged.
 *
 * `series` holds the one width the spec reads, ascending. Gaps may be filled
 * with synthetic candles (`candlesToSeries`) or left out; either way they decide
 * nothing.
 */
export function runBacktest(spec: StrategySpec, series: Series): BacktestOutcome {
  const pre = precheckBacktest(spec);
  if (pre) return pre;

  const params = backtestParams(spec);
  const width = params.bucketSeconds;
  if (series.bucketSeconds !== width) {
    return halt(
      spec,
      'mixed_timeframes',
      `The series supplied is ${widthLabel(series.bucketSeconds)} candles, and this rule reads ${widthLabel(width)}.`,
    );
  }

  const candles = series.candles;
  const recordedCount = candles.reduce((n, c) => n + (c.synthetic ? 0 : 1), 0);
  if (recordedCount === 0) return noCandles(spec);
  const short = insufficientHistory(spec, candles.length);
  if (short) return short;

  const need = params.windowCandles;
  const targetBps = params.targetDistanceBps!;
  const direction = spec.direction;

  const counts: BacktestCounts = {
    judged: 0,
    passed: 0,
    repeats: 0,
    notJudged: 0,
    unavailable: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    cannotTell: 0,
    openAtEnd: 0,
    decided: 0,
  };
  const trades: BacktestTrade[] = [];
  const traded = new Set<string>();
  let open: OpenTrade | null = null;
  /** Recorded candles in a row, one width apart, ending at the current one. */
  let run = 0;

  const close = (o: OpenTrade, outcome: TradeOutcome, exit: TradeExit, reason?: CannotTellReason) => {
    o.trade.outcome = outcome;
    o.trade.exit = exit;
    if (reason) o.trade.reason = reason;
    if (outcome === 'win') counts.wins += 1;
    else if (outcome === 'loss') counts.losses += 1;
    else counts.cannotTell += 1;
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1];
    const contiguous = prev !== undefined && c.timestamp - prev.timestamp === width;
    run = c.synthetic ? 0 : contiguous ? run + 1 : 1;

    // An open trade first: this candle is checked against its stop and target.
    if (open) {
      if (c.timestamp !== open.expectAt) {
        // A bucket after entry has no candle at all. What the price did in it is unknown.
        open.trade.heldCandles += 1;
        close(open, 'cannot_tell', { at: open.expectAt, candle: null, synthetic: true, comparisons: [] }, 'gap');
        open = null;
      } else if (c.synthetic) {
        open.trade.heldCandles += 1;
        close(open, 'cannot_tell', { at: c.timestamp, candle: null, synthetic: true, comparisons: [] }, 'gap');
        open = null;
        continue;
      } else {
        open.trade.heldCandles += 1;
        const comparisons = exitComparisons(open.trade, direction, c);
        const exit: TradeExit = { at: c.timestamp, candle: ohlc(c), synthetic: false, comparisons };
        const stopHit = comparisons.some((x) => x.level === 'stop');
        const targetHit = comparisons.some((x) => x.level === 'target');
        if (stopHit && targetHit) close(open, 'cannot_tell', exit, 'both_touched');
        else if (stopHit) close(open, 'loss', exit);
        else if (targetHit) close(open, 'win', exit);
        if (stopHit || targetHit) {
          open = null;
        } else {
          open.expectAt = c.timestamp + width;
          continue;
        }
      }
    }

    // Flat. Judge this candle's close only with a whole recorded window behind it.
    if (c.synthetic) continue;
    if (run < need) {
      if (i >= need - 1) counts.notJudged += 1;
      continue;
    }

    const window: Series = { asset: series.asset, bucketSeconds: width, candles: candles.slice(i - need + 1, i + 1) };
    const out = proposeTrade(spec, window, (c.timestamp + width) * 1000, {
      equity: PAPER_EQUITY,
      equitySource: 'paper',
    });
    if (out.kind === 'unavailable') {
      counts.unavailable += 1;
      continue;
    }
    counts.judged += 1;
    if (out.kind === 'refusal') continue;

    counts.passed += 1;
    const key = setupKey(out.results);
    if (traded.has(key)) {
      counts.repeats += 1;
      continue;
    }
    traded.add(key);

    const target = targetPrice({ direction, entry: out.setup.entry, targetDistanceBps: targetBps });
    const trade: BacktestTrade = {
      n: trades.length + 1,
      setupAt: c.timestamp,
      entry: out.setup.entry,
      stop: out.setup.stop,
      target,
      results: out.results,
      outcome: 'open_at_end',
      heldCandles: 0,
    };
    trades.push(trade);
    counts.trades += 1;
    if (!target) {
      // No price to put the target at: the trade cannot be followed to a result.
      trade.outcome = 'cannot_tell';
      trade.reason = 'target_not_priced';
      counts.cannotTell += 1;
      continue;
    }
    open = { trade, expectAt: c.timestamp + width };
  }

  if (open) counts.openAtEnd += 1;
  counts.decided = counts.wins + counts.losses;

  const stopBps = params.stopDistanceBps;
  const breakEvenBps = ratioBps(stopBps, stopBps + targetBps)!;
  const winRateBps = ratioBps(counts.wins, counts.decided);

  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  return {
    kind: 'result',
    range: {
      from: first.timestamp,
      to: last.timestamp + width,
      candles: candles.length,
      recorded: recordedCount,
      synthetic: candles.length - recordedCount,
    },
    counts,
    winRateBps,
    breakEvenBps,
    verdict: verdictOf(counts.wins, counts.decided, stopBps, targetBps),
    trades,
    gaps: findGaps(candles, width),
    params,
  };
}

/**
 * Above, below or at break-even, compared exactly rather than through two
 * rounded figures: `wins / decided` against `stop / (stop + target)` by cross
 * multiplication. With fewer than `MIN_DECIDED_TRADES` decided, no verdict.
 */
export function verdictOf(wins: number, decided: number, stopBps: number, targetBps: number): Verdict {
  if (decided < MIN_DECIDED_TRADES) return 'too_few_trades';
  const lhs = wins * (stopBps + targetBps);
  const rhs = decided * stopBps;
  return lhs > rhs ? 'above_break_even' : lhs < rhs ? 'below_break_even' : 'at_break_even';
}
