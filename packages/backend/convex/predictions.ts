import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { canTakeSide, marketPhase } from "@kanon/spec";
import { decimal } from "./schema";
import { MAX_LIST_ROWS } from "./limits";
import { isValidStake } from "./marketsLogic";
import { requireSubject, viewOwnedPrediction, viewerUser } from "./authz";
import { resolveWallet } from "./users";
import { parseChainEnv, describeEnvProblem } from "./serverEnv";
import { getReceipt, rpcFor, rpcIsOnChain } from "./chainReads";
import { isTxHash } from "./vaultLogic";
import { verifyPositionReceipt } from "./chainLogic";

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
      .order("desc")
      .take(MAX_LIST_ROWS);
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

export type RecordFailureReason =
  | "not_configured"
  | "no_user"
  | "wallet_not_linked"
  | "bad_signature"
  | "already_linked"
  | "wallet_in_use"
  | "invalid"
  | "rejected"
  | "rpc_unavailable";

export type RecordResult<T = string> =
  | { ok: true; id: T }
  | { ok: false; reason: RecordFailureReason; message: string };

const walletMessages: Record<string, string> = {
  no_user: "Finish signing up to continue.",
  wallet_not_linked: "Link your wallet first: sign the link message with it.",
  bad_signature: "That wallet signature is not valid.",
  already_linked: "Your account is already linked to a different wallet.",
  wallet_in_use: "That wallet is linked to another account.",
};

/** What the action needs to know about a market before it reads the chain. */
export const marketForRecord = internalQuery({
  args: { marketId: v.id("markets") },
  handler: async (ctx, args) => {
    const market = await ctx.db.get(args.marketId);
    if (!market) return null;
    return {
      direction: market.direction,
      chain: market.chain ?? null,
      open: canTakeSide(marketPhase(market, Math.floor(Date.now() / 1000))),
    };
  },
});

/**
 * Stores a stake already verified against the chain (`recordPosition`, below).
 * Internal: no client can insert a position row. Idempotent on the tx hash.
 */
export const insertVerifiedPosition = internalMutation({
  args: {
    userId: v.id("users"),
    marketId: v.id("markets"),
    side: v.union(v.literal("above"), v.literal("below")),
    stake: decimal,
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
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
      if (existing.userId !== args.userId) throw new Error("that transaction is already recorded");
      return existing._id;
    }

    return await ctx.db.insert("predictions", {
      userId: args.userId,
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

const marketForRecordRef = makeFunctionReference<
  "query",
  { marketId: Id<"markets"> },
  { direction: "above" | "below"; chain: { chainId: number; address: string; marketId: string; txHash: string } | null; open: boolean } | null
>("predictions:marketForRecord");
const insertVerifiedPositionRef = makeFunctionReference<
  "mutation",
  { userId: Id<"users">; marketId: Id<"markets">; side: "above" | "below"; stake: { atoms: string; decimals: number }; txHash: string },
  Id<"predictions">
>("predictions:insertVerifiedPosition");

/**
 * Records a stake the chain has already accepted. Nothing here moves money and
 * nothing here takes the stake, the side or the staker from the client: the
 * action reads the `takeSide` receipt from the chain and requires a successful
 * transaction to the ThresholdMarket carrying one `SideTaken` from the user's
 * linked wallet on this market. The stake and side come from that log.
 * Fails closed if the RPC or the market address is not configured.
 *
 * `walletSignature` is only for a user who has not linked a wallet yet.
 * Idempotent on the transaction hash.
 */
export const recordPosition = action({
  args: {
    marketId: v.id("markets"),
    txHash: v.string(),
    walletSignature: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RecordResult<Id<"predictions">>> => {
    const subject = await requireSubject(ctx);
    if (!isTxHash(args.txHash)) return { ok: false, reason: "invalid", message: "That is not a transaction hash." };

    const env = parseChainEnv(process.env, ["market"]);
    if (!env.ok) {
      console.error(describeEnvProblem("predictions:recordPosition", env.invalid));
      return { ok: false, reason: "not_configured", message: "Recording stakes is unavailable right now." };
    }

    const wallet = await resolveWallet(ctx, subject, args.walletSignature);
    if (!wallet.ok) return { ok: false, reason: wallet.reason, message: walletMessages[wallet.reason] ?? "Wallet check failed." };

    const market = await ctx.runQuery(marketForRecordRef, { marketId: args.marketId });
    if (!market) return { ok: false, reason: "invalid", message: "No such market." };
    if (!market.open) return { ok: false, reason: "rejected", message: "This market is closed to new sides." };
    const chain = market.chain;
    if (
      !chain ||
      chain.chainId !== env.value.chainId ||
      chain.address.toLowerCase() !== env.value.marketAddress
    ) {
      return { ok: false, reason: "rejected", message: "This market is not linked to the deployed contract." };
    }

    let verdict;
    try {
      const rpc = rpcFor(env.value);
      if (!(await rpcIsOnChain(rpc, env.value.chainId))) {
        console.error("predictions:recordPosition: RPC is on a different chain than MONAD_CHAIN_ID");
        return { ok: false, reason: "not_configured", message: "Recording stakes is unavailable right now." };
      }
      verdict = verifyPositionReceipt({
        receipt: await getReceipt(rpc, args.txHash),
        marketAddress: env.value.marketAddress!,
        chainMarketId: chain.marketId,
        wallet: wallet.wallet,
        direction: market.direction,
      });
    } catch (err) {
      console.error("predictions:recordPosition: RPC read failed", err instanceof Error ? err.message : "");
      return { ok: false, reason: "rpc_unavailable", message: "The chain could not be reached. Try again shortly." };
    }
    if (!verdict.ok) return { ok: false, reason: "rejected", message: verdict.reason };

    const id = await ctx.runMutation(insertVerifiedPositionRef, {
      userId: wallet.userId as Id<"users">,
      marketId: args.marketId,
      side: verdict.side,
      stake: verdict.stake,
      txHash: args.txHash.toLowerCase(),
    });
    return { ok: true, id };
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
