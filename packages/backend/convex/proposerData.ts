import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { ownedStrategyBySubject } from "./authz";

/**
 * What `proposer:runProposer` and `proposer:blockedReport` read on a caller's
 * behalf. Actions cannot touch the database, and these are internal so no
 * client can call them: the action authenticates the caller from their token
 * and passes the Privy DID (`identity.subject`) here, and the strategy is
 * returned only if that DID owns it. Nothing here trusts a client-sent id.
 */

/** The strategy and the owner's first margin account collateral, or `null` when it is not theirs. */
export const context = internalQuery({
  args: { strategyId: v.id("strategies"), subject: v.string() },
  handler: async (ctx, args) => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) return null;
    // The first account, exactly as `runProposer` read `accounts[0]` before; the schema has no explicit "active account".
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_user", (q) => q.eq("userId", owned.user._id))
      .first();
    return { strategy: owned.strategy, collateral: account?.collateral ?? null };
  },
});
