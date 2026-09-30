import { action, internalMutation, internalQuery } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { NansenFlow } from "@kanon/spec";
import { requireSubject } from "./authz";
import { checkRateLimit } from "./rateLimit";
import { describeEnvProblem, parseNansenEnv } from "./serverEnv";
import {
  fetchSmartMoneyFlow,
  isFresh,
  nansenAssetKey,
  type FetchLike,
} from "./nansenLogic";

/**
 * Smart-money net flow from Nansen, for the asset on the analytics screen.
 *
 * The key is read from the Convex deployment's environment, never a client:
 *
 *   NANSEN_API_KEY   set to connect. Unset, the action returns `not_connected`
 *                    without making a request, and the card says so.
 *
 * The action takes no user data and returns nothing private, but it needs a
 * signed-in caller, and each upstream call costs 5 credits, so a fresh cached read (10 minutes) is served instead
 * of buying another. That bounds spend to one call per asset per window however
 * often screens are opened. Only a successful read is cached.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

const readCacheRef = makeFunctionReference<
  "query",
  { asset: string },
  { fetchedAt: number; flow: NansenFlow } | null
>("nansen:readCache");

const writeCacheRef = makeFunctionReference<
  "mutation",
  { asset: string; fetchedAt: number; flow: NansenFlow },
  null
>("nansen:writeCache");

export const readCache = internalQuery({
  args: { asset: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("nansenFlowCache")
      .withIndex("by_asset", (q) => q.eq("asset", args.asset))
      .order("desc")
      .first();
    return row ? { fetchedAt: row.fetchedAt, flow: row.flow as NansenFlow } : null;
  },
});

export const writeCache = internalMutation({
  args: { asset: v.string(), fetchedAt: v.number(), flow: v.any() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("nansenFlowCache")
      .withIndex("by_asset", (q) => q.eq("asset", args.asset))
      .take(20);
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.insert("nansenFlowCache", {
      asset: args.asset,
      fetchedAt: args.fetchedAt,
      flow: args.flow,
    });
    return null;
  },
});

export const smartMoneyFlow = action({
  args: { asset: v.string() },
  handler: async (ctx, args): Promise<NansenFlow> => {
    // Each upstream read spends Nansen credits, so it is for signed-in users only.
    const subject = await requireSubject(ctx);
    const asset = nansenAssetKey(args.asset);
    const now = Date.now();

    const env = parseNansenEnv(process.env);
    if (!env.ok) {
      console.error(describeEnvProblem("nansen:smartMoneyFlow", env.invalid));
      return { status: "not_connected" };
    }
    const apiKey = env.value.apiKey;
    // No key: nothing is fetched and nothing cached is served. A cached figure
    // from a key that has since been removed is not something to keep showing.
    if (!apiKey) return { status: "not_connected" };

    const cached = await ctx.runQuery(readCacheRef, { asset });
    if (cached && isFresh(cached.fetchedAt, now)) return cached.flow;

    // Only a cache miss buys credits, so only a miss spends a slot.
    const limited = await checkRateLimit(ctx, subject, "nansen");
    if (limited) return { status: "error", kind: "rate_limited", message: limited.message };

    const flow = await fetchSmartMoneyFlow(asset, {
      apiKey,
      fetch: fetch as unknown as FetchLike,
      now,
      baseUrl: env.value.baseUrl,
    });
    if (flow.status === "ok") {
      await ctx.runMutation(writeCacheRef, { asset, fetchedAt: now, flow });
    }
    return flow;
  },
});
