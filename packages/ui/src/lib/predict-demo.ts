/**
 * The signed-out Predict feed: enough cards to look like a running product.
 *
 * Every card is flagged `demo`: nothing on one can be staked, its badge says
 * so, and its evidence sheet says so. Prices are the last close of the same demo
 * tape the Chart tab draws, so a card's line and its level agree, and each level
 * is derived with `deriveThreshold` from the spec, not typed in. Only assets with
 * a Pyth feed appear: AVAX never does, not even as a fixture.
 */

import { MARKET_TEMPLATES, deriveThreshold, isMarketAsset, type Decimal, type MarketDirection } from '@kanon/spec';
import { buildFixtureSeries } from './chart-fixtures';
import type { PredictMarket, PredictSettlement } from './predict-types';

interface DemoSpec {
  asset: string;
  timeframe: '1H' | '4H' | '1D';
  direction: MarketDirection;
  /** Seconds of the window already gone. Ignored once there is a result. */
  elapsed: number;
  /** The recorded series has already touched the level. */
  crossed?: boolean;
  /** A result, as it would read once settled. */
  result?: 'hit' | 'miss';
  /** Seconds since the window ended. Only with `result`. */
  endedAgo?: number;
}

const SPECS: readonly DemoSpec[] = [
  { asset: 'BTC/USD', timeframe: '1H', direction: 'above', elapsed: 780 },
  { asset: 'ETH/USD', timeframe: '4H', direction: 'below', elapsed: 4_200 },
  { asset: 'SOL/USD', timeframe: '1H', direction: 'above', elapsed: 1_320, crossed: true },
  { asset: 'MON/USD', timeframe: '1H', direction: 'above', elapsed: 240 },
  { asset: 'BTC/USD', timeframe: '1D', direction: 'below', elapsed: 21_600 },
  { asset: 'ETH/USD', timeframe: '1H', direction: 'above', elapsed: 3_600, result: 'hit', endedAgo: 2_400 },
  { asset: 'SOL/USD', timeframe: '4H', direction: 'below', elapsed: 14_400, result: 'miss', endedAgo: 9_000 },
];

/** A stand-in 32-byte hash. A demo card has no evidence; the sheet says so. */
const demoHash = (seed: number): string => `0x${((seed * 0x1f3d5b79 + 0x2545f491) % 0x100000000).toString(16).padStart(8, '0').repeat(8)}`;

/** `atoms` scaled by `num/den`, in BigInt. */
function scale(d: Decimal, num: bigint, den: bigint): Decimal {
  return { atoms: ((BigInt(d.atoms) * num) / den).toString(), decimals: d.decimals };
}

export function reelDemoMarkets(nowSeconds: number): PredictMarket[] {
  const out: PredictMarket[] = [];
  SPECS.forEach((spec, i) => {
    if (!isMarketAsset(spec.asset)) return;
    const candles = buildFixtureSeries(spec.asset, 900).candles;
    const last = candles[candles.length - 1];
    const template = MARKET_TEMPLATES.find((t) => t.id === spec.timeframe);
    if (!last || !template) return;

    const price = last.close;
    const target = deriveThreshold(price, spec.direction, template.offsetBps);
    const windowEnd = spec.result ? nowSeconds - (spec.endedAgo ?? 0) : nowSeconds - spec.elapsed + template.windowSeconds;
    const windowStart = windowEnd - template.windowSeconds;
    const id = `demo-reel-${i + 1}`;

    let settlement: PredictSettlement | null = null;
    if (spec.result) {
      const hit = spec.result === 'hit';
      // A miss stopped a fifth of a percent short of the level: close, and still a miss.
      const short = scale(target, spec.direction === 'above' ? 998n : 1_002n, 1_000n);
      settlement = {
        outcome: spec.result,
        decidingPrice: hit ? target : null,
        decidingAt: hit ? windowStart + template.windowSeconds / 2 : null,
        windowExtreme: { price: hit ? target : short, at: windowStart + template.windowSeconds / 2 },
        evidenceHash: demoHash(i + 1),
        recordedCandles: template.windowSeconds / template.bucketSeconds,
        settledAt: nowSeconds - (spec.endedAgo ?? 0) + 900,
      };
    }

    out.push({
      id,
      asset: spec.asset,
      assetClass: 'CRYPTO',
      timeframe: spec.timeframe,
      direction: spec.direction,
      target,
      price,
      priceAt: nowSeconds,
      windowStart,
      windowEnd,
      status: spec.result ? 'settled' : 'open',
      crossed: spec.crossed ? { price: target, at: nowSeconds - 300 } : null,
      terms: null,
      termsHash: demoHash(i + 1),
      settlement,
      positions: [],
      chain: null,
      demo: true,
    });
  });
  return out;
}
