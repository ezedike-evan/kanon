import { describe, expect, it } from 'vitest';
import {
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
  MAX_STALE_BUCKETS,
  PAPER_EQUITY,
  SETUP_RECENCY_CANDLES,
  UNDO_WINDOW_MS,
  bucketsNeeded,
  confirmTransition,
  finalizeTransition,
  modelRefusedOutcome,
  proposeTrade,
  requiredCandles,
  sizePosition,
  summariseBlocked,
  undoSecondsLeft,
  undoTransition,
} from './proposerLogic';

const px = (v: string) => parseDecimal(v, 2);

function candle(ts: number, o: string, h: string, l: string, c: string, bucket = 900): Candle {
  return {
    bucketIndex: Math.floor(ts / bucket),
    timestamp: ts,
    open: px(o),
    high: px(h),
    low: px(l),
    close: px(c),
    synthetic: false,
  };
}

function series(candles: Candle[], bucketSeconds = 900): Series {
  return { asset: 'BTC/USD', bucketSeconds, candles };
}

const T0 = 1_800_000_000 - (1_800_000_000 % 900); // a 15m boundary
const at = (i: number) => T0 + i * 900;

const bosSpec: StrategySpec = {
  ...RULE_04,
  predicates: [
    {
      kind: 'break_of_structure',
      id: 'p1',
      direction: 'long',
      swingLookbackCandles: stated(3),
      timeframe: stated('15m'),
    },
  ],
};

/** Four flat candles topping at 101, then a last candle closing at `last`. */
function bosSeries(last: string): Series {
  return series([
    candle(at(0), '100', '101', '99', '100'),
    candle(at(1), '100', '101', '99', '100'),
    candle(at(2), '100', '101', '99', '100'),
    candle(at(3), '100', '101', '99', '100'),
    candle(at(4), '100', '106', '99', last),
  ]);
}

const nowFor = (s: Series) => (s.candles[s.candles.length - 1]!.timestamp + 60) * 1000;

describe('proposeTrade', () => {
  it('proposes when every predicate is satisfied, with entry, stop and size', () => {
    const s = bosSeries('105');
    const out = proposeTrade(bosSpec, s, nowFor(s));
    expect(out.kind).toBe('proposal');
    if (out.kind !== 'proposal') return;
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ predicateId: 'p1', symbol: 'bos_bullish', satisfied: true });
    expect(formatDecimal(out.results[0]!.decidingValue)).toBe('105.00');
    expect(formatDecimal(out.results[0]!.referenceValue)).toBe('101.00');
    expect(formatDecimal(out.setup.entry)).toBe('105.00');
    // 50 bps of 105.00 is 0.525, rounded away from entry to 0.53.
    expect(formatDecimal(out.setup.stop)).toBe('104.47');
    // 0.50% of 25,000.00 = 125.00 at risk over 0.53 per unit, rounded down.
    expect(formatDecimal(out.setup.size)).toBe('235.8490');
    expect(out.setup.equitySource).toBe('paper');
    expect(out.setup.equity).toEqual(PAPER_EQUITY);
  });

  it('stamps the undo window from the time it was given', () => {
    const s = bosSeries('105');
    const now = nowFor(s);
    const out = proposeTrade(bosSpec, s, now);
    expect(out.kind === 'proposal' && out.undoExpiresAt).toBe(now + UNDO_WINDOW_MS);
  });

  it('refuses when a predicate fails, naming it and the exact failing number', () => {
    const s = bosSeries('100.50');
    const out = proposeTrade(bosSpec, s, nowFor(s));
    expect(out.kind).toBe('refusal');
    if (out.kind !== 'refusal') return;
    expect(out.failed.predicateId).toBe('p1');
    expect(out.failed.symbol).toBe('bos_bullish');
    expect(formatDecimal(out.failed.decidingValue)).toBe('100.50');
    expect(formatDecimal(out.failed.referenceValue)).toBe('101.00');
    expect(formatDecimal(out.shortfall)).toBe('−0.50');
    // -0.50 / 101.00 = -49.5 bps, rounded half away from zero.
    expect(out.shortfallBps).toBe(-50);
  });

  it('a break that happened before the recency window does not keep the setup alive', () => {
    const s = series([
      candle(at(0), '100', '101', '99', '100'),
      candle(at(1), '100', '101', '99', '100'),
      candle(at(2), '100', '101', '99', '100'),
      candle(at(3), '100', '106', '99', '105'), // the break
      candle(at(4), '105', '105', '99', '100'),
      candle(at(5), '100', '101', '98', '99'),
      candle(at(6), '99', '100', '97', '98'),
      candle(at(7), '98', '99', '96', '97'),
    ]);
    const out = proposeTrade(bosSpec, s, nowFor(s));
    expect(out.kind).toBe('refusal');
    if (out.kind === 'refusal') expect(out.scan.from).toBe(at(7) - (SETUP_RECENCY_CANDLES - 1) * 900);
  });

  it('names the first failing predicate in spec order and reports fair value gaps in bps', () => {
    const spec: StrategySpec = {
      ...bosSpec,
      predicates: [
        ...bosSpec.predicates,
        {
          kind: 'fair_value_gap',
          id: 'p2',
          direction: 'long',
          minGapBps: inferred(15),
          timeframe: stated('15m'),
        },
      ],
    };
    // Three-candle imbalance of 9 bps: c1.high 100.00, c3.low 100.09.
    const s = series([
      candle(at(0), '100', '100', '99', '100'),
      candle(at(1), '100', '101', '99', '100'),
      candle(at(2), '100', '101', '99', '100'),
      candle(at(3), '100', '101', '99', '100'),
      candle(at(4), '100', '100', '99', '100'),
      candle(at(5), '101', '104', '100.50', '103'),
      candle(at(6), '103', '106', '100.09', '105'),
    ]);
    const out = proposeTrade(spec, s, nowFor(s));
    expect(out.kind).toBe('refusal');
    if (out.kind !== 'refusal') return;
    expect(out.failed.kind).toBe('fair_value_gap');
    expect(out.failed.decidingValue).toEqual(dec('9', 0));
    expect(out.failed.referenceValue).toEqual(dec('15', 0));
    expect(out.shortfall).toEqual(dec('-6', 0));
    expect(out.shortfallBps).toBe(-6);
    // Every predicate's outcome is kept, the satisfied ones included.
    expect(out.results.map((r) => r.satisfied)).toEqual([true, false]);
  });

  it('is unavailable, not a refusal, when the series is too short to evaluate', () => {
    const s = series([candle(at(0), '100', '101', '99', '100'), candle(at(1), '100', '101', '99', '100')]);
    const out = proposeTrade(bosSpec, s, nowFor(s));
    expect(out).toMatchObject({ kind: 'unavailable', reason: 'insufficient_data' });
  });

  it('is unavailable when the newest candle is stale', () => {
    const s = bosSeries('105');
    const now = (s.candles[4]!.timestamp + (MAX_STALE_BUCKETS + 1) * 900) * 1000;
    expect(proposeTrade(bosSpec, s, now)).toMatchObject({ kind: 'unavailable', reason: 'stale' });
  });

  it('is unavailable when there are no candles, or no series at that timeframe', () => {
    expect(proposeTrade(bosSpec, series([]), Date.now())).toMatchObject({
      kind: 'unavailable',
      reason: 'no_series',
    });
    const s = bosSeries('105');
    const hourly: StrategySpec = {
      ...bosSpec,
      predicates: [{ ...bosSpec.predicates[0]!, timeframe: stated('1h') } as StrategySpec['predicates'][number]],
    };
    expect(proposeTrade(hourly, s, nowFor(s))).toMatchObject({ kind: 'unavailable', reason: 'no_series' });
  });

  it('evaluates each predicate on its own timeframe when given several series', () => {
    const fifteen = bosSeries('105');
    const hourly = series(
      [
        candle(T0 - 3 * 3600, '100', '101', '99', '100', 3600),
        candle(T0 - 2 * 3600, '100', '101', '99', '100', 3600),
        candle(T0 - 1 * 3600, '100', '101', '99', '100', 3600),
        candle(T0, '100', '110', '99', '108', 3600),
      ],
      3600,
    );
    const spec: StrategySpec = {
      ...bosSpec,
      predicates: [
        bosSpec.predicates[0]!,
        {
          ...bosSpec.predicates[0]!,
          id: 'p9',
          timeframe: stated('1h'),
        } as StrategySpec['predicates'][number],
      ],
    };
    expect(bucketsNeeded(spec)).toEqual([900, 3600]);
    const out = proposeTrade(spec, { 900: fifteen, 3600: hourly }, nowFor(fifteen));
    expect(out.kind).toBe('proposal');
    if (out.kind === 'proposal') {
      // The entry prices off the finest series in use.
      expect(formatDecimal(out.setup.entry)).toBe('105.00');
      expect(out.results.map((r) => r.predicateId)).toEqual(['p1', 'p9']);
    }
  });

  it('sizes against the account equity when one is supplied, and says so', () => {
    const s = bosSeries('105');
    const out = proposeTrade(bosSpec, s, nowFor(s), { equity: px('1000.00'), equitySource: 'account' });
    expect(out.kind === 'proposal' && out.setup.equitySource).toBe('account');
    expect(out.kind === 'proposal' && formatDecimal(out.setup.size)).toBe('9.4339');
  });
});

describe('sizePosition', () => {
  it('never risks more than the stated fraction', () => {
    const r = sizePosition({
      direction: 'long',
      entry: px('68441.20'),
      stopDistanceBps: 50,
      riskBps: 50,
      equity: px('25000.00'),
    })!;
    // distance = 342.206 -> ceil to 342.21 at 2dp
    expect(formatDecimal(r.stop)).toBe('68,098.99');
    const riskAtoms = (BigInt(r.size.atoms) * (BigInt(6844120) - BigInt(r.stop.atoms))) / 10n ** 4n;
    expect(riskAtoms <= 12500n).toBe(true); // 125.00 in 2dp atoms
  });

  it('places a short stop above the entry', () => {
    const r = sizePosition({
      direction: 'short',
      entry: px('100.00'),
      stopDistanceBps: 100,
      riskBps: 100,
      equity: px('10000.00'),
    })!;
    expect(formatDecimal(r.stop)).toBe('101.00');
    expect(formatDecimal(r.size)).toBe('100.0000');
  });

  it('refuses a price that cannot carry the stop', () => {
    expect(
      sizePosition({ direction: 'long', entry: dec('0', 2), stopDistanceBps: 50, riskBps: 50, equity: px('1.00') }),
    ).toBeNull();
  });
});

describe('requiredCandles', () => {
  it('covers the deepest lookback plus the recency window', () => {
    expect(requiredCandles(bosSpec, 900)).toBe(3 + SETUP_RECENCY_CANDLES + 1);
    // A sweep against the previous day needs that whole day behind it: 2d of 15m candles.
    expect(requiredCandles(RULE_04, 900)).toBeGreaterThanOrEqual(2 * 96);
  });
});

describe('undo window', () => {
  const trade = (over: Partial<{ status: 'proposed' | 'executed' | 'refused' | 'undone'; undoExpiresAt: number }>) => ({
    status: 'proposed' as const,
    undoExpiresAt: 10_000,
    ...over,
  });

  it('allows undo strictly before the window closes', () => {
    expect(undoTransition(trade({}), 9_999)).toEqual({ ok: true, status: 'undone' });
    expect(undoTransition(trade({}), 10_000)).toEqual({ ok: false, reason: 'window_closed' });
    expect(undoTransition(trade({}), 20_000)).toEqual({ ok: false, reason: 'window_closed' });
  });

  it('cannot undo what is not proposed', () => {
    for (const status of ['executed', 'refused', 'undone'] as const) {
      expect(undoTransition(trade({ status }), 1)).toEqual({ ok: false, reason: 'not_proposed' });
    }
  });

  it('confirm executes early but never revives an undone or refused trade', () => {
    expect(confirmTransition(trade({}), 1)).toEqual({ ok: true, status: 'executed' });
    expect(confirmTransition(trade({ status: 'undone' }), 1).ok).toBe(false);
    expect(confirmTransition(trade({ status: 'refused' }), 1).ok).toBe(false);
  });

  it('finalize executes only once the window has run out', () => {
    expect(finalizeTransition(trade({}), 9_999)).toEqual({ ok: false, reason: 'window_closed' });
    expect(finalizeTransition(trade({}), 10_000)).toEqual({ ok: true, status: 'executed' });
    expect(finalizeTransition(trade({ status: 'undone' }), 99_999).ok).toBe(false);
  });

  it('counts the seconds left, never below zero', () => {
    expect(undoSecondsLeft(trade({}), 3_500)).toBe(7);
    expect(undoSecondsLeft(trade({}), 9_100)).toBe(1);
    expect(undoSecondsLeft(trade({}), 50_000)).toBe(0);
    expect(undoSecondsLeft(trade({ status: 'undone' }), 0)).toBe(0);
  });
});

describe('modelRefusedOutcome', () => {
  const long = {
    direction: 'long' as const,
    entry: px('100.00'),
    stop: px('99.00'),
    size: dec('10', 0),
    at: (T0 + 100) * 1000,
  };

  it('is pending while nothing has printed since the refusal', () => {
    expect(modelRefusedOutcome(long, [candle(T0, '100', '101', '95', '99')])).toEqual({ status: 'pending' });
  });

  it('ignores the candle the refusal landed inside', () => {
    const inside = candle(T0, '100', '101', '90', '95'); // began before `at`
    const out = modelRefusedOutcome(long, [inside]);
    expect(out.status).toBe('pending');
  });

  it('a touch of the stop is a loss of exactly the stop distance times size', () => {
    const out = modelRefusedOutcome(long, [candle(at(1), '100', '101', '98.50', '100')]);
    expect(out.status).toBe('stopped');
    if (out.status !== 'stopped') return;
    expect(formatDecimal(out.pnl)).toBe('−10.00');
    expect(formatDecimal(out.exit)).toBe('99.00');
  });

  it('a setup that never touched its stop is marked at the latest close', () => {
    const out = modelRefusedOutcome(long, [
      candle(at(1), '100', '103', '99.50', '102'),
      candle(at(2), '102', '104', '100', '103'),
    ]);
    expect(out.status).toBe('open');
    if (out.status !== 'open') return;
    expect(out.lost).toBe(false);
    expect(formatDecimal(out.pnl)).toBe('30.00');
  });

  it('a short is stopped by a high, and marked down as price rises', () => {
    const short = { ...long, direction: 'short' as const, stop: px('101.00') };
    const stopped = modelRefusedOutcome(short, [candle(at(1), '100', '101.50', '99', '100')]);
    expect(stopped.status === 'stopped' && formatDecimal(stopped.pnl)).toBe('−10.00');
    const open = modelRefusedOutcome(short, [candle(at(1), '100', '100.50', '99', '99.50')]);
    expect(open.status === 'open' && open.lost).toBe(false);
    expect(open.status === 'open' && formatDecimal(open.pnl)).toBe('5.00');
  });

  it('an open setup marked below entry counts as a loss', () => {
    const out = modelRefusedOutcome(long, [candle(at(1), '100', '100.20', '99.40', '99.60')]);
    expect(out.status === 'open' && out.lost).toBe(true);
    expect(out.status === 'open' && formatDecimal(out.pnl)).toBe('−4.00');
  });
});

describe('summariseBlocked', () => {
  it('sums only the losers and leaves the pending ones out of the verdict', () => {
    const summary = summariseBlocked([
      { status: 'stopped', exit: px('99.00'), pnl: px('-10.00'), lost: true, at: 1 },
      { status: 'open', exit: px('103.00'), pnl: px('30.00'), lost: false, at: 1 },
      { status: 'open', exit: px('99.60'), pnl: px('-4.00'), lost: true, at: 1 },
      { status: 'pending' },
    ]);
    expect(summary).toMatchObject({ refused: 4, judged: 3, pending: 1, lostCount: 2 });
    expect(formatDecimal(summary.wouldHaveLost)).toBe('−14.00');
  });

  it('is zero, not undefined, with no refusals', () => {
    const s = summariseBlocked([]);
    expect(s).toMatchObject({ refused: 0, judged: 0, lostCount: 0 });
    expect(formatDecimal(s.wouldHaveLost)).toBe('0.00');
  });
});
