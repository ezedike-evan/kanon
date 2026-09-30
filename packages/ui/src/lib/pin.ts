/**
 * The seam between the ceremony and the chain.
 *
 * `PinClient` is what the data source calls to write a spec hash into the
 * StrategyRegistry. It is injected, so the screens and the flow logic carry no
 * chain library, and so a test (or a device with no wallet) can swap it out.
 * `pin-viem.ts` is the real implementation; `unavailablePinClient` is the honest
 * one for a build with no registry address and no wallet.
 *
 * The rule this file exists to hold: a pin is reported only when the chain
 * accepted it. Nothing here returns a receipt it did not get.
 */

import {
  predicatesCommitment,
  specHash as hashSpec,
  type Decimal,
  type PredicateDefinition,
  type StrategySpec,
} from '@kanon/spec';
import type { PinAvailability, PinFailure } from './flow-types';

/**
 * What the registry is given for one spec: its hash, the commitment to its
 * predicates (`keccak256(abi.encode(PredicateDefinition[]))`, which the gate
 * checks a proposer's predicates against) and the canonical series the gate
 * reads. All three are derived from the spec, never typed in.
 */
/** The predicates pinned now and the ones replacing them, as `StrategyRegistry.tighten` takes them. */
export interface TightenPredicates {
  old: readonly PredicateDefinition[];
  next: readonly PredicateDefinition[];
}

export interface PinTarget {
  specHash: string;
  predicatesCommitment: string;
  series: string;
}

/** A deployed CanonicalSeries. Cadence and bucket, where the config records them, must match the spec's. */
export interface SeriesConfig {
  address: string;
  cadenceSeconds?: number | undefined;
  bucketSeconds?: number | undefined;
}

/** Deployed series, keyed by normalised asset, e.g. `BTC/USD`. */
export type SeriesMap = Record<string, SeriesConfig>;

export interface PinReceipt {
  txHash: string;
  /** The registry's own id for the strategy, from the `StrategyPinned` event. */
  chainStrategyId: string;
  /** What the registry holds as bond, in the chain's native unit at 18 decimals. */
  bond: Decimal;
  chainId: number;
  registryAddress: string;
  /** What the registry recorded, read back from `StrategyPinned`. */
  predicatesCommitment: string;
  series: string;
}

export interface PinClient {
  chainId: number;
  registryAddress: string | undefined;
  /** `MON` on Monad. */
  nativeSymbol: string;
  availability(): PinAvailability;
  /** The registry's `minBond`, read from it. */
  readMinBond(): Promise<Decimal>;
  /** The CanonicalSeries contracts this build knows about. Empty means none is deployed. */
  series: SeriesMap;
  pin(target: PinTarget): Promise<PinReceipt>;
  /**
   * Applies a tightened spec at once. The registry decodes the predicates and refuses anything that
   * is not provably stricter, so the caller supplies the predicates now pinned and the new ones.
   */
  tighten(
    chainStrategyId: string,
    target: PinTarget,
    predicates: TightenPredicates,
  ): Promise<{ txHash: string }>;
  /** Starts the registry's own cooling-off for a loosened spec. */
  proposeLoosening(
    chainStrategyId: string,
    target: PinTarget,
  ): Promise<{ txHash: string; cooldownEndsAtMs: number | null }>;
  /** Permissionless: applies a loosening whose cooldown has fully run. */
  finalizeLoosening(chainStrategyId: string): Promise<{ txHash: string }>;
}

export class PinError extends Error {
  readonly code: PinFailure;
  constructor(code: PinFailure, message: string) {
    super(message);
    this.name = 'PinError';
    this.code = code;
  }
}

export const MONAD_CHAIN_ID = 143;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && ADDRESS.test(value);

/** `BTC / USD`, `btc/usd` and `BTC/USD` are the same asset. */
export function normalizeAsset(asset: string): string {
  return asset.replace(/\s+/g, '').toUpperCase();
}

/**
 * Where the CanonicalSeries addresses come from.
 *
 * `env` maps an asset to an address the app read from
 * `NEXT_PUBLIC_/EXPO_PUBLIC_SERIES_*` (each written out literally by the app,
 * because a bundler only inlines what it can see spelled out). `deployments` is
 * the parsed `packages/contracts/deployments/<chainid>.json`, whose keys are
 * `CanonicalSeries<BASE><QUOTE>`. Env wins. Anything that is not an address is
 * absent; nothing is guessed.
 */
export function resolveSeriesMap(input: {
  env?: Record<string, string | undefined> | undefined;
  deployments?: unknown;
}): SeriesMap {
  const out: SeriesMap = {};

  const d = input.deployments;
  if (d && typeof d === 'object') {
    for (const [key, value] of Object.entries(d as Record<string, unknown>)) {
      const m = /^CanonicalSeries([A-Z0-9]+?)(USD|USDC|USDT)$/.exec(key);
      if (!m) continue;
      const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
      const address = obj ? obj['address'] : value;
      if (!isAddress(address)) continue;
      const cadence = obj?.['cadenceSeconds'];
      const bucket = obj?.['bucketSeconds'];
      out[`${m[1]}/${m[2]}`] = {
        address,
        ...(typeof cadence === 'number' ? { cadenceSeconds: cadence } : {}),
        ...(typeof bucket === 'number' ? { bucketSeconds: bucket } : {}),
      };
    }
  }

  for (const [asset, raw] of Object.entries(input.env ?? {})) {
    const address = raw?.trim();
    if (address && isAddress(address)) out[normalizeAsset(asset)] = { address };
  }
  return out;
}

export type PinTargetResult =
  | { ok: true; target: PinTarget }
  | { ok: false; reason: 'series_not_deployed' | 'unencodable'; message: string };

/**
 * The three values a pin carries, derived from the spec. Fails, in words, when
 * there is no deployed series for the spec's asset and cadence, or when the
 * spec cannot be encoded for the gate (a predicate on a timeframe other than
 * the series' bucket).
 */
export async function buildPinTarget(spec: StrategySpec, series: SeriesMap): Promise<PinTargetResult> {
  const asset = normalizeAsset(spec.series.asset);
  const config = series[asset];
  if (!config) {
    return {
      ok: false,
      reason: 'series_not_deployed',
      message: `No canonical series is deployed for ${spec.series.asset}, so this rule cannot be pinned yet. Your draft is saved.`,
    };
  }
  if (
    (config.cadenceSeconds !== undefined && config.cadenceSeconds !== spec.series.cadenceSeconds) ||
    (config.bucketSeconds !== undefined && config.bucketSeconds !== spec.series.bucketSeconds)
  ) {
    return {
      ok: false,
      reason: 'series_not_deployed',
      message: `The deployed ${spec.series.asset} series does not sample at ${spec.series.cadenceSeconds}s into ${spec.series.bucketSeconds}s buckets, so this rule cannot be pinned yet. Your draft is saved.`,
    };
  }

  let commitment: string;
  try {
    commitment = predicatesCommitment(spec);
  } catch (err) {
    return {
      ok: false,
      reason: 'unencodable',
      message: err instanceof Error ? err.message : 'These predicates cannot be encoded for the gate.',
    };
  }
  return {
    ok: true,
    target: { specHash: await hashSpec(spec), predicatesCommitment: commitment, series: config.address },
  };
}

/**
 * Where the registry address comes from.
 *
 * `env` is `NEXT_PUBLIC_REGISTRY_ADDRESS` / `EXPO_PUBLIC_REGISTRY_ADDRESS`,
 * passed in by the app because a bundler only inlines those when they are
 * written out literally. `deployments` is the parsed
 * `packages/contracts/deployments/<chainid>.json`, when a build has one. Env
 * wins, so a deployment can be overridden without a rebuild of the contracts
 * package. A value that is not an address is treated as absent, never guessed at.
 */
export function resolveRegistryAddress(input: {
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
    const candidates = [
      rec['StrategyRegistry'],
      rec['strategyRegistry'],
      rec['registry'],
      nested['StrategyRegistry'],
      nested['strategyRegistry'],
    ];
    for (const c of candidates) {
      const address = typeof c === 'object' && c !== null ? (c as Record<string, unknown>)['address'] : c;
      if (isAddress(address)) return address;
    }
  }
  return undefined;
}

/** What a browser or a device says when it cannot pin, in words that are true. */
export function pinAvailability(input: {
  registryAddress: string | undefined;
  hasWallet: boolean;
}): PinAvailability {
  if (!input.registryAddress) {
    return {
      state: 'not_deployed',
      message:
        'The StrategyRegistry is not deployed on this network yet, so nothing can be pinned. Your draft is saved.',
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

/** A client that can read nothing and write nothing, and says why. Used when there is no registry or no wallet. */
export function unavailablePinClient(input: {
  registryAddress: string | undefined;
  hasWallet: boolean;
  chainId?: number;
  nativeSymbol?: string;
}): PinClient {
  const availability = () => pinAvailability(input);
  const fail = (): never => {
    const a = availability();
    throw new PinError(a.state === 'no_wallet' ? 'no_wallet' : 'not_deployed', 'message' in a ? a.message : 'Pinning is unavailable.');
  };
  return {
    chainId: input.chainId ?? MONAD_CHAIN_ID,
    registryAddress: input.registryAddress,
    nativeSymbol: input.nativeSymbol ?? 'MON',
    availability,
    series: {},
    readMinBond: async () => fail(),
    pin: async () => fail(),
    tighten: async () => fail(),
    proposeLoosening: async () => fail(),
    finalizeLoosening: async () => fail(),
  };
}
