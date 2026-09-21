/**
 * Pyth price data, off the wire and into the repo's own types.
 *
 * Two consumers share this file so they cannot disagree about what a Pyth
 * price means: the Convex tick ingester (the off-chain canonical series) and
 * the on-chain relayer (`packages/relayer`). Both turn a Hermes response into
 * a `Decimal` the same way, exactly, with no floats anywhere on the path.
 *
 * Nothing here owns the network: `fetchHermesLatest` takes the `fetch` it uses.
 */

import { z } from 'zod';
import { ASSETS } from './assets';
import { Decimal } from './decimal';

/**
 * Pyth feed ids for the sponsored Monad feeds, keyed by the same symbol
 * `assets.ts` uses.
 *
 * The source of truth for the on-chain side is
 * `packages/contracts/script/PythMonad.sol`. `pyth.test.ts` parses that file
 * and fails if any id here drifts from it, so a copy-paste slip cannot ship.
 *
 * Deliberately absent: `AVAX/USD`. It is in `assets.ts` (the predict tab
 * lists it) but is not one of the nine feeds Pyth sponsors on Monad, so
 * PythMonad.sol has no id for it and neither do we. It has no canonical
 * series, and ingestion skips it rather than guess an id.
 */
export const PYTH_FEEDS: Readonly<Record<string, `0x${string}`>> = {
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'MON/USD': '0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1',
  'SOL/USD': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};

/** The feed id for a symbol, or `undefined` when the asset has no sponsored feed. */
export function feedIdForSymbol(symbol: string): `0x${string}` | undefined {
  return PYTH_FEEDS[symbol];
}

/** Assets that are both listed in `assets.ts` and have a Pyth feed. Ingestion runs over exactly these. */
export function fedAssets(): { symbol: string; feedId: `0x${string}` }[] {
  return ASSETS.flatMap((a) => {
    const feedId = PYTH_FEEDS[a.symbol];
    return feedId ? [{ symbol: a.symbol, feedId }] : [];
  });
}

/** Lowercase, `0x`-prefixed. Hermes returns ids bare; the contracts use `0x`. */
export function normalizeFeedId(id: string): `0x${string}` {
  const bare = id.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error(`not a 32-byte feed id: ${id}`);
  return `0x${bare}`;
}

const MAX_DECIMALS = 18;
/** No real feed comes near this; it only stops `10n ** huge` from being built. */
const MAX_POSITIVE_EXPO = 36;

/**
 * Converts a Pyth `(price, expo)` pair to a `Decimal`, exactly.
 *
 * Pyth's value is `price * 10^expo`. A negative `expo` is the number of
 * decimals, so `{ price: '6841234000000', expo: -8 }` is 68,412.34 and becomes
 * `{ atoms: '6841234000000', decimals: 8 }` untouched. The repo's `Decimal`
 * carries at most 18 decimals: a rarer `expo` below -18 is only accepted if
 * its trailing zeros can be dropped without changing the value, otherwise it
 * throws rather than round. A non-negative `expo` scales the atoms up.
 */
export function pythPriceToDecimal(price: string, expo: number): Decimal {
  if (!/^-?\d+$/.test(price)) throw new Error(`pyth price is not an integer string: ${price}`);
  if (!Number.isInteger(expo)) throw new Error(`pyth expo is not an integer: ${expo}`);

  let atoms = BigInt(price);

  if (expo >= 0) {
    if (expo > MAX_POSITIVE_EXPO) throw new RangeError(`pyth expo ${expo} is out of range`);
    return { atoms: (atoms * 10n ** BigInt(expo)).toString(), decimals: 0 };
  }

  let decimals = -expo;
  while (decimals > MAX_DECIMALS && atoms % 10n === 0n) {
    atoms /= 10n;
    decimals -= 1;
  }
  if (decimals > MAX_DECIMALS) {
    throw new RangeError(
      `pyth price ${price} at expo ${expo} needs more than ${MAX_DECIMALS} decimals to stay exact`,
    );
  }
  return { atoms: atoms.toString(), decimals };
}

/** Hermes `/v2/updates/price/latest` response. Unknown fields are ignored. */
export const HermesLatestResponse = z.object({
  binary: z.object({
    encoding: z.enum(['hex', 'base64']),
    data: z.array(z.string()),
  }),
  parsed: z
    .array(
      z.object({
        id: z.string(),
        price: z.object({
          price: z.string().regex(/^-?\d+$/),
          expo: z.number().int(),
          publish_time: z.number().int().nonnegative(),
        }),
      }),
    )
    .optional(),
});
export type HermesLatestResponse = z.infer<typeof HermesLatestResponse>;

/**
 * The Hermes URL for the latest update of the given feeds. `ids[]` is written
 * literally, brackets and all, which is the form Hermes documents.
 */
export function hermesLatestUrl(baseUrl: string, feedIds: readonly string[]): string {
  const base = baseUrl.replace(/\/+$/, '');
  const ids = feedIds.map((id) => `ids[]=${normalizeFeedId(id)}`).join('&');
  return `${base}/v2/updates/price/latest?encoding=hex&parsed=true&${ids}`;
}

export interface PriceUpdate {
  asset: string;
  feedId: `0x${string}`;
  price: Decimal;
  /** Pyth publish time, unix seconds. */
  publishTime: number;
}

export interface SkippedUpdate {
  id: string;
  reason: string;
}

/**
 * Reads the `parsed` section of a Hermes response into per-asset updates.
 *
 * An entry is skipped, with a reason, rather than failing the batch, when its
 * feed is not one we track or its price is not usable (non-positive, or not
 * exactly representable). One bad feed must not take the others' ticks down.
 * A price of zero or below is never a real print for these pairs, and storing
 * one would poison a candle's low.
 */
export function extractPriceUpdates(
  response: HermesLatestResponse,
  feeds: Readonly<Record<string, string>> = PYTH_FEEDS,
): { updates: PriceUpdate[]; skipped: SkippedUpdate[] } {
  const symbolByFeed = new Map<string, string>();
  for (const [symbol, id] of Object.entries(feeds)) symbolByFeed.set(normalizeFeedId(id), symbol);

  const updates: PriceUpdate[] = [];
  const skipped: SkippedUpdate[] = [];

  for (const entry of response.parsed ?? []) {
    let feedId: `0x${string}`;
    try {
      feedId = normalizeFeedId(entry.id);
    } catch {
      skipped.push({ id: entry.id, reason: 'malformed feed id' });
      continue;
    }
    const asset = symbolByFeed.get(feedId);
    if (!asset) {
      skipped.push({ id: entry.id, reason: 'untracked feed' });
      continue;
    }
    try {
      const price = pythPriceToDecimal(entry.price.price, entry.price.expo);
      if (BigInt(price.atoms) <= 0n) {
        skipped.push({ id: entry.id, reason: 'non-positive price' });
        continue;
      }
      updates.push({ asset, feedId, price, publishTime: entry.price.publish_time });
    } catch (e) {
      skipped.push({ id: entry.id, reason: e instanceof Error ? e.message : 'unreadable price' });
    }
  }

  return { updates, skipped };
}

/**
 * The binary update blobs, as `0x`-prefixed hex, ready to hand to Pyth's
 * `updatePriceFeeds`. Base64 is refused rather than re-encoded: the fetch asks
 * for hex, so anything else means the request was not honoured.
 */
export function hermesUpdateData(response: HermesLatestResponse): `0x${string}`[] {
  if (response.binary.encoding !== 'hex') {
    throw new Error(`expected hex-encoded update data, got ${response.binary.encoding}`);
  }
  return response.binary.data.map((d): `0x${string}` => {
    const bare = d.replace(/^0x/, '');
    if (bare.length === 0 || bare.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(bare)) {
      throw new Error('update data is not valid hex');
    }
    return `0x${bare}`;
  });
}

export interface HermesConfig {
  /** Default `https://hermes.pyth.network`. Any Hermes-compatible endpoint works. */
  baseUrl: string;
  /**
   * Sent when set. The public endpoint answered 401 to unauthenticated price
   * requests when this was written (2026-09-20), so a keyed provider may be
   * needed in practice.
   */
  apiKey?: string | undefined;
  /** Header the key goes in. Default `Authorization`, sent as `Bearer <key>`; any other name gets the bare key. */
  apiKeyHeader?: string | undefined;
  timeoutMs?: number | undefined;
}

export const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

/**
 * Fetches and validates the latest Hermes update for the given feeds. The
 * `fetch` is injected so callers (and tests) own the network.
 */
export async function fetchHermesLatest(
  fetchFn: typeof fetch,
  cfg: HermesConfig,
  feedIds: readonly string[],
): Promise<HermesLatestResponse> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.apiKey) {
    const name = cfg.apiKeyHeader ?? 'Authorization';
    headers[name] = name.toLowerCase() === 'authorization' ? `Bearer ${cfg.apiKey}` : cfg.apiKey;
  }
  const res = await fetchFn(hermesLatestUrl(cfg.baseUrl, feedIds), {
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (endpoint needs credentials: set an API key or another Hermes URL)' : '';
    throw new Error(`Hermes responded ${res.status}${hint}`);
  }
  const parsed = HermesLatestResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error(`Hermes response did not match the expected shape: ${parsed.error.message}`);
  return parsed.data;
}
