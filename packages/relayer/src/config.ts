/**
 * Relayer configuration, from environment variables, validated with Zod.
 *
 *   RPC_URL                 required. Monad JSON-RPC endpoint.
 *   CHAIN_ID                default 143 (Monad mainnet). The relayer checks the
 *                           RPC reports this chain before doing anything.
 *   PYTH_ADDRESS            default: the Pyth PriceFeed proxy in
 *                           packages/contracts/script/PythMonad.sol.
 *   SERIES_ADDRESSES        required. Comma-separated `SYMBOL=0xAddress` pairs,
 *                           one CanonicalSeries per asset, e.g.
 *                           `BTC/USD=0xabc...,ETH/USD=0xdef...`. Each symbol
 *                           must have a Pyth feed (see `PYTH_FEEDS`).
 *   HERMES_URL              default https://hermes.pyth.network
 *   HERMES_API_KEY          optional, for a keyed Hermes endpoint
 *   HERMES_API_KEY_HEADER   optional, default `Authorization` (sent as Bearer)
 *   MAX_UPDATE_FEE_WEI      default 1e15 (0.001 MON). The relayer refuses to
 *                           pay a Pyth update fee above this.
 *   RELAYER_ADDRESS         optional sender for dry-run simulations when no key
 *                           is configured.
 *   RELAYER_BROADCAST       must be exactly `true` to send transactions.
 *                           Anything else, including unset, is a dry run.
 *   PRIVATE_KEY             required only when broadcasting.
 *
 * Broadcasting takes two independent switches on purpose: the env flag here,
 * and the absence of `--dry-run` on the command line (`loadConfig`'s
 * `dryRun`). Either one alone keeps the relayer read-only.
 */

import { z } from 'zod';
import {
  DEFAULT_HERMES_URL,
  PYTH_FEEDS,
  PYTH_MONAD_ADDRESS,
  type HermesConfig,
} from '@kanon/spec';

export { PYTH_MONAD_ADDRESS };

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address')
  .transform((v) => v as `0x${string}`);

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte 0x-prefixed hex key')
  .transform((v) => v as `0x${string}`);

export interface SeriesTarget {
  symbol: string;
  feedId: `0x${string}`;
  address: `0x${string}`;
}

const seriesList = z.string().transform((raw, ctx): SeriesTarget[] => {
  const targets: SeriesTarget[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const symbol = (eq === -1 ? part : part.slice(0, eq)).trim().toUpperCase();
    const addr = eq === -1 ? '' : part.slice(eq + 1).trim();
    const feedId = PYTH_FEEDS[symbol];
    if (!feedId) {
      ctx.addIssue({ code: 'custom', message: `"${symbol}" has no Pyth feed` });
      continue;
    }
    const parsed = address.safeParse(addr);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: `${symbol}: address ${parsed.error.issues[0]?.message ?? 'invalid'}` });
      continue;
    }
    if (seen.has(symbol)) {
      ctx.addIssue({ code: 'custom', message: `${symbol} listed twice` });
      continue;
    }
    seen.add(symbol);
    targets.push({ symbol, feedId, address: parsed.data });
  }
  if (targets.length === 0) ctx.addIssue({ code: 'custom', message: 'at least one series is required' });
  return targets;
});

const EnvSchema = z
  .object({
    RPC_URL: z.url(),
    CHAIN_ID: z.coerce.number().int().positive().default(143),
    PYTH_ADDRESS: address.default(PYTH_MONAD_ADDRESS),
    SERIES_ADDRESSES: seriesList,
    HERMES_URL: z.url().default(DEFAULT_HERMES_URL),
    HERMES_API_KEY: z.string().min(1).optional(),
    HERMES_API_KEY_HEADER: z.string().min(1).optional(),
    MAX_UPDATE_FEE_WEI: z
      .string()
      .regex(/^\d+$/, 'must be a non-negative integer in wei')
      .default('1000000000000000'),
    RELAYER_ADDRESS: address.optional(),
    RELAYER_BROADCAST: z.enum(['true', 'false']).default('false'),
    PRIVATE_KEY: privateKey.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.RELAYER_BROADCAST === 'true' && !env.PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['PRIVATE_KEY'], message: 'required when RELAYER_BROADCAST=true' });
    }
  });

export interface RelayerConfig {
  rpcUrl: string;
  chainId: number;
  pythAddress: `0x${string}`;
  series: SeriesTarget[];
  hermes: HermesConfig;
  maxUpdateFeeWei: bigint;
  senderAddress?: `0x${string}` | undefined;
  privateKey?: `0x${string}` | undefined;
  /** True only when the env flag says so AND the CLI did not pass `--dry-run`. */
  broadcast: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid relayer configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Empty strings are treated as unset, so a blank line in a .env file does not defeat a default. */
function clean(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') out[k] = v.trim();
  return out;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  opts: { dryRun?: boolean } = {},
): RelayerConfig {
  const parsed = EnvSchema.safeParse(clean(env));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    rpcUrl: e.RPC_URL,
    chainId: e.CHAIN_ID,
    pythAddress: e.PYTH_ADDRESS,
    series: e.SERIES_ADDRESSES,
    hermes: { baseUrl: e.HERMES_URL, apiKey: e.HERMES_API_KEY, apiKeyHeader: e.HERMES_API_KEY_HEADER },
    maxUpdateFeeWei: BigInt(e.MAX_UPDATE_FEE_WEI),
    senderAddress: e.RELAYER_ADDRESS,
    privateKey: e.PRIVATE_KEY,
    broadcast: e.RELAYER_BROADCAST === 'true' && opts.dryRun !== true,
  };
}
