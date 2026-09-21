/**
 * The asset classes Kanon trades, and the assets in each.
 *
 * Only crypto is live: the nine Pyth pairs sponsored on Monad. FX and
 * equities are deliberately absent, not half-built. Pyth publishes those
 * feeds but does not sponsor them on Monad, so they mean paying for your own
 * price updates (docs/ARCHITECTURE.md, "Oracle").
 *
 * Nothing in the core knows about asset classes. The spec's `asset` is a
 * plain string, the contracts take a feed id, and the predicates are
 * arithmetic over a `Series`. A class only exists here, in the Convex
 * validators derived from it, and in the UI's labels, so enabling one later
 * touches these places and no enforcement path:
 *
 *   1. Add the class to `ASSET_CLASSES`.
 *   2. Add its assets to `ASSETS`.
 *   3. Add the class literal to `assetClass` in
 *      `packages/backend/convex/schema.ts`. A type check there fails the
 *      build until it matches this file.
 *   4. Fund a price-update relayer for the class's feeds. That is a running
 *      cost, not a code change.
 */

export const ASSET_CLASSES = ['crypto'] as const;

export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface AssetDef {
  symbol: string;
  assetClass: AssetClass;
}

export const ASSETS: readonly AssetDef[] = [
  { symbol: 'BTC/USD', assetClass: 'crypto' },
  { symbol: 'ETH/USD', assetClass: 'crypto' },
  { symbol: 'SOL/USD', assetClass: 'crypto' },
  { symbol: 'MON/USD', assetClass: 'crypto' },
  { symbol: 'AVAX/USD', assetClass: 'crypto' },
];

export function isAssetClass(value: string): value is AssetClass {
  return (ASSET_CLASSES as readonly string[]).includes(value);
}

/** The class of a known asset, or `undefined` if the symbol isn't listed. */
export function assetClassOf(symbol: string): AssetClass | undefined {
  return ASSETS.find((a) => a.symbol === symbol)?.assetClass;
}
