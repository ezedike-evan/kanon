/**
 * The market Kanon listed on Kuru's testnet, as the app's spot screen reads it.
 *
 * Three things, kept apart so each can be tested without a chain:
 *
 *   - `readKuruListing` reads the record `kuru-list-cli.ts` wrote when it
 *     listed the market: addresses, parameters and transaction hashes. That
 *     file is the only place the market's address comes from. Nothing here
 *     guesses one.
 *   - `kuruMarketView` turns that record and one read of the book into the
 *     view the app is sent. Pure.
 *   - `createKuruBookReader` reads the book through Kuru's own SDK, the same
 *     calls the listing script was rehearsed with. It checks once that the
 *     market on-chain pairs the two tokens the record names.
 *
 * The SDK reports book levels as JS floats, and its AMM levels are computed in
 * floats. They are re-quantised here to the market's own decimals and are for
 * display and for a slippage reference only. No settlement arithmetic is done
 * on them: an order's bound is checked by the contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ethers as Ethers } from 'ethers';
import { z } from 'zod';
import type { Decimal } from '@kanon/spec';
import { KURU_NETWORK, loadKuruSdk } from './kuru';

// ---------------------------------------------------------------------------
// The record of the listing
// ---------------------------------------------------------------------------

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const digits = z.string().regex(/^\d+$/);

const Token = z.object({
  address,
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /** What the token is, in words: a test token is said to be one. */
  kind: z.string().min(1),
});

/** A listing that has at least reached a market. Liquidity and the first order are recorded when they happen. */
export const KuruListing = z.looseObject({
  network: z.literal('testnet'),
  chainId: z.number().int(),
  asset: z.string().min(1),
  note: z.string().min(1),
  base: Token.extend({ deployTx: txHash }),
  quote: Token,
  market: z.looseObject({
    address,
    vault: address,
    deployTx: txHash,
    pricePrecision: digits,
    sizePrecision: digits,
    minSize: digits,
    maxSize: digits,
    takerFeeBps: digits,
  }),
  liquidity: z.looseObject({ tx: txHash }).optional(),
  order: z.looseObject({ tx: txHash }).optional(),
});
export type KuruListing = z.infer<typeof KuruListing>;

/** Where the listing script writes, beside this package's `package.json`. */
export const KURU_LISTING_PATH = fileURLToPath(new URL('../kuru-listing.testnet.json', import.meta.url));

/** The recorded listing, or null when no market has been listed (no file, or a run that stopped before the market). */
export function readKuruListing(path: string = KURU_LISTING_PATH): KuruListing | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const parsed = KuruListing.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface KuruLevel {
  price: Decimal;
  size: Decimal;
}

export interface KuruToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  kind: string;
}

export interface KuruMarketView {
  ok: true;
  asset: string;
  network: 'testnet';
  chainId: number;
  /** The OrderBook contract a wallet sends an order to. */
  market: string;
  base: KuruToken;
  quote: KuruToken;
  /** What the two tokens are, in a sentence. */
  note: string;
  priceDecimals: number;
  sizeDecimals: number;
  minSize: Decimal;
  maxSize: Decimal;
  takerFeeBps: number;
  /** Best (highest) first. */
  bids: KuruLevel[];
  /** Best (lowest) first. */
  asks: KuruLevel[];
  blockNumber: number;
  /** Unix milliseconds: when this process read the book. */
  readAt: number;
  /** The transactions behind the listing, for the explorer. */
  listing: { marketTx: string; tokenTx: string; liquidityTx?: string; firstOrderTx?: string };
}

/** One read of the book, as the SDK returns it: `[price, size]` pairs in the market's own units, as floats. */
export interface KuruBookRead {
  bids: ReadonlyArray<ReadonlyArray<number>>;
  asks: ReadonlyArray<ReadonlyArray<number>>;
  blockNumber: number;
}

/** How many levels a side is sent with. */
export const KURU_VIEW_DEPTH = 8;

/** `1000` is three decimals. A precision that is not a power of ten has no decimals to speak of. */
export function precisionDecimals(precision: string): number {
  if (!/^10*$/.test(precision)) throw new Error(`precision ${precision} is not a power of ten`);
  return precision.length - 1;
}

/** A float from the SDK, re-quantised to `decimals`. Null for anything that is not a positive, finite amount at that scale. */
function quantise(value: number | undefined, decimals: number): Decimal | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const atoms = value.toFixed(decimals).replace('.', '').replace(/^0+(?=\d)/, '');
  return /^[1-9]\d*$/.test(atoms) ? { atoms, decimals } : null;
}

function levels(
  rows: ReadonlyArray<ReadonlyArray<number>>,
  priceDecimals: number,
  sizeDecimals: number,
  bestFirst: (a: KuruLevel, b: KuruLevel) => number,
): KuruLevel[] {
  const out: KuruLevel[] = [];
  for (const row of rows) {
    const price = quantise(row[0], priceDecimals);
    const size = quantise(row[1], sizeDecimals);
    if (price && size) out.push({ price, size });
  }
  return out.sort(bestFirst).slice(0, KURU_VIEW_DEPTH);
}

const byPrice = (a: KuruLevel, b: KuruLevel): number => {
  const x = BigInt(a.price.atoms);
  const y = BigInt(b.price.atoms);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The view of the listed market at one read of its book. Pure. */
export function kuruMarketView(listing: KuruListing, book: KuruBookRead, nowMs: number): KuruMarketView {
  const priceDecimals = precisionDecimals(listing.market.pricePrecision);
  const sizeDecimals = precisionDecimals(listing.market.sizePrecision);
  const token = (t: KuruToken): KuruToken => ({ address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals, kind: t.kind });
  return {
    ok: true,
    asset: listing.asset,
    network: listing.network,
    chainId: listing.chainId,
    market: listing.market.address,
    base: token(listing.base),
    quote: token(listing.quote),
    note: listing.note,
    priceDecimals,
    sizeDecimals,
    minSize: { atoms: listing.market.minSize, decimals: sizeDecimals },
    maxSize: { atoms: listing.market.maxSize, decimals: sizeDecimals },
    takerFeeBps: Number(listing.market.takerFeeBps),
    bids: levels(book.bids, priceDecimals, sizeDecimals, (a, b) => byPrice(b, a)),
    asks: levels(book.asks, priceDecimals, sizeDecimals, byPrice),
    blockNumber: book.blockNumber,
    readAt: nowMs,
    listing: {
      marketTx: listing.market.deployTx,
      tokenTx: listing.base.deployTx,
      ...(listing.liquidity ? { liquidityTx: listing.liquidity.tx } : {}),
      ...(listing.order ? { firstOrderTx: listing.order.tx } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the book
// ---------------------------------------------------------------------------

/**
 * Reads the listed market's book from the chain. The first read also checks
 * that the contract at the recorded address pairs the two recorded tokens at
 * the recorded precisions: a record that does not describe the market is
 * refused, not served.
 */
export function createKuruBookReader(opts: { listing: KuruListing; rpcUrl?: string }): () => Promise<KuruBookRead> {
  const { listing } = opts;
  // The Node build of ethers v5. An `import` under a bundler's resolver picks its browser build,
  // whose HTTP client fails under Node; `require` picks the one the Kuru SDK itself loads.
  const { ethers } = createRequire(import.meta.url)('ethers') as { ethers: typeof Ethers };
  const provider = new ethers.providers.StaticJsonRpcProvider(opts.rpcUrl ?? KURU_NETWORK[listing.network].rpcUrl, listing.chainId);
  let ready: Promise<{ sdk: Awaited<ReturnType<typeof loadKuruSdk>>; params: unknown }> | null = null;

  async function prepare() {
    const sdk = await loadKuruSdk();
    const params = await sdk.ParamFetcher.getMarketParams(provider, listing.market.address);
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (
      !same(params.baseAssetAddress, listing.base.address) ||
      !same(params.quoteAssetAddress, listing.quote.address) ||
      params.pricePrecision.toString() !== listing.market.pricePrecision ||
      params.sizePrecision.toString() !== listing.market.sizePrecision
    ) {
      throw new Error(`the contract at ${listing.market.address} is not the market the listing record describes`);
    }
    return { sdk, params };
  }

  return async () => {
    ready ??= prepare();
    let prepared;
    try {
      prepared = await ready;
    } catch (err) {
      // Not kept: the next read tries again, so one failed RPC call does not end the route.
      ready = null;
      throw err;
    }
    const { sdk, params } = prepared;
    const book = await sdk.OrderBook.getL2OrderBook(provider, listing.market.address, params as Parameters<typeof sdk.OrderBook.getL2OrderBook>[2]);
    return { bids: book.bids, asks: book.asks, blockNumber: book.blockNumber };
  };
}
