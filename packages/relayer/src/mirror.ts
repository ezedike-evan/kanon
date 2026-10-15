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
 * What to write, and when to refuse, is `planMirror` in `@kanon/spec`
 * (`packages/spec/src/mirror.ts`), shared with the Convex keeper. This file
 * keeps what only the CLI needs: the addresses and ABIs it calls through viem.
 * Never run the CLI with the keeper's key: the two would race each other's
 * nonces.
 */

import { PYTH_MONAD_ADDRESS } from '@kanon/spec';
import { parseAbi } from 'viem';

export { planMirror, type MirrorPlan, type PythPrice } from '@kanon/spec';

/** Pyth's PriceFeed proxy on Monad. Same address as `PythMonad.PRICE_FEED`. */
export const MAINNET_PYTH = PYTH_MONAD_ADDRESS;

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
