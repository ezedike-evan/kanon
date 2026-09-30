/**
 * `PinClient` over viem, for the StrategyRegistry.
 *
 * The signer is injected as an EIP-1193 provider: on the web that is the Privy
 * embedded wallet's provider, on a phone `@privy-io/expo`'s. This file knows
 * neither. It builds a wallet client over whatever provider it is handed and
 * talks to the registry through the ABI below.
 *
 * The ABI is the human-readable form of `packages/contracts/src/StrategyRegistry.sol`.
 * When `packages/contracts/abi/StrategyRegistry.json` ships, replace `registryAbi`
 * with it; the function and event names are the contract's own.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseEventLogs,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type Transport,
} from 'viem';
import type { Decimal } from '@kanon/spec';
import { PinError, pinAvailability, type PinClient, type PinReceipt, type PinTarget, type SeriesMap } from './pin';

export const registryAbi = parseAbi([
  'function pinStrategy(bytes32 specHash, bytes32 predicatesCommitment, address series) payable returns (uint256 strategyId)',
  'function tighten(uint256 strategyId, bytes32 newSpecHash, bytes32 newPredicatesCommitment, address newSeries, (uint8 kind, bytes32 symbol, uint8 direction, uint256 swingLookbackCandles, uint256 minGapBps, uint8 referenceExtreme, uint8 lookback, uint256 timeframeSeconds)[] oldPredicates, (uint8 kind, bytes32 symbol, uint8 direction, uint256 swingLookbackCandles, uint256 minGapBps, uint8 referenceExtreme, uint8 lookback, uint256 timeframeSeconds)[] newPredicates)',
  'function proposeLoosening(uint256 strategyId, bytes32 newSpecHash, bytes32 newPredicatesCommitment, address newSeries)',
  'function finalizeLoosening(uint256 strategyId)',
  'function activeSpecHash(uint256 strategyId) view returns (bytes32)',
  'function activePredicatesCommitment(uint256 strategyId) view returns (bytes32)',
  'function activeSeries(uint256 strategyId) view returns (address)',
  'function ownerOf(uint256 strategyId) view returns (address)',
  'function isCanonicalSeries(address) view returns (bool)',
  'function minBond() view returns (uint256)',
  'function loosenCooldownSeconds() view returns (uint256)',
  'event StrategyPinned(uint256 indexed strategyId, address indexed owner, bytes32 specHash, uint256 bond, bytes32 predicatesCommitment, address series)',
  'event LooseningProposed(uint256 indexed strategyId, bytes32 pendingSpecHash, bytes32 pendingPredicatesCommitment, address pendingSeries, uint256 cooldownEndsAt)',
  'error BondTooLow()',
  'error CoolingOff(uint256 cooldownEndsAt)',
  'error EmptyCommitment()',
  'error EmptySpecHash()',
  'error NoPendingLoosening()',
  'error NewPredicatesMismatch()',
  'error NotATightening(uint256 index)',
  'error NotOwner()',
  'error OldPredicatesMismatch()',
  'error SeriesChangeIsLoosening()',
  'error SeriesNotCanonical(address series)',
  'error UnknownStrategy()',
]);

export interface Signer {
  provider: EIP1193Provider;
  address: `0x${string}`;
}

export interface ViemPinClientOptions {
  chain: Chain;
  registryAddress: string | undefined;
  /** Whether a wallet exists at all. Drives the availability message before anything is asked to sign. */
  hasWallet: boolean;
  /** Deployed CanonicalSeries contracts by asset. A spec whose asset is absent cannot be pinned. */
  series?: SeriesMap;
  /** Resolves the signer at the moment of signing, so a wallet created after login is picked up. */
  getSigner: () => Promise<Signer | null>;
  /** How reads and receipts reach the chain. Defaults to the chain's own public RPC; tests inject one. */
  publicTransport?: Transport;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

function asHash(value: string): Hex {
  if (!HASH.test(value)) throw new PinError('failed', 'The spec hash is not a 32-byte value.');
  return value as Hex;
}

function asAddress(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new PinError('failed', 'The series address is not valid.');
  return value as `0x${string}`;
}

/** The three registry arguments for one spec, validated before anything asks to sign. */
function targetArgs(target: PinTarget): readonly [Hex, Hex, `0x${string}`] {
  return [asHash(target.specHash), asHash(target.predicatesCommitment), asAddress(target.series)];
}

function asId(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new PinError('failed', 'The strategy has no registry id.');
  }
}

/** Walks an error and its causes: viem wraps the wallet's own error a few layers deep. */
function chain(err: unknown): Array<{ name?: string; code?: number; shortMessage?: string; message?: string }> {
  const out: Array<{ name?: string; code?: number; shortMessage?: string; message?: string }> = [];
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    out.push(current as never);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function revertToPinError(name: string): PinError {
  switch (name) {
    case 'SeriesNotCanonical':
      return new PinError(
        'not_deployed',
        'The registry does not recognise this series as canonical. Nothing was pinned.',
      );
    case 'BondTooLow':
      return new PinError('failed', 'The bond is below the registry minimum. Nothing was pinned.');
    case 'CoolingOff':
      return new PinError('failed', 'The cooling-off period has not ended, so the registry refused it.');
    case 'NotOwner':
      return new PinError('failed', 'This wallet does not own that strategy on the registry.');
    case 'NotATightening':
    case 'SeriesChangeIsLoosening':
      return new PinError('failed', 'The registry does not treat this as a tightening, so it must wait out the hold.');
    case 'OldPredicatesMismatch':
    case 'NewPredicatesMismatch':
      return new PinError('failed', 'The predicates sent do not match the registry commitment. Nothing changed.');
    case 'EmptyCommitment':
    case 'EmptySpecHash':
      return new PinError('failed', 'The registry refused an empty hash. Nothing was pinned.');
    default:
      return new PinError('failed', `The registry refused it (${name}).`);
  }
}

/** Maps whatever the wallet or the node threw to a code the ceremony can word honestly. */
function toPinError(err: unknown): PinError {
  if (err instanceof PinError) return err;
  const layers = chain(err);
  if (layers.some((e) => e.name === 'UserRejectedRequestError' || e.code === 4001)) {
    return new PinError('rejected', 'The signature was declined. Nothing was pinned.');
  }
  // A revert the registry named: say what it means, in the ceremony's words.
  const reverted = layers
    .map((e) => (e as { data?: { errorName?: string } }).data?.errorName)
    .find((name): name is string => typeof name === 'string');
  if (reverted) return revertToPinError(reverted);
  const first = layers[0];
  return new PinError('failed', first?.shortMessage ?? first?.message ?? 'The transaction did not go through.');
}

export function createViemPinClient(opts: ViemPinClientOptions): PinClient {
  const { chain, registryAddress } = opts;
  const nativeSymbol = chain.nativeCurrency.symbol;
  const publicClient = createPublicClient({ chain, transport: opts.publicTransport ?? http() });

  const availability = () => pinAvailability({ registryAddress, hasWallet: opts.hasWallet });

  function requireReady(): `0x${string}` {
    const a = availability();
    if (a.state !== 'ready' || !registryAddress) {
      throw new PinError(a.state === 'no_wallet' ? 'no_wallet' : 'not_deployed', 'message' in a ? a.message : 'Pinning is unavailable.');
    }
    return registryAddress as `0x${string}`;
  }

  async function walletFor() {
    const signer = await opts.getSigner();
    if (!signer) throw new PinError('no_wallet', 'No wallet is available to sign with.');
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

  async function send(
    functionName: 'pinStrategy' | 'tighten' | 'proposeLoosening' | 'finalizeLoosening',
    args: readonly unknown[],
    value?: bigint,
  ) {
    const address = requireReady();
    try {
      const { wallet, account } = await walletFor();
      const hash = await wallet.writeContract({
        address,
        abi: registryAbi,
        functionName,
        args: args as never,
        account,
        chain,
        ...(value !== undefined ? { value } : {}),
      } as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new PinError('failed', 'The registry rejected the transaction. Nothing was pinned.');
      }
      return { hash, receipt };
    } catch (err) {
      throw toPinError(err);
    }
  }

  const readMinBond = async (): Promise<Decimal> => {
    const address = requireReady();
    try {
      const wei = await publicClient.readContract({ address, abi: registryAbi, functionName: 'minBond' });
      return { atoms: wei.toString(), decimals: chain.nativeCurrency.decimals };
    } catch (err) {
      throw toPinError(err);
    }
  };

  return {
    chainId: chain.id,
    registryAddress,
    nativeSymbol,
    availability,
    series: opts.series ?? {},
    readMinBond,

    async pin(target): Promise<PinReceipt> {
      const address = requireReady();
      const args = targetArgs(target);
      // The registry decides which series it will read. Ask it first, so a series it does not
      // know is refused here, in words, rather than as a reverted transaction that burns gas.
      try {
        const known = await publicClient.readContract({
          address,
          abi: registryAbi,
          functionName: 'isCanonicalSeries',
          args: [args[2]],
        });
        if (!known) throw revertToPinError('SeriesNotCanonical');
      } catch (err) {
        throw toPinError(err);
      }
      // The bond is the registry's own minimum, read at signing time, so a stale figure on screen never underpays.
      const bond = await readMinBond();
      const { hash: txHash, receipt } = await send('pinStrategy', args, BigInt(bond.atoms));
      const [pinned] = parseEventLogs({ abi: registryAbi, logs: receipt.logs, eventName: 'StrategyPinned' });
      if (!pinned) throw new PinError('failed', 'The registry accepted the call but emitted no pin. Check the transaction.');
      // What the registry recorded must be what was sent. Anything else is not a pin of this rule.
      if (
        pinned.args.specHash.toLowerCase() !== args[0].toLowerCase() ||
        pinned.args.predicatesCommitment.toLowerCase() !== args[1].toLowerCase() ||
        pinned.args.series.toLowerCase() !== args[2].toLowerCase()
      ) {
        throw new PinError('failed', 'The registry recorded different values than were sent. Check the transaction.');
      }
      return {
        txHash,
        chainStrategyId: pinned.args.strategyId.toString(),
        bond,
        chainId: chain.id,
        registryAddress: address,
        predicatesCommitment: pinned.args.predicatesCommitment,
        series: pinned.args.series,
      };
    },

    async tighten(chainStrategyId, target, predicates) {
      const { hash } = await send('tighten', [
        asId(chainStrategyId),
        ...targetArgs(target),
        predicates.old,
        predicates.next,
      ]);
      return { txHash: hash };
    },

    async proposeLoosening(chainStrategyId, target) {
      const { hash, receipt } = await send('proposeLoosening', [asId(chainStrategyId), ...targetArgs(target)]);
      const [proposed] = parseEventLogs({ abi: registryAbi, logs: receipt.logs, eventName: 'LooseningProposed' });
      return {
        txHash: hash,
        cooldownEndsAtMs: proposed ? Number(proposed.args.cooldownEndsAt) * 1000 : null,
      };
    },

    async finalizeLoosening(chainStrategyId) {
      const { hash } = await send('finalizeLoosening', [asId(chainStrategyId)]);
      return { txHash: hash };
    },
  };
}
