/**
 * Validation of the Convex deployment's own environment. Pure: takes the env
 * as an argument so it can be tested, and a report names the variables that
 * are wrong, never their values (keys and RPC URLs can carry credentials).
 *
 * Anything a chain-mirroring action needs fails closed: with the variable
 * unset or malformed the action refuses, it does not fall back to trusting the
 * client.
 */

import { z } from "zod";
import { DEFAULT_MONAD_RPC_URL, parseDecimal } from "@kanon/spec";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");
const httpUrl = z
  .string()
  .min(1)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");
const chainId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, "must be a positive integer")
  .transform((s) => Number(s));

export type Env = Record<string, string | undefined>;

export type EnvResult<T> = { ok: true; value: T } | { ok: false; invalid: string[] };

/** Variable names only. Never the values. */
function report<T>(schema: z.ZodType<T>, input: unknown): EnvResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const invalid = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "env")))];
  return { ok: false, invalid };
}

/** A blank variable is an unset one. */
const pick = (env: Env, names: readonly string[]): Record<string, string | undefined> =>
  Object.fromEntries(names.map((n) => [n, env[n]?.trim() || undefined]));

export interface ChainEnv {
  rpcUrl: string;
  chainId: number;
  marketAddress: string | undefined;
  factoryAddress: string | undefined;
}

/**
 * `MONAD_RPC_URL` and `MONAD_CHAIN_ID` are always required. The contract
 * addresses are required only by the action that reads them (`need`).
 */
export function parseChainEnv(
  env: Env,
  need: ReadonlyArray<"market" | "factory"> = [],
): EnvResult<ChainEnv> {
  const schema = z.object({
    MONAD_RPC_URL: httpUrl,
    MONAD_CHAIN_ID: chainId,
    THRESHOLD_MARKET_ADDRESS: need.includes("market") ? address : address.optional(),
    VAULT_FACTORY_ADDRESS: need.includes("factory") ? address : address.optional(),
  });
  const r = report(
    schema,
    pick(env, ["MONAD_RPC_URL", "MONAD_CHAIN_ID", "THRESHOLD_MARKET_ADDRESS", "VAULT_FACTORY_ADDRESS"]),
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      rpcUrl: r.value.MONAD_RPC_URL,
      chainId: r.value.MONAD_CHAIN_ID,
      marketAddress: r.value.THRESHOLD_MARKET_ADDRESS?.toLowerCase(),
      factoryAddress: r.value.VAULT_FACTORY_ADDRESS?.toLowerCase(),
    },
  };
}

export interface RegistryEnv {
  rpcUrl: string;
  chainId: number;
  registryAddress: string;
}

/**
 * Where a rule's pin is checked before its row says `pinned`.
 * `STRATEGY_REGISTRY_ADDRESS` is the deployed StrategyRegistry. Its chain is
 * `STRATEGY_REGISTRY_RPC_URL` with `STRATEGY_REGISTRY_CHAIN_ID` when those are
 * set, and `MONAD_RPC_URL` with `MONAD_CHAIN_ID` otherwise.
 *
 * The registry has its own pair because `MONAD_RPC_URL` is also where the tick
 * ingest reads Pyth (`ticks.ts`): with the registry on testnet and prices read
 * from mainnet, one variable cannot serve both. The pair is never mixed: an
 * RPC of one chain is not used with the id of the other.
 */
export function parseRegistryEnv(env: Env): EnvResult<RegistryEnv> {
  const r = report(
    z.object({
      STRATEGY_REGISTRY_ADDRESS: address,
      STRATEGY_REGISTRY_RPC_URL: httpUrl.optional(),
      STRATEGY_REGISTRY_CHAIN_ID: chainId.optional(),
      MONAD_RPC_URL: httpUrl.optional(),
      MONAD_CHAIN_ID: chainId.optional(),
    }),
    pick(env, [
      "STRATEGY_REGISTRY_ADDRESS",
      "STRATEGY_REGISTRY_RPC_URL",
      "STRATEGY_REGISTRY_CHAIN_ID",
      "MONAD_RPC_URL",
      "MONAD_CHAIN_ID",
    ]),
  );
  if (!r.ok) return r;
  const v = r.value;
  const registryAddress = v.STRATEGY_REGISTRY_ADDRESS.toLowerCase();
  if (v.STRATEGY_REGISTRY_RPC_URL !== undefined || v.STRATEGY_REGISTRY_CHAIN_ID !== undefined) {
    if (v.STRATEGY_REGISTRY_RPC_URL === undefined) return { ok: false, invalid: ["STRATEGY_REGISTRY_RPC_URL"] };
    if (v.STRATEGY_REGISTRY_CHAIN_ID === undefined) return { ok: false, invalid: ["STRATEGY_REGISTRY_CHAIN_ID"] };
    return { ok: true, value: { rpcUrl: v.STRATEGY_REGISTRY_RPC_URL, chainId: v.STRATEGY_REGISTRY_CHAIN_ID, registryAddress } };
  }
  const missing = [
    ...(v.MONAD_RPC_URL === undefined ? ["STRATEGY_REGISTRY_RPC_URL"] : []),
    ...(v.MONAD_CHAIN_ID === undefined ? ["STRATEGY_REGISTRY_CHAIN_ID"] : []),
  ];
  if (v.MONAD_RPC_URL === undefined || v.MONAD_CHAIN_ID === undefined) return { ok: false, invalid: missing };
  return { ok: true, value: { rpcUrl: v.MONAD_RPC_URL, chainId: v.MONAD_CHAIN_ID, registryAddress } };
}

export function parseDashscopeEnv(env: Env): EnvResult<{ apiKey: string }> {
  const r = report(z.object({ DASHSCOPE_API_KEY: z.string().min(8) }), pick(env, ["DASHSCOPE_API_KEY"]));
  return r.ok ? { ok: true, value: { apiKey: r.value.DASHSCOPE_API_KEY } } : r;
}

/**
 * Where the compiler's model is called. By default that is Alibaba Cloud Model
 * Studio (DashScope) with `DASHSCOPE_API_KEY`. `COMPILER_BASE_URL` with
 * `COMPILER_API_KEY` sends it to another OpenAI-compatible host, and
 * `COMPILER_MODEL` names the model to call there. Another host can be another
 * model: whichever it is must support a forced tool call (`compiler.ts`).
 * `COMPILER_THINKING` (`enabled` or `disabled`) is sent as that host's
 * `thinking: { type }` when set: Kimi refuses a forced tool call while its
 * model is thinking, so `kimi-k2.6` is called with `disabled`. Unset, nothing
 * is sent.
 *
 * The two keys are never mixed: a base URL without its own key is a fault, so
 * the DashScope key is never sent to a host that is not DashScope, and a
 * second key without a base URL is a fault for the same reason the other way.
 */
export function parseCompilerEnv(
  env: Env,
): EnvResult<{
  apiKey: string;
  baseUrl: string | undefined;
  model: string | undefined;
  thinking: "enabled" | "disabled" | undefined;
}> {
  const r = report(
    z.object({
      DASHSCOPE_API_KEY: z.string().min(8).optional(),
      COMPILER_API_KEY: z.string().min(8).optional(),
      COMPILER_BASE_URL: httpUrl.optional(),
      COMPILER_MODEL: z.string().min(1).optional(),
      COMPILER_THINKING: z.enum(["enabled", "disabled"]).optional(),
    }),
    pick(env, ["DASHSCOPE_API_KEY", "COMPILER_API_KEY", "COMPILER_BASE_URL", "COMPILER_MODEL", "COMPILER_THINKING"]),
  );
  if (!r.ok) return r;
  const { DASHSCOPE_API_KEY, COMPILER_API_KEY, COMPILER_BASE_URL, COMPILER_MODEL, COMPILER_THINKING } = r.value;
  if (COMPILER_BASE_URL || COMPILER_API_KEY) {
    if (!COMPILER_API_KEY) return { ok: false, invalid: ["COMPILER_API_KEY"] };
    if (!COMPILER_BASE_URL) return { ok: false, invalid: ["COMPILER_BASE_URL"] };
    return {
      ok: true,
      value: { apiKey: COMPILER_API_KEY, baseUrl: COMPILER_BASE_URL, model: COMPILER_MODEL, thinking: COMPILER_THINKING },
    };
  }
  if (!DASHSCOPE_API_KEY) return { ok: false, invalid: ["DASHSCOPE_API_KEY"] };
  return { ok: true, value: { apiKey: DASHSCOPE_API_KEY, baseUrl: undefined, model: COMPILER_MODEL, thinking: COMPILER_THINKING } };
}

/** Nansen is optional by design: unset means "not connected", not a fault. A malformed base URL is a fault. */
export function parseNansenEnv(env: Env): EnvResult<{ apiKey: string | undefined; baseUrl: string | undefined }> {
  const r = report(
    z.object({ NANSEN_API_KEY: z.string().min(8).optional(), NANSEN_BASE_URL: httpUrl.optional() }),
    pick(env, ["NANSEN_API_KEY", "NANSEN_BASE_URL"]),
  );
  return r.ok ? { ok: true, value: { apiKey: r.value.NANSEN_API_KEY, baseUrl: r.value.NANSEN_BASE_URL } } : r;
}

/** Jev's defaults: a pinned version, and how sure it must be before the chat answers without compiling. */
export const JEV_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai/v1",
  model: "jev-1.13.0",
  minProbability: 0.9,
} as const;

/**
 * Chat triage with Jev (`jevLogic.ts`). Optional like Nansen: with no
 * `JEV_API_KEY` every message goes to the compiler, as it always did.
 * `JEV_MIN_PROBABILITY` is a fraction from 0.5 to 1; anything else is a fault.
 */
export function parseJevEnv(
  env: Env,
): EnvResult<{ apiKey: string | undefined; baseUrl: string; model: string; minProbability: number }> {
  const r = report(
    z.object({
      JEV_API_KEY: z.string().min(8).optional(),
      JEV_BASE_URL: httpUrl.optional(),
      JEV_MODEL: z.string().min(1).optional(),
      JEV_MIN_PROBABILITY: z
        .string()
        .regex(/^(0\.\d{1,4}|1(\.0{1,4})?)$/, "must be a fraction such as 0.9")
        .transform(Number)
        .refine((n) => n >= 0.5 && n <= 1, "must be from 0.5 to 1")
        .optional(),
    }),
    pick(env, ["JEV_API_KEY", "JEV_BASE_URL", "JEV_MODEL", "JEV_MIN_PROBABILITY"]),
  );
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      apiKey: r.value.JEV_API_KEY,
      baseUrl: r.value.JEV_BASE_URL ?? JEV_DEFAULTS.baseUrl,
      model: r.value.JEV_MODEL ?? JEV_DEFAULTS.model,
      minProbability: r.value.JEV_MIN_PROBABILITY ?? JEV_DEFAULTS.minProbability,
    },
  };
}

/**
 * The key the gateway presents when it records an order (`http.ts`). It is the
 * same value as `VENUE_RECORDER_KEY` in the gateway's environment, and proves a
 * record comes from the process that sent the order, not from a client. Unset
 * or short, nothing is recorded and so nothing is sent.
 */
export function parseVenueRecorderEnv(env: Env): EnvResult<{ key: string }> {
  const r = report(z.object({ VENUE_RECORDER_KEY: z.string().min(32) }), pick(env, ["VENUE_RECORDER_KEY"]));
  return r.ok ? { ok: true, value: { key: r.value.VENUE_RECORDER_KEY } } : r;
}

// ---------------------------------------------------------------------------
// The signer, the gate and the keeper
// ---------------------------------------------------------------------------

/** A MON amount, read exactly into wei: "0.2" is 2 * 10^17, never a float on the way. */
const mon = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,18})?$/, "must be a MON amount")
  .transform((s) => BigInt(parseDecimal(s, 18).atoms));
/** A gas price in gwei, read exactly into wei. */
const gwei = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,9})?$/, "must be a gwei amount")
  .transform((s) => BigInt(parseDecimal(s, 9).atoms));
const gasUnits = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, "must be a whole number of gas")
  .transform((s) => BigInt(s));
const seconds = z
  .string()
  .regex(/^[1-9]\d{0,6}$/, "must be a whole number of seconds")
  .transform((s) => BigInt(s));
const hexAddress = address.transform((s) => s.toLowerCase() as `0x${string}`);

const WEI_PER_MON = 10n ** 18n;
const WEI_PER_GWEI = 10n ** 9n;

/** Every default here is also in convex/README.md's env table, so none of them is hidden. */
export const SIGNER_DEFAULTS = {
  minBalanceWei: WEI_PER_MON / 5n,
  warnBalanceWei: WEI_PER_MON,
  maxFeePerGasWei: 250n * WEI_PER_GWEI,
  dailySpendWei: 4n * WEI_PER_MON,
  keeperReserveWei: (5n * WEI_PER_MON) / 2n,
} as const;

export const GATE_DEFAULTS = {
  keeperMaxGas: 400_000n,
  gateMaxGas: 2_000_000n,
  maxSourceAgeSeconds: 7_200n,
} as const;

export interface SignerEnv {
  /** Never logged, never stored, never returned by anything a client can call. */
  privateKey: `0x${string}`;
  /** Below this the signer sends nothing. */
  minBalanceWei: bigint;
  /** Below this every tick logs a line asking for a top-up. */
  warnBalanceWei: bigint;
  /** A network gas price above this sends nothing; it is also the `maxFeePerGas` bid. */
  maxFeePerGasWei: bigint;
  /** What the signer may spend in one UTC day, keeper and gate together. */
  dailySpendWei: bigint;
  /**
   * The part of that day the gate may not spend: the keeper's share. A gate check stops at
   * `dailySpendWei - keeperReserveWei`, so judging can never starve the samples it judges on.
   */
  keeperReserveWei: bigint;
}

/**
 * The one key that signs for Kanon on-chain: the keeper's samples now, and the
 * gate's judgments after. `KEEPER_PRIVATE_KEY` is required and is reported by
 * name only, like every other variable here. The amounts default as in
 * `SIGNER_DEFAULTS`.
 */
export function parseSignerEnv(env: Env): EnvResult<SignerEnv> {
  const r = report(
    z.object({
      KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte key"),
      KEEPER_MIN_BALANCE_MON: mon.optional(),
      KEEPER_WARN_BALANCE_MON: mon.optional(),
      KEEPER_MAX_FEE_GWEI: gwei.optional(),
      SIGNER_DAILY_SPEND_MON: mon.optional(),
      KEEPER_RESERVE_MON: mon.optional(),
    }),
    pick(env, [
      "KEEPER_PRIVATE_KEY",
      "KEEPER_MIN_BALANCE_MON",
      "KEEPER_WARN_BALANCE_MON",
      "KEEPER_MAX_FEE_GWEI",
      "SIGNER_DAILY_SPEND_MON",
      "KEEPER_RESERVE_MON",
    ]),
  );
  if (!r.ok) return r;
  const v = r.value;
  return {
    ok: true,
    value: {
      privateKey: v.KEEPER_PRIVATE_KEY as `0x${string}`,
      minBalanceWei: v.KEEPER_MIN_BALANCE_MON ?? SIGNER_DEFAULTS.minBalanceWei,
      warnBalanceWei: v.KEEPER_WARN_BALANCE_MON ?? SIGNER_DEFAULTS.warnBalanceWei,
      maxFeePerGasWei: v.KEEPER_MAX_FEE_GWEI ?? SIGNER_DEFAULTS.maxFeePerGasWei,
      dailySpendWei: v.SIGNER_DAILY_SPEND_MON ?? SIGNER_DEFAULTS.dailySpendWei,
      keeperReserveWei: v.KEEPER_RESERVE_MON ?? SIGNER_DEFAULTS.keeperReserveWei,
    },
  };
}

/** The pairs a keeper series is deployed for. */
export const KEEPER_FEEDS = ["BTC/USD", "ETH/USD"] as const;
export type KeeperFeed = (typeof KEEPER_FEEDS)[number];

/** `BTC/USD` -> `SERIES_BTCUSD_ADDRESS`. */
export const seriesEnvName = (feed: KeeperFeed): string => `SERIES_${feed.replace("/", "")}_ADDRESS`;

/**
 * The CanonicalSeries addresses the keeper keeps fresh, by feed, lower-cased.
 * Each is optional on its own: a pair without its variable is a pair the keeper
 * does not serve, and a rule pinned on it is not counted in use. A malformed
 * address is a fault.
 */
export function parseSeriesEnv(env: Env): EnvResult<Partial<Record<KeeperFeed, `0x${string}`>>> {
  const names = KEEPER_FEEDS.map(seriesEnvName);
  const r = report(z.object(Object.fromEntries(names.map((n) => [n, hexAddress.optional()]))), pick(env, names));
  if (!r.ok) return r;
  const out: Partial<Record<KeeperFeed, `0x${string}`>> = {};
  for (const feed of KEEPER_FEEDS) {
    const a = (r.value as Record<string, `0x${string}` | undefined>)[seriesEnvName(feed)];
    if (a) out[feed] = a;
  }
  return { ok: true, value: out };
}

export interface GateEnv {
  /** The gate's chain: the registry's own pair (`parseRegistryEnv`). */
  rpcUrl: string;
  chainId: number;
  registryAddress: string;
  gateAddress: `0x${string}`;
  /** The testnet `MockPyth` the keeper writes mainnet prices to. */
  mockPythAddress: `0x${string}`;
  series: Partial<Record<KeeperFeed, `0x${string}`>>;
  /** Where mainnet Pyth is read for the mirror: `MONAD_RPC_URL`, as `ticks.ts` reads it. */
  sourceRpcUrl: string;
  /** Gas limit ceilings. Monad bills the limit, not the gas used. */
  keeperMaxGas: bigint;
  gateMaxGas: bigint;
  /** A mainnet price older than this is not mirrored. */
  maxSourceAgeSeconds: bigint;
}

/**
 * Where the gate and the keeper act. The chain and the registry come from
 * `parseRegistryEnv`, so the gate is never on another chain than the rules it
 * judges. `REFUSAL_GATE_ADDRESS` and `MOCK_PYTH_ADDRESS` are required; the
 * series are as `parseSeriesEnv` reads them; the limits default as in
 * `GATE_DEFAULTS`. Every fault is reported, by name, in one list.
 */
export function parseGateEnv(env: Env): EnvResult<GateEnv> {
  const registry = parseRegistryEnv(env);
  const series = parseSeriesEnv(env);
  const r = report(
    z.object({
      REFUSAL_GATE_ADDRESS: hexAddress,
      MOCK_PYTH_ADDRESS: hexAddress,
      MONAD_RPC_URL: httpUrl.optional(),
      KEEPER_MAX_GAS: gasUnits.optional(),
      GATE_MAX_GAS: gasUnits.optional(),
      KEEPER_MAX_SOURCE_AGE_SECONDS: seconds.optional(),
    }),
    pick(env, [
      "REFUSAL_GATE_ADDRESS",
      "MOCK_PYTH_ADDRESS",
      "MONAD_RPC_URL",
      "KEEPER_MAX_GAS",
      "GATE_MAX_GAS",
      "KEEPER_MAX_SOURCE_AGE_SECONDS",
    ]),
  );
  const invalid = [
    ...(registry.ok ? [] : registry.invalid),
    ...(series.ok ? [] : series.invalid),
    ...(r.ok ? [] : r.invalid),
  ];
  if (!registry.ok || !series.ok || !r.ok) return { ok: false, invalid: [...new Set(invalid)] };
  const v = r.value;
  return {
    ok: true,
    value: {
      ...registry.value,
      gateAddress: v.REFUSAL_GATE_ADDRESS,
      mockPythAddress: v.MOCK_PYTH_ADDRESS,
      series: series.value,
      sourceRpcUrl: v.MONAD_RPC_URL ?? DEFAULT_MONAD_RPC_URL,
      keeperMaxGas: v.KEEPER_MAX_GAS ?? GATE_DEFAULTS.keeperMaxGas,
      gateMaxGas: v.GATE_MAX_GAS ?? GATE_DEFAULTS.gateMaxGas,
      maxSourceAgeSeconds: v.KEEPER_MAX_SOURCE_AGE_SECONDS ?? GATE_DEFAULTS.maxSourceAgeSeconds,
    },
  };
}

/**
 * `KEEPER_ENABLED`: `on` or `off`, and off when unset, so a deploy alone never
 * spends anything. Anything else is a fault, and a fault sends nothing either.
 */
export function parseKeeperSwitch(env: Env): EnvResult<boolean> {
  const r = report(z.object({ KEEPER_ENABLED: z.enum(["on", "off"]).optional() }), pick(env, ["KEEPER_ENABLED"]));
  return r.ok ? { ok: true, value: r.value.KEEPER_ENABLED === "on" } : r;
}

/** The readable line logged server-side. Names only. */
export function describeEnvProblem(scope: string, invalid: string[]): string {
  return `${scope}: set or fix ${invalid.join(", ")} on this Convex deployment (npx convex env set <NAME> <value>).`;
}
