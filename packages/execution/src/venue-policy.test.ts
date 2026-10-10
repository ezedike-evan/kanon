import { describe, expect, it } from 'vitest';
import {
  VENUE_LIMITS,
  checkMargin,
  checkOrderRequest,
  formatCollateral,
  leverageCeiling,
  marginAtoms,
  scaled,
  type MarketFacts,
  type OrderRequest,
} from './venue-policy';

const BTC: MarketFacts = { symbol: 'BTC', maxLeverage: 1500, open: true };
const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({ asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2, ...over });

describe('checkOrderRequest', () => {
  it('passes an order inside every bound, at both ends', () => {
    expect(checkOrderRequest(order(), BTC)).toEqual({ ok: true });
    expect(checkOrderRequest(order({ usd: VENUE_LIMITS.minNotionalUsd, leverage: 1 }), BTC)).toEqual({ ok: true });
    expect(checkOrderRequest(order({ usd: VENUE_LIMITS.maxNotionalUsd, leverage: VENUE_LIMITS.maxLeverage, side: 'short' }), BTC)).toEqual({ ok: true });
  });

  it('turns away an asset the venue does not list, and a closed market', () => {
    expect(checkOrderRequest(order({ asset: 'DOGE/USD' }), null)).toEqual({ ok: false, reason: 'Perpl lists no market for DOGE/USD.' });
    expect(checkOrderRequest(order(), { ...BTC, open: false })).toEqual({ ok: false, reason: 'The BTC market is closed.' });
  });

  it('holds the notional to whole dollars inside the stated range', () => {
    for (const usd of [9, 101, 0, -25, 25.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkOrderRequest(order({ usd }), BTC), String(usd)).toEqual({
        ok: false,
        reason: 'An order here is $10 to $100, in whole dollars.',
      });
    }
  });

  it("holds leverage to whole steps, capped by the lower of ours and the market's", () => {
    for (const leverage of [0, 6, 1.5, -2, Number.NaN]) {
      expect(checkOrderRequest(order({ leverage }), BTC), String(leverage)).toEqual({
        ok: false,
        reason: 'Leverage on BTC here is 1x to 5x, in whole steps.',
      });
    }
    const tight: MarketFacts = { symbol: 'MON', maxLeverage: 300, open: true };
    expect(leverageCeiling(tight)).toBe(3);
    expect(checkOrderRequest(order({ leverage: 3 }), tight)).toEqual({ ok: true });
    expect(checkOrderRequest(order({ leverage: 4 }), tight)).toEqual({ ok: false, reason: 'Leverage on MON here is 1x to 3x, in whole steps.' });
    // A market that reports less than 1x still allows unlevered orders rather than none.
    expect(leverageCeiling({ symbol: 'X', maxLeverage: 50, open: true })).toBe(1);
  });

  it('uses the limits it is given, not only the defaults', () => {
    const limits = { minNotionalUsd: 1, maxNotionalUsd: 5, maxLeverage: 2, slippageBps: 10 };
    expect(checkOrderRequest(order({ usd: 5, leverage: 2 }), BTC, limits)).toEqual({ ok: true });
    expect(checkOrderRequest(order({ usd: 6, leverage: 2 }), BTC, limits)).toEqual({ ok: false, reason: 'An order here is $1 to $5, in whole dollars.' });
  });
});

describe('margin', () => {
  it('is notional over leverage in collateral atoms, rounded up', () => {
    expect(marginAtoms(25, 2)).toBe(12_500_000n);
    expect(marginAtoms(100, 1)).toBe(100_000_000n);
    expect(marginAtoms(10, 3)).toBe(3_333_334n);
  });

  it('passes when the free balance covers it, counting what is locked', () => {
    expect(checkMargin('12500000', '0', 25, 2)).toEqual({ ok: true });
    expect(checkMargin('100000000', undefined, 25, 2)).toEqual({ ok: true });
    expect(checkMargin('20000000', '7500000', 25, 2)).toEqual({ ok: true });
  });

  it('says what is free and what is needed when it does not', () => {
    expect(checkMargin('12499999', '0', 25, 2)).toEqual({
      ok: false,
      reason: 'The trading account has 12.49 AUSD free. This order needs 12.50.',
    });
    expect(checkMargin('20000000', '15000000', 100, 5)).toEqual({
      ok: false,
      reason: 'The trading account has 5.00 AUSD free. This order needs 20.00.',
    });
  });

  it('does not guess at a balance it cannot read', () => {
    expect(checkMargin('12.5', '0', 25, 2)).toEqual({ ok: false, reason: "The trading account's balance could not be read." });
    expect(checkMargin('', 'abc', 25, 2).ok).toBe(false);
  });

  it('formats collateral to two places, rounded down, with its sign', () => {
    expect(formatCollateral(0n)).toBe('0.00');
    expect(formatCollateral(8_575n)).toBe('0.00');
    expect(formatCollateral(1_087_551_520n)).toBe('1087.55');
    expect(formatCollateral(-8_575_000n)).toBe('-8.57');
  });
});

describe('scaled', () => {
  it('carries a venue integer and its scale without touching the digits', () => {
    expect(scaled(828471, 1)).toEqual({ atoms: '828471', decimals: 1 });
    expect(scaled('-8575', 6)).toEqual({ atoms: '-8575', decimals: 6 });
  });
});
