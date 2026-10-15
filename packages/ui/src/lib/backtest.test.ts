import { describe, expect, it } from 'vitest';
import { RULE_04, dec, parseDecimal, ratioBps } from '@kanon/spec';
import {
  FILTER_EMPTY,
  NOT_AUTOPILOT,
  backtestSubject,
  comparisonText,
  coverageRows,
  filterTrades,
  freshnessLine,
  fromReply,
  gapRows,
  gapSummary,
  haltView,
  paramRows,
  rangeLine,
  stamp,
  tiles,
  tradeRow,
  tradeSheet,
  verdictView,
  winRateFigure,
  winRateLine,
} from './backtest';
import { SAMPLE_BACKTEST } from './backtest-sample';
import type { BacktestHalt, BacktestResult, BacktestTrade } from './backtest-types';

const px = (v: string) => parseDecimal(v, 2);
const T = Date.UTC(2026, 9, 14, 13, 45) / 1000;

const params = SAMPLE_BACKTEST.params;

function trade(over: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    n: 7,
    setupAt: T,
    entry: px('105.00'),
    stop: px('103.95'),
    target: px('107.10'),
    results: [
      {
        predicateId: 'p1',
        kind: 'break_of_structure',
        symbol: 'bos_bullish',
        satisfied: true,
        decidingValue: px('105.00'),
        referenceValue: px('101.00'),
        at: T,
      },
      {
        predicateId: 'p2',
        kind: 'fair_value_gap',
        symbol: 'fvg_present',
        satisfied: true,
        decidingValue: dec('22', 0),
        referenceValue: dec('15', 0),
        at: T - 900,
      },
    ],
    outcome: 'win',
    exit: {
      at: T + 900,
      candle: { open: px('105.00'), high: px('107.10'), low: px('104.00'), close: px('104.50') },
      synthetic: false,
      comparisons: [{ field: 'high', value: px('107.10'), op: '>=', level: 'target', against: px('107.10') }],
    },
    heldCandles: 1,
    ...over,
  };
}

function result(over: Partial<BacktestResult> = {}): BacktestResult {
  return { ...SAMPLE_BACKTEST, ...over };
}

const halt = (reason: BacktestHalt['reason'], target: number | null = 200): BacktestHalt => ({
  kind: 'halted',
  reason,
  message: 'The server says why.',
  params: { ...params, targetDistanceBps: target },
});

describe('fromReply', () => {
  const ran = { specHash: '0xabc', throughBucket: T, computedAt: 1, behindCandles: 0, source: 'run' as const };

  it('turns a result into the screen state, with how current it is', () => {
    const out = fromReply({ status: 'result', result: SAMPLE_BACKTEST, ...ran });
    expect(out).toEqual({ state: { status: 'result', result: SAMPLE_BACKTEST, sample: false, ...ran } });
  });

  it('keeps a halt and its sentence, and says when nothing is stored yet', () => {
    expect(fromReply({ status: 'halted', specHash: '0xabc', halt: halt('no_candles') })).toEqual({
      state: { status: 'halted', halt: halt('no_candles') },
    });
    expect(fromReply({ status: 'halted', specHash: '0xabc', halt: halt('no_candles'), ran })).toMatchObject({
      state: { ran },
    });
    expect(fromReply({ status: 'not_run', specHash: '0xabc' })).toEqual({ state: { status: 'not_run' } });
  });

  it('leaves the screen as it was on a rate limit, with the server sentence to show', () => {
    expect(fromReply({ status: 'rate_limited', retryAfterMs: 60_000, message: 'Try again in about 1 minute.' })).toEqual({
      note: 'Try again in about 1 minute.',
    });
  });
});

describe('above the fold', () => {
  it('states the win rate over decided trades only, as a figure and a count', () => {
    const r = result({ winRateBps: 6429, counts: { ...SAMPLE_BACKTEST.counts, decided: 14 } });
    expect(winRateFigure(r)).toBe('64.29%');
    expect(winRateLine(r)).toBe('of 14 decided trades');
    expect(winRateLine(result({ counts: { ...SAMPLE_BACKTEST.counts, decided: 1 } }))).toBe('of 1 decided trade');
  });

  it('has no figure before anything was decided', () => {
    const r = result({ winRateBps: null, counts: { ...SAMPLE_BACKTEST.counts, decided: 0 } });
    expect(winRateFigure(r)).toBeNull();
    expect(winRateLine(r)).toBe('No trade reached its stop or its target.');
  });

  it('puts break-even next to the verdict, from the stated stop and target, before fees', () => {
    const v = verdictView(result({ verdict: 'above_break_even', breakEvenBps: 3333 }));
    expect(v).toMatchObject({ label: 'Above break-even', icon: 'arrow-up', more: null });
    expect(v.line).toBe('Break-even is 33.33% with a 0.50% stop and a 1.00% target, before fees.');
    expect(verdictView(result({ verdict: 'below_break_even' })).icon).toBe('arrow-down');
    expect(verdictView(result({ verdict: 'at_break_even' })).label).toBe('At break-even');
  });

  it('says how many decided trades a verdict needs when there are too few', () => {
    const v = verdictView(result({ verdict: 'too_few_trades', counts: { ...SAMPLE_BACKTEST.counts, decided: 12 } }));
    expect(v.label).toBe('Too few trades');
    expect(v.more).toBe('A verdict needs 30 decided trades. This test has 12.');
  });

  it('has four tiles, each the filter that lists its trades', () => {
    expect(tiles(SAMPLE_BACKTEST).map((t) => [t.filter, t.label])).toEqual([
      ['decided', 'Decided'],
      ['win', 'Wins'],
      ['loss', 'Losses'],
      ['cannot_tell', 'Cannot tell'],
    ]);
    for (const tile of tiles(SAMPLE_BACKTEST)) {
      expect(filterTrades(SAMPLE_BACKTEST.trades, tile.filter)).toHaveLength(Number(tile.value));
    }
  });

  it('states the data range and how much of it was recorded', () => {
    const r = result({ range: { from: T, to: T + 2 * 900, candles: 2, recorded: 2, synthetic: 0 } });
    expect(rangeLine(r)).toEqual({ span: '2026-10-14 13:45 to 2026-10-14 14:15 UTC', detail: '2 15M candles, every one recorded' });
    expect(rangeLine(SAMPLE_BACKTEST).detail).toBe('2,352 15M candles, 18 carried forward flat');
  });

  it('says whether the answer is current, how far behind it is, or that it is the sample', () => {
    const base = { status: 'result' as const, result: SAMPLE_BACKTEST };
    expect(freshnessLine({ ...base, sample: true })).toBe('Sample figures on the demo rule. Nothing was run.');
    expect(freshnessLine({ ...base, sample: false, behindCandles: 0 })).toBe('Current: it ran through the newest closed candle.');
    expect(freshnessLine({ ...base, sample: false, behindCandles: 1 })).toBe('1 newer candle has closed since this ran.');
    expect(freshnessLine({ ...base, sample: false, behindCandles: 3 })).toBe('3 newer candles have closed since this ran.');
  });

  it('never lets the test read as what autopilot trades', () => {
    expect(NOT_AUTOPILOT).toMatch(/Autopilot does not trade those/);
    expect(NOT_AUTOPILOT).toMatch(/timed trade/);
  });

  it('names the pair and the candle under test', () => {
    expect(backtestSubject(RULE_04)).toEqual({ asset: 'BTC/USD', timeframe: '15M' });
  });
});

describe('the trade list and its sheets', () => {
  const list = [
    trade({ n: 1, outcome: 'win' }),
    trade({ n: 2, outcome: 'loss' }),
    trade({ n: 3, outcome: 'cannot_tell', reason: 'both_touched' }),
    trade({ n: 4, outcome: 'open_at_end' }),
  ];

  it('filters by outcome, decided being wins and losses together', () => {
    expect(filterTrades(list, 'all').map((t) => t.n)).toEqual([1, 2, 3, 4]);
    expect(filterTrades(list, 'decided').map((t) => t.n)).toEqual([1, 2]);
    expect(filterTrades(list, 'win').map((t) => t.n)).toEqual([1]);
    expect(filterTrades(list, 'loss').map((t) => t.n)).toEqual([2]);
    expect(filterTrades(list, 'cannot_tell').map((t) => t.n)).toEqual([3]);
    expect(FILTER_EMPTY.cannot_tell).toBe('Every trade that ended was decided.');
  });

  it('draws a row with its setup time, its outcome and how long it was held', () => {
    expect(tradeRow(trade())).toEqual({
      n: 7,
      ordinal: '#07',
      setup: '2026-10-14 13:45',
      outcome: 'win',
      label: 'Win',
      held: 'held 1 candle',
    });
    expect(tradeRow(trade({ outcome: 'open_at_end', heldCandles: 3 })).held).toBe('open after 3 candles');
    expect(tradeRow(trade({ outcome: 'cannot_tell', reason: 'target_not_priced', heldCandles: 0 })).held).toBe('not followed');
  });

  it('opens a sheet with the predicate values, the levels, the exit candle and the comparison that decided it', () => {
    const s = tradeSheet(trade(), params);
    expect(s.title).toBe('TRADE 07');
    expect(s.facts).toEqual([
      ['Setup candle', '2026-10-14 13:45 UTC'],
      ['Entry (its close)', '105.00'],
      ['Stop', '103.95'],
      ['Target', '107.10'],
      ['Held', '1 candle'],
    ]);
    expect(s.predicates).toEqual([
      { id: 'p1', symbol: 'bos_bullish', comparison: '105.00 > 101.00', at: '2026-10-14 13:45 UTC' },
      { id: 'p2', symbol: 'fvg_present', comparison: '0.22% ≥ 0.15%', at: '2026-10-14 13:30 UTC' },
    ]);
    expect(s.exit).toEqual({
      at: '2026-10-14 14:00 UTC',
      candle: [
        ['Open', '105.00'],
        ['High', '107.10'],
        ['Low', '104.00'],
        ['Close', '104.50'],
      ],
      comparisons: ['high 107.10 ≥ target 107.10'],
    });
    expect(s.sentence).toBe('The target was touched in this candle, and the stop was not.');
  });

  it('says why a result cannot be told, and shows no candle that was never recorded', () => {
    const both = tradeSheet(trade({ outcome: 'cannot_tell', reason: 'both_touched' }), params);
    expect(both.sentence).toMatch(/Which came first is not in the recorded prices/);
    const gap = tradeSheet(
      trade({ outcome: 'cannot_tell', reason: 'gap', exit: { at: T + 900, candle: null, synthetic: true, comparisons: [] } }),
      params,
    );
    expect(gap.exit).toEqual({ at: '2026-10-14 14:00 UTC', candle: null, comparisons: [] });
    expect(gap.sentence).toMatch(/No price was recorded for this candle/);
    const { exit: _exit, ...stillOpen } = trade({ outcome: 'open_at_end' });
    const open = tradeSheet(stillOpen, params);
    expect(open.exit).toBeNull();
    expect(open.sentence).toBe('Neither the stop nor the target had been touched when the recorded prices end.');
  });

  it('writes an exit comparison as it was made', () => {
    expect(comparisonText({ field: 'low', value: px('103.90'), op: '<=', level: 'stop', against: px('103.95') })).toBe(
      'low 103.90 ≤ stop 103.95',
    );
  });
});

describe('below the fold', () => {
  it('lists every constant the run was shaped by, fees as not included, and any it does not know by name', () => {
    const rows = paramRows({ ...params, slippageModel: 'none-yet' });
    expect(rows.map((r) => r.key).sort()).toEqual([...Object.keys(params), 'slippageModel'].sort());
    expect(rows[0]).toEqual({ key: 'asset', label: 'Pair', value: 'BTC/USD' });
    expect(rows.find((r) => r.key === 'fees')).toEqual({ key: 'fees', label: 'Fees', value: 'Not included' });
    expect(rows.find((r) => r.key === 'stopDistanceBps')?.value).toBe('0.50% from entry');
    expect(rows.find((r) => r.key === 'targetDistanceBps')?.value).toBe('1.00% from entry');
    expect(rows[rows.length - 1]).toEqual({ key: 'slippageModel', label: 'slippageModel', value: 'none-yet' });
    expect(paramRows({ ...params, targetDistanceBps: null }).find((r) => r.key === 'targetDistanceBps')?.value).toBe('Not stated');
  });

  it('says how the candles were spent', () => {
    const rows = coverageRows(SAMPLE_BACKTEST);
    expect(rows.map(([label]) => label)).toEqual([
      'Closes judged',
      'Passed the rule',
      'Traded',
      'Same setup, not traded again',
      'Not judged: unrecorded candle in the window',
      'Still open at the end',
    ]);
    expect(coverageRows(result({ counts: { ...SAMPLE_BACKTEST.counts, unavailable: 2 } })).map(([l]) => l)).toContain(
      'Not judged: window too short for a predicate',
    );
  });

  it('sums up the gaps, and lists each one', () => {
    expect(gapSummary(SAMPLE_BACKTEST)).toBe('18 candles in 3 gaps had no price of their own. They decided nothing.');
    expect(gapSummary(result({ gaps: [] }))).toBe('Every candle in the range was recorded.');
    expect(gapRows(result({ gaps: [{ from: T, to: T, buckets: 1 }, { from: T, to: T + 900, buckets: 2 }] }))).toEqual([
      { key: String(T), span: '2026-10-14 13:45 UTC', count: '1 candle' },
      { key: String(T), span: '2026-10-14 13:45 to 2026-10-14 14:00 UTC', count: '2 candles' },
    ]);
  });
});

describe('halted', () => {
  it('stops with the server sentence, and offers the review when an exit is missing', () => {
    expect(haltView(halt('exits_not_stated', null))).toEqual({
      title: 'TEST STOPPED',
      message: 'The server says why.',
      action: { kind: 'review', label: 'STATE A TARGET' },
    });
    expect(haltView(halt('exits_not_stated', 200)).action).toEqual({ kind: 'review', label: 'STATE YOUR EXITS' });
  });

  it('offers a second try only while the history is being built', () => {
    expect(haltView(halt('history_not_ready')).action).toEqual({ kind: 'retry', label: 'TRY AGAIN' });
    for (const reason of ['mixed_timeframes', 'no_candles', 'insufficient_history'] as const) {
      expect(haltView(halt(reason)).action).toBeNull();
    }
  });
});

describe('the sample', () => {
  it('agrees with itself the way a run does', () => {
    const r = SAMPLE_BACKTEST;
    const c = r.counts;
    expect(c.trades).toBe(r.trades.length);
    expect(c.wins + c.losses + c.cannotTell + c.openAtEnd).toBe(c.trades);
    expect(c.decided).toBe(c.wins + c.losses);
    expect(r.winRateBps).toBe(ratioBps(c.wins, c.decided));
    expect(r.breakEvenBps).toBe(3333);
    expect(c.decided).toBeLessThan(r.params.minDecidedTrades);
    expect(r.verdict).toBe('too_few_trades');
    expect(r.range.recorded + r.range.synthetic).toBe(r.range.candles);
    expect(r.gaps.reduce((n, g) => n + g.buckets, 0)).toBe(r.range.synthetic);
  });

  it('puts every stop and target where the engine would, rounded away from the entry', () => {
    for (const t of SAMPLE_BACKTEST.trades) {
      const e = BigInt(t.entry.atoms);
      const ceil = (bps: number) => (e * BigInt(bps) + 9_999n) / 10_000n;
      expect(BigInt(t.stop.atoms)).toBe(e - ceil(50));
      expect(BigInt(t.target!.atoms)).toBe(e + ceil(100));
    }
  });

  it('decides each exit by the comparison it shows', () => {
    for (const t of SAMPLE_BACKTEST.trades) {
      if (t.outcome === 'win') expect(t.exit!.comparisons.map((x) => x.level)).toEqual(['target']);
      if (t.outcome === 'loss') expect(t.exit!.comparisons.map((x) => x.level)).toEqual(['stop']);
      if (t.reason === 'both_touched') expect(t.exit!.comparisons.map((x) => x.level)).toEqual(['stop', 'target']);
      if (t.reason === 'gap') expect(t.exit!.candle).toBeNull();
      if (t.outcome === 'open_at_end') expect(t.exit).toBeUndefined();
    }
  });

  it('stamps times in UTC', () => {
    expect(stamp(0)).toBe('1970-01-01 00:00');
  });
});
