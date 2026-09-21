import { describe, expect, it } from 'vitest';
import { formatDecimal, parseDecimal } from './decimal';
import {
  MARKET_TEMPLATES,
  MAX_REFERENCE_AGE_SECONDS,
  alignWindow,
  buildMarket,
  canTakeSide,
  deriveThreshold,
  distanceBps,
  evidenceFor,
  evidencePreimage,
  hashMarketTerms,
  hashSettlementEvidence,
  isMarketAsset,
  isReferenceFresh,
  marketAssets,
  marketPhase,
  positionResult,
  rescaleExact,
  resolveMarket,
  resultForSide,
  sideTakesYes,
  templateById,
  type MarketTerms,
} from './market';
import { makeCandle, makeSeries, p, TEST_BUCKET_SECONDS } from './test-fixtures';
import type { Candle } from './candle';

const B = TEST_BUCKET_SECONDS; // 900

const terms = (over: Partial<MarketTerms> = {}): MarketTerms => ({
  asset: 'BTC/USD',
  direction: 'above',
  thresholdPrice: p('101.00'),
  windowStart: 900,
  windowEnd: 2700,
  bucketSeconds: B,
  ...over,
});

const flat = (price: string, ts: number) => makeCandle(price, price, price, price, ts);

describe('assets', () => {
  it('lists exactly the assets with a Pyth feed, and never AVAX', () => {
    expect(marketAssets().sort()).toEqual(['BTC/USD', 'ETH/USD', 'MON/USD', 'SOL/USD']);
    expect(isMarketAsset('AVAX/USD')).toBe(false);
    expect(isMarketAsset('BTC/USD')).toBe(true);
  });
});

describe('templates', () => {
  it('have windows that are whole numbers of buckets, so a window ends on a bucket boundary', () => {
    for (const t of MARKET_TEMPLATES) {
      expect(t.windowSeconds % t.bucketSeconds).toBe(0);
      expect(t.offsetBps).toBeGreaterThan(0);
    }
    expect(templateById('4H')?.bucketSeconds).toBe(900);
    expect(templateById('nope')).toBeUndefined();
  });
});

describe('deriveThreshold', () => {
  it('moves a 2-decimal price by the offset and keeps the same grid', () => {
    expect(formatDecimal(deriveThreshold(p('100.00'), 'above', 50))).toBe('100.50');
    expect(formatDecimal(deriveThreshold(p('100.00'), 'below', 50))).toBe('99.50');
  });

  it('shows a BTC threshold without a run of trailing zeros', () => {
    const ref = parseDecimal('68412.34', 8);
    expect(deriveThreshold(ref, 'above', 50)).toEqual({ atoms: '68755', decimals: 0 });
    expect(deriveThreshold(ref, 'below', 50)).toEqual({ atoms: '68070', decimals: 0 });
  });

  it('rounds away from the reference, so the threshold is never nearer than the offset', () => {
    const ref = parseDecimal('68412.34', 8);
    const up = deriveThreshold(ref, 'above', 50);
    const down = deriveThreshold(ref, 'below', 50);
    // exact +50bp is 68754.4417, exact -50bp is 68070.2783
    expect(distanceBps(ref, up)).toBeGreaterThanOrEqual(50);
    expect(distanceBps(ref, down)).toBeLessThanOrEqual(-50);
  });

  it('uses more decimals for a smaller price, keeping five significant digits', () => {
    expect(deriveThreshold(parseDecimal('3400.12', 8), 'above', 100)).toEqual({
      atoms: '34342',
      decimals: 1,
    });
    expect(deriveThreshold(parseDecimal('135.123', 8), 'below', 100)).toEqual({
      atoms: '13377',
      decimals: 2,
    });
  });

  it('handles a sub-dollar price: MON at 0.041234 keeps five significant digits', () => {
    const t = deriveThreshold(parseDecimal('0.041234', 8), 'above', 200);
    // 0.041234 * 1.02 = 0.04205868, rounded up on the 6-decimal grid to 0.042059
    expect(t).toEqual({ atoms: '42059', decimals: 6 });
  });

  it('rounds a price with more integer digits than significant digits to a coarser grid', () => {
    const t = deriveThreshold(parseDecimal('1234567.00', 2), 'above', 50, 5);
    // 1234567 * 1.005 = 1240739.835 -> grid is 100 -> ceil to 1240800
    expect(t).toEqual({ atoms: '1240800', decimals: 0 });
    const down = deriveThreshold(parseDecimal('1234567.00', 2), 'below', 50, 5);
    // 1234567 * 0.995 = 1228394.165 -> floor to 1228300
    expect(down).toEqual({ atoms: '1228300', decimals: 0 });
  });

  it('is exact when the offset lands on the grid', () => {
    expect(deriveThreshold(p('200.00'), 'above', 100)).toEqual({ atoms: '20200', decimals: 2 });
  });

  it('refuses a non-positive reference and an offset that is not a real distance', () => {
    expect(() => deriveThreshold(p('0.00'), 'above', 50)).toThrow(RangeError);
    expect(() => deriveThreshold({ atoms: '-100', decimals: 2 }, 'above', 50)).toThrow(RangeError);
    expect(() => deriveThreshold(p('100.00'), 'above', 0)).toThrow(RangeError);
    expect(() => deriveThreshold(p('100.00'), 'below', 10_000)).toThrow(RangeError);
    expect(() => deriveThreshold(p('100.00'), 'above', 0.5)).toThrow(RangeError);
    expect(() => deriveThreshold(p('100.00'), 'above', 50, 0)).toThrow(RangeError);
  });

  it('refuses a price so small the threshold would round to zero', () => {
    // 1 atom at 18 decimals, below: the exact value is under one atom.
    expect(() => deriveThreshold({ atoms: '1', decimals: 18 }, 'below', 50)).toThrow(RangeError);
  });

  it('never returns a float-shaped atoms string', () => {
    const t = deriveThreshold(parseDecimal('68412.34', 8), 'above', 200);
    expect(t.atoms).toMatch(/^\d+$/);
  });
});

describe('distanceBps', () => {
  it('is signed and truncates toward zero', () => {
    expect(distanceBps(p('100.00'), p('100.50'))).toBe(50);
    expect(distanceBps(p('100.00'), p('99.50'))).toBe(-50);
    expect(distanceBps(p('100.00'), p('100.019'.slice(0, 6)))).toBe(1);
    expect(distanceBps(p('100.00'), p('100.00'))).toBe(0);
  });

  it('compares across different scales', () => {
    expect(distanceBps(parseDecimal('100', 8), { atoms: '10050', decimals: 2 })).toBe(50);
  });
});

describe('rescaleExact', () => {
  it('scales up freely and down only when nothing is lost', () => {
    expect(rescaleExact({ atoms: '68755', decimals: 0 }, 8)).toEqual({
      atoms: '6875500000000',
      decimals: 8,
    });
    expect(rescaleExact({ atoms: '6875500000000', decimals: 8 }, 0)).toEqual({
      atoms: '68755',
      decimals: 0,
    });
    expect(rescaleExact({ atoms: '6875500000001', decimals: 8 }, 0)).toBeNull();
    expect(rescaleExact({ atoms: '1', decimals: 2 }, -1)).toBeNull();
  });
});

describe('alignWindow', () => {
  const t = { windowSeconds: 3_600, bucketSeconds: 300 };

  it('starts on the next bucket boundary, strictly after now', () => {
    expect(alignWindow(1_000_050, t)).toEqual({ windowStart: 1_000_200, windowEnd: 1_003_800 });
  });

  it('starts a whole bucket later when now is exactly on a boundary', () => {
    expect(alignWindow(1_000_200, t)).toEqual({ windowStart: 1_000_500, windowEnd: 1_004_100 });
  });

  it('ends on a bucket boundary for every template', () => {
    for (const tpl of MARKET_TEMPLATES) {
      const { windowStart, windowEnd } = alignWindow(1_790_000_123, tpl);
      expect(windowStart % tpl.bucketSeconds).toBe(0);
      expect(windowEnd % tpl.bucketSeconds).toBe(0);
      expect(windowEnd - windowStart).toBe(tpl.windowSeconds);
    }
  });
});

describe('isReferenceFresh', () => {
  const now = 1_000_000;
  it('accepts a print exactly at the age limit and refuses one second past it', () => {
    expect(isReferenceFresh(now - MAX_REFERENCE_AGE_SECONDS, now)).toBe(true);
    expect(isReferenceFresh(now - MAX_REFERENCE_AGE_SECONDS - 1, now)).toBe(false);
  });
  it('tolerates a little clock skew and no more', () => {
    expect(isReferenceFresh(now + 60, now)).toBe(true);
    expect(isReferenceFresh(now + 61, now)).toBe(false);
  });
});

describe('buildMarket', () => {
  const tpl = templateById('4H')!;
  const reference = {
    price: parseDecimal('68412.34', 8),
    publishTime: 1_000_000 - 60,
    feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  };

  it('records every parameter that shaped the market', () => {
    const r = buildMarket({ asset: 'BTC/USD', direction: 'above', template: tpl, reference, nowSeconds: 1_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.market.params).toEqual({
      template: '4H',
      offsetBps: 100,
      significantDigits: 5,
      windowSeconds: 14_400,
      bucketSeconds: 900,
      referencePrice: reference.price,
      referenceAt: reference.publishTime,
      maxReferenceAgeSeconds: MAX_REFERENCE_AGE_SECONDS,
      feedId: reference.feedId,
    });
    expect(r.market.windowStart).toBe(1_000_800);
    expect(r.market.windowEnd).toBe(1_000_800 + 14_400);
    expect(distanceBps(reference.price, r.market.thresholdPrice)).toBeGreaterThanOrEqual(100);
  });

  it('refuses AVAX, which has no sponsored feed', () => {
    const r = buildMarket({ asset: 'AVAX/USD', direction: 'above', template: tpl, reference, nowSeconds: 1_000_000 });
    expect(r).toEqual({ ok: false, reason: 'unsupported_asset' });
  });

  it('refuses a stale reference rather than building from it', () => {
    const r = buildMarket({
      asset: 'BTC/USD',
      direction: 'below',
      template: tpl,
      reference: { ...reference, publishTime: 1_000_000 - MAX_REFERENCE_AGE_SECONDS - 1 },
      nowSeconds: 1_000_000,
    });
    expect(r).toEqual({ ok: false, reason: 'stale_reference' });
  });

  it('refuses an unusable reference price', () => {
    const r = buildMarket({
      asset: 'BTC/USD',
      direction: 'above',
      template: tpl,
      reference: { ...reference, price: { atoms: '0', decimals: 8 } },
      nowSeconds: 1_000_000,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_reference' });
  });

  it('puts an `above` threshold above the reference and a `below` one below it', () => {
    for (const tp of MARKET_TEMPLATES) {
      const up = buildMarket({ asset: 'ETH/USD', direction: 'above', template: tp, reference, nowSeconds: 1_000_000 });
      const dn = buildMarket({ asset: 'ETH/USD', direction: 'below', template: tp, reference, nowSeconds: 1_000_000 });
      if (!up.ok || !dn.ok) throw new Error('expected both to build');
      expect(distanceBps(reference.price, up.market.thresholdPrice)).toBeGreaterThan(0);
      expect(distanceBps(reference.price, dn.market.thresholdPrice)).toBeLessThan(0);
    }
  });
});

describe('marketPhase', () => {
  const base = { status: 'open' as const, windowStart: 1_000, windowEnd: 2_000 };

  it('walks upcoming, open, expired', () => {
    expect(marketPhase(base, 999)).toBe('upcoming');
    expect(marketPhase(base, 1_000)).toBe('open');
    expect(marketPhase(base, 1_999)).toBe('open');
    expect(marketPhase(base, 2_000)).toBe('expired');
    expect(marketPhase(base, 9_999)).toBe('expired');
  });

  it('closes to new sides at windowEnd exactly, as the contract does', () => {
    expect(canTakeSide(marketPhase(base, 1_999))).toBe(true);
    expect(canTakeSide(marketPhase(base, 2_000))).toBe(false);
  });

  it('reports a crossed market as closed while it is still running', () => {
    const crossed = { ...base, crossed: { price: p('1.00'), at: 1_200 } };
    expect(marketPhase(crossed, 1_500)).toBe('crossed');
    expect(canTakeSide('crossed')).toBe(false);
    expect(marketPhase(crossed, 2_000)).toBe('expired');
  });

  it('lets a recorded result win over the clock', () => {
    expect(marketPhase({ ...base, status: 'settled' }, 500)).toBe('settled');
    expect(marketPhase({ ...base, status: 'unresolvable' }, 500)).toBe('unresolvable');
    expect(canTakeSide('settled')).toBe(false);
    expect(canTakeSide('expired')).toBe(false);
    expect(canTakeSide('unresolvable')).toBe(false);
  });
});

describe('sides', () => {
  it('maps UP and DOWN onto the contract\'s YES and NO', () => {
    expect(sideTakesYes('above', 'above')).toBe(true); // UP on "reaches above"
    expect(sideTakesYes('above', 'below')).toBe(false);
    expect(sideTakesYes('below', 'below')).toBe(true); // DOWN on "reaches below"
    expect(sideTakesYes('below', 'above')).toBe(false);
  });

  it('decides won and lost from the side and the hit', () => {
    expect(positionResult('above', 'above', true)).toBe('won');
    expect(positionResult('above', 'below', true)).toBe('lost');
    expect(positionResult('above', 'above', false)).toBe('lost');
    expect(positionResult('above', 'below', false)).toBe('won');
    expect(positionResult('below', 'below', true)).toBe('won');
    expect(positionResult('below', 'above', false)).toBe('won');
  });

  it('refunds both sides of an unresolvable market', () => {
    expect(resultForSide('above', 'above', { kind: 'unresolvable' })).toBe('refunded');
    expect(resultForSide('above', 'below', { kind: 'unresolvable' })).toBe('refunded');
    expect(resultForSide('above', 'above', { kind: 'settled', hit: true })).toBe('won');
  });
});

describe('resolveMarket', () => {
  // Window [900, 2700] at 900s buckets: buckets at 900, 1800, 2700 are in it.
  // The 2700 bucket is complete only once a sample exists at 3600 or later.

  it('is open while the window runs and nothing has touched the threshold', () => {
    const s = makeSeries('BTC/USD', [flat('100.00', 0), flat('100.50', 900)]);
    expect(resolveMarket(s, terms(), 1_500)).toEqual({ kind: 'open' });
  });

  it('reports a hit early as crossed, without settling it', () => {
    const s = makeSeries('BTC/USD', [
      flat('100.00', 0),
      makeCandle('100.00', '101.20', '100.00', '101.00', 900),
    ]);
    const r = resolveMarket(s, terms(), 1_500);
    expect(r.kind).toBe('crossed');
    if (r.kind === 'crossed') {
      expect(formatDecimal(r.decidingPrice)).toBe('101.20');
      expect(r.decidingAt).toBe(900);
    }
  });

  it('counts touching the threshold exactly as a hit (above)', () => {
    const s = makeSeries('BTC/USD', [
      makeCandle('100.00', '101.00', '99.90', '100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]);
    const r = resolveMarket(s, terms(), 4_000);
    expect(r.kind).toBe('settled');
    if (r.kind === 'settled') {
      expect(r.hit).toBe(true);
      expect(formatDecimal(r.decidingPrice!)).toBe('101.00');
    }
  });

  it('one tick short of the threshold is a miss (above)', () => {
    const s = makeSeries('BTC/USD', [
      makeCandle('100.00', '100.99', '99.90', '100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]);
    const r = resolveMarket(s, terms(), 4_000);
    expect(r.kind).toBe('settled');
    if (r.kind === 'settled') {
      expect(r.hit).toBe(false);
      expect(r.decidingPrice).toBeUndefined();
      // The closest approach is evidence, not the decision.
      expect(formatDecimal(r.windowExtreme.price)).toBe('100.99');
      expect(r.windowExtreme.at).toBe(900);
    }
  });

  it('counts touching the threshold exactly as a hit (below)', () => {
    const s = makeSeries('BTC/USD', [
      makeCandle('100.00', '100.10', '99.00', '100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]);
    const r = resolveMarket(s, terms({ direction: 'below', thresholdPrice: p('99.00') }), 4_000);
    expect(r.kind === 'settled' && r.hit).toBe(true);
  });

  it('a candle before the window cannot hit it', () => {
    const s = makeSeries('BTC/USD', [
      makeCandle('100.00', '150.00', '100.00', '100.00', 0),
      flat('100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]);
    const r = resolveMarket(s, terms(), 4_000);
    expect(r.kind === 'settled' && r.hit).toBe(false);
  });

  it('the bucket opening at windowEnd is part of the window', () => {
    const s = makeSeries('BTC/USD', [
      flat('100.00', 900),
      flat('100.00', 1800),
      makeCandle('100.00', '101.50', '100.00', '101.00', 2700),
      flat('100.00', 3600),
    ]);
    const r = resolveMarket(s, terms(), 4_000);
    expect(r.kind === 'settled' && r.hit).toBe(true);
  });

  it('the bucket after the last one in the window cannot hit it', () => {
    const s = makeSeries('BTC/USD', [
      flat('100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      makeCandle('100.00', '150.00', '100.00', '100.00', 3600),
    ]);
    const r = resolveMarket(s, terms(), 4_000);
    expect(r.kind === 'settled' && r.hit).toBe(false);
  });

  describe('expiry boundary', () => {
    const missSeries = makeSeries('BTC/USD', [
      flat('100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]);

    it('is not final at windowEnd itself, even with a complete series', () => {
      expect(resolveMarket(missSeries, terms(), 2_700).kind).toBe('open');
    });

    it('is final one second after windowEnd once the series has moved past the window', () => {
      expect(resolveMarket(missSeries, terms(), 2_701).kind).toBe('settled');
    });

    it('waits when the series has not yet moved past the last bucket', () => {
      const short = makeSeries('BTC/USD', [flat('100.00', 900), flat('100.00', 1800), flat('100.00', 2700)]);
      expect(resolveMarket(short, terms(), 9_999)).toEqual({ kind: 'awaiting' });
    });

    it('waits on a series that stops inside the window', () => {
      const short = makeSeries('BTC/USD', [flat('100.00', 900), flat('100.00', 1800)]);
      expect(resolveMarket(short, terms(), 9_999)).toEqual({ kind: 'awaiting' });
    });

    it('waits, and does not settle a hit early, while the last bucket is still forming', () => {
      const s = makeSeries('BTC/USD', [
        flat('100.00', 900),
        makeCandle('100.00', '101.50', '100.00', '101.00', 2700),
      ]);
      expect(resolveMarket(s, terms(), 2_701)).toEqual({ kind: 'awaiting' });
    });
  });

  describe('recorded samples only', () => {
    it('is unresolvable when the window holds no recorded sample', () => {
      const s = makeSeries('BTC/USD', [flat('100.00', 0), flat('100.00', 3600)]);
      expect(resolveMarket(s, terms(), 4_000)).toEqual({ kind: 'unresolvable' });
    });

    it('does not let a carried-forward candle hit a threshold', () => {
      const synthetic: Candle = { ...flat('105.00', 1800), synthetic: true };
      const s = makeSeries('BTC/USD', [
        flat('105.00', 0),
        { ...flat('105.00', 900), synthetic: true },
        synthetic,
        { ...flat('105.00', 2700), synthetic: true },
        flat('105.00', 3600),
      ]);
      // Nobody printed inside the window. 105 was the prior close, not a print in it.
      expect(resolveMarket(s, terms(), 4_000)).toEqual({ kind: 'unresolvable' });
    });

    it('still settles from the real candles when a carried-forward one sits beside them', () => {
      const s = makeSeries('BTC/USD', [
        flat('100.00', 900),
        { ...flat('100.00', 1800), synthetic: true },
        flat('100.00', 2700),
        flat('100.00', 3600),
      ]);
      const r = resolveMarket(s, terms(), 4_000);
      expect(r.kind).toBe('settled');
      if (r.kind === 'settled') expect(r.recordedCandles).toBe(2);
    });
  });

  it('gives the same answer whenever the settler runs', () => {
    const s = makeSeries('BTC/USD', [
      makeCandle('100.00', '101.20', '99.00', '100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
      flat('100.00', 7200),
    ]);
    expect(resolveMarket(s, terms(), 4_000)).toEqual(resolveMarket(s, terms(), 900_000));
  });

  it('an empty series is open before the end and awaiting after', () => {
    const s = makeSeries('BTC/USD', []);
    expect(resolveMarket(s, terms(), 1_000)).toEqual({ kind: 'open' });
    expect(resolveMarket(s, terms(), 5_000)).toEqual({ kind: 'awaiting' });
  });
});

describe('evidence', () => {
  const settled = resolveMarket(
    makeSeries('BTC/USD', [
      makeCandle('100.00', '101.20', '99.00', '100.00', 900),
      flat('100.00', 1800),
      flat('100.00', 2700),
      flat('100.00', 3600),
    ]),
    terms(),
    4_000,
  );
  if (settled.kind !== 'settled') throw new Error('fixture must settle');

  it('has a fixed, readable preimage', () => {
    const pre = evidencePreimage(evidenceFor(terms(), settled));
    expect(pre.split('\n')).toEqual([
      'kanon.threshold-market.settlement.v1',
      'asset=BTC/USD',
      'direction=above',
      'threshold=10100@2',
      'windowStart=900',
      'windowEnd=2700',
      'bucketSeconds=900',
      'outcome=hit',
      'decidingPrice=10120@2',
      'decidingAt=900',
      'extremePrice=10120@2',
      'extremeAt=900',
      'recordedCandles=3',
    ]);
  });

  it('hashes to 32 bytes, deterministically, and changes when the deciding price does', async () => {
    const a = await hashSettlementEvidence(evidenceFor(terms(), settled));
    const b = await hashSettlementEvidence(evidenceFor(terms(), settled));
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).toBe(b);
    const moved = await hashSettlementEvidence({
      ...evidenceFor(terms(), settled),
      decidingPrice: p('101.21'),
    });
    expect(moved).not.toBe(a);
  });

  it('commits an unresolvable market to having no deciding price', () => {
    const pre = evidencePreimage(evidenceFor(terms(), { kind: 'unresolvable' }));
    expect(pre).toContain('outcome=unresolvable');
    expect(pre).toContain('decidingPrice=-');
  });

  it('hashes the terms of a market as created', async () => {
    const r = buildMarket({
      asset: 'BTC/USD',
      direction: 'above',
      template: templateById('1H')!,
      reference: {
        price: parseDecimal('68412.34', 8),
        publishTime: 999_940,
        feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
      },
      nowSeconds: 1_000_000,
    });
    if (!r.ok) throw new Error('expected a market');
    const h = await hashMarketTerms(r.market);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    const other = await hashMarketTerms({ ...r.market, thresholdPrice: { atoms: '68756', decimals: 0 } });
    expect(other).not.toBe(h);
  });
});
