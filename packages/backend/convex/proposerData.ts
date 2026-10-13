import { internalQuery, type DatabaseReader } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Decimal } from "@kanon/spec";
import { v } from "convex/values";
import { ownedStrategyBySubject } from "./authz";

/**
 * What `proposer:runProposer` and `proposer:blockedReport` read on a caller's
 * behalf. Actions cannot touch the database, and these are internal so no
 * client can call them: the action authenticates the caller from their token
 * and passes the Privy DID (`identity.subject`) here, and the strategy is
 * returned only if that DID owns it. Nothing here trusts a client-sent id.
 */

/**
 * A user's first margin account collateral, or null with none on file. The
 * first account, exactly as `runProposer` read `accounts[0]` before; the schema
 * has no explicit "active account". Autopilot sizes against the same figure.
 */
export async function firstCollateral(db: DatabaseReader, userId: Id<"users">): Promise<Decimal | null> {
  const account = await db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return account?.collateral ?? null;
}

/** The strategy and the owner's first margin account collateral, or `null` when it is not theirs. */
export const context = internalQuery({
  args: { strategyId: v.id("strategies"), subject: v.string() },
  handler: async (ctx, args) => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) return null;
    return { strategy: owned.strategy, collateral: await firstCollateral(ctx.db, owned.user._id) };
  },
});
