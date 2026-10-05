import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { resolveWallet } from "./users";
import { describeEnvProblem, parseChainEnv } from "./serverEnv";
import { getReceipt, readCopyVault, rpcFor, rpcIsOnChain } from "./chainReads";
import { receiptConfirms, verifyCopyVaultMirror } from "./chainLogic";
import { UNAVAILABLE, walletMessages, type VaultRecordResult } from "./vaults";
import { MAX_COUNT_ROWS, MAX_LIST_ROWS } from "./limits";
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
  requireSubject,
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
      .take(100);
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
            .take(MAX_COUNT_ROWS)
        ).length;
      out.push(leadView(lead, strategy, { taken: await count("executed"), blocked: await count("refused") }));
    }
    return out;
  },
});

/** The listing a follow is checked against, for the signed-in user only. Internal. */
export const leadForFollow = internalQuery({
  args: { leaderStrategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    const lead = await ctx.db
      .query("copyLeads")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.leaderStrategyId))
      .first();
    if (!lead) return null;
    const strategy = await ctx.db.get(lead.strategyId);
    return {
      profitShareBps: lead.profitShareBps,
      leaderExecutor: lead.leaderExecutor,
      feeRecipient: lead.feeRecipient,
      active: lead.active,
      chainStrategyId: strategy?.chainStrategyId ?? null,
    };
  },
});

/** Stores a follow the action verified on-chain. Internal. Idempotent on the address. */
export const insertVerifiedFollow = internalMutation({
  args: {
    userId: v.id("users"),
    leaderStrategyId: v.id("strategies"),
    allocationBps: v.number(),
    feeShareBps: v.number(),
    address: v.string(),
    chainId: v.number(),
    txHash: v.string(),
    leaderExecutor: v.string(),
    feeRecipient: v.string(),
  },
  handler: async (ctx, args) => {
    const address = normalizeAddress(args.address);
    const existing = await ctx.db
      .query("copyRelationships")
      .withIndex("by_address", (q) => q.eq("address", address))
      .first();
    if (existing) {
      if (existing.followerUserId !== args.userId) throw new Error("that vault address is already recorded");
      return existing._id;
    }
    return await ctx.db.insert("copyRelationships", {
      followerUserId: args.userId,
      leaderStrategyId: args.leaderStrategyId,
      allocationBps: args.allocationBps,
      feeShareBps: args.feeShareBps,
      active: true,
      createdAt: Date.now(),
      address,
      chainId: args.chainId,
      createTxHash: args.txHash,
      leaderExecutor: normalizeAddress(args.leaderExecutor),
      feeRecipient: normalizeAddress(args.feeRecipient),
    });
  },
});

type LeadForFollow = {
  profitShareBps: number;
  leaderExecutor: string;
  feeRecipient: string;
  active: boolean;
  chainStrategyId: string | null;
} | null;
const leadForFollowRef = makeFunctionReference<
  "query",
  { leaderStrategyId: Id<"strategies"> },
  LeadForFollow
>("copyRelationships:leadForFollow");
const insertVerifiedFollowRef = makeFunctionReference<
  "mutation",
  {
    userId: Id<"users">;
    leaderStrategyId: Id<"strategies">;
    allocationBps: number;
    feeShareBps: number;
    address: string;
    chainId: number;
    txHash: string;
    leaderExecutor: string;
    feeRecipient: string;
  },
  Id<"copyRelationships">
>("copyRelationships:insertVerifiedFollow");

/**
 * Records a follow the follower has just signed. The chain is asked: the
 * address must be a `CopyVault` the factory made, whose follower is the user's
 * linked wallet and which copies this lead's executor, fee address and
 * registry strategy. Allocation and fee are read off the vault, then checked
 * against the lead's listing. Fails closed if the RPC or factory is not
 * configured. Idempotent on the vault address.
 */
export const recordFollow = action({
  args: {
    leaderStrategyId: v.id("strategies"),
    address: v.string(),
    chainId: v.number(),
    txHash: v.string(),
    walletSignature: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<VaultRecordResult<Id<"copyRelationships">>> => {
    const subject = await requireSubject(ctx);
    if (!isAddress(args.address)) return { ok: false, reason: "invalid", message: "Vault address is not an address." };
    if (!isTxHash(args.txHash)) {
      return { ok: false, reason: "invalid", message: "A follow needs the transaction that created it." };
    }

    const env = parseChainEnv(process.env, ["factory"]);
    if (!env.ok) {
      console.error(describeEnvProblem("copyRelationships:recordFollow", env.invalid));
      return { ok: false, reason: "not_configured", message: UNAVAILABLE };
    }
    if (args.chainId !== env.value.chainId) {
      return { ok: false, reason: "rejected", message: "That vault is not on the deployed factory." };
    }

    const lead = await ctx.runQuery(leadForFollowRef, { leaderStrategyId: args.leaderStrategyId });
    if (!lead) return { ok: false, reason: "invalid", message: "This strategy is not listed for copying." };

    const wallet = await resolveWallet(ctx, subject, args.walletSignature);
    if (!wallet.ok) return { ok: false, reason: wallet.reason, message: walletMessages[wallet.reason] ?? "Wallet check failed." };

    let verdict;
    try {
      const rpc = rpcFor(env.value);
      if (!(await rpcIsOnChain(rpc, env.value.chainId))) {
        console.error("copyRelationships:recordFollow: RPC is on a different chain than MONAD_CHAIN_ID");
        return { ok: false, reason: "not_configured", message: UNAVAILABLE };
      }
      const reads = await readCopyVault(rpc, env.value.factoryAddress!, normalizeAddress(args.address));
      verdict = verifyCopyVaultMirror({ reads, wallet: wallet.wallet, lead });
      if (verdict.ok) {
        const receipt = await getReceipt(rpc, args.txHash);
        if (!receiptConfirms(receipt, env.value.factoryAddress!)) {
          return { ok: false, reason: "rejected", message: "The creating transaction did not succeed against the factory." };
        }
      }
    } catch (err) {
      console.error("copyRelationships:recordFollow: RPC read failed", err instanceof Error ? err.message : "");
      return { ok: false, reason: "rpc_unavailable", message: "The chain could not be reached. Try again shortly." };
    }
    if (!verdict.ok) return { ok: false, reason: "rejected", message: verdict.reason };

    const problems = validateFollow({
      terms: { allocationBps: verdict.allocationBps, feeShareBps: verdict.feeShareBps },
      lead,
    });
    if (problems.length > 0) return { ok: false, reason: "rejected", message: problems.join(" ") };

    const id = await ctx.runMutation(insertVerifiedFollowRef, {
      userId: wallet.userId as Id<"users">,
      leaderStrategyId: args.leaderStrategyId,
      allocationBps: verdict.allocationBps,
      feeShareBps: verdict.feeShareBps,
      address: args.address,
      chainId: args.chainId,
      txHash: args.txHash.toLowerCase(),
      leaderExecutor: lead.leaderExecutor,
      feeRecipient: lead.feeRecipient,
    });
    return { ok: true, id };
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
      .order("desc")
      .take(MAX_LIST_ROWS);
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
