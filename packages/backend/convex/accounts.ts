import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assetClass, decimal } from "./schema";
import { viewOwnedAccount, viewerUser } from "./authz";

/**
 * The margin ledger. Reads are the signed-in user's own. The two writes are
 * internal: `collateral` is the equity the proposer sizes trades against, so a
 * client that could declare it could size itself past its own rule. Only
 * server code mirroring the chain writes it.
 */

const exposureByAssetClass = v.array(
  v.object({
    assetClass,
    notional: decimal,
  }),
);

export const createAccount = internalMutation({
  args: {
    userId: v.id("users"),
    collateral: decimal,
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("accounts", {
      userId: args.userId,
      collateral: args.collateral,
      exposureByAssetClass: [],
    });
  },
});

export const getAccount = query({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    return (await viewOwnedAccount(ctx, args.accountId))?.account ?? null;
  },
});

/** The signed-in user's accounts. */
export const listAccountsByOwner = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("accounts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(50);
  },
});

export const updateAccountLedger = internalMutation({
  args: {
    accountId: v.id("accounts"),
    collateral: decimal,
    exposureByAssetClass,
  },
  handler: async (ctx, args) => {
    return await ctx.db.patch(args.accountId, {
      collateral: args.collateral,
      exposureByAssetClass: args.exposureByAssetClass,
    });
  },
});
