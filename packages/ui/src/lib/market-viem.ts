/**
 * `MarketClient` over viem, for the `ThresholdMarket` contract.
 *
 * The signer is injected as an EIP-1193 provider, exactly as `pin-viem.ts` does
 * it: on the web that is the Privy embedded wallet's provider, on a phone
 * `@privy-io/expo`'s. This file knows neither. It builds a wallet client over
 * whatever provider it is handed.
 *
 * The ABI below is the human-readable form of the functions this client calls;
 * `market-viem.test.ts` checks every one of them against
 * `packages/contracts/abi/ThresholdMarket.json`, so a contract change that
 * moves a signature fails a test rather than a transaction.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Decimal } from '@kanon/spec';
import {
  CROSSED_MESSAGE,
  MarketError,
  STALE_MESSAGE,
  firstMismatch,
  marketAvailability,
  stakeToWei,
  thresholdInSeriesUnits,
  type ChainMarketFields,
  type EnsuredMarket,
  type MarketClient,
  type OnChainTerms,
} from './market-client';
import type { ChainMarketRef } from './market-client';

export const thresholdMarketAbi = parseAbi([
  'function series(bytes32) view returns (address)',
  'function nextMarketId() view returns (uint256)',
  'function markets(uint256) view returns (address seriesContract, int256 thresholdPrice, bool above, uint256 windowStart, uint256 windowEnd, uint256 yesPool, uint256 noPool, bool settled, bool unresolvable, bool yesWon)',
  'function openMarket(bytes32 seriesId, int256 thresholdPrice, bool above, uint256 windowStart, uint256 windowEnd) returns (uint256 marketId)',
  'function takeSide(uint256 marketId, bool takesAboveSide) payable',
  'function hasCrossed(uint256 marketId) view returns (bool)',
  'error MarketClosed()',
  'error MarketCrossed()',
  'error StaleSeries()',
  'error UnknownMarket()',
  'error ZeroStake()',
  'error SeriesNotRegistered()',
  'error InvalidWindow()',
  'event MarketOpened(uint256 indexed marketId, bytes32 indexed seriesId, int256 thresholdPrice, bool above, uint256 windowStart, uint256 windowEnd)',
]);

export const canonicalSeriesAbi = parseAbi([
  'function priceExpo() view returns (int32)',
  'function priceExpoSet() view returns (bool)',
  'function bucketSeconds() view returns (uint256)',
]);

export interface Signer {
  provider: EIP1193Provider;
  address: `0x${string}`;
}

export interface ViemMarketClientOptions {
  chain: Chain;
  marketAddress: string | undefined;
  /** Whether a wallet exists at all. Drives the availability message before anything is asked to sign. */
  hasWallet: boolean;
  /** Resolves the signer at the moment of signing, so a wallet created after login is picked up. */
  getSigner: () => Promise<Signer | null>;
  /** Replaces the default HTTP public client. Tests hand in a fake. */
  publicClient?: Pick<PublicClient, 'readContract' | 'simulateContract' | 'waitForTransactionReceipt'>;
}

/** The id a series is registered under in the `ThresholdMarket` constructor: `keccak256("BTC/USD")`. */
export function seriesIdFor(asset: string): Hex {
  return keccak256(toBytes(asset));
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type Thrown = { name?: string; code?: number; shortMessage?: string; message?: string; cause?: unknown };

/** Whether a signature request was declined, anywhere in the chain viem wraps the wallet's error in. */
function wasDeclined(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth += 1) {
    const e = cur as Thrown;
    if (e.name === 'UserRejectedRequestError' || e.code === 4001) return true;
    cur = e.cause;
  }
  return false;
}

/** The contract error name a failed call carries, anywhere in the chain viem wraps it in. */
export function revertName(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur && typeof cur === 'object'; depth += 1) {
    const e = cur as Thrown & { data?: { errorName?: string } };
    if (typeof e.data?.errorName === 'string') return e.data.errorName;
    cur = e.cause;
  }
  return undefined;
}

/** Maps whatever the wallet or the node threw to a code the card can word honestly. */
export function toMarketError(err: unknown): MarketError {
  if (err instanceof MarketError) return err;
  switch (revertName(err)) {
    case 'MarketCrossed':
      return new MarketError('crossed', CROSSED_MESSAGE);
    case 'StaleSeries':
      return new MarketError('stale', STALE_MESSAGE);
    case 'MarketClosed':
    case 'UnknownMarket':
      return new MarketError('not_open', 'This market is closed to new sides.');
    case 'ZeroStake':
      return new MarketError('failed', 'The stake must be more than zero.');
    default:
      break;
  }
  if (wasDeclined(err)) {
    return new MarketError('rejected', 'The signature was declined. Nothing was staked.');
  }
  const e = err as Thrown;
  return new MarketError('failed', e.shortMessage ?? e.message ?? 'The transaction did not go through.');
}

export function createViemMarketClient(opts: ViemMarketClientOptions): MarketClient {
  const { chain, marketAddress } = opts;
  const publicClient =
    opts.publicClient ?? (createPublicClient({ chain, transport: http() }) as PublicClient);

  const availability = () => marketAvailability({ marketAddress, hasWallet: opts.hasWallet });

  function requireReady(): `0x${string}` {
    const a = availability();
    if (a.state !== 'ready' || !marketAddress) {
      throw new MarketError(
        a.state === 'no_wallet' ? 'no_wallet' : 'not_deployed',
        'message' in a ? a.message : 'Taking a side is unavailable.',
      );
    }
    return marketAddress as `0x${string}`;
  }

  async function walletFor() {
    const signer = await opts.getSigner();
    if (!signer) throw new MarketError('no_wallet', 'No wallet is available to sign with.');
    const wallet = createWalletClient({
      account: signer.address,
      chain,
      transport: custom(signer.provider),
    });
    // An embedded wallet may still be pointed at another chain. Ask it to move; if it
    // cannot, the write below fails with the chain named rather than sending elsewhere.
    try {
      await wallet.switchChain({ id: chain.id });
    } catch {
      /* the write will surface a wrong-chain error */
    }
    return { wallet, account: signer.address };
  }

  async function write(
    address: `0x${string}`,
    functionName: 'openMarket' | 'takeSide',
    args: readonly unknown[],
    value?: bigint,
  ) {
    const { wallet, account } = await walletFor();
    const hash = await wallet.writeContract({
      address,
      abi: thresholdMarketAbi,
      functionName,
      args: args as never,
      account,
      chain,
      ...(value !== undefined ? { value } : {}),
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new MarketError('failed', 'The contract rejected the transaction. Nothing was staked.');
    }
    return { hash, receipt };
  }

  async function ensureMarket(
    terms: OnChainTerms,
    linked?: ChainMarketRef | undefined,
  ): Promise<EnsuredMarket> {
    const address = requireReady();
    try {
      const seriesId = seriesIdFor(terms.asset);
      const seriesAddress = (await publicClient.readContract({
        address,
        abi: thresholdMarketAbi,
        functionName: 'series',
        args: [seriesId],
      })) as string;
      if (!seriesAddress || seriesAddress === ZERO_ADDRESS) {
        throw new MarketError('not_open', `${terms.asset} has no price series on this deployment, so it cannot be staked on here.`);
      }

      const seriesRead = (fn: 'priceExpo' | 'priceExpoSet' | 'bucketSeconds') =>
        publicClient.readContract({ address: seriesAddress as `0x${string}`, abi: canonicalSeriesAbi, functionName: fn });

      if (!(await seriesRead('priceExpoSet'))) {
        throw new MarketError('not_open', `The on-chain ${terms.asset} series has no samples yet, so it has no price scale to open a market in.`);
      }
      const bucket = Number(await seriesRead('bucketSeconds'));
      if (bucket !== terms.bucketSeconds) {
        throw new MarketError(
          'mismatch',
          `The on-chain series is bucketed at ${bucket}s and this market is decided on ${terms.bucketSeconds}s candles, so the two would disagree. Nothing was staked.`,
        );
      }
      const expo = Number(await seriesRead('priceExpo'));
      const thresholdUnits = thresholdInSeriesUnits(terms.thresholdPrice, expo);
      if (thresholdUnits === null) {
        throw new MarketError('mismatch', 'The threshold cannot be written exactly in the on-chain series\' units. Nothing was staked.');
      }

      if (linked) {
        if (linked.address.toLowerCase() !== address.toLowerCase() || linked.chainId !== chain.id) {
          throw new MarketError('mismatch', 'This market is linked to a different contract. Nothing was staked.');
        }
        const row = (await publicClient.readContract({
          address,
          abi: thresholdMarketAbi,
          functionName: 'markets',
          args: [BigInt(linked.marketId)],
        })) as readonly [string, bigint, boolean, bigint, bigint, bigint, bigint, boolean, boolean, boolean];
        const chainFields: ChainMarketFields = {
          seriesContract: row[0],
          thresholdPrice: row[1],
          above: row[2],
          windowStart: row[3],
          windowEnd: row[4],
          settled: row[7],
        };
        const why = firstMismatch({ chain: chainFields, terms, seriesAddress, thresholdUnits });
        if (why) {
          throw new MarketError('mismatch', `The on-chain market does not match the card: ${why}. Nothing was staked.`);
        }
        return { ...linked, opened: false };
      }

      const { hash, receipt } = await write(address, 'openMarket', [
        seriesId,
        thresholdUnits,
        terms.direction === 'above',
        BigInt(terms.windowStart),
        BigInt(terms.windowEnd),
      ]);
      let marketId: bigint | undefined;
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: thresholdMarketAbi, data: log.data, topics: log.topics });
          if (ev.eventName === 'MarketOpened') {
            marketId = (ev.args as { marketId: bigint }).marketId;
            break;
          }
        } catch {
          /* a log from another contract in the same transaction */
        }
      }
      if (marketId === undefined) {
        throw new MarketError('failed', 'The contract accepted the call but emitted no market. Check the transaction.');
      }
      return { chainId: chain.id, address, marketId: marketId.toString(), txHash: hash, opened: true };
    } catch (err) {
      throw toMarketError(err);
    }
  }

  async function takeSide(input: { chainMarketId: string; yes: boolean; stake: Decimal }) {
    const address = requireReady();
    const wei = stakeToWei(input.stake);
    if (wei === null) throw new MarketError('failed', 'The stake must be a positive amount, no finer than one wei.');
    let id: bigint;
    try {
      id = BigInt(input.chainMarketId);
    } catch {
      throw new MarketError('not_open', 'This market has no on-chain id.');
    }
    try {
      // The contract closes a market once the recorded series has touched the threshold.
      // Ask it first, so a closed market never reaches a wallet prompt.
      if (await readCrossed(address, id)) throw new MarketError('crossed', CROSSED_MESSAGE);

      // Dry-run the exact call. `takeSide` may record a fresh sample first (more gas) and reverts
      // `StaleSeries` if it cannot: the revert name comes back here, before anything is signed.
      const signer = await opts.getSigner();
      if (!signer) throw new MarketError('no_wallet', 'No wallet is available to sign with.');
      await publicClient.simulateContract({
        address,
        abi: thresholdMarketAbi,
        functionName: 'takeSide',
        args: [id, input.yes],
        account: signer.address,
        value: wei,
      });

      const { hash } = await write(address, 'takeSide', [id, input.yes], wei);
      return { txHash: hash };
    } catch (err) {
      throw toMarketError(err);
    }
  }

  async function readCrossed(address: `0x${string}`, id: bigint): Promise<boolean> {
    return (await publicClient.readContract({
      address,
      abi: thresholdMarketAbi,
      functionName: 'hasCrossed',
      args: [id],
    })) as boolean;
  }

  async function hasCrossed(chainMarketId: string): Promise<boolean> {
    const address = requireReady();
    let id: bigint;
    try {
      id = BigInt(chainMarketId);
    } catch {
      throw new MarketError('not_open', 'This market has no on-chain id.');
    }
    try {
      return await readCrossed(address, id);
    } catch (err) {
      throw toMarketError(err);
    }
  }

  return {
    chainId: chain.id,
    marketAddress,
    nativeSymbol: chain.nativeCurrency.symbol,
    availability,
    ensureMarket,
    takeSide,
    hasCrossed,
  };
}
