/**
 * Keyless Pyth price reads: `getPriceUnsafe` over plain JSON-RPC `eth_call`
 * against the Pyth PriceFeed contract on Monad.
 *
 * This is the same contract `CanonicalSeries.recordSample()` reads
 * (`getPriceNoOlderThan`, which is `getPriceUnsafe` plus a staleness check), so
 * the off-chain series and the on-chain one are sourced identically. No API
 * key, no client library: the call is one 4-byte selector plus a bytes32, and
 * the answer is four ABI words, both handled by hand below and pinned to known
 * vectors in `pyth-rpc.test.ts`.
 *
 * The sponsored feeds are pushed on-chain by Pyth itself, so between pushes the
 * price and its `publishTime` do not change. Callers dedupe on `publishTime`.
 */

import { z } from 'zod';
import { fedAssets, normalizeFeedId, pythPriceToDecimal, type PriceUpdate, type SkippedUpdate } from './pyth';

/** Pyth's PriceFeed proxy on Monad, from packages/contracts/script/PythMonad.sol. */
export const PYTH_MONAD_ADDRESS = '0x2880aB155794e7179c9eE2e38200202908C17B43' as const;

export const DEFAULT_MONAD_RPC_URL = 'https://rpc.monad.xyz';

/** `bytes4(keccak256("getPriceUnsafe(bytes32)"))`. */
export const GET_PRICE_UNSAFE_SELECTOR = '0x96834ad3' as const;

/** Calldata for `getPriceUnsafe(feedId)`. */
export function encodeGetPriceUnsafe(feedId: string): `0x${string}` {
  return `${GET_PRICE_UNSAFE_SELECTOR}${normalizeFeedId(feedId).slice(2)}`;
}

export interface OnChainPrice {
  /** int64, as a base-10 string. */
  price: string;
  conf: string;
  expo: number;
  /** Unix seconds. */
  publishTime: number;
}

const WORD = 64;

function signed(word: string): bigint {
  const n = BigInt(`0x${word}`);
  return n >= 1n << 255n ? n - (1n << 256n) : n;
}

function inRange(n: bigint, min: bigint, max: bigint, what: string): bigint {
  if (n < min || n > max) throw new RangeError(`${what} out of range: ${n}`);
  return n;
}

/**
 * Decodes the `PythStructs.Price` struct `(int64 price, uint64 conf, int32
 * expo, uint256 publishTime)`, which is four static words. Signed values are
 * sign-extended to 32 bytes by the ABI, and each is range-checked against its
 * declared width, so garbage return data is rejected rather than misread.
 */
export function decodePriceStruct(data: string): OnChainPrice {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new Error('return data is not hex');
  const hex = data.slice(2);
  if (hex.length !== 4 * WORD) throw new Error(`expected 4 words of return data, got ${hex.length / 2} bytes`);
  const w = (i: number) => hex.slice(i * WORD, (i + 1) * WORD);

  const price = inRange(signed(w(0)), -(1n << 63n), (1n << 63n) - 1n, 'price');
  const conf = inRange(BigInt(`0x${w(1)}`), 0n, (1n << 64n) - 1n, 'conf');
  const expo = inRange(signed(w(2)), -(1n << 31n), (1n << 31n) - 1n, 'expo');
  const publishTime = inRange(BigInt(`0x${w(3)}`), 0n, BigInt(Number.MAX_SAFE_INTEGER), 'publishTime');
  return { price: price.toString(), conf: conf.toString(), expo: Number(expo), publishTime: Number(publishTime) };
}

const RpcResponse = z.object({
  result: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export interface MonadRpcConfig {
  /** Default `https://rpc.monad.xyz`. */
  rpcUrl?: string | undefined;
  /** Default: the Pyth proxy in PythMonad.sol. */
  address?: string | undefined;
  timeoutMs?: number | undefined;
}

async function ethCall(fetchFn: typeof fetch, rpcUrl: string, to: string, data: string, timeoutMs: number, id: number): Promise<string> {
  const res = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC responded ${res.status}`);
  const parsed = RpcResponse.safeParse(await res.json());
  if (!parsed.success) throw new Error('RPC response did not match the JSON-RPC shape');
  if (parsed.data.error) throw new Error(`eth_call reverted: ${parsed.data.error.message}`);
  if (parsed.data.result === undefined) throw new Error('RPC response had no result');
  return parsed.data.result;
}

/**
 * The current on-chain Pyth price for each tracked feed, as `PriceUpdate`s.
 *
 * One `eth_call` per feed, in parallel. A feed that reverts (never pushed) or
 * returns something unusable is skipped with a reason and does not take the
 * others down. If the RPC itself is unreachable for every feed, it throws, so a
 * dead endpoint is loud rather than an empty success.
 */
export async function fetchPythOnChain(
  fetchFn: typeof fetch,
  cfg: MonadRpcConfig = {},
  feeds: readonly { symbol: string; feedId: string }[] = fedAssets(),
): Promise<{ updates: PriceUpdate[]; skipped: SkippedUpdate[] }> {
  const rpcUrl = cfg.rpcUrl ?? DEFAULT_MONAD_RPC_URL;
  const to = cfg.address ?? PYTH_MONAD_ADDRESS;
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  const settled = await Promise.allSettled(
    feeds.map(async (f, i) => {
      const feedId = normalizeFeedId(f.feedId);
      const price = decodePriceStruct(await ethCall(fetchFn, rpcUrl, to, encodeGetPriceUnsafe(feedId), timeoutMs, i + 1));
      return { symbol: f.symbol, feedId, price };
    }),
  );

  const updates: PriceUpdate[] = [];
  const skipped: SkippedUpdate[] = [];
  settled.forEach((r, i) => {
    const id = feeds[i]!.feedId;
    if (r.status === 'rejected') {
      skipped.push({ id, reason: r.reason instanceof Error ? r.reason.message : 'call failed' });
      return;
    }
    const { symbol, feedId, price } = r.value;
    if (price.publishTime === 0) {
      skipped.push({ id, reason: 'feed has never been updated' });
      return;
    }
    try {
      const decimal = pythPriceToDecimal(price.price, price.expo);
      if (BigInt(decimal.atoms) <= 0n) {
        skipped.push({ id, reason: 'non-positive price' });
        return;
      }
      updates.push({ asset: symbol, feedId, price: decimal, publishTime: price.publishTime });
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : 'unreadable price' });
    }
  });

  if (feeds.length > 0 && updates.length === 0 && skipped.length === feeds.length) {
    throw new Error(`no price could be read from ${rpcUrl}: ${skipped[0]!.reason}`);
  }
  return { updates, skipped };
}
