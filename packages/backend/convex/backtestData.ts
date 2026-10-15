import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { CandleRow } from "./seriesLogic";

/**
 * What `backtest:run` reads and writes. Actions cannot touch the database, and
 * these are internal so no client can call them: the action has already
 * authenticated the caller, settled the spec and its hash, and decided which
 * closed candles may be read.
 *
 * The deployment is near its database I/O limit, so every read here is a
 * bounded index range and a fresh run reads each candle row once:
 *
 *   bounds      the asset's backfill state and the oldest and newest candle
 *               starts at or before `through`: three single-row reads
 *   candlePage  up to `CANDLE_PAGE_SIZE` rows from `from` to `through`, ascending.
 *               The next page starts one width after the last row, so pages
 *               never overlap
 *   cached      the one stored run of a spec
 *   store       replaces it
 */

/** Rows per page: well inside a query's read limits, and few pages for a long history. */
export const CANDLE_PAGE_SIZE = 1000;

export type BoundsState = "none" | "backfilling" | "ready";

export interface Bounds {
  /** `none`: no candle history was ever started for the asset. `backfilling`: it is still being built. */
  state: BoundsState;
  /** Unix seconds: the oldest and newest candle starts at or before `through`, or null when there are none. */
  oldest: number | null;
  newest: number | null;
}

export const bounds = internalQuery({
  args: { asset: v.string(), bucketSeconds: v.number(), through: v.number() },
  handler: async (ctx, args): Promise<Bounds> => {
    const meta = await ctx.db
      .query("candleMeta")
      .withIndex("by_asset", (q) => q.eq("asset", args.asset))
      .first();
    if (!meta) return { state: "none", oldest: null, newest: null };
    // Until the backfill finishes, the stored candles are a partial view of the ticks: not tested on.
    if (meta.state !== "ready") return { state: "backfilling", oldest: null, newest: null };
    const range = () =>
      ctx.db
        .query("candles")
        .withIndex("by_asset_width_start", (q) =>
          q.eq("asset", args.asset).eq("bucketSeconds", args.bucketSeconds).lte("start", args.through),
        );
    const oldest = await range().order("asc").first();
    const newest = await range().order("desc").first();
    return { state: "ready", oldest: oldest?.start ?? null, newest: newest?.start ?? null };
  },
});

/** Candles from `from` to `through` inclusive, oldest first, at most `CANDLE_PAGE_SIZE`. Only what a candle row means is returned. */
export const candlePage = internalQuery({
  args: { asset: v.string(), bucketSeconds: v.number(), from: v.number(), through: v.number() },
  handler: async (ctx, args): Promise<CandleRow[]> => {
    const rows = await ctx.db
      .query("candles")
      .withIndex("by_asset_width_start", (q) =>
        q
          .eq("asset", args.asset)
          .eq("bucketSeconds", args.bucketSeconds)
          .gte("start", args.from)
          .lte("start", args.through),
      )
      .order("asc")
      .take(CANDLE_PAGE_SIZE);
    return rows.map((r) => ({
      start: r.start,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      openTime: r.openTime,
      closeTime: r.closeTime,
    }));
  },
});

export const cached = internalQuery({
  args: { specHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("backtests")
      .withIndex("by_spec", (q) => q.eq("specHash", args.specHash))
      .first();
  },
});

/**
 * Replaces the stored run of a spec. A run over older candles never replaces
 * one over newer candles from the same engine: two runs that crossed each other
 * leave the newer answer in place.
 */
export const store = internalMutation({
  args: {
    specHash: v.string(),
    asset: v.string(),
    bucketSeconds: v.number(),
    throughBucket: v.number(),
    computedAt: v.number(),
    engineVersion: v.number(),
    outcome: v.any(),
  },
  handler: async (ctx, args): Promise<null> => {
    const existing = await ctx.db
      .query("backtests")
      .withIndex("by_spec", (q) => q.eq("specHash", args.specHash))
      .first();
    if (!existing) {
      await ctx.db.insert("backtests", args);
      return null;
    }
    if (existing.engineVersion === args.engineVersion && existing.throughBucket > args.throughBucket) return null;
    await ctx.db.replace(existing._id, args);
    return null;
  },
});
