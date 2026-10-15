import { dec, parseDecimal, ratioBps, type Decimal } from '@kanon/spec';
import type {
  BacktestGap,
  BacktestParams,
  BacktestResult,
  BacktestTrade,
  CannotTellReason,
  TradeOutcome,
} from './backtest-types';

/*
 * The test screen's sample, for a visitor who has not signed in: the shape of a
 * run of the demo rule (RULE 04: BOS 5, FVG 15 bps, a sweep of the previous
 * day's low, a 0.50% stop and a 1.00% target) over three and a half weeks of
 * BTC/USD 15m candles. Every figure here is made up for the sample and the
 * screen says so; nothing is ever presented as a run.
 *
 * The figures are worked out the way the engine works them out (the levels
 * rounded away from the entry, a win at the target touched, the win rate over
 * decided trades only), so the sample reads like the real thing and never
 * contradicts itself.
 */

const W = 900;
const FROM = Date.UTC(2026, 8, 21) / 1000;
const CANDLES = 2_352;
const STOP_BPS = 50;
const TARGET_BPS = 100;

/** Ceiling of `price * bps / 10_000`, at least one atom: the engine's distance. */
function distance(price: bigint, bps: number): bigint {
  const raw = price * BigInt(bps);
  const d = raw / 10_000n + (raw % 10_000n === 0n ? 0n : 1n);
  return d < 1n ? 1n : d;
}

const at = (i: number) => FROM + i * W;
const px = (v: bigint): Decimal => dec(v, 2);

/** Setup candle, outcome, entry, candles held, and the reason a result could not be told. */
const ROWS: Array<[number, TradeOutcome, string, number, CannotTellReason?]> = [
  [214, 'win', '63184.20', 6],
  [371, 'loss', '63902.75', 3],
  [530, 'win', '62711.40', 11],
  [702, 'win', '63355.10', 4],
  [866, 'cannot_tell', '64120.55', 1, 'both_touched'],
  [1_003, 'loss', '64488.90', 2],
  [1_141, 'win', '64010.35', 9],
  [1_288, 'win', '64873.60', 5],
  [1_402, 'cannot_tell', '65240.15', 2, 'gap'],
  [1_640, 'loss', '65602.80', 7],
  [1_757, 'win', '65118.45', 3],
  [1_893, 'loss', '65987.20', 4],
  [1_986, 'win', '66430.70', 8],
  [2_074, 'win', '66012.95', 6],
  [2_161, 'loss', '66755.30', 2],
  [2_249, 'win', '66198.85', 5],
  [2_346, 'open_at_end', '66904.10', 5],
];

/** Unrecorded runs of buckets. The second begins under the `gap` trade's second candle. */
const GAPS: BacktestGap[] = [
  { from: at(610), to: at(617), buckets: 8 },
  { from: at(1_404), to: at(1_409), buckets: 6 },
  { from: at(2_011), to: at(2_014), buckets: 4 },
];

function trade(n: number, [i, outcome, price, held, reason]: (typeof ROWS)[number]): BacktestTrade {
  const entry = parseDecimal(price, 2);
  const p = BigInt(entry.atoms);
  const stop = p - distance(p, STOP_BPS);
  const target = p + distance(p, TARGET_BPS);
  const setupAt = at(i);
  const results: BacktestTrade['results'] = [
    {
      predicateId: 'p1',
      kind: 'break_of_structure',
      symbol: 'bos_bullish',
      satisfied: true,
      decidingValue: entry,
      referenceValue: px(p - distance(p, 21)),
      at: setupAt,
    },
    {
      predicateId: 'p2',
      kind: 'fair_value_gap',
      symbol: 'fvg_present',
      satisfied: true,
      decidingValue: dec(String(17 + (n % 5) * 3), 0),
      referenceValue: dec('15', 0),
      at: setupAt - W,
    },
    {
      predicateId: 'p3',
      kind: 'liquidity_sweep',
      symbol: 'sweep_prev_day_low',
      satisfied: true,
      decidingValue: px(p - distance(p, 88)),
      referenceValue: px(p - distance(p, 64)),
      at: setupAt - 3 * W,
    },
  ];
  const base: BacktestTrade = {
    n,
    setupAt,
    entry,
    stop: px(stop),
    target: px(target),
    results,
    outcome,
    heldCandles: held,
  };
  if (reason) base.reason = reason;
  if (outcome === 'open_at_end') return base;

  const exitAt = setupAt + held * W;
  if (reason === 'gap') return { ...base, exit: { at: exitAt, candle: null, synthetic: true, comparisons: [] } };

  const wiggle = distance(p, 7);
  const high = outcome === 'loss' ? p + wiggle : target + wiggle;
  const low = outcome === 'win' ? p - wiggle : stop - wiggle;
  const comparisons: NonNullable<BacktestTrade['exit']>['comparisons'] = [];
  if (outcome !== 'win') comparisons.push({ field: 'low', value: px(low), op: '<=', level: 'stop', against: px(stop) });
  if (outcome !== 'loss') comparisons.push({ field: 'high', value: px(high), op: '>=', level: 'target', against: px(target) });
  return {
    ...base,
    exit: {
      at: exitAt,
      candle: { open: px(p + wiggle), high: px(high), low: px(low), close: px(outcome === 'win' ? high - wiggle : low + wiggle) },
      synthetic: false,
      comparisons,
    },
  };
}

const trades = ROWS.map((row, i) => trade(i + 1, row));
const count = (o: TradeOutcome) => trades.filter((t) => t.outcome === o).length;
const wins = count('win');
const losses = count('loss');
const synthetic = GAPS.reduce((n, g) => n + g.buckets, 0);
const held = trades.reduce((n, t) => n + t.heldCandles, 0);
const windowCandles = 197;
const notJudged = GAPS.length * (windowCandles - 1);
const passed = trades.length + 9;

const params: BacktestParams = {
  engineVersion: 1,
  asset: 'BTC/USD',
  direction: 'long',
  bucketSeconds: W,
  windowCandles,
  recencyCandles: 4,
  minDecidedTrades: 30,
  maxCandles: 20_000,
  stopDistanceBps: STOP_BPS,
  targetDistanceBps: TARGET_BPS,
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

export const SAMPLE_BACKTEST: BacktestResult = {
  kind: 'result',
  range: { from: FROM, to: at(CANDLES), candles: CANDLES, recorded: CANDLES - synthetic, synthetic },
  counts: {
    judged: CANDLES - (windowCandles - 1) - synthetic - notJudged - held,
    passed,
    repeats: passed - trades.length,
    notJudged,
    unavailable: 0,
    trades: trades.length,
    wins,
    losses,
    cannotTell: count('cannot_tell'),
    openAtEnd: count('open_at_end'),
    decided: wins + losses,
  },
  winRateBps: ratioBps(wins, wins + losses),
  breakEvenBps: ratioBps(STOP_BPS, STOP_BPS + TARGET_BPS)!,
  verdict: 'too_few_trades',
  trades,
  gaps: GAPS,
  params,
};
