import { describe, expect, it } from 'vitest';
import { ASSETS, ASSET_CLASSES, assetClassOf, isAssetClass } from './assets';

describe('assets', () => {
  it('only lists crypto while FX and equities are out of scope', () => {
    expect([...ASSET_CLASSES]).toEqual(['crypto']);
    expect(isAssetClass('fx')).toBe(false);
    expect(isAssetClass('equity')).toBe(false);
  });

  it('resolves a listed asset to its class and an unlisted one to undefined', () => {
    expect(assetClassOf('BTC/USD')).toBe('crypto');
    expect(assetClassOf('EUR/USD')).toBeUndefined();
  });

  it('gives every listed asset a class that is enabled', () => {
    for (const a of ASSETS) expect(isAssetClass(a.assetClass)).toBe(true);
  });

  it('lists each symbol once', () => {
    const symbols = ASSETS.map((a) => a.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});
