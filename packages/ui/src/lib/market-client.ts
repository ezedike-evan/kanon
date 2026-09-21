/**
 * The seam between the Predict tab and the `ThresholdMarket` contract.
 *
 * `MarketClient` is what the feed calls to take a side on-chain. It is
 * injected, so the screens carry no chain library and a build with no contract
 * address or no wallet swaps in `unavailableMarketClient`, which says why
 * instead of pretending. `market-viem.ts` is the real implementation.
 *
 * The rule this file exists to hold, the same as `pin.ts`: a side is reported
 * taken only when the chain accepted the transaction. Nothing here returns a
 * receipt it did not get.
 */

import { rescaleExact, type Decimal, type MarketDirection } from '@kanon/spec';
import { isAddress } from './pin';

export type MarketAvailability =
  | { state: 'ready' }
  | { state: 'not_deployed'; message: string }
  | { state: 'no_wallet'; message: string }
  | { state: 'demo'; message: string };

export type MarketFailure =
  | 'not_deployed'
  | 'no_wallet'
  | 'demo'
  /** The market is closed to new sides, or nothing exists on-chain to take a side on. */
  | 'not_open'
  /** The recorded price has already touched the threshold, so the contract takes no new side. A closed market, not a fault. */
  | 'crossed'
  /** The price series has no sample fresh enough to check a side against. Retry once a price prints. */
  | 'stale'
  /** The on-chain market does not have the terms the card shows. Nothing was staked. */
  | 'mismatch'
  | 'rejected'
  | 'failed';

export class MarketError extends Error {
  readonly code: MarketFailure;
  constructor(code: MarketFailure, message: string) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
  }
}

/** The terms a market is opened with on-chain: what the card shows, exactly. */
export interface OnChainTerms {
  asset: string;
  direction: MarketDirection;
  thresholdPrice: Decimal;
  windowStart: number;
  windowEnd: number;
  bucketSeconds: number;
}

export interface ChainMarketRef {
  chainId: number;
  address: string;
  /** The contract's own market id, as a base-10 string. */
  marketId: string;
  /** The transaction that opened it. */
  txHash: string;
}

export interface EnsuredMarket extends ChainMarketRef {
  /** True when this call opened the market, so the app should record the link. */
  opened: boolean;
}

export interface MarketClient {
  chainId: number;
  marketAddress: string | undefined;
  /** `MON` on Monad. */
  nativeSymbol: string;
  availability(): MarketAvailability;
  /**
   * The on-chain market for `terms`. When `linked` is given it is read back and
   * checked against `terms`, and refused on any difference; when it is not, the
   * market is opened. Either way, what it returns matches `terms` on the chain.
   */
  ensureMarket(terms: OnChainTerms, linked?: ChainMarketRef | undefined): Promise<EnsuredMarket>;
  /** Stakes `stake` on YES (`yes`) or NO. Resolves only once the chain has accepted it. */
  takeSide(input: { chainMarketId: string; yes: boolean; stake: Decimal }): Promise<{ txHash: string }>;
  /** The contract's own `hasCrossed`: whether the recorded series has already touched the threshold. */
  hasCrossed(chainMarketId: string): Promise<boolean>;
}

export const DEPLOYMENT_KEY = 'ThresholdMarket';

/**
 * Where the market address comes from. `env` is
 * `NEXT_PUBLIC_THRESHOLD_MARKET_ADDRESS` / `EXPO_PUBLIC_THRESHOLD_MARKET_ADDRESS`,
 * passed in by the app because a bundler only inlines those when they are
 * written out literally. `deployments` is a parsed
 * `packages/contracts/deployments/<chainid>.json`. Env wins. A value that is not
 * an address is treated as absent, never guessed at.
 */
export function resolveMarketAddress(input: {
  env?: string | undefined;
  deployments?: unknown;
}): string | undefined {
  const fromEnv = input.env?.trim();
  if (fromEnv && isAddress(fromEnv)) return fromEnv;

  const d = input.deployments;
  if (d && typeof d === 'object') {
    const rec = d as Record<string, unknown>;
    const nested =
      rec['contracts'] && typeof rec['contracts'] === 'object'
        ? (rec['contracts'] as Record<string, unknown>)
        : {};
    for (const c of [rec[DEPLOYMENT_KEY], nested[DEPLOYMENT_KEY]]) {
      const address = typeof c === 'object' && c !== null ? (c as Record<string, unknown>)['address'] : c;
      if (isAddress(address)) return address;
    }
  }
  return undefined;
}

/** What a device says when it cannot take a side, in words that are true. */
export function marketAvailability(input: {
  marketAddress: string | undefined;
  hasWallet: boolean;
}): MarketAvailability {
  if (!input.marketAddress) {
    return {
      state: 'not_deployed',
      message:
        'The ThresholdMarket contract is not deployed on this network yet, so no side can be taken here. Markets and their results still update.',
    };
  }
  if (!input.hasWallet) {
    return {
      state: 'no_wallet',
      message: 'No wallet is available to sign with. Sign in again and Kanon will create one.',
    };
  }
  return { state: 'ready' };
}

/** What the two contract states that close a side say. Neither is an error: the market is doing its job. */
export const CROSSED_MESSAGE = 'Closed: threshold already crossed';
export const STALE_MESSAGE = 'Waiting for a fresh price';

export const DEMO_MARKET_AVAILABILITY = {
  state: 'demo',
  message: 'Demo data. Sign in to take a side.',
} as const satisfies MarketAvailability;

/** A client that can stake nothing, and says why. Used with no contract address, no wallet, or in demo. */
export function unavailableMarketClient(input: {
  marketAddress: string | undefined;
  hasWallet: boolean;
  chainId?: number;
  nativeSymbol?: string;
}): MarketClient {
  const availability = () => marketAvailability(input);
  const fail = (): never => {
    const a = availability();
    throw new MarketError(
      a.state === 'no_wallet' ? 'no_wallet' : 'not_deployed',
      'message' in a ? a.message : 'Taking a side is unavailable.',
    );
  };
  return {
    chainId: input.chainId ?? 143,
    marketAddress: input.marketAddress,
    nativeSymbol: input.nativeSymbol ?? 'MON',
    availability,
    ensureMarket: async () => fail(),
    takeSide: async () => fail(),
    hasCrossed: async () => fail(),
  };
}

const MAX_INT256 = 2n ** 255n - 1n;

/**
 * A threshold in the units a `CanonicalSeries` reports prices in: whole
 * multiples of `10^expo`. `null` when that would drop a digit, or overflow an
 * `int256`. A contract must never be handed a number the card did not show.
 */
export function thresholdInSeriesUnits(threshold: Decimal, expo: number): bigint | null {
  if (!Number.isInteger(expo)) return null;
  let atoms: bigint;
  if (expo <= 0) {
    const scaled = rescaleExact(threshold, -expo);
    if (!scaled) return null;
    atoms = BigInt(scaled.atoms);
  } else {
    const whole = rescaleExact(threshold, 0);
    if (!whole) return null;
    const unit = 10n ** BigInt(expo);
    const n = BigInt(whole.atoms);
    if (n % unit !== 0n) return null;
    atoms = n / unit;
  }
  return atoms > 0n && atoms <= MAX_INT256 ? atoms : null;
}

/** A stake as wei: the native unit at 18 decimals, exactly. `null` if it is zero, negative or finer than a wei. */
export function stakeToWei(stake: Decimal): bigint | null {
  const wei = rescaleExact(stake, 18);
  if (!wei) return null;
  const atoms = BigInt(wei.atoms);
  return atoms > 0n ? atoms : null;
}

/** The on-chain fields of a market, as the contract's `markets(id)` getter returns them. */
export interface ChainMarketFields {
  seriesContract: string;
  thresholdPrice: bigint;
  above: boolean;
  windowStart: bigint;
  windowEnd: bigint;
  settled: boolean;
}

/**
 * The first difference between what the chain holds and what the card shows,
 * or `null` when they agree. Compared field by field, in the series' own units,
 * so a market someone else opened with a different threshold or window is
 * caught before a stake goes into it.
 */
export function firstMismatch(input: {
  chain: ChainMarketFields;
  terms: OnChainTerms;
  seriesAddress: string;
  thresholdUnits: bigint;
}): string | null {
  const { chain, terms, seriesAddress, thresholdUnits } = input;
  if (chain.seriesContract.toLowerCase() !== seriesAddress.toLowerCase()) {
    return 'it reads a different price series';
  }
  if (chain.thresholdPrice !== thresholdUnits) return 'its threshold is different';
  if (chain.above !== (terms.direction === 'above')) return 'it asks the other way round';
  if (chain.windowStart !== BigInt(terms.windowStart)) return 'its window starts at another time';
  if (chain.windowEnd !== BigInt(terms.windowEnd)) return 'its window ends at another time';
  if (chain.settled) return 'it has already settled';
  return null;
}
