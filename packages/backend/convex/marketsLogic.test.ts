import { describe, expect, it } from 'vitest';
import {
  MARKET_TEMPLATES,
  MAX_REFERENCE_AGE_SECONDS,
  formatDecimal,
  parseDecimal,
  resolveMarket,
  templateById,
} from '@kanon/spec';
import {
  DIRECTIONS,
  isStreamLive,
  isValidStake,
  planNewMarkets,
  seriesForMarket,
  settlementFields,
  sliceWindowRead,
  streamKey,
  unionRange,
  windowReadRange,
} from './marketsLogic';

const NOW = 1_800_000_000;
const ref = (price: string, age = 30) => ({
  price: parseDecimal(price, 8),
  publishTime: NOW - age,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
});

describe('isStreamLive', () => {
  it('is live until the window ends, and not at windowEnd itself', () => {
    expect(isStreamLive({ windowEnd: NOW + 1 }, NOW)).toBe(true);
    expect(isStreamLive({ windowEnd: NOW }, NOW)).toBe(false);
    expect(isStreamLive({ windowEnd: NOW - 1 }, NOW)).toBe(false);
    expect(isStreamLive(null, NOW)).toBe(false);
    expect(isStreamLive(undefined, NOW)).toBe(false);
  });
});

describe('planNewMarkets', () => {
  const latest = {
    'BTC/USD': ref('68412.34'),
    'ETH/USD': ref('3400.12'),
    'SOL/USD': ref('135.123'),
    'MON/USD': ref('0.041234'),
  };

  it('opens one market per asset, window length and direction on a cold start', () => {
    const plan = planNewMarkets({ nowSeconds: NOW, latest, live: new Set() });
    expect(plan.toOpen).toHaveLength(4 * MARKET_TEMPLATES.length * DIRECTIONS.length);
    expect(plan.skipped).toEqual([]);
    const keys = plan.toOpen.map((m) => streamKey(m.asset, m.template, m.direction));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never opens a market on AVAX, even if a price for it is handed in', () => {
    const plan = planNewMarkets({
      nowSeconds: NOW,
      latest: { ...latest, 'AVAX/USD': ref('45.00') },
      live: new Set(),
    });
    expect(plan.toOpen.some((m) => m.asset === 'AVAX/USD')).toBe(false);
  });

  it('leaves a live stream alone and opens the rest', () => {
    const live = new Set([streamKey('BTC/USD', '1H', 'above')]);
    const plan = planNewMarkets({ nowSeconds: NOW, latest, live });
    expect(plan.toOpen.find((m) => m.asset === 'BTC/USD' && m.template === '1H' && m.direction === 'above')).toBeUndefined();
    expect(plan.toOpen.find((m) => m.asset === 'BTC/USD' && m.template === '1H' && m.direction === 'below')).toBeDefined();
    expect(plan.toOpen).toHaveLength(4 * MARKET_TEMPLATES.length * 2 - 1);
  });

  it('opens nothing when every stream is live', () => {
    const live = new Set(
      ['BTC/USD', 'ETH/USD', 'SOL/USD', 'MON/USD'].flatMap((a) =>
        MARKET_TEMPLATES.flatMap((t) => DIRECTIONS.map((d) => streamKey(a, t.id, d))),
      ),
    );
    expect(planNewMarkets({ nowSeconds: NOW, latest, live }).toOpen).toEqual([]);
  });

  it('skips an asset with no print, and says why', () => {
    const plan = planNewMarkets({
      nowSeconds: NOW,
      latest: { ...latest, 'MON/USD': null },
      live: new Set(),
    });
    expect(plan.toOpen.some((m) => m.asset === 'MON/USD')).toBe(false);
    expect(plan.skipped.filter((s) => s.asset === 'MON/USD').every((s) => s.reason === 'no_reference')).toBe(true);
    expect(plan.skipped).toHaveLength(MARKET_TEMPLATES.length * 2);
  });

  it('skips an asset whose newest print is older than the limit', () => {
    const plan = planNewMarkets({
      nowSeconds: NOW,
      latest: { ...latest, 'ETH/USD': ref('3400.12', MAX_REFERENCE_AGE_SECONDS + 1) },
      live: new Set(),
    });
    expect(plan.toOpen.some((m) => m.asset === 'ETH/USD')).toBe(false);
    expect(plan.skipped.every((s) => s.asset === 'ETH/USD' && s.reason === 'stale_reference')).toBe(true);
  });

  it('opens on a print exactly at the age limit', () => {
    const plan = planNewMarkets({
      nowSeconds: NOW,
      latest: { 'BTC/USD': ref('68412.34', MAX_REFERENCE_AGE_SECONDS) },
      live: new Set(),
      assets: ['BTC/USD'],
    });
    expect(plan.toOpen).toHaveLength(MARKET_TEMPLATES.length * 2);
  });

  it('starts every window strictly after now, on a bucket boundary', () => {
    const plan = planNewMarkets({ nowSeconds: NOW, latest, live: new Set() });
    for (const m of plan.toOpen) {
      expect(m.windowStart).toBeGreaterThan(NOW);
      expect(m.windowStart % m.bucketSeconds).toBe(0);
      expect(m.windowEnd % m.bucketSeconds).toBe(0);
    }
  });

  it('carries every parameter on the market, so nothing is a hidden default', () => {
    const plan = planNewMarkets({ nowSeconds: NOW, latest, live: new Set(), assets: ['BTC/USD'] });
    const m = plan.toOpen.find((x) => x.template === '4H' && x.direction === 'above')!;
    const t = templateById('4H')!;
    expect(m.params.offsetBps).toBe(t.offsetBps);
    expect(m.params.windowSeconds).toBe(t.windowSeconds);
    expect(m.params.referencePrice).toEqual(latest['BTC/USD'].price);
    expect(m.params.referenceAt).toBe(latest['BTC/USD'].publishTime);
    expect(m.params.feedId).toBe(latest['BTC/USD'].feedId);
  });
});

describe('seriesForMarket', () => {
  const window = { windowStart: 900, windowEnd: 2700, bucketSeconds: 900 };
  const tick = (price: string, publishTime: number) => ({ price: parseDecimal(price, 2), publishTime });

  it('reads the window from its start to the end of its last bucket', () => {
    expect(windowReadRange(window)).toEqual({ from: 900, to: 3600 });
  });

  it('drops ticks outside the window range and does not carry a gap forward', () => {
    const s = seriesForMarket({
      asset: 'BTC/USD',
      window,
      windowTicks: [tick('999.00', 899), tick('100.00', 900), tick('101.00', 2700), tick('999.00', 3600)],
    });
    expect(s.candles.map((c) => c.timestamp)).toEqual([900, 2700]);
    expect(s.candles.every((c) => !c.synthetic)).toBe(true);
  });

  it('adds the closing tick as a later bucket, which is what completes the window', () => {
    const s = seriesForMarket({
      asset: 'BTC/USD',
      window,
      windowTicks: [tick('100.00', 1000)],
      closingTick: tick('100.10', 3600),
    });
    expect(s.candles.map((c) => c.timestamp)).toEqual([900, 3600]);
  });

  it('ignores a closing tick that is still inside the window range', () => {
    const s = seriesForMarket({
      asset: 'BTC/USD',
      window,
      windowTicks: [tick('100.00', 1000)],
      closingTick: tick('100.10', 3599),
    });
    expect(s.candles.map((c) => c.timestamp)).toEqual([900]);
  });

  it('feeds resolveMarket end to end: a window that touched the threshold settles as a hit', () => {
    const series = seriesForMarket({
      asset: 'BTC/USD',
      window,
      windowTicks: [tick('100.00', 1000), tick('101.10', 1800), tick('100.00', 2800)],
      closingTick: tick('100.20', 3700),
    });
    const r = resolveMarket(
      series,
      { asset: 'BTC/USD', direction: 'above', thresholdPrice: parseDecimal('101.00', 2), ...window },
      4_000,
    );
    expect(r.kind).toBe('settled');
    if (r.kind === 'settled') {
      expect(r.hit).toBe(true);
      expect(formatDecimal(r.decidingPrice!)).toBe('101.10');
    }
  });

  it('a window with only the closing tick is unresolvable, not a miss', () => {
    const series = seriesForMarket({
      asset: 'BTC/USD',
      window,
      windowTicks: [],
      closingTick: tick('100.20', 3700),
    });
    const r = resolveMarket(
      series,
      { asset: 'BTC/USD', direction: 'above', thresholdPrice: parseDecimal('101.00', 2), ...window },
      4_000,
    );
    expect(r).toEqual({ kind: 'unresolvable' });
  });
});

describe('settlementFields', () => {
  it('writes a hit with its deciding price and time', () => {
    const f = settlementFields({
      kind: 'settled',
      hit: true,
      decidingPrice: parseDecimal('101.10', 2),
      decidingAt: 1800,
      windowExtreme: { price: parseDecimal('101.10', 2), at: 1800 },
      recordedCandles: 3,
    });
    expect(f).toMatchObject({ status: 'settled', outcome: 'hit', decidingAt: 1800, recordedCandles: 3 });
    expect(f?.decidingPrice).toEqual(parseDecimal('101.10', 2));
  });

  it('writes a miss with no deciding price, and the closest approach as evidence', () => {
    const f = settlementFields({
      kind: 'settled',
      hit: false,
      windowExtreme: { price: parseDecimal('100.90', 2), at: 900 },
      recordedCandles: 2,
    });
    expect(f?.outcome).toBe('miss');
    expect(f).not.toHaveProperty('decidingPrice');
    expect(f?.windowExtreme?.price).toEqual(parseDecimal('100.90', 2));
  });

  it('writes an unresolvable market with no outcome', () => {
    expect(settlementFields({ kind: 'unresolvable' })).toEqual({ status: 'unresolvable', recordedCandles: 0 });
  });

  it('writes nothing for a resolution that is not final', () => {
    expect(settlementFields({ kind: 'open' })).toBeNull();
    expect(settlementFields({ kind: 'awaiting' })).toBeNull();
    expect(
      settlementFields({ kind: 'crossed', decidingPrice: parseDecimal('1.00', 2), decidingAt: 0 }),
    ).toBeNull();
  });
});

describe('isValidStake', () => {
  it('accepts a positive stake at up to 18 decimals', () => {
    expect(isValidStake({ atoms: '10000000000000000', decimals: 18 })).toBe(true);
    expect(isValidStake({ atoms: '1', decimals: 0 })).toBe(true);
  });
  it('refuses zero, negative, fractional and over-precise stakes', () => {
    expect(isValidStake({ atoms: '0', decimals: 18 })).toBe(false);
    expect(isValidStake({ atoms: '-5', decimals: 18 })).toBe(false);
    expect(isValidStake({ atoms: '1.5', decimals: 18 })).toBe(false);
    expect(isValidStake({ atoms: '1', decimals: 19 })).toBe(false);
    expect(isValidStake({ atoms: '1', decimals: -1 })).toBe(false);
  });
});

describe('reading several windows at once', () => {
  const t = (publishTime: number, atoms = 100) => ({ publishTime, price: parseDecimal(String(atoms), 2) });
  // Ticks 10, 20 ... 100 for one asset.
  const all = Array.from({ length: 10 }, (_, i) => t((i + 1) * 10, 100 + i));

  it('unions the ranges into one read, and reads nothing for none', () => {
    expect(unionRange([])).toBeNull();
    expect(unionRange([{ from: 30, to: 60 }, { from: 10, to: 40 }, { from: 50, to: 90 }])).toEqual({ from: 10, to: 90 });
  });

  /** What `markets:windowTicks` returns for one range read on its own. */
  const alone = (range: { from: number; to: number }, maxTicks: number) => {
    const rows = all.filter((x) => x.publishTime >= range.from && x.publishTime < range.to);
    const closing = all.find((x) => x.publishTime >= range.to) ?? null;
    return { ticks: rows.slice(0, maxTicks), closing, truncated: rows.length > maxTicks };
  };

  /** What the union read returns: the ticks in the union and the first one after it. */
  const unionRead = (ranges: { from: number; to: number }[]) => {
    const u = unionRange(ranges)!;
    return {
      union: all.filter((x) => x.publishTime >= u.from && x.publishTime < u.to),
      afterUnion: all.find((x) => x.publishTime >= u.to) ?? null,
    };
  };

  it('cuts exactly what a read of that window alone would have returned', () => {
    const ranges = [
      { from: 20, to: 50 },
      { from: 30, to: 90 },
      { from: 10, to: 110 }, // runs past the last tick
      { from: 95, to: 120 }, // holds nothing
    ];
    const shared = unionRead(ranges);
    for (const range of ranges) {
      for (const maxTicks of [100, 3]) {
        expect(sliceWindowRead({ ...shared, range, maxTicks })).toEqual(alone(range, maxTicks));
      }
    }
  });

  it('takes the closing tick from beyond the union only when nothing in it closes the window', () => {
    const ranges = [{ from: 20, to: 50 }, { from: 60, to: 80 }];
    const shared = unionRead(ranges);
    // The 20..50 window is closed by the tick at 50, which the union read holds.
    expect(sliceWindowRead({ ...shared, range: ranges[0]!, maxTicks: 100 }).closing?.publishTime).toBe(50);
    // The 60..80 window is the union's end, so its closer is the first tick after the union.
    expect(sliceWindowRead({ ...shared, range: ranges[1]!, maxTicks: 100 }).closing?.publishTime).toBe(80);
  });

  it('says truncated on the same rule as a read of that window alone', () => {
    const range = { from: 10, to: 110 };
    const out = sliceWindowRead({ ...unionRead([range]), range, maxTicks: 4 });
    expect(out.truncated).toBe(true);
    expect(out.ticks).toHaveLength(4);
  });
});
