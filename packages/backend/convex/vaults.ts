import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { decimal } from "./schema";
import {
  decideVaultChange,
  guardFromRows,
  normalizeAddress,
  validateVaultRecord,
} from "./vaultLogic";
import {
  requireOwnedStrategy,
  requireOwnedVault,
  viewOwnedVault,
  viewerUser,
} from "./authz";

/**
 * The app's index of on-chain `GuardedVault`s.
 *
 * The contract's whitelist and drawdown cap are immutable, so a vault row never
 * changes its limits: a different set of limits is a different vault. The
 * chain is the truth for balances and refusals; this table is how the app
 * finds a vault again, holds a loosening through its hold, and keeps the
 * balance history the drawdown guard is shown against.
 *
 * A row is stored as a vault only with an address and the transaction that
 * created it. There is no way to record a vault that was not signed.
 */

/**
 * Records a vault the owner has just created on-chain. Idempotent on the
 * vault address, so a retry after a dropped response is not a second row.
 */
export const recordVault = mutation({
  args: {
    strategyId: v.id("strategies"),
    address: v.string(),
    chainId: v.number(),
    factoryAddress: v.string(),
    executor: v.string(),
    seriesAddress: v.string(),
    txHash: v.string(),
    whitelistedAssets: v.array(v.string()),
    maxDailyDrawdownBps: v.number(),
    depositBalance: decimal,
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwnedStrategy(ctx, args.strategyId);
    const problems = validateVaultRecord({
      address: args.address,
      chainId: args.chainId,
      executor: args.executor,
      txHash: args.txHash,
      assets: args.whitelistedAssets,
      maxDailyDrawdownBps: args.maxDailyDrawdownBps,
    });
    if (problems.length > 0) throw new Error(problems.join(" "));

    const address = normalizeAddress(args.address);
    const existing = await ctx.db
      .query("vaults")
      .withIndex("by_address", (q) => q.eq("address", address))
      .first();
    if (existing) {
      // Idempotent on the address, but only for the row's own owner: another
      // user is never handed someone else's row id.
      if (existing.ownerUserId !== user._id) throw new Error("that vault address is already recorded");
      return existing._id;
    }

    return await ctx.db.insert("vaults", {
      strategyId: args.strategyId,
      ownerUserId: user._id,
      depositBalance: args.depositBalance,
      whitelistedAssets: args.whitelistedAssets,
      maxDailyDrawdownBps: args.maxDailyDrawdownBps,
      createdAt: Date.now(),
      address,
      chainId: args.chainId,
      factoryAddress: normalizeAddress(args.factoryAddress),
      executor: normalizeAddress(args.executor),
      seriesAddress: normalizeAddress(args.seriesAddress),
      createTxHash: args.txHash,
    });
  },
});

export const getVault = query({
  args: { vaultId: v.id("vaults") },
  handler: async (ctx, args) => {
    return (await viewOwnedVault(ctx, args.vaultId))?.vault ?? null;
  },
});

/** Signed vaults only, newest first. Unsigned intent rows are never listed. */
export const listVaultsByOwner = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("vaults")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    return rows.filter((r) => r.address !== undefined).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Mirrors the vault's balance after a deposit or withdrawal, and logs the point. */
export const recordBalance = mutation({
  args: {
    vaultId: v.id("vaults"),
    /** The balance before this movement, in atoms. */
    equityAtoms: v.string(),
    /** The balance after it, in atoms and at the vault's own decimals. */
    depositBalance: decimal,
    txHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwnedVault(ctx, args.vaultId);
    if (!/^\d+$/.test(args.equityAtoms)) throw new Error("equity must be a non-negative integer");
    await ctx.db.patch(args.vaultId, { depositBalance: args.depositBalance });
    await ctx.db.insert("vaultEquity", {
      vaultId: args.vaultId,
      at: Math.floor(Date.now() / 1000),
      equityAtoms: args.equityAtoms,
      realizedPnlAtoms: "0",
      ...(args.txHash ? { txHash: args.txHash } : {}),
    });
  },
});

/** The drawdown guard for a vault, computed from its stored balance history. */
export const drawdownGuard = query({
  args: { vaultId: v.id("vaults") },
  handler: async (ctx, args) => {
    const owned = await viewOwnedVault(ctx, args.vaultId);
    if (!owned) return null;
    const { vault } = owned;
    const rows = await ctx.db
      .query("vaultEquity")
      .withIndex("by_vault_and_time", (q) => q.eq("vaultId", args.vaultId))
      .order("desc")
      .take(500);
    const g = guardFromRows({
      rows: rows.map((r) => ({ at: r.at, equityAtoms: r.equityAtoms, realizedPnlAtoms: r.realizedPnlAtoms })),
      nowSeconds: Math.floor(Date.now() / 1000),
      currentEquityAtoms: vault.depositBalance.atoms,
      maxDailyDrawdownBps: vault.maxDailyDrawdownBps,
    });
    // bigint is not a Convex value; the wire form is the same atoms as a string.
    return {
      utcDay: g.utcDay,
      referenceBalance: g.referenceBalance.toString(),
      realizedToday: g.realizedToday.toString(),
      lossBudget: g.lossBudget.toString(),
      remaining: g.remaining.toString(),
      usedBps: g.usedBps,
    };
  },
});

/**
 * What asking for different limits does, decided on the server so the client
 * cannot choose a shorter hold. A tightening returns `apply` at once and the
 * client then creates the replacement vault. A loosening is staged here and
 * returns `stage`, then `wait`, and only `apply` once the hold has run.
 */
export const requestVaultChange = mutation({
  args: {
    vaultId: v.id("vaults"),
    whitelistedAssets: v.array(v.string()),
    maxDailyDrawdownBps: v.number(),
  },
  handler: async (ctx, args) => {
    const { vault } = await requireOwnedVault(ctx, args.vaultId);
    const decision = decideVaultChange({
      current: { assets: vault.whitelistedAssets, maxDailyDrawdownBps: vault.maxDailyDrawdownBps },
      requested: { assets: args.whitelistedAssets, maxDailyDrawdownBps: args.maxDailyDrawdownBps },
      pending: vault.pendingLoosening
        ? {
            limits: {
              assets: vault.pendingLoosening.whitelistedAssets,
              maxDailyDrawdownBps: vault.pendingLoosening.maxDailyDrawdownBps,
            },
            requestedAt: vault.pendingLoosening.requestedAt,
            endsAt: vault.pendingLoosening.endsAt,
          }
        : null,
      nowMs: Date.now(),
    });

    if (decision.action === "stage") {
      await ctx.db.patch(args.vaultId, {
        pendingLoosening: {
          whitelistedAssets: [...decision.pending.limits.assets],
          maxDailyDrawdownBps: decision.pending.limits.maxDailyDrawdownBps,
          requestedAt: decision.pending.requestedAt,
          endsAt: decision.pending.endsAt,
        },
      });
    }
    return decision;
  },
});

/** Drops a staged loosening. The vault's current limits never stopped applying. */
export const withdrawVaultChange = mutation({
  args: { vaultId: v.id("vaults") },
  handler: async (ctx, args) => {
    await requireOwnedVault(ctx, args.vaultId);
    await ctx.db.patch(args.vaultId, { pendingLoosening: undefined });
  },
});
