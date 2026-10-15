import type { Decimal, PredicateKind } from '@kanon/spec';

/*
 * Test on recorded prices: what `backtest:run` answers, and what the test screen
 * draws from it.
 *
 * The wire shapes are restated from the backend (`convex/backtestLogic.ts` and
 * `convex/backtest.ts`), because `packages/ui` does not depend on it. They are
 * plain data, every number an integer or a `Decimal`, and nothing in them is
 * money: a test counts what a rule's stated stop and target would have done.
 */

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export type BacktestHaltReason =
  | 'exits_not_stated'
  | 'mixed_timeframes'
  | 'no_candles'
  | 'insufficient_history'
  | 'history_not_ready';

export type TradeOutcome = 'win' | 'loss' | 'cannot_tell' | 'open_at_end';

export type CannotTellReason = 'both_touched' | 'gap' | 'target_not_priced';

export type Verdict = 'above_break_even' | 'below_break_even' | 'at_break_even' | 'too_few_trades';

export interface BacktestPredicate {
  predicateId: string;
  kind: PredicateKind;
  symbol: string;
  satisfied: boolean;
  decidingValue: Decimal;
  referenceValue: Decimal;
  /** Unix seconds: the candle that decided it. */
  at: number;
}

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
  /** Null when that candle was carried forward flat or never recorded. */
  candle: { open: Decimal; high: Decimal; low: Decimal; close: Decimal } | null;
  synthetic: boolean;
  comparisons: ExitComparison[];
}

export interface BacktestTrade {
  n: number;
  /** Unix seconds: the start of the candle whose close passed the rule. */
  setupAt: number;
  entry: Decimal;
  stop: Decimal;
  target: Decimal | null;
  results: BacktestPredicate[];
  outcome: TradeOutcome;
  reason?: CannotTellReason;
  exit?: TradeExit;
  heldCandles: number;
}

export interface BacktestGap {
  from: number;
  to: number;
  buckets: number;
}

/**
 * Every constant a run was shaped by. The known keys are typed; the screen lists
 * every key it is sent, known or not, so a constant added on the server is
 * never hidden by a client that predates it.
 */
export interface BacktestParams {
  engineVersion: number;
  asset: string;
  direction: 'long' | 'short';
  bucketSeconds: number;
  windowCandles: number;
  recencyCandles: number;
  minDecidedTrades: number;
  maxCandles: number;
  stopDistanceBps: number;
  targetDistanceBps: number | null;
  [key: string]: string | number | boolean | null;
}

export interface BacktestCounts {
  judged: number;
  passed: number;
  repeats: number;
  notJudged: number;
  unavailable: number;
  trades: number;
  wins: number;
  losses: number;
  cannotTell: number;
  openAtEnd: number;
  decided: number;
}

export interface BacktestRange {
  from: number;
  to: number;
  candles: number;
  recorded: number;
  synthetic: number;
}

export interface BacktestResult {
  kind: 'result';
  range: BacktestRange;
  counts: BacktestCounts;
  winRateBps: number | null;
  breakEvenBps: number;
  verdict: Verdict;
  trades: BacktestTrade[];
  gaps: BacktestGap[];
  params: BacktestParams;
}

export interface BacktestHalt {
  kind: 'halted';
  reason: BacktestHaltReason;
  message: string;
  params: BacktestParams;
}

/** A run, stored or just made, and how far behind the newest closed candle it is. */
export interface BacktestRan {
  specHash: string;
  throughBucket: number;
  computedAt: number;
  behindCandles: number;
  source: 'stored' | 'run';
}

export type BacktestReply =
  | ({ status: 'result'; result: BacktestResult } & BacktestRan)
  | { status: 'halted'; specHash: string; halt: BacktestHalt; ran?: BacktestRan }
  | { status: 'not_run'; specHash: string }
  | { status: 'rate_limited'; retryAfterMs: number; message: string };

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** What is being tested: the spec under review (a draft, or a staged change), or one of the person's rules. */
export type BacktestSubject = { kind: 'review' } | { kind: 'rule'; id: string };

export type BacktestState =
  /** Asking what is stored for this spec. Nothing is run by opening the screen. */
  | { status: 'loading' }
  /** Nothing to test: no draft under review, or no rule by that id. */
  | { status: 'nothing'; message: string }
  /** Nothing stored for this spec yet: the action at the foot runs it. */
  | { status: 'not_run' }
  /** `sample` is the signed-out fixture, labelled as such and never presented as a run. */
  | ({ status: 'result'; result: BacktestResult; sample: boolean } & Partial<BacktestRan>)
  | { status: 'halted'; halt: BacktestHalt; ran?: BacktestRan }
  /** The server could not be asked, or did not answer. Its sentence, as it is. */
  | { status: 'failed'; message: string };

export interface BacktestRead {
  state: BacktestState;
  /** The pair and the candle width under test, for the header. Null with nothing to test. */
  subject: { asset: string; timeframe: string } | null;
  /** A run is out. */
  running: boolean;
  /** Why the last press did not run (the hour's runs are spent, or the server failed). Null otherwise. */
  note: string | null;
  /** Signed in, with a spec to test. Signed out the screen shows the sample and runs nothing. */
  canRun: boolean;
  /** Runs the test, unless the stored answer is already current. Never rejects. */
  run(): void;
}
