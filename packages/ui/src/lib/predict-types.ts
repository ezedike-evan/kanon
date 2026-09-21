/**
 * What the Predict screen renders, and what it can ask for.
 *
 * Kept apart from `data.tsx` so the pure mapping (`predict-map.ts`), the
 * take-a-side flow (`predict-flow.ts`) and their tests can import these
 * without dragging in React or the demo fixtures.
 */

import type {
  AssetClass as SpecAssetClass,
  Decimal,
  MarketDirection,
  MarketSide,
  MarketStatus,
  PositionResult,
} from '@kanon/spec';
import type { ChainMarketRef, MarketAvailability, MarketFailure } from './market-client';

export type PredictFeedState =
  /** Auth or the market read is still resolving. */
  | 'loading'
  /** Signed in, and no market is open or recently resolved. Not an error. */
  | 'empty'
  | 'ready'
  /** Signed out: fixtures, and nothing can be staked. */
  | 'demo';

export interface PredictSettlement {
  outcome: 'hit' | 'miss' | 'unresolvable';
  /** `settleThreshold`'s deciding price. Only on a hit. */
  decidingPrice: Decimal | null;
  /** Start of the candle that decided it, unix seconds. */
  decidingAt: number | null;
  /** The window's own high or low: how close a miss came. Evidence, not the decision. */
  windowExtreme: { price: Decimal; at: number } | null;
  /** The full sha-256, `0x…`. */
  evidenceHash: string;
  recordedCandles: number;
  /** Unix seconds. */
  settledAt: number | null;
}

export interface PredictPosition {
  side: MarketSide;
  stake: Decimal | null;
  /** Null until the market settles. */
  result: PositionResult | null;
  txHash: string | null;
}

/** Every number that shaped a market. Absent on a demo card, which is not one. */
export interface PredictTerms {
  offsetBps: number;
  /** The signed distance of the threshold from the reference, in whole bps. */
  distanceBps: number;
  significantDigits: number;
  referencePrice: Decimal;
  /** Unix seconds. */
  referenceAt: number;
  windowSeconds: number;
  bucketSeconds: number;
  feedId: string;
}

export interface PredictMarket {
  id: string;
  asset: string;
  assetClass: Uppercase<SpecAssetClass>;
  /** The window length, `1H`, `4H`, `1D`. */
  timeframe: string;
  /** The question: does the price reach a level above or below where it was. */
  direction: MarketDirection;
  target: Decimal;
  /** The newest recorded price, and when it printed (unix seconds). Null when nothing has printed. */
  price: Decimal | null;
  priceAt: number | null;
  /** Unix seconds. */
  windowStart: number;
  windowEnd: number;
  status: MarketStatus;
  /** Set while the window runs once the recorded series has already touched the threshold. */
  crossed: { price: Decimal; at: number } | null;
  terms: PredictTerms | null;
  /** The full sha-256 of the terms as created. */
  termsHash: string | null;
  settlement: PredictSettlement | null;
  /** The signed-in user's stakes on this market. */
  positions: PredictPosition[];
  /** The on-chain market this row is linked to, once someone opened it there. */
  chain: ChainMarketRef | null;
  /** A fixture, not a market. Nothing about it can be staked. */
  demo: boolean;
}

export type TakeSideFailure = MarketFailure | 'closed' | 'no_user' | 'invalid_stake';

export type TakeSideOutcome =
  /** `recorded` is false when the chain accepted the stake but the app could not save it: the chain is the record. */
  | { ok: true; txHash: string; recorded: boolean }
  | { ok: false; reason: TakeSideFailure; message: string };

export interface PredictFeed {
  state: PredictFeedState;
  markets: PredictMarket[];
  /** Whether this device can take a side right now, stated rather than assumed. */
  availability: MarketAvailability;
  /** The native unit a stake is in, e.g. `MON`. */
  nativeSymbol: string;
  /** Takes UP (`above`) or DOWN (`below`) on a market. Reports a stake only once the chain has accepted it. */
  takeSide(marketId: string, side: MarketSide, stake: Decimal): Promise<TakeSideOutcome>;
  /**
   * Asks the contract whether the recorded series has already touched a
   * market's threshold, which closes it to new sides. `null` when it cannot be
   * asked: the market is not on-chain yet, nothing is deployed, or it is a demo.
   */
  checkCrossed(marketId: string): Promise<boolean | null>;
}

/**
 * The stakes offered. Fixed and shown, so the amount is never a default the
 * reader did not choose. In the chain's native unit at 18 decimals.
 */
export const STAKE_PRESETS: readonly Decimal[] = [
  { atoms: '10000000000000000', decimals: 18 }, // 0.01
  { atoms: '50000000000000000', decimals: 18 }, // 0.05
  { atoms: '100000000000000000', decimals: 18 }, // 0.1
];
