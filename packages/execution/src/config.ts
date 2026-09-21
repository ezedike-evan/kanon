/**
 * Environment configuration for the execution layer, validated with Zod.
 *
 * The rule (docs/ARCHITECTURE.md, SCOPE.md kill criteria): execution defaults
 * to PAPER. A venue goes live only when `KANON_EXECUTION_MODE=live` AND that
 * venue's credentials are all present. Half-set credentials are a
 * configuration error, not a silent downgrade. A live request with no
 * credentials falls back to paper for that venue and says so in `warnings`,
 * and every leg of every report carries the mode it actually ran in.
 *
 * Nothing secret is defaulted, hard-coded or logged.
 */

import { z } from 'zod';
import type { PerplNetwork } from './perpl-constants';
import type { KuruNetwork } from './kuru';

const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex');
const evmKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex private key');

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const ExecutionEnvSchema = z
  .object({
    KANON_EXECUTION_MODE: z.enum(['paper', 'live']).default('paper'),

    KANON_PERPL_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
    /** Opaque X-API-Key token from Perpl enrollment. */
    PERPL_API_KEY: z.string().min(1).optional(),
    /** Ed25519 secret for that key, 32 bytes hex. */
    PERPL_API_KEY_SECRET: hex32.optional(),
    /** On-chain exchange account id (`getAccountByAddr`). */
    PERPL_ACCOUNT_ID: z.coerce.number().int().positive().optional(),
    KANON_PERPL_DEFAULT_LEVERAGE: z.coerce.number().int().min(1).default(1),

    KANON_KURU_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
    KANON_KURU_PRIVATE_KEY: evmKey.optional(),
    KANON_KURU_RPC_URL: z.url().optional(),
    /** Which stablecoin a USD-quoted spot asset ("MON/USD") routes to. AUSD
     * is the Agora bounty's margin asset. */
    KANON_KURU_QUOTE: z.enum(['AUSD', 'USDC']).default('AUSD'),
    KANON_KURU_USE_MARGIN: boolish.default(true),

    /** Market-order slippage cap in bps when a trade carries none. Absent =
     * venue default on Perpl, 50 bps on Kuru. */
    KANON_DEFAULT_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(9_999).optional(),
  })
  .superRefine((env, ctx) => {
    const perpl = [env.PERPL_API_KEY, env.PERPL_API_KEY_SECRET, env.PERPL_ACCOUNT_ID];
    if (perpl.some((v) => v !== undefined) && perpl.some((v) => v === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'PERPL_API_KEY, PERPL_API_KEY_SECRET and PERPL_ACCOUNT_ID must all be set together',
        path: ['PERPL_API_KEY'],
      });
    }
  });

export type ExecutionEnv = z.infer<typeof ExecutionEnvSchema>;

export interface PerplCredentials {
  apiKey: string;
  secretKeyHex: string;
  accountId: number;
}

export interface ResolvedExecutionConfig {
  /** What was asked for. */
  requestedMode: 'paper' | 'live';
  perpl: { network: PerplNetwork; mode: 'paper' | 'live'; credentials?: PerplCredentials; defaultLeverageX: number };
  kuru: {
    network: KuruNetwork;
    mode: 'paper' | 'live';
    privateKey?: string;
    rpcUrl?: string;
    quote: 'AUSD' | 'USDC';
    useMargin: boolean;
  };
  defaultMaxSlippageBps?: number;
  /** Human-readable notes, e.g. a live request downgraded for lack of credentials. */
  warnings: string[];
}

/** Parses and validates the environment. Throws a `ZodError` on a malformed
 * or half-set value. Never returns a secret in an error message. */
export function resolveExecutionConfig(env: Record<string, string | undefined>): ResolvedExecutionConfig {
  const parsed = ExecutionEnvSchema.parse(env);
  const warnings: string[] = [];
  const wantsLive = parsed.KANON_EXECUTION_MODE === 'live';

  const perplCreds: PerplCredentials | undefined =
    parsed.PERPL_API_KEY !== undefined && parsed.PERPL_API_KEY_SECRET !== undefined && parsed.PERPL_ACCOUNT_ID !== undefined
      ? { apiKey: parsed.PERPL_API_KEY, secretKeyHex: parsed.PERPL_API_KEY_SECRET, accountId: parsed.PERPL_ACCOUNT_ID }
      : undefined;
  const perplLive = wantsLive && perplCreds !== undefined;
  if (wantsLive && !perplLive) warnings.push('KANON_EXECUTION_MODE=live but Perpl credentials are missing: perps stay in paper mode');

  const kuruLive = wantsLive && parsed.KANON_KURU_PRIVATE_KEY !== undefined;
  if (wantsLive && !kuruLive) warnings.push('KANON_EXECUTION_MODE=live but KANON_KURU_PRIVATE_KEY is missing: spot stays in paper mode');

  return {
    requestedMode: parsed.KANON_EXECUTION_MODE,
    perpl: {
      network: parsed.KANON_PERPL_NETWORK,
      mode: perplLive ? 'live' : 'paper',
      ...(perplLive && perplCreds ? { credentials: perplCreds } : {}),
      defaultLeverageX: parsed.KANON_PERPL_DEFAULT_LEVERAGE,
    },
    kuru: {
      network: parsed.KANON_KURU_NETWORK,
      mode: kuruLive ? 'live' : 'paper',
      ...(kuruLive && parsed.KANON_KURU_PRIVATE_KEY ? { privateKey: parsed.KANON_KURU_PRIVATE_KEY } : {}),
      ...(parsed.KANON_KURU_RPC_URL ? { rpcUrl: parsed.KANON_KURU_RPC_URL } : {}),
      quote: parsed.KANON_KURU_QUOTE,
      useMargin: parsed.KANON_KURU_USE_MARGIN,
    },
    ...(parsed.KANON_DEFAULT_MAX_SLIPPAGE_BPS !== undefined ? { defaultMaxSlippageBps: parsed.KANON_DEFAULT_MAX_SLIPPAGE_BPS } : {}),
    warnings,
  };
}
