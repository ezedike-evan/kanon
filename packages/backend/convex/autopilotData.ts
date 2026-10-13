import { internalMutation, internalQuery, type DatabaseReader, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  HANDOFF_MESSAGES,
  MAX_ARMED,
  candleSecondsOf,
  directionOf,
  handoffExpired,
  notOpenedPatch,
  openedPatch,
  sameMarket,
  withinHandoff,
} from "./autopilotLogic";
import { firstCollateral } from "./proposerData";
import { decimal } from "./schema";
import { takeLock } from "./venueData";

/**
 * What autopilot reads and writes: for its sweep (`autopilot.ts`), and for the
 * gateway, which opens a timed trade for a proposal the rule passed and asks
 * for these writes through `http.ts` (`/autopilot/*`).
 *
 * Everything here is internal. Nobody signs in for an autopilot trade, so a
 * proposal stands in for its owner the way a timed trade stands in for the
 * owner of its closing order (`timedData.beginClose`): the user is read from
 * the proposal's own strategy, never from what the gateway sent.
 */

const network = v.union(v.literal("testnet"), v.literal("mainnet"));

/** How many waiting proposals one read hands the gateway, or one sweep finishes. */
const MAX_WAITING = 100;

type Proposal = Doc<"trades">;

/** A row the sweep wrote for a pass: the only kind the gateway may act for. */
const isProposal = (row: Proposal | null): row is Proposal =>
  row !== null && row.origin === "autopilot" && row.handoff !== undefined;

/** A proposal nothing has been decided about yet. */
const isPending = (row: Proposal | null): row is Proposal =>
  isProposal(row) && row.handoff === "pending" && row.status === "proposed";

async function waitingProposals(db: DatabaseReader): Promise<Proposal[]> {
  return await db
    .query("trades")
    .withIndex("by_handoff_and_strategy", (q) => q.eq("handoff", "pending"))
    .take(MAX_WAITING);
}

/**
 * Whether a strategy has an autopilot trade waiting to be opened or still
 * running. Only its newest opened proposal can be running: the one before it
 * had to end before that one was written.
 */
export async function hasOpenTrade(db: DatabaseReader, strategyId: Id<"strategies">): Promise<boolean> {
  const waiting = await db
    .query("trades")
    .withIndex("by_handoff_and_strategy", (q) => q.eq("handoff", "pending").eq("strategyId", strategyId))
    .first();
  if (waiting) return true;
  const last = await db
    .query("trades")
    .withIndex("by_handoff_and_strategy", (q) => q.eq("handoff", "opened").eq("strategyId", strategyId))
    .order("desc")
    .first();
  if (!last?.timedTradeId) return false;
  const timed = await db.get(last.timedTradeId);
  return timed !== null && timed.status !== "closed";
}

/**
 * Finishes a strategy's proposals that have not gone to the venue, when its
 * owner turns autopilot off. One whose order is already on its way is left for
 * the gateway to report: turning autopilot off does not unsend an order.
 */
export async function withdrawWaiting(ctx: MutationCtx, strategyId: Id<"strategies">): Promise<void> {
  const waiting = await ctx.db
    .query("trades")
    .withIndex("by_handoff_and_strategy", (q) => q.eq("handoff", "pending").eq("strategyId", strategyId))
    .take(MAX_WAITING);
  for (const row of waiting) {
    if (row.openOrderId !== undefined) continue;
    await ctx.db.patch(row._id, notOpenedPatch(HANDOFF_MESSAGES.turnedOff));
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Every strategy autopilot is on for, with what tells whether a candle has
 * closed since it was last judged, and how many proposals have waited past any
 * order that could be on its way. The clock is the caller's.
 */
export const snapshot = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) => {
    const armed = await ctx.db
      .query("strategies")
      .withIndex("by_autopilot", (q) => q.eq("autopilot", true))
      .take(MAX_ARMED);
    const waiting = await waitingProposals(ctx.db);
    return {
      strategies: armed.map((s) => ({
        strategyId: s._id,
        candleSeconds: candleSecondsOf(s.spec),
        judgedBucket: s.autopilotBucket ?? null,
      })),
      expired: waiting.filter((row) => handoffExpired(row.createdAt, args.nowMs)).length,
    };
  },
});

/** The strategy and its owner's collateral, as `proposerData:context` reads them, for a strategy autopilot is still on for. */
export const context = internalQuery({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    const strategy = await ctx.db.get(args.strategyId);
    // An unpinned draft is judged by nothing, by a button or by a sweep.
    if (!strategy || !strategy.autopilot || strategy.status === "draft" || strategy.spec === undefined) return null;
    // A pass here sends an order to the venue, so the sweep judges only a pin the backend read from the chain.
    if (strategy.pinVerified !== true) return null;
    return { strategy, collateral: await firstCollateral(ctx.db, strategy.ownerUserId) };
  },
});

/** The first sweep after autopilot is turned on: remembers the candle that has closed and judges nothing. */
export const arm = internalMutation({
  args: { strategyId: v.id("strategies"), bucket: v.number() },
  handler: async (ctx, args): Promise<null> => {
    const strategy = await ctx.db.get(args.strategyId);
    if (!strategy || !strategy.autopilot || strategy.autopilotBucket !== undefined) return null;
    await ctx.db.patch(strategy._id, { autopilotBucket: args.bucket });
    return null;
  },
});

/**
 * Finishes proposals that waited too long. One the gateway never began is too
 * old to open. One whose order was begun and never reported is not known to be
 * closed: its reason says to look.
 */
export const expire = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    let finished = 0;
    for (const row of await waitingProposals(ctx.db)) {
      if (!handoffExpired(row.createdAt, now)) continue;
      const reason = row.openOrderId === undefined ? HANDOFF_MESSAGES.notPickedUp : HANDOFF_MESSAGES.noAnswer;
      await ctx.db.patch(row._id, notOpenedPatch(reason));
      finished += 1;
    }
    return finished;
  },
});

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

/**
 * The proposals that have not been handed to the venue yet, oldest first, each
 * with the trade the gateway is asked to open for it. One that has waited past
 * its window is left out: it is finished by the next sweep, not opened late.
 */
export const pending = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) => {
    const waiting = await waitingProposals(ctx.db);
    return waiting
      .filter((row) => isPending(row) && row.openOrderId === undefined && withinHandoff(row.createdAt, args.nowMs))
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((row) =>
        row.stakeUsd === undefined || row.holdSeconds === undefined
          ? []
          : [
              {
                proposalId: row._id as string,
                asset: row.asset,
                direction: directionOf(row.direction),
                stakeUsd: row.stakeUsd,
                seconds: row.holdSeconds,
              },
            ],
      );
  },
});

/**
 * Takes the order lock for a proposal's own order and records the order under
 * the proposal's owner. The opening order is given once, to a proposal still
 * inside its window, for the market and the side the rule passed. A second
 * asker (another gateway process, say) is told `busy`, which is true: that
 * order is on its way, and what became of it is the first asker's to report.
 * A closing order is only ever the gateway taking back a position it opened
 * for the proposal and could not record, so it is not held to the window.
 */
export const begin = internalMutation({
  args: {
    proposalId: v.id("trades"),
    network,
    asset: v.string(),
    action: v.union(v.literal("open"), v.literal("close")),
    side: v.optional(v.union(v.literal("long"), v.literal("short"))),
    notionalUsd: v.optional(v.number()),
    leverage: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; orderId: string } | { ok: false; code: "not_pending" | "no_user" | "busy" }> => {
    const { proposalId, ...order } = args;
    const row = await ctx.db.get(proposalId);
    if (!isProposal(row) || !sameMarket(order.asset, row.asset)) return { ok: false, code: "not_pending" };
    if (order.action === "open") {
      const mayOpen = isPending(row) && withinHandoff(row.createdAt, Date.now()) && order.side === row.direction;
      if (!mayOpen) return { ok: false, code: "not_pending" };
      if (row.openOrderId !== undefined) return { ok: false, code: "busy" };
    }
    const strategy = await ctx.db.get(row.strategyId);
    if (!strategy) return { ok: false, code: "no_user" };

    const taken = await takeLock(ctx, strategy.ownerUserId, order);
    if (taken.ok && order.action === "open") {
      await ctx.db.patch(row._id, { openOrderId: taken.orderId as Id<"venueOrders"> });
    }
    return taken;
  },
});

/**
 * Writes the row for a timed trade that has just opened for a proposal, under
 * the proposal's owner, and finishes the proposal as opened in the same
 * transaction: there is no moment at which the position is recorded and the
 * proposal still reads as waiting.
 */
export const start = internalMutation({
  args: {
    proposalId: v.id("trades"),
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
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; tradeId: string } | { ok: false; code: "not_pending" | "no_user" }> => {
    const { proposalId, ...trade } = args;
    const row = await ctx.db.get(proposalId);
    if (!isPending(row)) return { ok: false, code: "not_pending" };
    const strategy = await ctx.db.get(row.strategyId);
    if (!strategy) return { ok: false, code: "no_user" };

    const tradeId = await ctx.db.insert("timedTrades", {
      ...trade,
      userId: strategy.ownerUserId,
      venue: "perpl",
      status: "live",
      origin: "autopilot",
      proposalId,
    });
    await ctx.db.patch(row._id, openedPatch(tradeId, Date.now()));
    return { ok: true, tradeId };
  },
});

/**
 * What became of a proposal, said by the gateway. Only a proposal still
 * pending is changed, so a report said twice, or said after `start` already
 * finished it, changes nothing. An `opened` report has to name a timed trade
 * that was opened for this proposal.
 */
export const report = internalMutation({
  args: {
    proposalId: v.id("trades"),
    outcome: v.union(v.literal("opened"), v.literal("not_opened")),
    timedTradeId: v.optional(v.id("timedTrades")),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true } | { ok: false; code: "not_found" }> => {
    const row = await ctx.db.get(args.proposalId);
    if (!isProposal(row)) return { ok: false, code: "not_found" };
    if (!isPending(row)) return { ok: true };

    if (args.outcome === "opened") {
      const timed = args.timedTradeId ? await ctx.db.get(args.timedTradeId) : null;
      if (!timed || timed.proposalId !== row._id) return { ok: false, code: "not_found" };
      await ctx.db.patch(row._id, openedPatch(timed._id, Date.now()));
      return { ok: true };
    }
    await ctx.db.patch(row._id, notOpenedPatch(args.reason ?? HANDOFF_MESSAGES.noAnswer));
    return { ok: true };
  },
});
