import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { canTakeSide, marketPhase } from "@kanon/spec";
import { decimal } from "./schema";
import { isValidStake } from "./marketsLogic";
import { requireUser, viewOwnedPrediction, viewerUser } from "./authz";

/**
 * Internal: a prediction row with no market and no transaction is a client's
 * bare claim. Stakes are recorded by `recordPosition`, against a receipt.
 */
export const createPrediction = internalMutation({
  args: {
    userId: v.id("users"),
    asset: v.string(),
    direction: v.union(v.literal("above"), v.literal("below")),
    thresholdPrice: decimal,
    windowStart: v.number(),
    windowEnd: v.number(),
    side: v.union(v.literal("above"), v.literal("below")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("predictions", {
      ...args,
      status: "open",
    });
  },
});

export const getPrediction = query({
  args: { predictionId: v.id("predictions") },
  handler: async (ctx, args) => {
    return (await viewOwnedPrediction(ctx, args.predictionId))?.prediction ?? null;
  },
});

export const listPredictionsByOwner = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("predictions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/**
 * Settlement of a stake is `markets:settlePositions`, driven by the sweep from
 * the market's own result. This lower-level write is internal so that no client
 * can declare its own prediction won.
 */
export const settlePrediction = internalMutation({
  args: {
    predictionId: v.id("predictions"),
    result: v.union(v.literal("won"), v.literal("lost"), v.literal("refunded")),
    decidingPrice: decimal,
    decidingAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.patch(args.predictionId, {
      status: "settled",
      result: args.result,
      decidingPrice: args.decidingPrice,
      decidingAt: args.decidingAt,
    });
  },
});

/**
 * Records a stake the chain has already accepted. Nothing here moves money and
 * nothing here invents a stake: the client calls it with the `takeSide`
 * transaction hash once the receipt is in, and a market that is closed by the
 * server's clock (window over, or threshold already touched) refuses it.
 *
 * `side` is the price side the person took: `above` is UP, `below` is DOWN.
 * Idempotent on the transaction hash.
 */
export const recordPosition = mutation({
  args: {
    marketId: v.id("markets"),
    side: v.union(v.literal("above"), v.literal("below")),
    stake: decimal,
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) throw new Error("not a transaction hash");
    if (!isValidStake(args.stake)) throw new Error("stake must be a positive amount");

    const market = await ctx.db.get(args.marketId);
    if (!market) throw new Error("no such market");
    if (!canTakeSide(marketPhase(market, Math.floor(Date.now() / 1000)))) {
      throw new Error("market is closed to new sides");
    }

    const existing = await ctx.db
      .query("predictions")
      .withIndex("by_market", (q) => q.eq("marketId", args.marketId))
      .filter((q) => q.eq(q.field("txHash"), args.txHash))
      .first();
    if (existing) {
      if (existing.userId !== user._id) throw new Error("that transaction is already recorded");
      return existing._id;
    }

    return await ctx.db.insert("predictions", {
      userId: user._id,
      asset: market.asset,
      direction: market.direction,
      thresholdPrice: market.thresholdPrice,
      windowStart: market.windowStart,
      windowEnd: market.windowEnd,
      side: args.side,
      status: "open",
      marketId: args.marketId,
      stake: args.stake,
      txHash: args.txHash,
    });
  },
});

/** The signed-in user's stakes on markets, newest first. Bounded: the feed shows recent ones. */
export const listMarketPositions = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("predictions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(300);
    return rows.filter((p) => p.marketId !== undefined);
  },
});
