/**
 * Testnet price mirror: what to write, decided without a network.
 *
 * Pyth's Monad testnet contract is only as fresh as the last update somebody
 * pushed to it, and pushing needs a Hermes key. Kanon's testnet deployment
 * therefore points its `CanonicalSeries` at a `MockPyth` that is fed the prices
 * Pyth's mainnet contract holds right now (a free `eth_call`, no key). The
 * oracle on testnet is a mock; the prices are real. Mainnet deployments never
 * use this: they read Pyth directly.
 *
 * `publishTime` is set to the testnet block time, not the source's, because
 * `CanonicalSeries` buckets a sample by its own `publishTime`, and the sponsored
 * mainnet feeds only republish hourly or on a 0.02% move. Reusing the source
 * time would stack many minutes of samples into one instant. A source older than
 * `maxSourceAgeSeconds` is refused rather than presented as current.
 *
 * Two writers share this file so they cannot disagree about what is mirrored:
 * the relayer's `mirror-cli` and the Convex keeper (`packages/backend`). Never
 * run both with the same key: they would race each other's nonces.
 */

import { decodePriceStruct, type OnChainPrice } from './pyth-rpc';

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

/** A decoded `getPriceUnsafe` answer as a `PythPrice`. Exact: no field passes through a float. */
export function pythPriceFromOnChain(p: OnChainPrice): PythPrice {
  return { price: BigInt(p.price), conf: BigInt(p.conf), expo: p.expo, publishTime: BigInt(p.publishTime) };
}

/**
 * The mirror's source, straight from `getPriceUnsafe` return data (the call is
 * `encodeGetPriceUnsafe(feedId)` against `PYTH_MONAD_ADDRESS`). Garbage return
 * data throws, as `decodePriceStruct` does.
 */
export function decodeSourcePrice(data: string): PythPrice {
  return pythPriceFromOnChain(decodePriceStruct(data));
}
