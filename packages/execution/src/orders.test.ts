import { describe, expect, it } from 'vitest';
import type { Candle, Series } from '@kanon/spec';
import { formatDecimal, parseDecimal } from '@kanon/spec';
import {
  AdvancedOrderWatcher,
  IcebergRunner,
  TwapRunner,
  applyBps,
  checkStopLoss,
  checkTakeProfit,
  checkTrailingStop,
  dueTwapSlices,
  nextIcebergSlice,
  sliceTwap,
  type IcebergOrder,
  type StopLossOrder,
  type TakeProfitOrder,
  type TrailingStopOrder,
  type TwapOrder,
} from './orders';
import { PaperExecutionClient } from './paper';

const DP = 2;
const BUCKET_SECONDS = 900; // 15m, matches docs/SCOPE.md's BTC/USD 15m

function p(value: string) {
  return parseDecimal(value, DP);
}

function candle(open: string, high: string, low: string, close: string, timestamp: number): Candle {
  return {
    bucketIndex: Math.floor(timestamp / BUCKET_SECONDS),
    timestamp,
    open: p(open),
    high: p(high),
    low: p(low),
    close: p(close),
    synthetic: false,
  };
}

function series(candles: Candle[]): Series {
  return { asset: 'BTC/USD', bucketSeconds: BUCKET_SECONDS, candles };
}

// ---------------------------------------------------------------------------
// applyBps
// ---------------------------------------------------------------------------

describe('applyBps', () => {
  it('shrinks a value by the given bps when direction is down', () => {
    // 100.00 shrunk by 100bps (1%) -> 99.00
    expect(formatDecimal(applyBps(p('100.00'), 100, 'down'))).toBe('99.00');
  });

  it('grows a value by the given bps when direction is up', () => {
    expect(formatDecimal(applyBps(p('100.00'), 100, 'up'))).toBe('101.00');
  });

  it('rejects a negative bps', () => {
    expect(() => applyBps(p('100.00'), -1, 'down')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Stop-loss
// ---------------------------------------------------------------------------

describe('checkStopLoss', () => {
  const baseLong: StopLossOrder = {
    kind: 'stop_loss',
    id: 'sl-1',
    asset: 'BTC/USD',
    direction: 'long',
    triggerPrice: p('99.00'),
    size: p('1.00'),
  };

  it('triggers a long stop on the first candle whose low touches the trigger', () => {
    const s = series([
      candle('101', '101.5', '100.5', '101.2', 0),
      candle('101.2', '101.4', '99.00', '99.50', 900), // low == trigger
      candle('99.50', '100.0', '99.20', '99.80', 1800),
    ]);
    const result = checkStopLoss(baseLong, s);
    expect(result.triggered).toBe(true);
    expect(result.candle?.timestamp).toBe(900);
  });

  it('does not trigger a long stop while the low stays above the trigger', () => {
    const s = series([
      candle('101', '101.5', '100.5', '101.2', 0),
      candle('101.2', '101.4', '99.50', '99.80', 900),
    ]);
    expect(checkStopLoss(baseLong, s).triggered).toBe(false);
  });

  it('triggers a short stop on the first candle whose high touches the trigger', () => {
    const shortStop: StopLossOrder = { ...baseLong, direction: 'short', triggerPrice: p('102.00') };
    const s = series([
      candle('100', '100.5', '99.5', '100.2', 0),
      candle('100.2', '102.00', '100.0', '101.50', 900), // high == trigger
    ]);
    const result = checkStopLoss(shortStop, s);
    expect(result.triggered).toBe(true);
    expect(result.candle?.timestamp).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Take-profit
// ---------------------------------------------------------------------------

describe('checkTakeProfit', () => {
  it('triggers a long take-profit when the high reaches the target', () => {
    const tp: TakeProfitOrder = {
      kind: 'take_profit',
      id: 'tp-1',
      asset: 'BTC/USD',
      direction: 'long',
      triggerPrice: p('105.00'),
      size: p('1.00'),
    };
    const s = series([
      candle('100', '101', '99.5', '100.5', 0),
      candle('100.5', '105.00', '100.0', '104.00', 900),
    ]);
    const result = checkTakeProfit(tp, s);
    expect(result.triggered).toBe(true);
    expect(result.candle?.timestamp).toBe(900);
  });

  it('triggers a short take-profit when the low reaches the target', () => {
    const tp: TakeProfitOrder = {
      kind: 'take_profit',
      id: 'tp-2',
      asset: 'BTC/USD',
      direction: 'short',
      triggerPrice: p('95.00'),
      size: p('1.00'),
    };
    const s = series([candle('100', '100.5', '94.50', '95.00', 0)]);
    expect(checkTakeProfit(tp, s).triggered).toBe(true);
  });

  it('does not trigger before the target is reached', () => {
    const tp: TakeProfitOrder = {
      kind: 'take_profit',
      id: 'tp-3',
      asset: 'BTC/USD',
      direction: 'long',
      triggerPrice: p('105.00'),
      size: p('1.00'),
    };
    const s = series([candle('100', '104.90', '99.5', '104.00', 0)]);
    expect(checkTakeProfit(tp, s).triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trailing stop
// ---------------------------------------------------------------------------

describe('checkTrailingStop', () => {
  it('trails a rising peak and triggers once price retraces trailingBps from it (long)', () => {
    const order: TrailingStopOrder = {
      kind: 'trailing_stop',
      id: 'ts-1',
      asset: 'BTC/USD',
      direction: 'long',
      trailingBps: 200, // 2%
      size: p('1.00'),
      activationPrice: p('100.00'),
    };
    const s = series([
      candle('100', '102.00', '100.00', '101.50', 0), // peak -> 102.00, stop -> 99.96; low 100.00 doesn't cross
      candle('101.50', '104.00', '102.50', '103.50', 900), // peak -> 104.00, stop -> 101.92; low 102.50 doesn't cross (yet)
      candle('103.50', '103.80', '101.50', '102.00', 1800), // peak unchanged (103.80 < 104), low 101.50 <= 101.92 -> trigger
    ]);
    const result = checkTrailingStop(order, s);
    expect(result.triggered).toBe(true);
    expect(result.candle?.timestamp).toBe(1800);
    expect(formatDecimal(result.stopPrice!)).toBe('101.92');
  });

  it('never ratchets the stop down when price makes a lower high (long)', () => {
    const order: TrailingStopOrder = {
      kind: 'trailing_stop',
      id: 'ts-2',
      asset: 'BTC/USD',
      direction: 'long',
      trailingBps: 500, // 5%
      size: p('1.00'),
      activationPrice: p('100.00'),
    };
    const s = series([
      candle('100', '110.00', '106.00', '108.00', 0), // peak 110, stop 104.50; low 106.00 doesn't cross intrabar
      candle('108.00', '109.00', '105.00', '106.00', 900), // lower high, stop must stay 104.50; low 105.00 doesn't cross
    ]);
    const result = checkTrailingStop(order, s);
    expect(result.triggered).toBe(false);
    expect(formatDecimal(result.stopPrice!)).toBe('104.50');
  });

  it('trails a falling trough and triggers on a retrace up (short)', () => {
    const order: TrailingStopOrder = {
      kind: 'trailing_stop',
      id: 'ts-3',
      asset: 'BTC/USD',
      direction: 'short',
      trailingBps: 200,
      size: p('1.00'),
      activationPrice: p('100.00'),
    };
    const s = series([
      candle('100', '99.50', '98.00', '98.50', 0), // trough -> 98.00, stop -> 99.96; high 99.50 doesn't cross
      candle('98.50', '97.50', '96.00', '96.50', 900), // trough -> 96.00, stop -> 97.92; high 97.50 doesn't cross (yet)
      candle('96.50', '98.00', '96.50', '97.80', 1800), // trough unchanged, high 98.00 >= 97.92 -> trigger
    ]);
    const result = checkTrailingStop(order, s);
    expect(result.triggered).toBe(true);
    expect(result.candle?.timestamp).toBe(1800);
  });
});

// ---------------------------------------------------------------------------
// TWAP slicing
// ---------------------------------------------------------------------------

describe('sliceTwap', () => {
  it('splits size into equal slices spaced evenly across the duration', () => {
    const order: TwapOrder = {
      kind: 'twap',
      id: 'twap-1',
      asset: 'BTC/USD',
      side: 'buy',
      totalSize: p('4.00'),
      slices: 4,
      durationSeconds: 3600,
      startTimestamp: 1_000_000,
    };
    const slices = sliceTwap(order);
    expect(slices).toHaveLength(4);
    expect(slices.map((s) => formatDecimal(s.size))).toEqual(['1.00', '1.00', '1.00', '1.00']);
    expect(slices.map((s) => s.timestamp)).toEqual([1_000_000, 1_001_200, 1_002_400, 1_003_600]);
  });

  it('folds the remainder from integer division entirely into the last slice', () => {
    const order: TwapOrder = {
      kind: 'twap',
      id: 'twap-2',
      asset: 'BTC/USD',
      side: 'sell',
      totalSize: p('1.00'), // 100 atoms at 2dp / 3 slices
      slices: 3,
      durationSeconds: 900,
      startTimestamp: 0,
    };
    const slices = sliceTwap(order);
    const total = slices.reduce((sum, s) => sum + BigInt(s.size.atoms), 0n);
    expect(total.toString()).toBe('100');
    expect(slices[0]!.size.atoms).toBe('33');
    expect(slices[1]!.size.atoms).toBe('33');
    expect(slices[2]!.size.atoms).toBe('34');
  });

  it('places a single slice at the start timestamp when slices is 1', () => {
    const order: TwapOrder = {
      kind: 'twap',
      id: 'twap-3',
      asset: 'BTC/USD',
      side: 'buy',
      totalSize: p('2.00'),
      slices: 1,
      durationSeconds: 3600,
      startTimestamp: 500,
    };
    const slices = sliceTwap(order);
    expect(slices).toEqual([{ index: 0, timestamp: 500, size: p('2.00') }]);
  });
});

describe('dueTwapSlices', () => {
  it('only returns slices whose scheduled time has arrived', () => {
    const order: TwapOrder = {
      kind: 'twap',
      id: 'twap-4',
      asset: 'BTC/USD',
      side: 'buy',
      totalSize: p('3.00'),
      slices: 3,
      durationSeconds: 1800,
      startTimestamp: 0,
    };
    expect(dueTwapSlices(order, 0).map((s) => s.index)).toEqual([0]);
    expect(dueTwapSlices(order, 900).map((s) => s.index)).toEqual([0, 1]);
    expect(dueTwapSlices(order, 1800).map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Iceberg slicing
// ---------------------------------------------------------------------------

describe('nextIcebergSlice', () => {
  it('shows the display size while more than that remains', () => {
    expect(formatDecimal(nextIcebergSlice(p('10.00'), p('2.00')))).toBe('2.00');
  });

  it('shows only what remains once it drops below the display size', () => {
    expect(formatDecimal(nextIcebergSlice(p('1.50'), p('2.00')))).toBe('1.50');
  });
});

// ---------------------------------------------------------------------------
// Stateful runners against PaperExecutionClient (in-memory, no network —
// exercises the wiring between the pure trigger/slicing logic above and
// ExecutionClient.placeOrder).
// ---------------------------------------------------------------------------

describe('AdvancedOrderWatcher', () => {
  it('fires a reduce-only market order the first time a stop-loss triggers, and never again', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('100.00') } });
    const watcher = new AdvancedOrderWatcher(client);
    const order: StopLossOrder = {
      kind: 'stop_loss',
      id: 'sl-watch-1',
      asset: 'BTC/USD',
      direction: 'long',
      triggerPrice: p('95.00'),
      size: p('1.00'),
    };
    const triggeringSeries = series([candle('100', '100.50', '94.00', '94.50', 0)]);

    const first = await watcher.evaluate([order], triggeringSeries);
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe('filled');
    expect(watcher.hasFired('sl-watch-1')).toBe(true);

    const second = await watcher.evaluate([order], triggeringSeries);
    expect(second).toHaveLength(0);
  });

  it('does not fire when nothing has triggered', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('100.00') } });
    const watcher = new AdvancedOrderWatcher(client);
    const order: TakeProfitOrder = {
      kind: 'take_profit',
      id: 'tp-watch-1',
      asset: 'BTC/USD',
      direction: 'long',
      triggerPrice: p('120.00'),
      size: p('1.00'),
    };
    const results = await watcher.evaluate([order], series([candle('100', '101', '99', '100.5', 0)]));
    expect(results).toHaveLength(0);
  });
});

describe('TwapRunner', () => {
  it('places only the slices due by the given time, and does not repeat them', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('100.00') } });
    const order: TwapOrder = {
      kind: 'twap',
      id: 'twap-runner-1',
      asset: 'BTC/USD',
      side: 'buy',
      totalSize: p('3.00'),
      slices: 3,
      durationSeconds: 1800,
      startTimestamp: 0,
    };
    const runner = new TwapRunner(client, order);

    const first = await runner.tick(0);
    expect(first).toHaveLength(1);
    expect(runner.sentCount).toBe(1);

    const same = await runner.tick(0);
    expect(same).toHaveLength(0);

    const rest = await runner.tick(1800);
    expect(rest).toHaveLength(2);
    expect(runner.sentCount).toBe(3);
  });
});

describe('IcebergRunner', () => {
  it('posts slices until the total size is exhausted against an instantly-filling client', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('100.00') } });
    const order: IcebergOrder = {
      kind: 'iceberg',
      id: 'ice-1',
      asset: 'BTC/USD',
      side: 'sell',
      totalSize: p('5.00'),
      displaySize: p('2.00'),
      limitPrice: p('100.00'),
    };
    const runner = new IcebergRunner(client, order);
    const results = await runner.run();

    expect(results).toHaveLength(3);
    expect(results.map((r) => formatDecimal(r.filledSize!))).toEqual(['2.00', '2.00', '1.00']);
    expect(formatDecimal(runner.remainingSize)).toBe('0.00');
  });
});
