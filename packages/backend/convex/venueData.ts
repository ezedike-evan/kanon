import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userBySubject, viewerUser } from "./authz";
import { decimal } from "./schema";
import { isLocked } from "./venueLogic";

/**
 * The record of orders sent to the venue, and the lock that lets one out at a
 * time. The gateway sends the orders; it asks for these writes through
 * `http.ts`. The writes are internal: a row exists only because a route that
 * checked the recorder key and the caller's own token asked for it.
 */

const side = v.union(v.literal("long"), v.literal("short"));

/** How many of a user's orders a list shows. */
export const MAX_ORDERS = 50;

/**
 * Records an order that is about to be sent and takes the lock for it. Refuses
 * while another order is still on its way to the same account, so no two
 * orders read the same request id from the venue.
 */
export const begin = internalMutation({
  args: {
    subject: v.string(),
    network: v.union(v.literal("testnet"), v.literal("mainnet")),
    asset: v.string(),
    action: v.union(v.literal("open"), v.literal("close")),
    side: v.optional(side),
    notionalUsd: v.optional(v.number()),
    leverage: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; orderId: string } | { ok: false; code: "no_user" | "busy" }> => {
    const user = await userBySubject(ctx.db, args.subject);
    if (!user) return { ok: false, code: "no_user" };

    const now = Date.now();
    const pending = await ctx.db
      .query("venueOrders")
      .withIndex("by_status", (q) => q.eq("status", "submitting"))
      .order("desc")
      .first();
    if (isLocked(pending?.createdAt ?? null, now)) return { ok: false, code: "busy" };
    // An order whose action never reported back is closed out here, so it stops reading as on its way.
    if (pending) {
      await ctx.db.patch(pending._id, {
        status: "failed",
        settledAt: now,
        reason: "No answer was recorded for this order. Check the position on the venue.",
      });
    }

    const { subject: _subject, ...order } = args;
    const orderId = await ctx.db.insert("venueOrders", {
      ...order,
      userId: user._id,
      venue: "perpl",
      status: "submitting",
      createdAt: now,
    });
    return { ok: true, orderId };
  },
});

/** Writes what became of an order and releases the lock. Only a row still `submitting` is settled. */
export const settle = internalMutation({
  args: {
    orderId: v.id("venueOrders"),
    status: v.union(v.literal("filled"), v.literal("unfilled"), v.literal("refused"), v.literal("failed")),
    side: v.optional(side),
    requestId: v.optional(v.number()),
    size: v.optional(decimal),
    fillPrice: v.optional(decimal),
    fee: v.optional(decimal),
    block: v.optional(v.number()),
    txHash: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { orderId, ...outcome } = args;
    const row = await ctx.db.get(orderId);
    if (!row || row.status !== "submitting") return null;
    await ctx.db.patch(orderId, { ...outcome, settledAt: Date.now() });
    return null;
  },
});

/**
 * Adds a fill's own figures to an order already recorded as filled. The venue's
 * history lists a fill seconds after the position moves, so the answer goes
 * back first and the price, fee and transaction follow. Only a `filled` row is
 * touched, and what became of the order is never changed here.
 */
export const amend = internalMutation({
  args: {
    orderId: v.id("venueOrders"),
    size: v.optional(decimal),
    fillPrice: v.optional(decimal),
    fee: v.optional(decimal),
    block: v.optional(v.number()),
    txHash: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<null> => {
    const { orderId, ...details } = args;
    const row = await ctx.db.get(orderId);
    if (!row || row.status !== "filled") return null;
    await ctx.db.patch(orderId, details);
    return null;
  },
});

/** The signed-in user's own orders, newest first. Empty for anyone else. */
export const listMyOrders = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("venueOrders")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(MAX_ORDERS);
  },
});
