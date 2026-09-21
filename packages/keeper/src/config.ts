/**
 * Keeper configuration, from environment variables, validated with Zod.
 *
 *   RPC_URL                  required. Monad JSON-RPC endpoint.
 *   CHAIN_ID                 default 143 (Monad mainnet). The keeper checks the
 *                            RPC reports this chain at the start of every pass.
 *   MARGIN_ACCOUNT_ADDRESS   required. The MarginAccount to police.
 *   START_BLOCK              default 0. First block scanned for `PositionOpened`.
 *                            Set it to the deployment block on a real chain.
 *   LOG_RANGE_BLOCKS         default 1000. Widest eth_getLogs range per request.
 *   REORG_DEPTH_BLOCKS       default 8. Blocks re-scanned on every pass.
 *   EXTRA_ACCOUNTS           optional, comma-separated addresses always checked,
 *                            in addition to whatever discovery finds.
 *   MAX_GAS_PRICE_WEI        default 1e12 (1000 gwei). No tx is sent while the
 *                            network gas price is above this, and no tx can bid
 *                            more than this per gas.
 *   MAX_GAS_PER_TX           default 1500000. A tx whose gas estimate is above
 *                            this is not sent.
 *   MAX_TXS_PER_PASS         default 20. Spend budget per pass.
 *   MAX_ACTIONS_PER_ACCOUNT  default 8. Bounds the deleverage/liquidate loop on
 *                            one account within a pass.
 *   RECORD_SAMPLES           default true. When an account cannot be priced
 *                            because nobody has called `recordSample()` in the
 *                            current bucket, the keeper calls it (permissionless,
 *                            same caps, same dry-run rule).
 *   KEEPER_ADDRESS           optional sender for dry-run simulations when no key
 *                            is configured.
 *   KEEPER_BROADCAST         must be exactly `true` to send transactions.
 *                            Anything else, including unset, is a dry run.
 *   PRIVATE_KEY              required only when broadcasting.
 *
 * Broadcasting takes two independent switches on purpose: the env flag here,
 * and the absence of `--dry-run` on the command line. Either one alone keeps
 * the keeper read-only.
 */

import { z } from 'zod';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address')
  .transform((v) => v as `0x${string}`);

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte 0x-prefixed hex key')
  .transform((v) => v as `0x${string}`);

const weiInt = (dflt: string) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .default(dflt)
    .transform((v) => BigInt(v));

const positiveInt = (dflt: number) => z.coerce.number().int().positive().default(dflt);

const addressList = z.string().transform((raw, ctx): `0x${string}`[] => {
  const out: `0x${string}`[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const parsed = address.safeParse(part);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: `"${part.slice(0, 12)}...": ${parsed.error.issues[0]?.message ?? 'invalid'}` });
      continue;
    }
    const key = parsed.data.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
  }
  return out;
});

const EnvSchema = z
  .object({
    RPC_URL: z.url(),
    CHAIN_ID: positiveInt(143),
    MARGIN_ACCOUNT_ADDRESS: address,
    START_BLOCK: weiInt('0'),
    LOG_RANGE_BLOCKS: positiveInt(1000),
    REORG_DEPTH_BLOCKS: z.coerce.number().int().nonnegative().default(8),
    EXTRA_ACCOUNTS: addressList.default([]),
    MAX_GAS_PRICE_WEI: weiInt('1000000000000'),
    MAX_GAS_PER_TX: weiInt('1500000'),
    MAX_TXS_PER_PASS: positiveInt(20),
    MAX_ACTIONS_PER_ACCOUNT: positiveInt(8),
    RECORD_SAMPLES: z.enum(['true', 'false']).default('true'),
    KEEPER_ADDRESS: address.optional(),
    KEEPER_BROADCAST: z.enum(['true', 'false']).default('false'),
    PRIVATE_KEY: privateKey.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.KEEPER_BROADCAST === 'true' && !env.PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['PRIVATE_KEY'], message: 'required when KEEPER_BROADCAST=true' });
    }
    if (env.MAX_GAS_PRICE_WEI === 0n) {
      ctx.addIssue({ code: 'custom', path: ['MAX_GAS_PRICE_WEI'], message: 'must be greater than zero' });
    }
    if (env.MAX_GAS_PER_TX === 0n) {
      ctx.addIssue({ code: 'custom', path: ['MAX_GAS_PER_TX'], message: 'must be greater than zero' });
    }
  });

export interface KeeperConfig {
  rpcUrl: string;
  chainId: number;
  marginAddress: `0x${string}`;
  startBlock: bigint;
  logRangeBlocks: bigint;
  reorgDepthBlocks: bigint;
  extraAccounts: `0x${string}`[];
  maxGasPriceWei: bigint;
  maxGasPerTx: bigint;
  maxTxsPerPass: number;
  maxActionsPerAccount: number;
  recordSamples: boolean;
  senderAddress?: `0x${string}` | undefined;
  privateKey?: `0x${string}` | undefined;
  /** True only when the env flag says so AND the CLI did not pass `--dry-run`. */
  broadcast: boolean;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid keeper configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
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
): KeeperConfig {
  const parsed = EnvSchema.safeParse(clean(env));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    rpcUrl: e.RPC_URL,
    chainId: e.CHAIN_ID,
    marginAddress: e.MARGIN_ACCOUNT_ADDRESS,
    startBlock: e.START_BLOCK,
    logRangeBlocks: BigInt(e.LOG_RANGE_BLOCKS),
    reorgDepthBlocks: BigInt(e.REORG_DEPTH_BLOCKS),
    extraAccounts: e.EXTRA_ACCOUNTS,
    maxGasPriceWei: e.MAX_GAS_PRICE_WEI,
    maxGasPerTx: e.MAX_GAS_PER_TX,
    maxTxsPerPass: e.MAX_TXS_PER_PASS,
    maxActionsPerAccount: e.MAX_ACTIONS_PER_ACCOUNT,
    recordSamples: e.RECORD_SAMPLES === 'true',
    senderAddress: e.KEEPER_ADDRESS,
    privateKey: e.PRIVATE_KEY,
    broadcast: e.KEEPER_BROADCAST === 'true' && opts.dryRun !== true,
  };
}
