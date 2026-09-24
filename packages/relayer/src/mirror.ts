/**
 * Testnet price mirror.
 *
 * Pyth's Monad testnet contract is only as fresh as the last update somebody
 * pushed to it, and pushing needs a Hermes key. Kanon's testnet deployment
 * therefore points its `CanonicalSeries` at a `MockPyth` this process feeds
 * with the prices Pyth's mainnet contract holds right now (a free `eth_call`,
 * no key). The oracle on testnet is a mock; the prices are real. Mainnet
 * deployments never use this: they read Pyth directly.
 *
 * `publishTime` is set to the testnet block time, not the source's, because
 * `CanonicalSeries` buckets a sample by its own `publishTime`, and the sponsored
 * mainnet feeds only republish hourly or on a 0.02% move. Reusing the source
 * time would stack many minutes of samples into one instant. A source older than
 * `maxSourceAgeSeconds` is refused rather than presented as current.
 */

import { parseAbi } from 'viem';

/** Pyth's PriceFeed proxy on Monad. Same address as `PythMonad.PRICE_FEED`. */
export const MAINNET_PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43' as const;

/** Same feed ids as `PythMonad.sol`. */
export const FEEDS = {
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
} as const;

export type FeedName = keyof typeof FEEDS;

export const sourcePythAbi = parseAbi([
  'function getPriceUnsafe(bytes32 id) view returns (int64 price, uint64 conf, int32 expo, uint256 publishTime)',
]);

export const mockPythAbi = parseAbi([
  'function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)',
]);

export interface PythPrice {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
}

export type MirrorPlan =
  | { ok: true; price: PythPrice; sourceAgeSeconds: bigint }
  | { ok: false; reason: 'source_stale' | 'source_not_positive' | 'source_from_future'; sourceAgeSeconds: bigint };

/**
 * What to write to the mock for one feed, or why not to. Pure: `nowSeconds` is
 * the testnet block time and `sourceNowSeconds` the mainnet block time, so a
 * source's age is measured on its own chain's clock.
 */
export function planMirror(
  source: PythPrice,
  sourceNowSeconds: bigint,
  nowSeconds: bigint,
  maxSourceAgeSeconds: bigint,
): MirrorPlan {
  const sourceAgeSeconds = sourceNowSeconds - source.publishTime;
  if (source.price <= 0n) return { ok: false, reason: 'source_not_positive', sourceAgeSeconds };
  if (sourceAgeSeconds < 0n) return { ok: false, reason: 'source_from_future', sourceAgeSeconds };
  if (sourceAgeSeconds > maxSourceAgeSeconds) return { ok: false, reason: 'source_stale', sourceAgeSeconds };
  return { ok: true, price: { ...source, publishTime: nowSeconds }, sourceAgeSeconds };
}
