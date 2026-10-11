import { describe, expect, it } from 'vitest';
import {
  TIMED_LIMITS,
  checkTimedRequest,
  directionOf,
  durationLabel,
  lossReachesStake,
  moveAtoms,
  sideOf,
  timedLeverage,
  type TimedRequest,
} from './timed-policy';
import type { MarketFacts } from './venue-policy';

const BTC: MarketFacts = { symbol: 'BTC', maxLeverage: 1500, open: true };
const ask = (over: Partial<TimedRequest> = {}): TimedRequest => ({ asset: 'BTC/USD', direction: 'up', stakeUsd: 25, seconds: 60, ...over });

describe('a timed trade as a position', () => {
  it('is a long when it calls up and a short when it calls down', () => {
    expect(sideOf('up')).toBe('long');
    expect(sideOf('down')).toBe('short');
    expect(directionOf('long')).toBe('up');
    expect(directionOf('short')).toBe('down');
  });

  it('uses the lower of our leverage and the market\'s, never less than 1x', () => {
    expect(timedLeverage(BTC)).toBe(5);
    expect(timedLeverage({ symbol: 'MON', maxLeverage: 300, open: true })).toBe(3);
    expect(timedLeverage({ symbol: 'X', maxLeverage: 50, open: true })).toBe(1);
    expect(timedLeverage(BTC, { ...TIMED_LIMITS, maxLeverage: 2 })).toBe(2);
  });

  it('words a duration the way the screen does', () => {
    expect([60, 300, 900, 3600, 45].map(durationLabel)).toEqual(['1m', '5m', '15m', '1h', '45s']);
  });
});

describe('checkTimedRequest', () => {
  it('passes every stake and duration on offer, both ways', () => {
    for (const stakeUsd of TIMED_LIMITS.stakesUsd) {
      for (const seconds of TIMED_LIMITS.durations) {
        expect(checkTimedRequest(ask({ stakeUsd, seconds }), BTC)).toEqual({ ok: true });
        expect(checkTimedRequest(ask({ stakeUsd, seconds, direction: 'down' }), BTC)).toEqual({ ok: true });
      }
    }
  });

  it('turns away an unlisted pair and a closed market', () => {
    expect(checkTimedRequest(ask({ asset: 'DOGE/USD' }), null)).toEqual({ ok: false, reason: 'Perpl lists no market for DOGE/USD.' });
    expect(checkTimedRequest(ask(), { ...BTC, open: false })).toEqual({ ok: false, reason: 'The BTC market is closed.' });
  });

  it('holds the stake and the time to what is on offer, and says what that is', () => {
    for (const stakeUsd of [0, 5, 30, 12.5, 1000, Number.NaN]) {
      expect(checkTimedRequest(ask({ stakeUsd }), BTC), String(stakeUsd)).toEqual({
        ok: false,
        reason: 'A stake here is one of $10, $25, $50, $100.',
      });
    }
    for (const seconds of [0, 30, 61, 7200, -60]) {
      expect(checkTimedRequest(ask({ seconds }), BTC), String(seconds)).toEqual({
        ok: false,
        reason: 'A trade here runs for one of 1m, 5m, 15m, 1h.',
      });
    }
    expect(checkTimedRequest(ask({ direction: 'sideways' as 'up' }), BTC)).toEqual({ ok: false, reason: 'A trade goes up or down.' });
  });
});

describe('the arithmetic of a result', () => {
  // 0.00030 BTC entered at 82,847.1: the position testnet opened on 2026-10-10.
  const trade = { size: 30, sizeDecimals: 5, priceDecimals: 1 };

  it('is the price change times the size, in collateral atoms', () => {
    // Up $30.0 on 0.0003 BTC is $0.009.
    expect(moveAtoms({ ...trade, direction: 'up', fromPrice: 828471, toPrice: 828771 })).toBe(9_000n);
    expect(moveAtoms({ ...trade, direction: 'up', fromPrice: 828471, toPrice: 828171 })).toBe(-9_000n);
    expect(moveAtoms({ ...trade, direction: 'up', fromPrice: 828471, toPrice: 828471 })).toBe(0n);
  });

  it('is reversed for a trade that called down', () => {
    expect(moveAtoms({ ...trade, direction: 'down', fromPrice: 828471, toPrice: 828171 })).toBe(9_000n);
    expect(moveAtoms({ ...trade, direction: 'down', fromPrice: 828471, toPrice: 828771 })).toBe(-9_000n);
  });

  it('stays exact on sizes and prices far past what a float holds', () => {
    expect(moveAtoms({ direction: 'up', size: 9_007_199_254_740_991, sizeDecimals: 8, fromPrice: 1, toPrice: 9_007_199_254_740_991, priceDecimals: 8 })).toBe(
      ((9_007_199_254_740_991n - 1n) * 9_007_199_254_740_991n * 1_000_000n) / 10n ** 16n,
    );
  });

  it('cuts a trade when its loss at the mark price reaches its stake, and not a cent before', () => {
    // $100 of BTC at 5x on a $20... here: 0.01 BTC (size 1000 at 5 decimals) entered at 80,000.0; stake $10.
    const base = { direction: 'up' as const, size: 1000, sizeDecimals: 5, priceDecimals: 1, entryPrice: 800_000, stakeUsd: 10 };
    // A $1,000 fall on 0.01 BTC is exactly $10.
    expect(lossReachesStake({ ...base, markPrice: 790_000 })).toBe(true);
    expect(lossReachesStake({ ...base, markPrice: 790_001 })).toBe(false);
    expect(lossReachesStake({ ...base, markPrice: 810_000 })).toBe(false);
    // The same trade the other way loses on a rise.
    expect(lossReachesStake({ ...base, direction: 'down', markPrice: 810_000 })).toBe(true);
    expect(lossReachesStake({ ...base, direction: 'down', markPrice: 790_000 })).toBe(false);
  });
});
