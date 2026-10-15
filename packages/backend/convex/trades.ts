import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { MAX_LIST_ROWS } from "./limits";
import type { Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { decimal, gateRecord } from "./schema";
import {
  ownedStrategyBySubject,
  requireOwnedTrade,
  viewOwnedStrategy,
  viewOwnedTrade,
  viewerUser,
} from "./authz";
import { hasOpenTrade } from "./autopilotData";
import { HANDOFF_EXPIRY_MS, HANDOFF_MESSAGES, notOpenedPatch } from "./autopilotLogic";
import {
  UNDO_WINDOW_MS,
  confirmTransition,
  finalizeTransition,
  undoTransition,
} from "./proposerLogic";

const tradeStatus = v.union(
  v.literal("proposed"),
  v.literal("executed"),
  v.literal("refused"),
  v.literal("undone"),
);

const outcome = v.object({
  predicateId: v.string(),
  kind: v.string(),
  symbol: v.string(),
  satisfied: v.boolean(),
  decidingValue: decimal,
  referenceValue: decimal,
  at: v.number(),
});

// Referenced by name: `_generated/api.d.ts` is stale until `npx convex dev`
// regenerates it, so `internal.trades.finalizeTrade` would not type-check yet.
const finalizeTradeRef = makeFunctionReference<
  "mutation",
  { tradeId: Id<"trades"> },
  unknown
>("trades:finalizeTrade");

const expireOneRef = makeFunctionReference<"mutation", { tradeId: Id<"trades"> }, unknown>("autopilotData:expireOne");

/**
 * Written only by `evaluateStrategy` (`proposer.ts`), for a button press or for
 * autopilot, once a gate transaction has carried a verdict. Not callable by a
 * client: a browser must never be able to insert an "executed" trade, or a
 * refusal that did not happen.
 *
 * Every gate transaction gets its row: what the chain said is recorded, even
 * when nothing follows from it. With `autopilot`, a pass is handed to the
 * gateway only if this one transaction can still settle that it should be:
 *
 *   - the bucket this pass claimed is still the strategy's claim. Autopilot
 *     turned off meanwhile makes the pass a proposal that was not opened,
 *     `turnedOff`;
 *   - the strategy has no autopilot trade waiting to be opened or still
 *     running. One that has makes the pass a proposal not opened, `stillOpen`.
 *
 * A refusal is recorded either way. A pass handed to the gateway is finished
 * by `autopilotData:expireOne` if nothing answered for it in time.
 */
export const recordEvaluation = internalMutation({
  args: {
    strategyId: v.id("strategies"),
    direction: v.union(v.literal("long"), v.literal("short")),
    asset: v.string(),
    entry: decimal,
    size: decimal,
    stop: decimal,
    status: v.union(v.literal("proposed"), v.literal("refused")),
    satisfiedPredicateIds: v.array(v.string()),
    failedPredicateId: v.optional(v.string()),
    failedSymbol: v.optional(v.string()),
    failingValue: v.optional(decimal),
    requiredValue: v.optional(decimal),
    evidenceRefs: v.array(v.string()),
    results: v.array(outcome),
    specHash: v.string(),
    scan: v.object({ from: v.number(), to: v.number(), asOf: v.number() }),
    equity: decimal,
    equitySource: v.union(v.literal("account"), v.literal("paper")),
    riskBps: v.number(),
    feed: v.string(),
    undoExpiresAt: v.optional(v.number()),
    resultsSource: v.optional(v.union(v.literal("chain"), v.literal("offchain"))),
    gate: v.optional(gateRecord),
    /** Autopilot's: the bucket it claimed (its start, unix seconds) and what a pass asks the gateway to open. */
    autopilot: v.optional(v.object({ bucket: v.number(), stakeUsd: v.number(), holdSeconds: v.number() })),
  },
  handler: async (ctx, args): Promise<{ tradeId: Id<"trades">; handoff?: "pending" | "not_opened" }> => {
    const { autopilot, ...row } = args;
    const createdAt = Date.now();

    if (!autopilot) {
      const tradeId = await ctx.db.insert("trades", { ...row, createdAt });
      if (row.status === "proposed" && row.undoExpiresAt !== undefined) {
        // The trade executes on its own once the undo window has run. A little
        // slack keeps the scheduler from firing a hair before the window closes.
        await ctx.scheduler.runAfter(UNDO_WINDOW_MS + 250, finalizeTradeRef, { tradeId });
      }
      return { tradeId };
    }

    if (row.status === "refused") {
      return { tradeId: await ctx.db.insert("trades", { ...row, createdAt, origin: "autopilot" }) };
    }
    // No undo window and no paper execution: the gateway opens this, and reports what became of it.
    const { undoExpiresAt: _noWindow, ...proposal } = row;
    const pass = { ...proposal, createdAt, origin: "autopilot" as const, stakeUsd: autopilot.stakeUsd, holdSeconds: autopilot.holdSeconds };

    const strategy = await ctx.db.get(row.strategyId);
    const claimed = strategy !== null && strategy.autopilot && strategy.autopilotBucket === autopilot.bucket;
    if (!claimed) {
      const tradeId = await ctx.db.insert("trades", { ...pass, ...notOpenedPatch(HANDOFF_MESSAGES.turnedOff) });
      return { tradeId, handoff: "not_opened" };
    }
    if (await hasOpenTrade(ctx.db, strategy._id)) {
      const tradeId = await ctx.db.insert("trades", { ...pass, ...notOpenedPatch(HANDOFF_MESSAGES.stillOpen) });
      return { tradeId, handoff: "not_opened" };
    }
    const tradeId = await ctx.db.insert("trades", { ...pass, handoff: "pending" });
    await ctx.scheduler.runAfter(HANDOFF_EXPIRY_MS, expireOneRef, { tradeId });
    return { tradeId, handoff: "pending" };
  },
});

export const getTrade = query({
  args: { tradeId: v.id("trades") },
  handler: async (ctx, args) => {
    return (await viewOwnedTrade(ctx, args.tradeId))?.trade ?? null;
  },
});

export const listTradesByStrategy = query({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args) => {
    if (!(await viewOwnedStrategy(ctx, args.strategyId))) return [];
    return await ctx.db
      .query("trades")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
      .order("desc")
      .take(MAX_LIST_ROWS);
  },
});

/** How many rows one recent-activity read may return. */
export const MAX_ACTIVITY = 50;

/**
 * The signed-in user's newest trades across every strategy they own, slimmed
 * to what an activity row shows (no evidence chain: that is one tap away, on
 * the trade). Bounded by `limit` per strategy, so it costs the same however
 * long the history is, unlike `listTradesByStrategy`, which returns the newest 500.
 */
export const listRecentActivity = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await viewerUser(ctx);
    if (!user) return [];
    const limit = Math.min(MAX_ACTIVITY, Math.max(1, Math.floor(args.limit ?? 10)));
    const strategies = await ctx.db
      .query("strategies")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .take(100);
    const rows = [];
    for (const strategy of strategies) {
      const trades = await ctx.db
        .query("trades")
        .withIndex("by_strategy", (q) => q.eq("strategyId", strategy._id))
        .order("desc")
        .take(limit);
      rows.push(...trades);
    }
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((t) => ({
        _id: t._id,
        strategyId: t.strategyId,
        asset: t.asset,
        direction: t.direction,
        status: t.status,
        entry: t.entry,
        size: t.size,
        stop: t.stop,
        createdAt: t.createdAt,
        executedAt: t.executedAt,
        failedSymbol: t.failedSymbol,
        // `autopilot` when autopilot wrote the row. Absent for a button press.
        origin: t.origin,
        // The gate transaction that decided it. Absent on a row decided off-chain, before the gate.
        gateTx: t.gate?.txHash,
      }));
  },
});

export const listTradesByStrategyAndStatus = query({
  args: {
    strategyId: v.id("strategies"),
    status: tradeStatus,
  },
  handler: async (ctx, args) => {
    if (!(await viewOwnedStrategy(ctx, args.strategyId))) return [];
    return await ctx.db
      .query("trades")
      .withIndex("by_strategy_and_status", (q) =>
        q.eq("strategyId", args.strategyId).eq("status", args.status),
      )
      .order("desc")
      .take(MAX_LIST_ROWS);
  },
});

/**
 * Refused trades of a strategy, for the blocked-report action. Internal: the
 * action has already authenticated the caller and passes their Privy DID, and
 * the strategy must be theirs.
 */
export const refusedForSubject = internalQuery({
  args: { strategyId: v.id("strategies"), subject: v.string() },
  handler: async (ctx, args) => {
    if (!(await ownedStrategyBySubject(ctx.db, args.subject, args.strategyId))) return [];
    return await ctx.db
      .query("trades")
      .withIndex("by_strategy_and_status", (q) =>
        q.eq("strategyId", args.strategyId).eq("status", "refused"),
      )
      .order("desc")
      .take(MAX_LIST_ROWS);
  },
});

/** Undo, enforced against the server clock. A trade past its window cannot be undone. */
export const undoTrade = mutation({
  args: { tradeId: v.id("trades") },
  handler: async (ctx, args) => {
    const { trade } = await requireOwnedTrade(ctx, args.tradeId);
    const next = undoTransition(trade, Date.now());
    if (!next.ok) return { ok: false as const, reason: next.reason, status: trade.status };
    await ctx.db.patch(trade._id, { status: next.status });
    return { ok: true as const, status: next.status };
  },
});

/**
 * Executes a proposed trade before its window has run. An autopilot proposal is
 * not confirmed from here: the gateway opens it, and marking it executed on
 * paper while its order may be on its way would leave one row telling two stories.
 */
export const confirmTrade = mutation({
  args: { tradeId: v.id("trades") },
  handler: async (ctx, args) => {
    const { trade } = await requireOwnedTrade(ctx, args.tradeId);
    if (trade.origin === "autopilot" && trade.status === "proposed") {
      return { ok: false as const, reason: "not_proposed" as const, status: trade.status };
    }
    const next = confirmTransition(trade, Date.now());
    if (!next.ok) return { ok: false as const, reason: next.reason, status: trade.status };
    if (trade.status !== next.status) {
      await ctx.db.patch(trade._id, {
        status: next.status,
        executedAt: Date.now(),
        executionMode: "paper",
      });
    }
    return { ok: true as const, status: next.status };
  },
});

/**
 * Executes a proposed trade whose undo window has run out. Idempotent. Internal:
 * only the scheduler (`recordEvaluation` schedules it) runs it, so no client
 * can trigger a state change on a trade id it merely holds.
 */
export const finalizeTrade = internalMutation({
  args: { tradeId: v.id("trades") },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.tradeId);
    if (!trade) return { ok: false as const, reason: "not_found" as const };
    const next = finalizeTransition(trade, Date.now());
    if (!next.ok) return { ok: false as const, reason: next.reason, status: trade.status };
    if (trade.status !== next.status) {
      await ctx.db.patch(trade._id, {
        status: next.status,
        executedAt: Date.now(),
        executionMode: "paper",
      });
    }
    return { ok: true as const, status: next.status };
  },
});
