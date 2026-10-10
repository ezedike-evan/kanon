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

export function parseDashscopeEnv(env: Env): EnvResult<{ apiKey: string }> {
  const r = report(z.object({ DASHSCOPE_API_KEY: z.string().min(8) }), pick(env, ["DASHSCOPE_API_KEY"]));
  return r.ok ? { ok: true, value: { apiKey: r.value.DASHSCOPE_API_KEY } } : r;
}

/** Nansen is optional by design: unset means "not connected", not a fault. A malformed base URL is a fault. */
export function parseNansenEnv(env: Env): EnvResult<{ apiKey: string | undefined; baseUrl: string | undefined }> {
  const r = report(
    z.object({ NANSEN_API_KEY: z.string().min(8).optional(), NANSEN_BASE_URL: httpUrl.optional() }),
    pick(env, ["NANSEN_API_KEY", "NANSEN_BASE_URL"]),
  );
  return r.ok ? { ok: true, value: { apiKey: r.value.NANSEN_API_KEY, baseUrl: r.value.NANSEN_BASE_URL } } : r;
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

/** The readable line logged server-side. Names only. */
export function describeEnvProblem(scope: string, invalid: string[]): string {
  return `${scope}: set or fix ${invalid.join(", ")} on this Convex deployment (npx convex env set <NAME> <value>).`;
}
