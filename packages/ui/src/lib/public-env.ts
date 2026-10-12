/**
 * Boot-time validation of a client's public environment.
 *
 * Each app passes its `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` values in, read out
 * literally (a bundler only inlines variables it can see spelled out), so this
 * module is pure and testable. A wrong value stops the app at start with a
 * message naming the variable and what it should be. The message never
 * contains the value: URLs and ids in these can carry credentials.
 *
 * Hand-written rather than Zod: `@kanon/ui` and the apps do not depend on it.
 */

export interface PublicEnvInput {
  convexUrl: string | undefined;
  privyAppId: string | undefined;
  /** Mobile only. */
  privyClientId?: string | undefined;
  chainId: string | undefined;
  registryAddress: string | undefined;
  thresholdMarketAddress: string | undefined;
  vaultChainId: string | undefined;
  vaultRpcUrl: string | undefined;
  vaultFactoryAddress: string | undefined;
  vaultCollateralAddress: string | undefined;
  vaultStartBlock: string | undefined;
  vaultCollateralDecimals: string | undefined;
  /** The market data gateway. Unset, charts read their candles from Convex. */
  gatewayUrl?: string | undefined;
  /** The Kanon indexer's GraphQL endpoint on Envio. Unset, the on-chain record says it is not connected. */
  indexerUrl?: string | undefined;
}

export interface PublicEnvProblem {
  name: string;
  expected: string;
}

export interface PublicEnvNames {
  convexUrl: string;
  privyAppId: string;
  privyClientId: string;
  chainId: string;
  registryAddress: string;
  thresholdMarketAddress: string;
  vaultChainId: string;
  vaultRpcUrl: string;
  vaultFactoryAddress: string;
  vaultCollateralAddress: string;
  vaultStartBlock: string;
  vaultCollateralDecimals: string;
  gatewayUrl: string;
  indexerUrl: string;
}

const names = (prefix: string): PublicEnvNames => ({
  convexUrl: `${prefix}_CONVEX_URL`,
  privyAppId: `${prefix}_PRIVY_APP_ID`,
  privyClientId: `${prefix}_PRIVY_CLIENT_ID`,
  chainId: `${prefix}_CHAIN_ID`,
  registryAddress: `${prefix}_REGISTRY_ADDRESS`,
  thresholdMarketAddress: `${prefix}_THRESHOLD_MARKET_ADDRESS`,
  vaultChainId: `${prefix}_VAULT_CHAIN_ID`,
  vaultRpcUrl: `${prefix}_VAULT_RPC_URL`,
  vaultFactoryAddress: `${prefix}_VAULT_FACTORY_ADDRESS`,
  vaultCollateralAddress: `${prefix}_VAULT_COLLATERAL_ADDRESS`,
  vaultStartBlock: `${prefix}_VAULT_START_BLOCK`,
  vaultCollateralDecimals: `${prefix}_VAULT_COLLATERAL_DECIMALS`,
  gatewayUrl: `${prefix}_GATEWAY_URL`,
  indexerUrl: `${prefix}_INDEXER_URL`,
});

export const WEB_ENV_NAMES = names('NEXT_PUBLIC');
export const MOBILE_ENV_NAMES = names('EXPO_PUBLIC');

const blank = (s: string | undefined): s is undefined => s === undefined || s.trim() === '';
const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
const isUint = (s: string) => /^\d{1,15}$/.test(s.trim());

export interface PublicEnvOptions {
  platform: 'web' | 'mobile';
  /**
   * Whether the always-needed values (Convex URL, Privy ids) must be present.
   * False during a server-side build, where the browser's env is not the point.
   */
  requireCore: boolean;
}

/** Every problem with `env`, by variable name. Empty means the env is fine. */
export function validatePublicEnv(env: PublicEnvInput, opts: PublicEnvOptions): PublicEnvProblem[] {
  const n = opts.platform === 'web' ? WEB_ENV_NAMES : MOBILE_ENV_NAMES;
  const problems: PublicEnvProblem[] = [];
  const need = (name: string, value: string | undefined, ok: (s: string) => boolean, expected: string) => {
    if (blank(value)) problems.push({ name, expected: `${expected} (required)` });
    else if (!ok(value)) problems.push({ name, expected });
  };
  const maybe = (name: string, value: string | undefined, ok: (s: string) => boolean, expected: string) => {
    if (!blank(value) && !ok(value)) problems.push({ name, expected });
  };

  if (opts.requireCore) {
    need(n.convexUrl, env.convexUrl, isHttpUrl, 'an https URL');
    need(n.privyAppId, env.privyAppId, (s) => s.trim().length >= 8 && !/\s/.test(s.trim()), 'a Privy app id');
    if (opts.platform === 'mobile') {
      need(n.privyClientId, env.privyClientId, (s) => s.trim().length >= 8 && !/\s/.test(s.trim()), 'a Privy client id');
    }
  } else {
    maybe(n.convexUrl, env.convexUrl, isHttpUrl, 'an https URL');
  }
  maybe(n.chainId, env.chainId, isUint, 'a chain id such as 143 or 10143');
  maybe(n.registryAddress, env.registryAddress, isAddress, 'a 0x address');
  maybe(n.thresholdMarketAddress, env.thresholdMarketAddress, isAddress, 'a 0x address');
  maybe(n.vaultChainId, env.vaultChainId, isUint, 'a chain id');
  maybe(n.vaultRpcUrl, env.vaultRpcUrl, isHttpUrl, 'an http(s) URL');
  maybe(n.vaultFactoryAddress, env.vaultFactoryAddress, isAddress, 'a 0x address');
  maybe(n.vaultCollateralAddress, env.vaultCollateralAddress, isAddress, 'a 0x address');
  maybe(n.vaultStartBlock, env.vaultStartBlock, isUint, 'a block number');
  maybe(
    n.vaultCollateralDecimals,
    env.vaultCollateralDecimals,
    (s) => isUint(s) && Number(s) <= 36,
    'an integer from 0 to 36',
  );
  maybe(n.gatewayUrl, env.gatewayUrl, isHttpUrl, 'an http(s) URL');
  maybe(n.indexerUrl, env.indexerUrl, isHttpUrl, 'an http(s) URL');
  return problems;
}

/** The message shown at boot. Names and expectations only. */
export function describePublicEnvProblems(problems: PublicEnvProblem[]): string {
  return [
    'Kanon cannot start: the public environment is wrong.',
    ...problems.map((p) => `  ${p.name}: expected ${p.expected}`),
  ].join('\n');
}

/** Throws one readable error listing every problem. Returns normally when the env is fine. */
export function assertPublicEnv(env: PublicEnvInput, opts: PublicEnvOptions): void {
  const problems = validatePublicEnv(env, opts);
  if (problems.length > 0) throw new Error(describePublicEnvProblems(problems));
}
