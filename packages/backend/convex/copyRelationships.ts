import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  isAddress,
  isTxHash,
  normalizeAddress,
  validateFollow,
  validateListing,
} from "./vaultLogic";
import {
  requireOwnedCopyRelationship,
  requireOwnedStrategy,
  requireUser,
  viewOwnedCopyRelationship,
  viewerUser,
} from "./authz";

/**
 * Copy trading, as the app indexes it.
 *
 * A lead is a strategy its owner has listed, with one profit share. A
 * relationship is a follower's own `CopyVault` on-chain: the follower holds the
 * funds, and `active` is their kill switch. Unfollowing is immediate and has no
 * hold, no fee and no approval, exactly as the contract's `setActive` has none.
 */

const leadView = (
  lead: Doc<"copyLeads">,
  strategy: Doc<"strategies"> | null,
  counts: { taken: number; blocked: number },
) => ({
  leadId: lead._id,
  strategyId: lead.strategyId,
  chainStrategyId: strategy?.chainStrategyId ?? null,
  specHash: strategy?.specHash ?? null,
  spec: strategy?.spec ?? null,
  profitShareBps: lead.profitShareBps,
  leaderExecutor: lead.leaderExecutor,
  feeRecipient: lead.feeRecipient,
  listedAt: lead.listedAt,
  taken: counts.taken,
  blocked: counts.blocked,
});

/** Lists the owner's pinned strategy for copying. One listing per strategy. */
export const listLead = mutation({
  args: {
    strategyId: v.id("strategies"),
    profitShareBps: v.number(),
    leaderExecutor: v.string(),
    feeRecipient: v.string(),
  },
  handler: async (ctx, args) => {
    const { user, strategy } = await requireOwnedStrategy(ctx, args.strategyId);
    const problems = validateListing(args);
    if (problems.length > 0) throw new Error(problems.join(" "));
    if (strategy.status === "draft" || !strategy.chainStrategyId) {
      throw new Error("only a pinned strategy can be listed");
    }

    const existing = await ctx.db
      .query("copyLeads")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
      .first();
    const fields = {
      profitShareBps: args.profitShareBps,
      leaderExecutor: normalizeAddress(args.leaderExecutor),
      feeRecipient: normalizeAddress(args.feeRecipient),
      active: true,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("copyLeads", {
      strategyId: args.strategyId,
      ownerUserId: user._id,
      listedAt: Date.now(),
      ...fields,
    });
  },
});

export const delistLead = mutation({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    const { user } = await requireOwnedStrategy(ctx, args.strategyId);
    const lead = await ctx.db
      .query("copyLeads")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
      .first();
    if (!lead || lead.ownerUserId !== user._id) throw new Error("listing not found");
    await ctx.db.patch(lead._id, { active: false });
  },
});

/** Leads open to follow. Public by design: listing is the owner's opt-in. */
export const listLeads = query({
  args: {},
  handler: async (ctx) => {
    const leads = await ctx.db
      .query("copyLeads")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    const out = [];
    for (const lead of leads) {
      const strategy = await ctx.db.get(lead.strategyId);
      const count = async (status: "executed" | "refused") =>
        (
          await ctx.db
            .query("trades")
            .withIndex("by_strategy_and_status", (q) =>
              q.eq("strategyId", lead.strategyId).eq("status", status),
            )
            .collect()
        ).length;
      out.push(leadView(lead, strategy, { taken: await count("executed"), blocked: await count("refused") }));
    }
    return out;
  },
});

/**
 * Records a follow the follower has just signed. Validated against the lead's
 * listing, so a fee the follower was not shown cannot be recorded, and
 * idempotent on the vault address.
 */
export const recordFollow = mutation({
  args: {
    leaderStrategyId: v.id("strategies"),
    allocationBps: v.number(),
    feeShareBps: v.number(),
    address: v.string(),
    chainId: v.number(),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const lead = await ctx.db
      .query("copyLeads")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.leaderStrategyId))
      .first();
    if (!lead) throw new Error("this strategy is not listed for copying");

    const problems = validateFollow({
      terms: { allocationBps: args.allocationBps, feeShareBps: args.feeShareBps },
      lead,
    });
    if (!isAddress(args.address)) problems.push("Vault address is not an address.");
    if (!isTxHash(args.txHash)) problems.push("A follow needs the transaction that created it.");
    if (problems.length > 0) throw new Error(problems.join(" "));

    const address = normalizeAddress(args.address);
    const existing = await ctx.db
      .query("copyRelationships")
      .withIndex("by_address", (q) => q.eq("address", address))
      .first();
    if (existing) {
      if (existing.followerUserId !== user._id) throw new Error("that vault address is already recorded");
      return existing._id;
    }

    return await ctx.db.insert("copyRelationships", {
      followerUserId: user._id,
      leaderStrategyId: args.leaderStrategyId,
      allocationBps: args.allocationBps,
      feeShareBps: args.feeShareBps,
      active: true,
      createdAt: Date.now(),
      address,
      chainId: args.chainId,
      createTxHash: args.txHash,
      leaderExecutor: lead.leaderExecutor,
      feeRecipient: lead.feeRecipient,
    });
  },
});

export const getCopyRelationship = query({
  args: { copyRelationshipId: v.id("copyRelationships") },
  handler: async (ctx, args) => {
    return (await viewOwnedCopyRelationship(ctx, args.copyRelationshipId))?.relationship ?? null;
  },
});

export const listCopyRelationshipsByOwner = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("copyRelationships")
      .withIndex("by_follower", (q) => q.eq("followerUserId", user._id))
      .collect();
    return rows.filter((r) => r.address !== undefined).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Mirrors the follower's kill switch. There is nothing to wait for and nothing
 * to approve, so this only ever writes: the chain call has already happened.
 */
export const setCopyRelationshipActive = mutation({
  args: {
    copyRelationshipId: v.id("copyRelationships"),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwnedCopyRelationship(ctx, args.copyRelationshipId);
    await ctx.db.patch(args.copyRelationshipId, {
      active: args.active,
      unfollowedAt: args.active ? undefined : Date.now(),
    });
  },
});
