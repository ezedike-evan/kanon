import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { userBySubject, viewerUser } from "./authz";
import { decimal } from "./schema";
import { mayMoveTo } from "./timedLogic";
import { takeLock } from "./venueData";

/**
 * The record of timed trades (Predict). The gateway opens and closes the
 * positions; it asks for these writes through `http.ts`. The writes and the two
 * reads the gateway uses are internal: a row exists only because a route that
 * checked the recorder key, and the caller's own token where a caller is
 * involved, asked for it. `listMine` is the one public function.
 */

const network = v.union(v.literal("testnet"), v.literal("mainnet"));

/** How many of a user's trades a list shows. */
export const MAX_TRADES = 50;
/** How many unfinished trades a restarted gateway is handed. Far more than one shared account can hold. */
const MAX_RUNNING = 200;

/** Writes the row for a trade whose position has just opened. */
export const start = internalMutation({
  args: {
    subject: v.string(),
    network,
    asset: v.string(),
    direction: v.union(v.literal("up"), v.literal("down")),
    stakeUsd: v.number(),
    leverage: v.number(),
    seconds: v.number(),
    openedAt: v.number(),
    expiresAt: v.number(),
    size: decimal,
    entryPrice: decimal,
    openFee: v.optional(decimal),
    openTx: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true; tradeId: string } | { ok: false; code: "no_user" }> => {
    const user = await userBySubject(ctx.db, args.subject);
    if (!user) return { ok: false, code: "no_user" };
    const { subject: _subject, ...trade } = args;
    const tradeId = await ctx.db.insert("timedTrades", { ...trade, userId: user._id, venue: "perpl", status: "live" });
    return { ok: true, tradeId };
  },
});

/**
 * Takes the order lock for a trade's closing order and records the order under
 * the trade's own user. The server sends this order when the time is up, so it
 * is vouched for by the trade, not by a sign-in token: the person may be gone.
 */
export const beginClose = internalMutation({
  args: { tradeId: v.id("timedTrades"), network, asset: v.string() },
  handler: async (ctx, args): Promise<{ ok: true; orderId: string } | { ok: false; code: "no_user" | "busy" }> => {
    const trade = await ctx.db.get(args.tradeId);
    // The same answer a missing user gets: there is nobody to send this order for.
    if (!trade || trade.status === "closed") return { ok: false, code: "no_user" };
    return await takeLock(ctx, trade.userId, { network: args.network, asset: args.asset, action: "close" });
  },
});

/** Adds how a trade ended, and the figures that follow, to its row. A closed trade is never reopened. */
export const update = internalMutation({
  args: {
    tradeId: v.id("timedTrades"),
    status: v.optional(v.union(v.literal("closing"), v.literal("closed"))),
    endedBy: v.optional(v.union(v.literal("time"), v.literal("cut"), v.literal("owner"), v.literal("venue"))),
    closedAt: v.optional(v.number()),
    exitPrice: v.optional(decimal),
    result: v.optional(decimal),
    fees: v.optional(decimal),
    openFee: v.optional(decimal),
    openTx: v.optional(v.string()),
    closeTx: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { tradeId, status, ...rest } = args;
    const row = await ctx.db.get(tradeId);
    if (!row) return null;
    await ctx.db.patch(tradeId, { ...rest, ...(status && mayMoveTo(row.status, status) ? { status } : {}) });
    return null;
  },
});

/** Every trade that has not ended: what a gateway reads when it starts, to close what an earlier one opened. */
export const running = internalQuery({
  args: {},
  handler: async (ctx) => {
    const live = await ctx.db
      .query("timedTrades")
      .withIndex("by_status", (q) => q.eq("status", "live"))
      .take(MAX_RUNNING);
    const closing = await ctx.db
      .query("timedTrades")
      .withIndex("by_status", (q) => q.eq("status", "closing"))
      .take(MAX_RUNNING);
    return [...live, ...closing].map((t) => ({
      id: t._id as string,
      network: t.network,
      asset: t.asset,
      direction: t.direction,
      stakeUsd: t.stakeUsd,
      leverage: t.leverage,
      seconds: t.seconds,
      openedAt: t.openedAt,
      expiresAt: t.expiresAt,
      size: t.size,
      entryPrice: t.entryPrice,
      ...(t.openFee ? { openFee: t.openFee } : {}),
    }));
  },
});

/** Whether a running trade belongs to the holder of a token. */
export const owns = internalQuery({
  args: { subject: v.string(), tradeId: v.id("timedTrades") },
  handler: async (ctx, args): Promise<boolean> => {
    const user = await userBySubject(ctx.db, args.subject);
    if (!user) return false;
    const trade = await ctx.db.get(args.tradeId);
    return trade !== null && trade.userId === user._id && trade.status !== "closed";
  },
});

/** The signed-in user's own timed trades, newest first. Empty for anyone else. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("timedTrades")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(MAX_TRADES);
  },
});
