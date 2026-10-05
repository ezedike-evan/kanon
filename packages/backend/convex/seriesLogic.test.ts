import { describe, expect, it } from 'vitest';
import { dec, formatDecimal } from '@kanon/spec';
import {
  ALLOWED_BUCKET_SECONDS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  bucketStart,
  candlesToSeries,
  foldTickIntoCandle,
  mergeCandles,
  type CandleRow,
  clampLimit,
  isAllowedBucketSeconds,
  normalizeAsset,
  ticksToSeries,
  tickerFrom,
  tradesToMarkers,
  windowStartSeconds,
  type MarkableTrade,
  type StoredTick,
} from './seriesLogic';

const HOUR = 3600;
const px = (atoms: number): StoredTick["price"] => dec(BigInt(atoms), 2);
const tick = (publishTime: number, atoms: number): StoredTick => ({ publishTime, price: px(atoms) });

describe('bucketStart', () => {
  it('floors to the bucket start, so a boundary tick opens its own bucket', () => {
    expect(bucketStart(0, HOUR)).toBe(0);
    expect(bucketStart(HOUR - 1, HOUR)).toBe(0);
    expect(bucketStart(HOUR, HOUR)).toBe(HOUR);
    expect(bucketStart(HOUR + 1, HOUR)).toBe(HOUR);
  });

  it('is epoch-anchored for every allowed width, as the contract is', () => {
    const t = 1_760_000_123;
    for (const w of ALLOWED_BUCKET_SECONDS) {
      expect(bucketStart(t, w)).toBe(Math.floor(t / w) * w);
      expect(bucketStart(t, w) % w).toBe(0);
    }
  });

  it('puts weekly buckets on a Thursday, because the epoch was one', () => {
    const week = 604_800;
    const start = bucketStart(1_760_000_000, week);
    expect(new Date(start * 1000).getUTCDay()).toBe(4);
  });

  it('is exact just below and at a day boundary', () => {
    expect(bucketStart(86_399, 86_400)).toBe(0);
    expect(bucketStart(86_400, 86_400)).toBe(86_400);
  });
});

describe('windowStartSeconds', () => {
  it('reaches back limit-1 buckets from the latest tick bucket', () => {
    expect(windowStartSeconds(10 * HOUR + 5, HOUR, 4)).toBe(7 * HOUR);
    expect(windowStartSeconds(10 * HOUR, HOUR, 1)).toBe(10 * HOUR);
  });
});

describe('request guards', () => {
  it('only allows the published bucket widths', () => {
    expect(isAllowedBucketSeconds(3600)).toBe(true);
    expect(isAllowedBucketSeconds(14_400)).toBe(true);
    expect(isAllowedBucketSeconds(86_400)).toBe(true);
    expect(isAllowedBucketSeconds(604_800)).toBe(true);
    expect(isAllowedBucketSeconds(0)).toBe(false);
    expect(isAllowedBucketSeconds(3601)).toBe(false);
    expect(isAllowedBucketSeconds(-3600)).toBe(false);
  });

  it('clamps limit into range and defaults when absent', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(10.9)).toBe(10);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
  });

  it('normalises how the UI spells an asset', () => {
    expect(normalizeAsset('BTC / USD')).toBe('BTC/USD');
    expect(normalizeAsset(' eth/usd ')).toBe('ETH/USD');
  });
});

describe('ticksToSeries', () => {
  it('buckets ticks into OHLC candles with exact decimals', () => {
    const s = ticksToSeries({
      asset: 'BTC/USD',
      bucketSeconds: HOUR,
      truncated: false,
      ticks: [
        tick(10, 100_00),
        tick(20, 120_05),
        tick(30, 90_10),
        tick(HOUR - 1, 110_00),
        tick(HOUR, 111_00),
      ],
    });
    expect(s.asset).toBe('BTC/USD');
    expect(s.truncated).toBe(false);
    expect(s.candles).toHaveLength(2);
    const [a, b] = s.candles;
    expect(a).toMatchObject({ bucketIndex: 0, timestamp: 0, synthetic: false });
    expect(formatDecimal(a!.open)).toBe('100.00');
    expect(formatDecimal(a!.high)).toBe('120.05');
    expect(formatDecimal(a!.low)).toBe('90.10');
    expect(formatDecimal(a!.close)).toBe('110.00');
    // The tick at exactly HOUR opens the next bucket, it does not close the first.
    expect(b).toMatchObject({ bucketIndex: 1, timestamp: HOUR, synthetic: false });
    expect(formatDecimal(b!.open)).toBe('111.00');
  });

  it('sorts unordered input before bucketing', () => {
    const s = ticksToSeries({
      asset: 'BTC/USD',
      bucketSeconds: HOUR,
      truncated: false,
      ticks: [tick(30, 90_00), tick(10, 100_00), tick(20, 95_00)],
    });
    expect(formatDecimal(s.candles[0]!.open)).toBe('100.00');
    expect(formatDecimal(s.candles[0]!.close)).toBe('90.00');
  });

  it('carries an empty bucket forward flat and never invents a range', () => {
    const s = ticksToSeries({
      asset: 'BTC/USD',
      bucketSeconds: HOUR,
      truncated: false,
      ticks: [tick(10, 100_00), tick(2 * HOUR + 5, 105_00)],
    });
    expect(s.candles.map((c) => [c.bucketIndex, c.synthetic])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    const gap = s.candles[1]!;
    expect(gap.open).toEqual(gap.high);
    expect(gap.high).toEqual(gap.low);
    expect(gap.low).toEqual(gap.close);
    expect(formatDecimal(gap.close)).toBe('100.00');
  });

  it('returns no candles for no ticks', () => {
    expect(ticksToSeries({ asset: 'X', bucketSeconds: HOUR, ticks: [], truncated: false }).candles).toEqual([]);
  });

  it('re-buckets the same ticks at each width', () => {
    const ticks = [tick(10, 100_00), tick(HOUR + 10, 110_00), tick(2 * HOUR + 10, 90_00), tick(5 * HOUR, 95_00)];
    const hourly = ticksToSeries({ asset: 'A', bucketSeconds: HOUR, ticks, truncated: false });
    const fourHour = ticksToSeries({ asset: 'A', bucketSeconds: 4 * HOUR, ticks, truncated: false });
    expect(hourly.bucketSeconds).toBe(HOUR);
    expect(fourHour.bucketSeconds).toBe(4 * HOUR);
    expect(fourHour.candles.map((c) => c.timestamp)).toEqual([0, 4 * HOUR]);
    const first = fourHour.candles[0]!;
    expect(formatDecimal(first.high)).toBe('110.00');
    expect(formatDecimal(first.low)).toBe('90.00');
    expect(formatDecimal(first.close)).toBe('90.00');
  });

  it('drops the partial oldest candle when the read was truncated', () => {
    const ticks = [tick(30, 100_00), tick(HOUR + 1, 101_00), tick(2 * HOUR + 1, 102_00)];
    const s = ticksToSeries({ asset: 'A', bucketSeconds: HOUR, ticks, truncated: true });
    expect(s.truncated).toBe(true);
    expect(s.candles.map((c) => c.timestamp)).toEqual([HOUR, 2 * HOUR]);
  });

  it('keeps a lone candle even when truncated, and says so', () => {
    const s = ticksToSeries({ asset: 'A', bucketSeconds: HOUR, ticks: [tick(30, 100_00)], truncated: true });
    expect(s.candles).toHaveLength(1);
    expect(s.truncated).toBe(true);
  });

  it('survives atoms beyond float precision', () => {
    const big = { atoms: '9007199254740993', decimals: 8 };
    const s = ticksToSeries({
      asset: 'A',
      bucketSeconds: HOUR,
      truncated: false,
      ticks: [{ publishTime: 5, price: big }],
    });
    expect(s.candles[0]!.close).toEqual(big);
  });

  it('returns plain data Convex can serialise', () => {
    const s = ticksToSeries({ asset: 'A', bucketSeconds: HOUR, ticks: [tick(5, 1_00)], truncated: false });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('tradesToMarkers', () => {
  const at = (seconds: number) => seconds * 1000;
  const trade = (over: Partial<MarkableTrade>): MarkableTrade => ({
    asset: 'BTC/USD',
    direction: 'long',
    status: 'executed',
    createdAt: at(HOUR + 1234),
    ...over,
  });

  it('pins a trade to the start of its candle', () => {
    expect(tradesToMarkers([trade({})], { asset: 'BTC/USD', bucketSeconds: HOUR })).toEqual([
      { timestamp: HOUR, side: 'long', kind: 'executed' },
    ]);
  });

  it('lands a trade at exactly a boundary in the bucket it opens, and one second before in the last', () => {
    const out = tradesToMarkers(
      [trade({ createdAt: at(2 * HOUR) }), trade({ createdAt: at(2 * HOUR - 1), direction: 'short' })],
      { asset: 'BTC/USD', bucketSeconds: HOUR },
    );
    expect(out).toEqual([
      { timestamp: HOUR, side: 'short', kind: 'executed' },
      { timestamp: 2 * HOUR, side: 'long', kind: 'executed' },
    ]);
  });

  it('floors milliseconds before bucketing', () => {
    const out = tradesToMarkers([trade({ createdAt: at(HOUR) - 1 })], { asset: 'BTC/USD', bucketSeconds: HOUR });
    expect(out[0]!.timestamp).toBe(0);
  });

  it('buckets the same trade differently per width', () => {
    const t = trade({ createdAt: at(5 * HOUR + 10) });
    expect(tradesToMarkers([t], { asset: 'BTC/USD', bucketSeconds: HOUR })[0]!.timestamp).toBe(5 * HOUR);
    expect(tradesToMarkers([t], { asset: 'BTC/USD', bucketSeconds: 4 * HOUR })[0]!.timestamp).toBe(4 * HOUR);
    expect(tradesToMarkers([t], { asset: 'BTC/USD', bucketSeconds: 86_400 })[0]!.timestamp).toBe(0);
  });

  it('maps a refusal to a blocked mark and skips trades that never hit the tape', () => {
    const out = tradesToMarkers(
      [
        trade({ status: 'refused', direction: 'short' }),
        trade({ status: 'proposed' }),
        trade({ status: 'undone' }),
      ],
      { asset: 'BTC/USD', bucketSeconds: HOUR },
    );
    expect(out).toEqual([{ timestamp: HOUR, side: 'short', kind: 'blocked' }]);
  });

  it('keeps only the requested asset, tolerating the UI spelling', () => {
    const out = tradesToMarkers([trade({ asset: 'ETH/USD' }), trade({})], {
      asset: 'BTC / USD',
      bucketSeconds: HOUR,
    });
    expect(out).toHaveLength(1);
  });

  it('collapses identical marks on one bar and sorts ascending', () => {
    const out = tradesToMarkers(
      [
        trade({ createdAt: at(3 * HOUR + 1) }),
        trade({ createdAt: at(HOUR + 1) }),
        trade({ createdAt: at(HOUR + 900) }),
        trade({ createdAt: at(HOUR + 900), status: 'refused' }),
      ],
      { asset: 'BTC/USD', bucketSeconds: HOUR },
    );
    expect(out).toEqual([
      { timestamp: HOUR, side: 'long', kind: 'executed' },
      { timestamp: HOUR, side: 'long', kind: 'blocked' },
      { timestamp: 3 * HOUR, side: 'long', kind: 'executed' },
    ]);
  });
});

describe('tickerFrom', () => {
  const latest = tick(10_000, 51_000);

  it('states the move from the first print in the window, in integer bps', () => {
    const t = tickerFrom({ asset: 'BTC/USD', latest, open: tick(4_000, 50_000) });
    expect(t.changeBps).toBe(200); // +2.00%
    expect(t.openTime).toBe(4_000);
    expect(t.open).toEqual(px(50_000));
    expect(t.price).toEqual(px(51_000));
  });

  it('is negative when the price has fallen', () => {
    expect(tickerFrom({ asset: 'BTC/USD', latest: tick(10, 49_000), open: tick(1, 50_000) }).changeBps).toBe(-200);
  });

  it('claims no move when the latest print is the only one', () => {
    for (const open of [null, latest]) {
      const t = tickerFrom({ asset: 'BTC/USD', latest, open });
      expect(t.changeBps).toBeNull();
      expect(t.open).toBeNull();
      expect(t.openTime).toBeNull();
    }
  });
});

describe('pre-aggregated candles', () => {
  const fold = (ticks: StoredTick[], width: number) => {
    const rows = new Map<number, CandleRow>();
    for (const t of ticks) {
      const s = bucketStart(t.publishTime, width);
      rows.set(s, foldTickIntoCandle(rows.get(s) ?? null, t, width));
    }
    return [...rows.values()].sort((a, b) => a.start - b.start);
  };
  const ticks: StoredTick[] = [
    tick(0, 100), tick(30, 120), tick(59, 90), tick(60, 95), tick(2 * HOUR + 5, 110), tick(2 * HOUR + 6, 80),
    tick(5 * HOUR - 1, 105), tick(5 * HOUR, 107),
  ];

  it('equals ticksToSeries (gap fill included) at every width', () => {
    for (const w of ALLOWED_BUCKET_SECONDS) {
      const expected = ticksToSeries({ asset: 'BTC/USD', bucketSeconds: w, ticks, truncated: false });
      const got = candlesToSeries({ asset: 'BTC/USD', bucketSeconds: w, rows: fold(ticks, w) });
      expect(got).toEqual(expected);
    }
  });

  it('is order-independent and idempotent', () => {
    const shuffled = [...ticks].reverse().concat(ticks);
    for (const w of [60, HOUR]) expect(fold(shuffled, w)).toEqual(fold(ticks, w));
  });

  it('merging two partial aggregates equals folding all ticks', () => {
    const w = HOUR;
    const a = fold(ticks.slice(0, 5), w);
    const b = fold(ticks.slice(3), w);
    const merged = new Map(a.map((r) => [r.start, r]));
    for (const r of b) merged.set(r.start, merged.has(r.start) ? mergeCandles(merged.get(r.start)!, r) : r);
    expect([...merged.values()].sort((x, y) => x.start - y.start)).toEqual(fold(ticks, w));
  });
});
