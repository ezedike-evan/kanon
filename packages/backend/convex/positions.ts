import { internalMutation, query } from "./_generated/server";
import { MAX_LIST_ROWS } from "./limits";
import { v } from "convex/values";
import { assetClass, decimal } from "./schema";
import { viewOwnedAccount, viewOwnedPosition } from "./authz";

/** Reads are the signed-in user's own. The write is internal: positions mirror the chain, not a client's say-so. */

export const createPosition = internalMutation({
  args: {
    accountId: v.id("accounts"),
    asset: v.string(),
    assetClass,
    side: v.union(v.literal("long"), v.literal("short")),
    size: decimal,
    entryPrice: decimal,
    liquidationPrice: v.union(decimal, v.null()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("positions", {
      ...args,
      openedAt: Date.now(),
    });
  },
});

export const getPosition = query({
  args: { positionId: v.id("positions") },
  handler: async (ctx, args) => {
    return (await viewOwnedPosition(ctx, args.positionId))?.position ?? null;
  },
});

export const listPositionsByOwner = query({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    if (!(await viewOwnedAccount(ctx, args.accountId))) return [];
    return await ctx.db
      .query("positions")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .take(MAX_LIST_ROWS);
  },
});
