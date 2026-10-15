import { describe, expect, it } from 'vitest';
import {
  BOS20_15M_NO_TARGET,
  RULE_04,
  dec,
  formatDecimal,
  inferred,
  parseDecimal,
  stated,
  type Candle,
  type Series,
  type StrategySpec,
} from '@kanon/spec';
import {
  ENGINE_VERSION,
  MAX_BACKTEST_CANDLES,
  MIN_DECIDED_TRADES,
  minimumCandles,
  precheckBacktest,
  runBacktest,
  verdictOf,
  type BacktestOutcome,
  type BacktestResult,
} from './backtestLogic';
import { requiredCandles } from './proposerLogic';

const px = (v: string) => parseDecimal(v, 2);
const W = 900;
const T0 = 1_800_000_000 - (1_800_000_000 % W); // a 15m boundary

/** A long break of structure over 3 candles, a 1% stop and a 2% target, all stated. */
const longSpec: StrategySpec = {
  ...RULE_04,
  predicates: [
    { kind: 'break_of_structure', id: 'p1', direction: 'long', swingLookbackCandles: stated(3), timeframe: stated('15m') },
  ],
  risk: { riskPerTradeBps: stated(50), stopDistanceBps: stated(100), targetDistanceBps: stated(200) },
};

const shortSpec: StrategySpec = {
  ...longSpec,
  direction: 'short',
  predicates: [
    { kind: 'break_of_structure', id: 'p1', direction: 'short', swingLookbackCandles: stated(3), timeframe: stated('15m') },
  ],
};

/** One candle, written `open/high/low/close`; `S` is a synthetic candle carrying the prior close; `X` is a bucket with no candle. */
type Step = [string, string, string, string] | 'S' | 'X' | { synthetic: [string, string, string, string] };

const FLAT: Step = ['100', '101', '99', '100'];
/** Closes above the 101 swing high: a long setup. Entry 105.00, stop 103.95, target 107.10. */
const BREAK_UP: Step = ['100', '105', '100', '105'];
/** Each exit candle closes back under 105, so it never forms a break of structure of its own. */
const LONG_WIN: Step = ['105', '107.10', '104', '104.50'];
const LONG_LOSS: Step = ['105', '105.50', '103.95', '104'];
const LONG_BOTH: Step = ['105', '108', '103', '105'];
const LONG_HOLD: Step = ['105', '106', '104', '105'];
/** A fresh break above 106 that touches neither level of a trade opened at 105.00. */
const BREAK_WHILE_OPEN: Step = ['105', '106.50', '104.50', '106.50'];
/** Closes below the 99 swing low: a short setup. Entry 95.00, stop 95.95, target 93.10. */
const BREAK_DOWN: Step = ['100', '100', '95', '95'];
const SHORT_WIN: Step = ['95', '95.50', '93.10', '94'];
const SHORT_LOSS: Step = ['95', '95.95', '94', '95'];

const flats = (n: number): Step[] => Array.from({ length: n }, () => FLAT);

function series(steps: Step[]): Series {
  const candles: Candle[] = [];
  let close = px('100');
  steps.forEach((step, i) => {
    const ts = T0 + i * W;
    if (step === 'X') return;
    if (step === 'S') {
      candles.push({ bucketIndex: ts / W, timestamp: ts, open: close, high: close, low: close, close, synthetic: true });
      return;
    }
    const [o, h, l, c] = Array.isArray(step) ? step : step.synthetic;
    candles.push({
      bucketIndex: ts / W,
      timestamp: ts,
      open: px(o),
      high: px(h),
      low: px(l),
      close: px(c),
      synthetic: !Array.isArray(step),
    });
    close = px(c);
  });
  return { asset: 'BTC/USD', bucketSeconds: W, candles };
}

function result(out: BacktestOutcome): BacktestResult {
  if (out.kind !== 'result') throw new Error(`expected a result, got ${out.reason}: ${out.message}`);
  return out;
}

const NEED = requiredCandles(longSpec, W); // 8: three back for the swing, four of recency, one more

describe('halts, with no win rate', () => {
  it('halts a rule with no stated target, in the exits sentence', () => {
    const out = runBacktest(BOS20_15M_NO_TARGET, series(flats(40)));
    expect(out.kind).toBe('halted');
    if (out.kind !== 'halted') return;
    expect(out.reason).toBe('exits_not_stated');
    expect(out.message).toMatch(/no stated target/);
    expect('winRateBps' in out).toBe(false);
  });

  it('treats an inferred stop or target as not stated', () => {
    const inferredTarget = { ...longSpec, risk: { ...longSpec.risk, targetDistanceBps: inferred(200) } };
    const inferredStop = { ...longSpec, risk: { ...longSpec.risk, stopDistanceBps: inferred(100) } };
    expect(precheckBacktest(inferredTarget)?.reason).toBe('exits_not_stated');
    expect(precheckBacktest(inferredStop)?.message).toMatch(/no stated stop/);
  });

  it('halts a rule that reads more than one candle width', () => {
    const mixed: StrategySpec = {
      ...longSpec,
      predicates: [
        ...longSpec.predicates,
        { kind: 'fair_value_gap', id: 'p2', direction: 'long', minGapBps: stated(10), timeframe: stated('1h') },
      ],
    };
    const out = runBacktest(mixed, series(flats(40)));
    expect(out.kind === 'halted' && out.reason).toBe('mixed_timeframes');
    expect(out.kind === 'halted' && out.message).toMatch(/15m and 1h/);
  });

  it('halts a rule whose predicates read a width other than the one it is judged at', () => {
    const hourly: StrategySpec = {
      ...longSpec,
      predicates: [{ ...longSpec.predicates[0]!, timeframe: stated('1h') } as StrategySpec['predicates'][number]],
    };
    expect(precheckBacktest(hourly)?.reason).toBe('mixed_timeframes');
    expect(precheckBacktest(hourly)?.message).toMatch(/reads 1h candles but is judged at every 15m close/);
  });

  it('halts with no candles, and with nothing but synthetic ones', () => {
    const empty = runBacktest(longSpec, series([]));
    expect(empty.kind === 'halted' && empty.reason).toBe('no_candles');
    const allSynthetic = runBacktest(longSpec, series(Array.from({ length: 20 }, () => 'S' as const)));
    expect(allSynthetic.kind === 'halted' && allSynthetic.reason).toBe('no_candles');
  });

  it('halts with too little history to judge one setup and see one candle after it', () => {
    expect(minimumCandles(longSpec)).toBe(NEED + 1);
    const out = runBacktest(longSpec, series(flats(NEED)));
    expect(out.kind === 'halted' && out.reason).toBe('insufficient_history');
    expect(out.kind === 'halted' && out.message).toBe(
      `A test of this rule needs at least ${NEED + 1} 15m candles of BTC/USD: ${NEED} to judge a setup and one after it. ${NEED} are recorded.`,
    );
    expect(runBacktest(longSpec, series(flats(NEED + 1))).kind).toBe('result');
  });

  it('echoes every constant on a halt too', () => {
    const out = runBacktest(BOS20_15M_NO_TARGET, series([]));
    expect(out.params.targetDistanceBps).toBeNull();
    expect(out.params.fees).toBe('not_included');
    expect(out.params.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('outcomes', () => {
  it('counts a long that touches its target as a win, entered at the setup close', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_WIN, ...flats(3)])));
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.setupAt).toBe(T0 + 7 * W);
    expect(formatDecimal(t.entry)).toBe('105.00');
    expect(formatDecimal(t.stop)).toBe('103.95');
    expect(formatDecimal(t.target!)).toBe('107.10');
    expect(t.outcome).toBe('win');
    expect(t.heldCandles).toBe(1);
    expect(t.exit!.at).toBe(T0 + 8 * W);
    expect(t.exit!.comparisons).toEqual([
      { field: 'high', value: px('107.10'), op: '>=', level: 'target', against: px('107.10') },
    ]);
    // The predicate values at the setup are the evidence.
    expect(t.results[0]).toMatchObject({ predicateId: 'p1', satisfied: true, decidingValue: px('105'), referenceValue: px('101') });
    expect(r.counts).toMatchObject({ wins: 1, losses: 0, decided: 1, trades: 1 });
  });

  it('counts a long that touches its stop as a loss, exactly at the level', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_LOSS, ...flats(2)])));
    expect(r.trades[0]!.outcome).toBe('loss');
    expect(r.trades[0]!.exit!.comparisons).toEqual([
      { field: 'low', value: px('103.95'), op: '<=', level: 'stop', against: px('103.95') },
    ]);
  });

  it('cannot tell when one candle touched both the stop and the target', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_BOTH, ...flats(2)])));
    const t = r.trades[0]!;
    expect(t.outcome).toBe('cannot_tell');
    expect(t.reason).toBe('both_touched');
    expect(t.exit!.comparisons.map((x) => x.level)).toEqual(['stop', 'target']);
    expect(r.counts).toMatchObject({ cannotTell: 1, decided: 0 });
    expect(r.winRateBps).toBeNull();
  });

  it('holds through candles that touch neither, and leaves a trade open at the end of the data', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_HOLD, LONG_HOLD])));
    const t = r.trades[0]!;
    expect(t.outcome).toBe('open_at_end');
    expect(t.exit).toBeUndefined();
    expect(t.heldCandles).toBe(2);
    expect(r.counts).toMatchObject({ openAtEnd: 1, decided: 0, trades: 1 });
  });

  it('wins and loses a short the other way up', () => {
    const win = result(runBacktest(shortSpec, series([...flats(7), BREAK_DOWN, SHORT_WIN, ...flats(2)])));
    expect(formatDecimal(win.trades[0]!.stop)).toBe('95.95');
    expect(formatDecimal(win.trades[0]!.target!)).toBe('93.10');
    expect(win.trades[0]!.outcome).toBe('win');
    const loss = result(runBacktest(shortSpec, series([...flats(7), BREAK_DOWN, SHORT_LOSS, ...flats(2)])));
    expect(loss.trades[0]!.outcome).toBe('loss');
    expect(loss.trades[0]!.exit!.comparisons[0]).toMatchObject({ field: 'high', op: '>=', level: 'stop' });
  });

  it('cannot tell a short whose target would be at or below zero', () => {
    const wide = { ...shortSpec, risk: { ...shortSpec.risk, targetDistanceBps: stated(10_000) } };
    const r = result(runBacktest(wide, series([...flats(7), BREAK_DOWN, SHORT_WIN, ...flats(2)])));
    expect(r.trades[0]).toMatchObject({ outcome: 'cannot_tell', reason: 'target_not_priced', target: null });
    expect(r.counts.cannotTell).toBe(1);
  });
});

describe('synthetic and missing candles never decide anything', () => {
  it('never judges a window holding a synthetic candle, even one that would pass', () => {
    // A carried-forward candle doctored to close above the swing: judged, it would be a setup.
    const steps: Step[] = [...flats(7), { synthetic: BREAK_UP as [string, string, string, string] }, ...flats(NEED - 1)];
    const r = result(runBacktest(longSpec, series(steps)));
    expect(r.trades).toHaveLength(0);
    // The seven recorded candles after it still have it in their window.
    expect(r.counts.notJudged).toBe(NEED - 1);
    expect(r.counts.judged).toBe(0);
    expect(r.range.synthetic).toBe(1);
    expect(r.gaps).toEqual([{ from: T0 + 7 * W, to: T0 + 7 * W, buckets: 1 }]);
  });

  it('judges again once the window has filled with recorded candles', () => {
    const steps: Step[] = [...flats(4), 'S', ...flats(NEED - 1), BREAK_UP, LONG_WIN];
    const r = result(runBacktest(longSpec, series(steps)));
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.setupAt).toBe(T0 + (4 + NEED) * W);
  });

  it('ends a trade as cannot_tell at a synthetic candle, whatever it shows, then re-warms', () => {
    const doctoredLoss = { synthetic: ['105', '105', '90', '90'] as [string, string, string, string] };
    const steps: Step[] = [...flats(7), BREAK_UP, doctoredLoss, ...flats(3), BREAK_UP, LONG_WIN, ...flats(NEED - 5), BREAK_UP, LONG_WIN];
    const r = result(runBacktest(longSpec, series(steps)));
    const t = r.trades[0]!;
    expect(t.outcome).toBe('cannot_tell');
    expect(t.reason).toBe('gap');
    expect(t.exit).toEqual({ at: T0 + 8 * W, candle: null, synthetic: true, comparisons: [] });
    // The breakout four candles after the gap is not judged: its window still holds the gap.
    expect(r.trades).toHaveLength(2);
    expect(r.trades[1]!.setupAt).toBe(T0 + (9 + 3 + 1 + 1 + NEED - 5) * W);
    expect(r.trades[1]!.outcome).toBe('win');
  });

  it('ends a trade as cannot_tell at a bucket with no candle at all', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, 'X', LONG_LOSS, ...flats(2)])));
    expect(r.trades[0]).toMatchObject({ outcome: 'cannot_tell', reason: 'gap' });
    expect(r.trades[0]!.exit).toEqual({ at: T0 + 8 * W, candle: null, synthetic: true, comparisons: [] });
    expect(r.gaps).toEqual([{ from: T0 + 8 * W, to: T0 + 8 * W, buckets: 1 }]);
  });
});

describe('one trade at a time, each setup once', () => {
  it('judges nothing while a trade is open', () => {
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_HOLD, BREAK_WHILE_OPEN, LONG_HOLD])));
    expect(r.trades).toHaveLength(1);
    expect(r.counts).toMatchObject({ judged: 1, passed: 1, openAtEnd: 1 });
  });

  it('does not trade the same setup again after a quick exit', () => {
    // After the win the breakout is still inside the recency window, so the rule passes on it again.
    const r = result(runBacktest(longSpec, series([...flats(7), BREAK_UP, LONG_WIN, ...flats(5)])));
    expect(r.trades).toHaveLength(1);
    // Judged at the exit candle's close and the two after it, while the breakout is still among the newest four.
    expect(r.counts.repeats).toBe(3);
    expect(r.counts.passed).toBe(1 + r.counts.repeats);
  });
});

/** `wins` wins and `losses` losses, each a fresh breakout after enough flat candles to clear the last one. */
function rounds(wins: number, losses: number): Step[] {
  const steps: Step[] = [...flats(7)];
  for (let i = 0; i < wins + losses; i++) steps.push(BREAK_UP, i < wins ? LONG_WIN : LONG_LOSS, ...flats(7));
  return steps;
}

describe('win rate, break-even and the verdict', () => {
  it('takes the win rate over decided trades only, and says too few under the minimum', () => {
    const r = result(runBacktest(longSpec, series([...rounds(3, 1), BREAK_UP, LONG_BOTH, ...flats(7), BREAK_UP, LONG_HOLD])));
    expect(r.counts).toMatchObject({ wins: 3, losses: 1, cannotTell: 1, openAtEnd: 1, decided: 4, trades: 6 });
    expect(r.winRateBps).toBe(7500);
    expect(r.breakEvenBps).toBe(3333); // 100 / (100 + 200), rounded half up
    expect(r.verdict).toBe('too_few_trades');
  });

  it('draws a verdict at the minimum, exactly against break-even', () => {
    expect(MIN_DECIDED_TRADES).toBe(30);
    expect(result(runBacktest(longSpec, series(rounds(20, 10)))).verdict).toBe('above_break_even');
    expect(result(runBacktest(longSpec, series(rounds(9, 21)))).verdict).toBe('below_break_even');
    const even = result(runBacktest(longSpec, series(rounds(10, 20))));
    expect(even.winRateBps).toBe(3333);
    expect(even.verdict).toBe('at_break_even');
  });

  it('compares exactly, not through two rounded figures', () => {
    // 1/3 against a 1:2 stop and target is break-even exactly; both round to 3333 bps.
    expect(verdictOf(10, 30, 100, 200)).toBe('at_break_even');
    expect(verdictOf(10, 31, 100, 200)).toBe('below_break_even');
    expect(verdictOf(11, 31, 100, 200)).toBe('above_break_even');
    expect(verdictOf(29, 29, 100, 200)).toBe('too_few_trades');
  });

  it('states the data range and every constant it ran under', () => {
    const r = result(runBacktest(longSpec, series(rounds(1, 0))));
    expect(r.range).toEqual({ from: T0, to: T0 + r.range.candles * W, candles: 7 + 9, recorded: 16, synthetic: 0 });
    expect(r.params).toEqual({
      engineVersion: ENGINE_VERSION,
      asset: 'BTC/USD',
      direction: 'long',
      bucketSeconds: 900,
      windowCandles: NEED,
      recencyCandles: 4,
      minDecidedTrades: 30,
      maxCandles: MAX_BACKTEST_CANDLES,
      stopDistanceBps: 100,
      targetDistanceBps: 200,
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
    });
  });
});

/** A seeded walk of recorded 15m candles around 65,000.00, with a gap now and then. Integers only. */
function walk(n: number, seed = 7): Series {
  let s = seed;
  const rand = (k: number) => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s % k;
  };
  const candles: Candle[] = [];
  let close = 6_500_000n;
  for (let i = 0; i < n; i++) {
    const ts = T0 + i * W;
    if (i > 0 && rand(4_000) === 0) {
      candles.push({ bucketIndex: ts / W, timestamp: ts, open: dec(close, 2), high: dec(close, 2), low: dec(close, 2), close: dec(close, 2), synthetic: true });
      continue;
    }
    const open = close;
    close = open + BigInt(rand(60_001) - 30_000);
    const hi = (open > close ? open : close) + BigInt(rand(15_001));
    const lo = (open < close ? open : close) - BigInt(rand(15_001));
    candles.push({ bucketIndex: ts / W, timestamp: ts, open: dec(open, 2), high: dec(hi, 2), low: dec(lo, 2), close: dec(close, 2), synthetic: false });
  }
  return { asset: 'BTC/USD', bucketSeconds: W, candles };
}

const BOS20: StrategySpec = {
  ...BOS20_15M_NO_TARGET,
  risk: { ...BOS20_15M_NO_TARGET.risk, targetDistanceBps: stated(400) },
};

describe('determinism and speed', () => {
  it('gives the same answer for the same spec and series, and leaves the series as it was', () => {
    const s = walk(3_000);
    const before = JSON.stringify(s);
    const a = runBacktest(BOS20, s);
    const b = runBacktest(BOS20, s);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(s)).toBe(before);
    expect(result(a).counts.trades).toBeGreaterThan(0);
  });

  it('walks 20,000 candles of BOS 20 in under two seconds', () => {
    const s = walk(MAX_BACKTEST_CANDLES);
    const started = performance.now();
    const r = result(runBacktest(BOS20, s));
    const ms = performance.now() - started;
    expect(r.range.candles).toBe(MAX_BACKTEST_CANDLES);
    expect(r.counts.decided).toBeGreaterThan(0);
    expect(r.counts.trades).toBe(r.counts.wins + r.counts.losses + r.counts.cannotTell + r.counts.openAtEnd);
    // No trade ever ends on, or is opened at, a synthetic candle.
    const synthetic = new Set(s.candles.filter((c) => c.synthetic).map((c) => c.timestamp));
    for (const t of r.trades) {
      expect(synthetic.has(t.setupAt)).toBe(false);
      if (t.exit && t.outcome !== 'cannot_tell') expect(synthetic.has(t.exit.at)).toBe(false);
    }
    expect(ms).toBeLessThan(2_000);
  });
});
