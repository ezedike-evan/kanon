import { describe, expect, it } from 'vitest';
import { assetTitle, baseOf, compactSymbol, normalizeSymbol, parseAssetParam, predicateCode } from './chart-assets';

describe('asset naming', () => {
  it('treats spelling variants as one symbol', () => {
    expect(normalizeSymbol('btc / usd')).toBe('BTC/USD');
    expect(compactSymbol('BTC / USD')).toBe('BTCUSD');
    expect(baseOf('eth/usd')).toBe('ETH');
  });

  it('titles a known asset in full and an unknown one by its ticker', () => {
    expect(assetTitle('BTC/USD')).toBe('Bitcoin / U.S. Dollar');
    expect(assetTitle('XYZ/USD')).toBe('XYZ / U.S. Dollar');
  });

  it('shortens predicate sentences to their codes', () => {
    expect(predicateCode('Bullish break of structure confirmed')).toBe('BOS');
    expect(predicateCode('Fair value gap present')).toBe('FVG');
    expect(predicateCode('Liquidity sweep confirmed')).toBe('SWEEP');
  });
});

describe('?asset= route parameter', () => {
  it('accepts the spellings a link is likely to use', () => {
    for (const raw of ['ETH/USD', 'eth/usd', 'ETH-USD', 'ETH_USD', 'ETHUSD', 'ETH%2FUSD', ' eth usd ']) {
      expect(parseAssetParam(raw)).toBe('ETH/USD');
    }
  });

  it('only ever returns an asset the spec lists', () => {
    expect(parseAssetParam('DOGE/USD')).toBeUndefined();
    expect(parseAssetParam('BTC/EUR')).toBeUndefined();
    expect(parseAssetParam('')).toBeUndefined();
    expect(parseAssetParam(null)).toBeUndefined();
    expect(parseAssetParam(undefined)).toBeUndefined();
  });

  it('a malformed escape is ignored, not thrown', () => {
    expect(() => parseAssetParam('%E0%A4%A')).not.toThrow();
  });
});
