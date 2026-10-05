import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { vaultAssetId } from "@kanon/spec";
import { resolveWallet } from "./users";
import { describeEnvProblem, parseChainEnv } from "./serverEnv";
import { getReceipt, readTotalCollateral, readVault, rpcFor, rpcIsOnChain } from "./chainReads";
import { receiptConfirms, verifyVaultMirror } from "./chainLogic";
import type { RecordFailureReason } from "./predictions";
import { decimal } from "./schema";
import {
  decideVaultChange,
  guardFromRows,
  isAddress,
  isTxHash,
  normalizeAddress,
  validateVaultRecord,
} from "./vaultLogic";
import {
  ownedStrategyBySubject,
  ownedVaultBySubject,
  requireSubject,
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

/** Vaults one owner can list. A person has a handful; this is a ceiling, not a page size. */
const MAX_VAULTS = 100;

export type VaultRecordResult<T = string> =
  | { ok: true; id: T }
  | { ok: false; reason: RecordFailureReason; message: string };

export const walletMessages: Record<string, string> = {
  no_user: "Finish signing up to continue.",
  wallet_not_linked: "Link your wallet first: sign the link message with it.",
  bad_signature: "That wallet signature is not valid.",
  already_linked: "Your account is already linked to a different wallet.",
  wallet_in_use: "That wallet is linked to another account.",
};
export const UNAVAILABLE = "Recording vaults is unavailable right now.";

/** The strategy, only if the DID owns it, and what the action needs from it. */
export const strategyForRecord = internalQuery({
  args: { subject: v.string(), strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    const owned = await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId);
    if (!owned) return null;
    return { userId: owned.user._id, seriesAddress: owned.strategy.seriesAddress ?? null };
  },
});

/** Stores a vault the action verified on-chain. Internal. Idempotent on the address. */
export const insertVerifiedVault = internalMutation({
  args: {
    userId: v.id("users"),
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
    const address = normalizeAddress(args.address);
    const existing = await ctx.db
      .query("vaults")
      .withIndex("by_address", (q) => q.eq("address", address))
      .first();
    if (existing) {
      // Idempotent on the address, but only for the row's own owner: another
      // user is never handed someone else's row id.
      if (existing.ownerUserId !== args.userId) throw new Error("that vault address is already recorded");
      return existing._id;
    }
    return await ctx.db.insert("vaults", {
      strategyId: args.strategyId,
      ownerUserId: args.userId,
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

const strategyForRecordRef = makeFunctionReference<
  "query",
  { subject: string; strategyId: Id<"strategies"> },
  { userId: Id<"users">; seriesAddress: string | null } | null
>("vaults:strategyForRecord");
const insertVerifiedVaultRef = makeFunctionReference<
  "mutation",
  {
    userId: Id<"users">;
    strategyId: Id<"strategies">;
    address: string;
    chainId: number;
    factoryAddress: string;
    executor: string;
    seriesAddress: string;
    txHash: string;
    whitelistedAssets: string[];
    maxDailyDrawdownBps: number;
    depositBalance: { atoms: string; decimals: number };
  },
  Id<"vaults">
>("vaults:insertVerifiedVault");

/**
 * Records a vault the owner has just created on-chain. The action asks the
 * chain: the address must be a vault `VaultFactory.isVault` knows, owned by the
 * user's linked wallet, with the executor, drawdown cap and whitelist the
 * client described; the creating transaction must have succeeded against the
 * factory; and the balance is the vault's own `totalCollateral`. Fails closed
 * if the RPC or factory address is not configured. Idempotent on the address.
 */
export const recordVault = action({
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
    /** Only its `decimals` is read: the atoms come from the chain. */
    depositBalance: decimal,
    walletSignature: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<VaultRecordResult<Id<"vaults">>> => {
    const subject = await requireSubject(ctx);
    const problems = validateVaultRecord({
      address: args.address,
      chainId: args.chainId,
      executor: args.executor,
      txHash: args.txHash,
      assets: args.whitelistedAssets,
      maxDailyDrawdownBps: args.maxDailyDrawdownBps,
    });
    if (problems.length > 0) return { ok: false, reason: "invalid", message: problems.join(" ") };
    if (!isAddress(args.factoryAddress) || !isAddress(args.seriesAddress)) {
      return { ok: false, reason: "invalid", message: "Factory or series is not an address." };
    }
    const decimals = args.depositBalance.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return { ok: false, reason: "invalid", message: "Collateral decimals are not valid." };
    }

    const env = parseChainEnv(process.env, ["factory"]);
    if (!env.ok) {
      console.error(describeEnvProblem("vaults:recordVault", env.invalid));
      return { ok: false, reason: "not_configured", message: UNAVAILABLE };
    }
    if (args.chainId !== env.value.chainId || normalizeAddress(args.factoryAddress) !== env.value.factoryAddress) {
      return { ok: false, reason: "rejected", message: "That vault is not on the deployed factory." };
    }

    const strategy = await ctx.runQuery(strategyForRecordRef, { subject, strategyId: args.strategyId });
    if (!strategy) return { ok: false, reason: "invalid", message: "Strategy not found." };
    if (strategy.seriesAddress && strategy.seriesAddress.toLowerCase() !== normalizeAddress(args.seriesAddress)) {
      return { ok: false, reason: "rejected", message: "The series does not match the pinned strategy." };
    }

    const wallet = await resolveWallet(ctx, subject, args.walletSignature);
    if (!wallet.ok) return { ok: false, reason: wallet.reason, message: walletMessages[wallet.reason] ?? "Wallet check failed." };

    let collateral: bigint;
    try {
      const rpc = rpcFor(env.value);
      if (!(await rpcIsOnChain(rpc, env.value.chainId))) {
        console.error("vaults:recordVault: RPC is on a different chain than MONAD_CHAIN_ID");
        return { ok: false, reason: "not_configured", message: UNAVAILABLE };
      }
      const vault = normalizeAddress(args.address);
      const reads = await readVault(rpc, env.value.factoryAddress!, vault);
      const verdict = verifyVaultMirror({
        reads,
        wallet: wallet.wallet,
        claimed: {
          executor: args.executor,
          maxDailyDrawdownBps: args.maxDailyDrawdownBps,
          assetIds: args.whitelistedAssets.map(vaultAssetId),
        },
      });
      if (!verdict.ok) return { ok: false, reason: "rejected", message: verdict.reason };
      const receipt = await getReceipt(rpc, args.txHash);
      if (!receiptConfirms(receipt, env.value.factoryAddress!)) {
        return { ok: false, reason: "rejected", message: "The creating transaction did not succeed against the factory." };
      }
      const read = await readTotalCollateral(rpc, vault);
      if (read === null) return { ok: false, reason: "rejected", message: "The vault balance could not be read." };
      collateral = read;
    } catch (err) {
      console.error("vaults:recordVault: RPC read failed", err instanceof Error ? err.message : "");
      return { ok: false, reason: "rpc_unavailable", message: "The chain could not be reached. Try again shortly." };
    }

    const id = await ctx.runMutation(insertVerifiedVaultRef, {
      userId: strategy.userId,
      strategyId: args.strategyId,
      address: args.address,
      chainId: args.chainId,
      factoryAddress: args.factoryAddress,
      executor: args.executor,
      seriesAddress: args.seriesAddress,
      txHash: args.txHash.toLowerCase(),
      whitelistedAssets: args.whitelistedAssets,
      maxDailyDrawdownBps: args.maxDailyDrawdownBps,
      depositBalance: { atoms: collateral.toString(), decimals },
    });
    return { ok: true, id };
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
      .order("desc")
      .take(MAX_VAULTS);
    return rows.filter((r) => r.address !== undefined).sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** The vault row an action may act on, only if the DID owns it. */
export const vaultForRecord = internalQuery({
  args: { subject: v.string(), vaultId: v.id("vaults") },
  handler: async (ctx, args) => {
    const owned = await ownedVaultBySubject(ctx.db, args.subject, args.vaultId);
    if (!owned) return null;
    const { vault } = owned;
    return { address: vault.address ?? null, balanceAtoms: vault.depositBalance.atoms, decimals: vault.depositBalance.decimals };
  },
});

/** Applies a balance the action read from the chain, and logs the point. Internal. */
export const applyVerifiedBalance = internalMutation({
  args: {
    vaultId: v.id("vaults"),
    equityAtoms: v.string(),
    depositBalance: decimal,
    txHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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

const vaultForRecordRef = makeFunctionReference<
  "query",
  { subject: string; vaultId: Id<"vaults"> },
  { address: string | null; balanceAtoms: string; decimals: number } | null
>("vaults:vaultForRecord");
const applyVerifiedBalanceRef = makeFunctionReference<
  "mutation",
  { vaultId: Id<"vaults">; equityAtoms: string; depositBalance: { atoms: string; decimals: number }; txHash?: string },
  null
>("vaults:applyVerifiedBalance");

/**
 * Mirrors the vault's balance after a deposit or withdrawal, and logs the
 * point. Nothing numeric is taken from the client: the new balance is the
 * vault's `totalCollateral` read from the chain, and the balance before it is
 * the one this table already held. `txHash` is kept only if it is a successful
 * transaction to this vault.
 */
export const recordBalance = action({
  args: {
    vaultId: v.id("vaults"),
    txHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; balance: { atoms: string; decimals: number } } | { ok: false; reason: RecordFailureReason; message: string }> => {
    const subject = await requireSubject(ctx);
    const env = parseChainEnv(process.env, []);
    if (!env.ok) {
      console.error(describeEnvProblem("vaults:recordBalance", env.invalid));
      return { ok: false, reason: "not_configured", message: "Balance updates are unavailable right now." };
    }
    const vault = await ctx.runQuery(vaultForRecordRef, { subject, vaultId: args.vaultId });
    if (!vault || !vault.address) return { ok: false, reason: "invalid", message: "Vault not found." };

    let current: bigint | null;
    let tx: string | undefined;
    try {
      const rpc = rpcFor(env.value);
      if (!(await rpcIsOnChain(rpc, env.value.chainId))) {
        console.error("vaults:recordBalance: RPC is on a different chain than MONAD_CHAIN_ID");
        return { ok: false, reason: "not_configured", message: "Balance updates are unavailable right now." };
      }
      current = await readTotalCollateral(rpc, vault.address);
      if (args.txHash && isTxHash(args.txHash) && receiptConfirms(await getReceipt(rpc, args.txHash), vault.address)) {
        tx = args.txHash.toLowerCase();
      }
    } catch (err) {
      console.error("vaults:recordBalance: RPC read failed", err instanceof Error ? err.message : "");
      return { ok: false, reason: "rpc_unavailable", message: "The chain could not be reached. Try again shortly." };
    }
    if (current === null) return { ok: false, reason: "rejected", message: "The vault balance could not be read." };

    const balance = { atoms: current.toString(), decimals: vault.decimals };
    await ctx.runMutation(applyVerifiedBalanceRef, {
      vaultId: args.vaultId,
      equityAtoms: vault.balanceAtoms,
      depositBalance: balance,
      ...(tx ? { txHash: tx } : {}),
    });
    return { ok: true, balance };
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
