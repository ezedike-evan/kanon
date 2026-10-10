import { describe, expect, it } from 'vitest';
import { toEngineMarkers, type TradeMarker } from '../components/chart/markers';
import { toEnginePriceLines } from './chart-series';
import {
  fillMarkers,
  mergeMarkers,
  positionLabel,
  positionLevels,
  type ChartOrder,
  type ChartPosition,
} from './venue-chart-overlays';

// Only what the chart reads of a position and of an order. Neither type has a field for a result.
const position = (over: Partial<ChartPosition> = {}): ChartPosition => ({
  asset: 'BTC/USD',
  side: 'long',
  size: { atoms: '30000', decimals: 8 },
  entryPrice: { atoms: '6820730', decimals: 2 },
  ...over,
});

const order = (over: Partial<ChartOrder> = {}): ChartOrder => ({
  asset: 'BTC/USD',
  action: 'open',
  side: 'long',
  status: 'filled',
  createdAt: 1_760_000_000_000,
  settledAt: 1_760_000_004_000,
  ...over,
});

describe('the open position as a level', () => {
  it('is nothing when there is no position', () => {
    expect(positionLevels(null)).toEqual([]);
  });

  it('is the entry price, labelled with the side as a word and the size', () => {
    const [level, ...rest] = positionLevels(position());
    expect(rest).toEqual([]);
    expect(level).toEqual({
      id: 'entry:BTC/USD',
      price: { atoms: '6820730', decimals: 2 },
      label: 'LONG 0.0003',
      tone: 'long',
    });
  });

  it('takes the short tone and word for a short', () => {
    const [level] = positionLevels(position({ side: 'short', size: { atoms: '1250000000', decimals: 8 } }));
    expect(level?.tone).toBe('short');
    expect(level?.label).toBe('SHORT 12.50');
  });

  it('keeps one id per asset however the symbol is written, so the line is updated in place', () => {
    expect(positionLevels(position({ asset: 'btc / usd' }))[0]?.id).toBe('entry:BTC/USD');
  });

  it('states no result: side and size only', () => {
    expect(positionLabel(position())).toMatch(/^LONG [\d.]+$/);
  });

  it('becomes a chart number only at the last step, and a price that is not one is dropped', () => {
    expect(toEnginePriceLines(positionLevels(position()))).toEqual([
      { id: 'entry:BTC/USD', price: 68207.3, label: 'LONG 0.0003', tone: 'long' },
    ]);
    expect(toEnginePriceLines(positionLevels(position({ entryPrice: { atoms: 'nope', decimals: 2 } })))).toEqual([]);
  });
});

describe('the viewer’s fills as markers', () => {
  /** `settledAt` of the fixture order, in seconds. */
  const fillSeconds = 1_760_000_004;

  it('puts a fill on the start of the candle that holds its fill time', () => {
    expect(fillMarkers([order()], 'BTC/USD', 60)).toEqual([
      { timestamp: Math.floor(fillSeconds / 60) * 60, side: 'long', kind: 'executed' },
    ]);
    expect(fillMarkers([order()], 'BTC/USD', 3_600)[0]?.timestamp).toBe(Math.floor(fillSeconds / 3_600) * 3_600);
    expect(fillMarkers([order()], 'BTC/USD', 3_600)[0]!.timestamp % 3_600).toBe(0);
  });

  it('uses the time the order was sent when the fill carries no settle time', () => {
    const [marker] = fillMarkers([order({ settledAt: null, createdAt: 1_760_000_125_000 })], 'BTC/USD', 60);
    expect(marker?.timestamp).toBe(Math.floor(1_760_000_125 / 60) * 60);
  });

  it('draws a close as its own kind, on the side of the position it closed', () => {
    expect(fillMarkers([order({ action: 'close', side: 'short' })], 'BTC/USD', 60)).toEqual([
      { timestamp: Math.floor(fillSeconds / 60) * 60, side: 'short', kind: 'closed' },
    ]);
  });

  it('draws only what filled', () => {
    const rest = (['submitting', 'unfilled', 'refused', 'failed'] as const).map((status) => order({ status }));
    expect(fillMarkers(rest, 'BTC/USD', 60)).toEqual([]);
  });

  it('draws only the chart’s asset, however the symbol is written', () => {
    expect(fillMarkers([order({ asset: 'ETH/USD' })], 'BTC/USD', 60)).toEqual([]);
    expect(fillMarkers([order({ asset: 'btc / usd' })], 'BTC/USD', 60)).toHaveLength(1);
  });

  it('leaves out a fill with no side, and anything on a timeframe that is not one', () => {
    expect(fillMarkers([order({ side: null })], 'BTC/USD', 60)).toEqual([]);
    expect(fillMarkers([order()], 'BTC/USD', 0)).toEqual([]);
    expect(fillMarkers([order()], 'BTC/USD', Number.NaN)).toEqual([]);
  });
});

describe('fills beside the rule’s own trades', () => {
  const rule: TradeMarker[] = [
    { timestamp: 600, side: 'long', kind: 'executed' },
    { timestamp: 600, side: 'long', kind: 'executed' },
    { timestamp: 1_200, side: 'short', kind: 'blocked' },
  ];

  it('returns the rule’s markers untouched when there are no fills', () => {
    expect(mergeMarkers(rule, [])).toBe(rule);
  });

  it('adds fills and never removes or reorders a rule marker', () => {
    const merged = mergeMarkers(rule, [{ timestamp: 1_800, side: 'short', kind: 'closed' }]);
    expect(merged.slice(0, rule.length)).toEqual(rule);
    expect(merged).toHaveLength(rule.length + 1);
  });

  it('does not draw a mark a candle already carries', () => {
    const merged = mergeMarkers(rule, [
      { timestamp: 600, side: 'long', kind: 'executed' }, // the rule already marks this candle
      { timestamp: 1_200, side: 'short', kind: 'executed' }, // a different fact about the refused candle
      { timestamp: 1_800, side: 'long', kind: 'executed' },
      { timestamp: 1_800, side: 'long', kind: 'executed' }, // a second fill in the same candle
    ]);
    expect(merged.slice(rule.length)).toEqual([
      { timestamp: 1_200, side: 'short', kind: 'executed' },
      { timestamp: 1_800, side: 'long', kind: 'executed' },
    ]);
  });
});

describe('how a marker is drawn', () => {
  const palette = { up: 'UP', down: 'DOWN', refused: 'REFUSED', closed: 'CLOSED' };

  it('draws a close as a square that is neither the refusal’s colour nor a direction’s', () => {
    const [long, short] = toEngineMarkers(
      [
        { timestamp: 60, side: 'long', kind: 'closed' },
        { timestamp: 120, side: 'short', kind: 'closed' },
      ],
      palette,
    );
    expect(long).toEqual({ time: 60, position: 'belowBar', shape: 'square', color: 'CLOSED' });
    expect(short).toEqual({ time: 120, position: 'aboveBar', shape: 'square', color: 'CLOSED' });
  });

  it('keeps an open and a refusal as they were', () => {
    expect(
      toEngineMarkers(
        [
          { timestamp: 180, side: 'short', kind: 'blocked' },
          { timestamp: 60, side: 'long', kind: 'executed' },
          { timestamp: 120, side: 'short', kind: 'executed' },
        ],
        palette,
      ),
    ).toEqual([
      { time: 60, position: 'belowBar', shape: 'arrowUp', color: 'UP' },
      { time: 120, position: 'aboveBar', shape: 'arrowDown', color: 'DOWN' },
      { time: 180, position: 'aboveBar', shape: 'circle', color: 'REFUSED' },
    ]);
  });

  it('by default takes its colours from the tokens, and a close is not the refusal’s', () => {
    const [closed] = toEngineMarkers([{ timestamp: 60, side: 'long', kind: 'closed' }]);
    const [blocked] = toEngineMarkers([{ timestamp: 60, side: 'long', kind: 'blocked' }]);
    const [opened] = toEngineMarkers([{ timestamp: 60, side: 'long', kind: 'executed' }]);
    expect(closed?.color).not.toBe(blocked?.color);
    expect(closed?.color).not.toBe(opened?.color);
  });
});
