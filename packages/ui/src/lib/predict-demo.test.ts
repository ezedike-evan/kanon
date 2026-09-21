import { describe, expect, it } from 'vitest';
import { deriveThreshold, isMarketAsset, marketPhase } from '@kanon/spec';
import { reelDemoMarkets } from './predict-demo';
import { pageState, reelItems } from './predict-reel';
import { DEMO_MARKET_AVAILABILITY } from './market-client';

const NOW = 1_800_000_000;

describe('the signed-out feed', () => {
  const markets = reelDemoMarkets(NOW);

  it('is rich enough to look alive: live, crossed and settled cards across assets and windows', () => {
    expect(markets.length).toBeGreaterThanOrEqual(6);
    const phases = markets.map((m) => marketPhase(m, NOW));
    expect(phases).toContain('open');
    expect(phases).toContain('crossed');
    expect(phases).toContain('settled');
    expect(new Set(markets.map((m) => m.asset)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(markets.map((m) => m.timeframe)).size).toBeGreaterThanOrEqual(3);
    expect(markets.some((m) => m.direction === 'above') && markets.some((m) => m.direction === 'below')).toBe(true);
  });

  it('only has assets with a Pyth feed, and never AVAX', () => {
    for (const m of markets) {
      expect(isMarketAsset(m.asset)).toBe(true);
      expect(m.asset).not.toMatch(/AVAX/);
    }
  });

  it('flags every card as demo, with unique ids and nothing staked', () => {
    expect(markets.every((m) => m.demo)).toBe(true);
    expect(new Set(markets.map((m) => m.id)).size).toBe(markets.length);
    expect(markets.every((m) => m.positions.length === 0 && m.chain === null)).toBe(true);
  });

  it('derives each level from its price with the spec, on the side its direction names', () => {
    for (const m of markets) {
      expect(m.price).not.toBeNull();
      const above = BigInt(m.target.atoms) * 10n ** BigInt(Math.max(0, m.price!.decimals - m.target.decimals));
      const price = BigInt(m.price!.atoms) * 10n ** BigInt(Math.max(0, m.target.decimals - m.price!.decimals));
      if (m.direction === 'above') expect(above > price).toBe(true);
      else expect(above < price).toBe(true);
    }
    const btc = markets.find((m) => m.asset === 'BTC/USD' && m.timeframe === '1H')!;
    expect(btc.target).toEqual(deriveThreshold(btc.price!, 'above', 50));
  });

  it('settles a hit on its level and a miss short of it, each with evidence', () => {
    const settled = markets.filter((m) => m.status === 'settled');
    expect(settled.map((m) => m.settlement?.outcome).sort()).toEqual(['hit', 'miss']);
    for (const m of settled) {
      expect(m.settlement?.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(m.windowEnd - m.windowStart).toBeGreaterThan(0);
      expect(m.windowEnd).toBeLessThan(NOW);
    }
    const hit = settled.find((m) => m.settlement?.outcome === 'hit')!;
    expect(hit.settlement?.decidingPrice).toEqual(hit.target);
    const miss = settled.find((m) => m.settlement?.outcome === 'miss')!;
    expect(miss.settlement?.decidingPrice).toBeNull();
  });

  it('makes live cards that read as open, with a crossed one closed by a neutral note', () => {
    const states = markets.map((m) =>
      pageState({ market: m, nowSeconds: NOW, crossedOnChain: false, availability: DEMO_MARKET_AVAILABILITY }),
    );
    expect(states.filter((s) => s.showSides).length).toBeGreaterThanOrEqual(4);
    expect(states.find((s) => s.phase === 'crossed')?.note?.kind).toBe('crossed');
    expect(reelItems(markets).at(-1)?.kind).toBe('end');
  });
});
