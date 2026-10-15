import {
  formatBps,
  formatDecimal,
  predicateComparison,
  type StrategySpec,
} from '@kanon/spec';
import type {
  BacktestHalt,
  BacktestParams,
  BacktestReply,
  BacktestResult,
  BacktestState,
  BacktestTrade,
  CannotTellReason,
  ExitComparison,
  TradeOutcome,
  Verdict,
} from './backtest-types';

/*
 * The test screen's words and figures, worked out from what the server sent and
 * nothing else. Pure, so every sentence the screen can show is pinned down in
 * `backtest.test.ts`.
 *
 * Three things hold in all of it. No money: a test counts what a stated stop
 * and target would have done, and a win rate is not a result in dollars. Every
 * constant the run was shaped by is listed, including the ones a reader would
 * rather not see (fees not included). And a rule the test cannot judge, or a
 * trade it cannot follow, is said plainly and calmly, as the answer it is.
 */

// ---------------------------------------------------------------------------
// From the server's reply to the screen's state
// ---------------------------------------------------------------------------

/**
 * What a reply makes of the screen. A rate limit is not a state of the test:
 * whatever was shown stays, and the sentence goes above the action.
 */
export function fromReply(reply: BacktestReply): { state: BacktestState } | { note: string } {
  switch (reply.status) {
    case 'result': {
      const { status: _s, result, ...ran } = reply;
      return { state: { status: 'result', result, sample: false, ...ran } };
    }
    case 'halted':
      return { state: { status: 'halted', halt: reply.halt, ...(reply.ran ? { ran: reply.ran } : {}) } };
    case 'not_run':
      return { state: { status: 'not_run' } };
    case 'rate_limited':
      return { note: reply.message };
  }
}

const TIMEFRAME: Record<number, string> = { 60: '1M', 300: '5M', 900: '15M', 3600: '1H', 14_400: '4H', 86_400: '1D' };

/** `15M`, or the width in seconds when it has no name. */
export function timeframeOf(seconds: number): string {
  return TIMEFRAME[seconds] ?? `${seconds}S`;
}

/** The pair and the candle width under test, as the header names them. */
export function backtestSubject(spec: StrategySpec): { asset: string; timeframe: string } {
  return { asset: spec.series.asset, timeframe: timeframeOf(spec.series.bucketSeconds) };
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `2026-10-14 13:45`, UTC, from unix seconds. */
export function stamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const grouped = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${grouped(n)} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Above the fold
// ---------------------------------------------------------------------------

export type TradeFilter = 'all' | 'decided' | 'win' | 'loss' | 'cannot_tell';

export interface Tile {
  filter: TradeFilter;
  label: string;
  value: string;
}

export interface VerdictView {
  verdict: Verdict;
  label: string;
  icon: 'arrow-up' | 'arrow-down' | 'minus' | 'info';
  /** Break-even, with the stop and target it comes from. */
  line: string;
  /** Only for too few trades: how many a verdict needs. */
  more: string | null;
}

const VERDICT_LABEL: Record<Verdict, { label: string; icon: VerdictView['icon'] }> = {
  above_break_even: { label: 'Above break-even', icon: 'arrow-up' },
  below_break_even: { label: 'Below break-even', icon: 'arrow-down' },
  at_break_even: { label: 'At break-even', icon: 'minus' },
  too_few_trades: { label: 'Too few trades', icon: 'info' },
};

export function verdictView(result: BacktestResult): VerdictView {
  const { params, counts } = result;
  const target = params.targetDistanceBps ?? 0;
  const { label, icon } = VERDICT_LABEL[result.verdict];
  return {
    verdict: result.verdict,
    label,
    icon,
    line: `Break-even is ${formatBps(result.breakEvenBps)} with a ${formatBps(params.stopDistanceBps)} stop and a ${formatBps(target)} target, before fees.`,
    more:
      result.verdict === 'too_few_trades'
        ? `A verdict needs ${grouped(params.minDecidedTrades)} decided trades. This test has ${grouped(counts.decided)}.`
        : null,
  };
}

/** The win rate, `64.29%`, or null before anything was decided. */
export function winRateFigure(result: BacktestResult): string | null {
  return result.winRateBps === null ? null : formatBps(result.winRateBps);
}

export function winRateLine(result: BacktestResult): string {
  const { decided } = result.counts;
  return decided === 0 ? 'No trade reached its stop or its target.' : `of ${plural(decided, 'decided trade')}`;
}

/** The four tiles, each the filter on the trade list that is its evidence. */
export function tiles(result: BacktestResult): Tile[] {
  const c = result.counts;
  return [
    { filter: 'decided', label: 'Decided', value: grouped(c.decided) },
    { filter: 'win', label: 'Wins', value: grouped(c.wins) },
    { filter: 'loss', label: 'Losses', value: grouped(c.losses) },
    { filter: 'cannot_tell', label: 'Cannot tell', value: grouped(c.cannotTell) },
  ];
}

export function rangeLine(result: BacktestResult): { span: string; detail: string } {
  const { range, params } = result;
  const tf = timeframeOf(params.bucketSeconds);
  return {
    span: `${stamp(range.from)} to ${stamp(range.to)} UTC`,
    detail:
      range.synthetic === 0
        ? `${plural(range.candles, `${tf} candle`)}, every one recorded`
        : `${plural(range.candles, `${tf} candle`)}, ${grouped(range.synthetic)} carried forward flat`,
  };
}

/** Whether what is shown is current, or how far behind it is. */
export function freshnessLine(state: Extract<BacktestState, { status: 'result' }>): string {
  if (state.sample) return 'Sample figures on the demo rule. Nothing was run.';
  const behind = state.behindCandles ?? 0;
  if (behind === 0) return 'Current: it ran through the newest closed candle.';
  return `${plural(behind, 'newer candle')} ${behind === 1 ? 'has' : 'have'} closed since this ran.`;
}

/**
 * The one line that keeps the test from being read as a promise about
 * autopilot: autopilot opens timed trades, and does not trade this stop and
 * target.
 */
export const NOT_AUTOPILOT =
  'This tests the rule with its own stop and target. Autopilot does not trade those: it opens a timed trade for a fixed hold, so its record is not this one.';

// ---------------------------------------------------------------------------
// The trade list and its sheets
// ---------------------------------------------------------------------------

export const OUTCOME_LABEL: Record<TradeOutcome, string> = {
  win: 'Win',
  loss: 'Loss',
  cannot_tell: 'Cannot tell',
  open_at_end: 'Open at end',
};

export const OUTCOME_ICON: Record<TradeOutcome, 'check' | 'x' | 'help' | 'clock'> = {
  win: 'check',
  loss: 'x',
  cannot_tell: 'help',
  open_at_end: 'clock',
};

export function filterTrades(trades: readonly BacktestTrade[], filter: TradeFilter): BacktestTrade[] {
  switch (filter) {
    case 'all':
      return [...trades];
    case 'decided':
      return trades.filter((t) => t.outcome === 'win' || t.outcome === 'loss');
    default:
      return trades.filter((t) => t.outcome === filter);
  }
}

export const FILTER_EMPTY: Record<TradeFilter, string> = {
  all: 'The rule passed no setup in these candles, so nothing was traded.',
  decided: 'No trade reached its stop or its target.',
  win: 'No trade reached its target first.',
  loss: 'No trade reached its stop first.',
  cannot_tell: 'Every trade that ended was decided.',
};

export interface TradeRowView {
  n: number;
  /** `#07`. */
  ordinal: string;
  setup: string;
  outcome: TradeOutcome;
  label: string;
  /** `held 6 candles`, `still open after 3 candles`. */
  held: string;
}

export function tradeRow(trade: BacktestTrade): TradeRowView {
  return {
    n: trade.n,
    ordinal: `#${pad2(trade.n)}`,
    setup: stamp(trade.setupAt),
    outcome: trade.outcome,
    label: OUTCOME_LABEL[trade.outcome],
    held:
      trade.outcome === 'open_at_end'
        ? `open after ${plural(trade.heldCandles, 'candle')}`
        : trade.outcome === 'cannot_tell' && trade.reason === 'target_not_priced'
          ? 'not followed'
          : `held ${plural(trade.heldCandles, 'candle')}`,
  };
}

const OP: Record<ExitComparison['op'], string> = { '<=': '≤', '>=': '≥' };

/** `low 103.95 ≤ stop 103.95`: the comparison an exit was decided by, as it was made. */
export function comparisonText(c: ExitComparison): string {
  return `${c.field} ${formatDecimal(c.value)} ${OP[c.op]} ${c.level} ${formatDecimal(c.against)}`;
}

const REASON: Record<CannotTellReason, string> = {
  both_touched:
    'This candle reached both the stop and the target. Which came first is not in the recorded prices, so the result cannot be told.',
  gap: 'No price was recorded for this candle, so what the trade did in it cannot be told. Nothing is judged again until the window has filled with recorded candles.',
  target_not_priced:
    'A target this far below a short entry would be at or below zero, so the trade cannot be followed to a result.',
};

export function exitSentence(trade: BacktestTrade): string {
  switch (trade.outcome) {
    case 'win':
      return 'The target was touched in this candle, and the stop was not.';
    case 'loss':
      return 'The stop was touched in this candle, and the target was not.';
    case 'open_at_end':
      return 'Neither the stop nor the target had been touched when the recorded prices end.';
    case 'cannot_tell':
      return REASON[trade.reason ?? 'gap'];
  }
}

export interface TradeSheetView {
  title: string;
  label: string;
  /** The setup and its levels. */
  facts: Array<[string, string]>;
  /** Every predicate at the setup: the evidence that the rule passed. */
  predicates: Array<{ id: string; symbol: string; comparison: string; at: string }>;
  /** The candle the trade ended in, or null while it is open at the end. */
  exit: {
    at: string;
    candle: Array<[string, string]> | null;
    comparisons: string[];
  } | null;
  sentence: string;
}

export function tradeSheet(trade: BacktestTrade, params: BacktestParams): TradeSheetView {
  const direction = params.direction;
  const facts: Array<[string, string]> = [
    ['Setup candle', `${stamp(trade.setupAt)} UTC`],
    ['Entry (its close)', formatDecimal(trade.entry)],
    ['Stop', formatDecimal(trade.stop)],
    ['Target', trade.target ? formatDecimal(trade.target) : 'No price'],
    ['Held', trade.reason === 'target_not_priced' ? 'Not followed' : plural(trade.heldCandles, 'candle')],
  ];
  const predicates = trade.results.map((r) => ({
    id: r.predicateId,
    symbol: r.symbol,
    comparison: predicateComparison({ kind: r.kind, direction }, r.decidingValue, r.referenceValue, r.satisfied),
    at: `${stamp(r.at)} UTC`,
  }));
  const exit = trade.exit
    ? {
        at: `${stamp(trade.exit.at)} UTC`,
        candle: trade.exit.candle
          ? ([
              ['Open', formatDecimal(trade.exit.candle.open)],
              ['High', formatDecimal(trade.exit.candle.high)],
              ['Low', formatDecimal(trade.exit.candle.low)],
              ['Close', formatDecimal(trade.exit.candle.close)],
            ] as Array<[string, string]>)
          : null,
        comparisons: trade.exit.comparisons.map(comparisonText),
      }
    : null;
  return {
    title: `TRADE ${pad2(trade.n)}`,
    label: OUTCOME_LABEL[trade.outcome],
    facts,
    predicates,
    exit,
    sentence: exitSentence(trade),
  };
}

// ---------------------------------------------------------------------------
// Below the fold: the rules of the test, what was judged, the gaps
// ---------------------------------------------------------------------------

export interface ParamRow {
  key: string;
  label: string;
  value: string;
}

const NOT_INCLUDED = 'Not included';

/** Each known constant, in the words the test screen lists it in. */
const PARAM_ROWS: Record<string, (v: string | number | boolean | null, p: BacktestParams) => [string, string]> = {
  asset: (v) => ['Pair', String(v)],
  direction: (v) => ['Direction', v === 'short' ? 'Short' : 'Long'],
  bucketSeconds: (v) => ['Candle', timeframeOf(Number(v))],
  stopDistanceBps: (v) => ['Stop', `${formatBps(Number(v))} from entry`],
  targetDistanceBps: (v) => ['Target', v === null ? 'Not stated' : `${formatBps(Number(v))} from entry`],
  entry: () => ['Entry', 'Close of the candle that passed'],
  judgedAt: () => ['Judged', 'At each candle close'],
  windowCandles: (v) => ['Window', `${plural(Number(v), 'candle')}, ending at the judged one`],
  recencyCandles: (v) => ['Setup recency', `Newest ${plural(Number(v), 'candle')} may decide`],
  touch: () => ['Touch', 'Reaching a level exactly counts'],
  levelRounding: () => ['Stop and target', 'Rounded away from entry'],
  bothTouched: () => ['Both in one candle', 'Cannot tell'],
  gapMidTrade: () => ['Unrecorded candle mid-trade', 'Cannot tell'],
  syntheticCandles: () => ['Unrecorded candles', 'Never decide a setup or an exit'],
  oneTradeAtATime: () => ['Trades at once', 'One'],
  setupTradedOnce: () => ['Same setup again', 'Not traded twice'],
  minDecidedTrades: (v) => ['A verdict needs', plural(Number(v), 'decided trade')],
  maxCandles: (v) => ['History read', `Newest ${plural(Number(v), 'candle')} at most`],
  fees: () => ['Fees', NOT_INCLUDED],
  slippage: () => ['Slippage', NOT_INCLUDED],
  funding: () => ['Funding', NOT_INCLUDED],
  engineVersion: (v) => ['Engine', `Version ${String(v)}`],
};

const ORDER = Object.keys(PARAM_ROWS);

/**
 * Every constant the run was shaped by, known ones in a reading order and any
 * the server added since, under their own names. None is left out.
 */
export function paramRows(params: BacktestParams): ParamRow[] {
  const keys = Object.keys(params).sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib) || a.localeCompare(b);
  });
  return keys.map((key) => {
    const value = params[key] ?? null;
    const known = PARAM_ROWS[key];
    const [label, text] = known ? known(value, params) : [key, value === null ? 'None' : String(value)];
    return { key, label, value: text };
  });
}

/** How the candles were spent: judged, passed, traded, and what was left out and why. */
export function coverageRows(result: BacktestResult): Array<[string, string]> {
  const c = result.counts;
  const rows: Array<[string, string]> = [
    ['Closes judged', grouped(c.judged)],
    ['Passed the rule', grouped(c.passed)],
    ['Traded', grouped(c.trades)],
    ['Same setup, not traded again', grouped(c.repeats)],
    ['Not judged: unrecorded candle in the window', grouped(c.notJudged)],
  ];
  if (c.unavailable > 0) rows.push(['Not judged: window too short for a predicate', grouped(c.unavailable)]);
  rows.push(['Still open at the end', grouped(c.openAtEnd)]);
  return rows;
}

export function gapSummary(result: BacktestResult): string {
  const { gaps } = result;
  if (gaps.length === 0) return 'Every candle in the range was recorded.';
  const buckets = gaps.reduce((n, g) => n + g.buckets, 0);
  return `${plural(buckets, 'candle')} in ${plural(gaps.length, 'gap')} had no price of their own. They decided nothing.`;
}

export function gapRows(result: BacktestResult): Array<{ key: string; span: string; count: string }> {
  return result.gaps.map((g) => ({
    key: String(g.from),
    span: g.from === g.to ? `${stamp(g.from)} UTC` : `${stamp(g.from)} to ${stamp(g.to)} UTC`,
    count: plural(g.buckets, 'candle'),
  }));
}

// ---------------------------------------------------------------------------
// Halted
// ---------------------------------------------------------------------------

export interface HaltView {
  title: string;
  message: string;
  /** What the foot offers: the review to state an exit, a second try, or nothing. */
  action: { kind: 'review'; label: string } | { kind: 'retry'; label: string } | null;
}

export function haltView(halt: BacktestHalt): HaltView {
  const action: HaltView['action'] =
    halt.reason === 'exits_not_stated'
      ? { kind: 'review', label: halt.params.targetDistanceBps === null ? 'STATE A TARGET' : 'STATE YOUR EXITS' }
      : halt.reason === 'history_not_ready'
        ? { kind: 'retry', label: 'TRY AGAIN' }
        : null;
  return { title: 'TEST STOPPED', message: halt.message, action };
}
