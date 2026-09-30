import { query } from "./_generated/server";
import { MAX_COUNT_ROWS } from "./limits";
import { v } from "convex/values";
import { isMarketAsset } from "@kanon/spec";
import { normalizeAsset } from "./seriesLogic";
import {
  MAX_LEADS,
  assembleSpark,
  leadSummary,
  rankLeads,
  sparkSampleTimes,
  type LeadSummary,
  type SparkSample,
} from "./homeFeedLogic";

/**
 * What the Home tab reads that the price and activity queries do not carry.
 * Both are market or marketplace data with nothing per-user in them, so both
 * are on the public-by-design list in `publicSurface.test.ts`.
 */

/**
 * A pair's last day as a line: one sample per two hours plus the newest print.
 *
 * A dozen index reads per pair, each on a fixed grid so only the last one moves
 * when a price prints (see `sparkSampleTimes`). Assets without a Pyth feed
 * return no line: AVAX is not a market, so it is not drawn as one.
 */
export const sparkline = query({
  args: { asset: v.string() },
  handler: async (ctx, args): Promise<{ asset: string; points: number[] }> => {
    const asset = normalizeAsset(args.asset);
    if (!isMarketAsset(asset)) return { asset, points: [] };

    const latestRow = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", asset))
      .order("desc")
      .first();
    if (!latestRow) return { asset, points: [] };
    const latest: SparkSample = { price: latestRow.price, publishTime: latestRow.publishTime };

    const instants = sparkSampleTimes(latest.publishTime);
    const samples: (SparkSample | null)[] = [];
    for (const at of instants) {
      const row = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) => q.eq("asset", asset).gte("publishTime", at))
        .order("asc")
        .first();
      samples.push(row ? { price: row.price, publishTime: row.publishTime } : null);
    }
    return { asset, points: assembleSpark(instants, samples, latest) };
  },
});

/**
 * Strategies listed for copying, as cards: how faithfully each followed its own
 * rule and how many people follow it. Listing is the owner's opt-in, so a
 * strategy appears only once they chose it, and the rows carry no user ids.
 */
export const leadSummaries = query({
  args: {},
  handler: async (ctx): Promise<LeadSummary[]> => {
    const leads = await ctx.db
      .query("copyLeads")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(100);
    const out: LeadSummary[] = [];
    for (const lead of leads) {
      const strategy = await ctx.db.get(lead.strategyId);
      const count = async (status: "executed" | "refused") =>
        (
          await ctx.db
            .query("trades")
            .withIndex("by_strategy_and_status", (q) =>
              q.eq("strategyId", lead.strategyId).eq("status", status),
            )
            .take(MAX_COUNT_ROWS)
        ).length;
      const followers = (
        await ctx.db
          .query("copyRelationships")
          .withIndex("by_leaderStrategy", (q) => q.eq("leaderStrategyId", lead.strategyId))
          .take(1000)
      ).filter((r) => r.active).length;
      out.push(
        leadSummary({
          leadId: lead._id,
          strategyId: lead.strategyId,
          spec: strategy?.spec ?? null,
          taken: await count("executed"),
          blocked: await count("refused"),
          followers,
          profitShareBps: lead.profitShareBps,
        }),
      );
    }
    return rankLeads(out).slice(0, MAX_LEADS);
  },
});
