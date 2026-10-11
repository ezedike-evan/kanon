import { describe, expect, it } from 'vitest';
import { formatBps, formatDecimal, parseDecimal } from '@kanon/spec';
import { buildFixtureSeries, demoQuote } from './chart-fixtures';
import { changeOver24h, formatDecimalAt, seriesDisplayDecimals } from './chart-series';
import { CHART_TIMEFRAMES } from './chart-timeframes';
import { DEMO_ASSETS, DEMO_MARKETS, atPlaces, demoTicker, moveBps } from './domain-demo';
import { formatTimedPrice } from './timed-trade';

/**
 * A demo pair has one price. These checks are what stop a pair row, a Predict
 * slide and the chart from stating two: each is asked for the string it prints,
 * and the strings are compared.
 */

const pairs = () => {
  if (DEMO_MARKETS.status !== 'demo') throw new Error('demo markets expected');
  return DEMO_MARKETS.pairs;
};

describe('the demo pairs', () => {
  it('are the four listed assets, in order, each with its own ticker', () => {
    expect(pairs().map((p) => p.asset)).toEqual([...DEMO_ASSETS]);
    expect(DEMO_ASSETS).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'MON/USD']);
    for (const pair of pairs()) {
      const ticker = demoTicker(pair.asset);
      expect(ticker.status).toBe('demo');
      if (ticker.status === 'demo') expect(ticker.ticker).toBe(pair);
    }
  });

  it('are built once: the same list and the same ticker every time they are asked for', () => {
    expect(pairs()).toBe(pairs());
    expect(demoTicker('ETH/USD')).toBe(demoTicker('eth / usd'));
  });

  it.each([...DEMO_ASSETS])('%s: the list, the slide and the chart header print one price', (asset) => {
    const ticker = demoTicker(asset);
    if (ticker.status !== 'demo') throw new Error(`no demo ticker for ${asset}`);
    // What a pair row prints (Home, the chart's Markets list), and what a Predict slide prints.
    const row = formatDecimal(ticker.ticker.price);
    const slide = formatTimedPrice(ticker.ticker.price);
    expect(slide).toBe(row);
    // What the chart's header prints, at every timeframe: the series' last close at its display places.
    for (const tf of CHART_TIMEFRAMES) {
      const series = buildFixtureSeries(asset, tf.bucketSeconds);
      const last = series.candles[series.candles.length - 1]!;
      expect(formatDecimalAt(last.close, seriesDisplayDecimals(series))).toBe(row);
    }
  }, 60_000);

  it.each([...DEMO_ASSETS])('%s: the 24-hour move is the one the chart opens on', (asset) => {
    const ticker = demoTicker(asset);
    if (ticker.status !== 'demo') throw new Error(`no demo ticker for ${asset}`);
    // The chart opens on the demo rule's 15m candles, and its header works the move out from them.
    const change = changeOver24h(buildFixtureSeries(asset, 900));
    expect(change).not.toBeNull();
    expect(ticker.ticker.changeBps).toBe(change!.bps);
    expect(Number.isInteger(ticker.ticker.changeBps)).toBe(true);
    // The same digits on both: the header's percent, and the row's.
    expect(formatBps(Math.abs(ticker.ticker.changeBps!))).toBe(change!.percentText.replace(/^[+−]/, ''));
  }, 60_000);

  it('quote from the tape itself: the newest print, and none for a second invented figure', () => {
    for (const asset of DEMO_ASSETS) {
      const quote = demoQuote(asset);
      const series = buildFixtureSeries(asset, 60);
      expect(quote?.price).toEqual(series.candles[series.candles.length - 1]!.close);
      expect(quote?.dayAgo).not.toBeNull();
    }
  }, 60_000);
});

describe('atPlaces', () => {
  it('rounds half up on the integers, and leaves a price that is already that coarse alone', () => {
    expect(atPlaces(parseDecimal('162.404', 3), 2)).toEqual(parseDecimal('162.40', 2));
    expect(atPlaces(parseDecimal('162.405', 3), 2)).toEqual(parseDecimal('162.41', 2));
    expect(atPlaces(parseDecimal('0.03420', 5), 5)).toEqual(parseDecimal('0.03420', 5));
    const coarse = parseDecimal('64200.00', 2);
    expect(atPlaces(coarse, 4)).toBe(coarse);
  });
});

describe('moveBps', () => {
  it('is whole basis points of the earlier price, truncated toward zero as the chart header truncates', () => {
    expect(moveBps(parseDecimal('101.00', 2), parseDecimal('100.00', 2))).toBe(100);
    expect(moveBps(parseDecimal('99.00', 2), parseDecimal('100.00', 2))).toBe(-100);
    // 0.999% up and down: 99 and -99, never rounded to 100.
    expect(moveBps(parseDecimal('100.999', 3), parseDecimal('100.00', 2))).toBe(99);
    expect(moveBps(parseDecimal('99.001', 3), parseDecimal('100.00', 2))).toBe(-99);
    expect(moveBps(parseDecimal('5.00', 2), parseDecimal('0.00', 2))).toBe(0);
  });
});
