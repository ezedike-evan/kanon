/**
 * Where the vault contracts live, and whether they are there at all.
 *
 * Addresses come from the environment or a `deployments/<chainid>.json`. When
 * neither names a factory the result is `not_deployed` with a plain message,
 * and every screen built on it says exactly that. Nothing here invents an
 * address, and nothing falls back to a demo one in live use.
 */

export interface VaultConfig {
  chainId: number;
  rpcUrl: string;
  /** `VaultFactory`. */
  factory: string;
  /** The collateral token. Read from the factory when the env does not name it. */
  collateralToken: string | undefined;
  /** Block to scan event logs from. */
  startBlock: bigint;
  collateralDecimals: number;
  collateralSymbol: string;
}

/** The raw strings a client reads out of its own environment. */
export interface VaultEnv {
  chainId?: string | undefined;
  rpcUrl?: string | undefined;
  factory?: string | undefined;
  collateralToken?: string | undefined;
  startBlock?: string | undefined;
  collateralDecimals?: string | undefined;
  collateralSymbol?: string | undefined;
}

export type VaultConfigResult =
  | { status: 'ready'; config: VaultConfig }
  | { status: 'not_deployed'; message: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (s: string | undefined): s is string => !!s && ADDRESS.test(s);

export const NOT_DEPLOYED =
  'Vault contracts are not deployed on this network. Nothing here can be created or funded until they are.';

const parseIntStrict = (s: string | undefined): number | undefined =>
  s !== undefined && /^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined;

export function resolveVaultConfig(env: VaultEnv): VaultConfigResult {
  const chainId = parseIntStrict(env.chainId);
  if (!chainId || !env.rpcUrl) {
    return { status: 'not_deployed', message: NOT_DEPLOYED };
  }
  if (!isAddress(env.factory)) {
    return { status: 'not_deployed', message: NOT_DEPLOYED };
  }
  return {
    status: 'ready',
    config: {
      chainId,
      rpcUrl: env.rpcUrl,
      factory: env.factory,
      collateralToken: isAddress(env.collateralToken) ? env.collateralToken : undefined,
      startBlock: BigInt(parseIntStrict(env.startBlock) ?? 0),
      collateralDecimals: parseIntStrict(env.collateralDecimals) ?? 6,
      collateralSymbol: env.collateralSymbol?.trim() || 'USDC',
    },
  };
}

/**
 * Reads a `packages/contracts/deployments/<chainid>.json` into the same shape
 * as the environment. A vault's series is its strategy's pinned series, held by
 * the registry, so no series address is configured here.
 */
export function envFromDeployment(
  deployment: Record<string, unknown>,
  rpcUrl: string,
): VaultEnv {
  const str = (k: string) => (typeof deployment[k] === 'string' ? (deployment[k] as string) : undefined);
  const num = (k: string) => (typeof deployment[k] === 'number' ? String(deployment[k]) : undefined);
  return {
    chainId: num('chainId'),
    rpcUrl,
    factory: str('VaultFactory'),
    collateralToken: str('CollateralToken'),
    startBlock: num('startBlock'),
  };
}
