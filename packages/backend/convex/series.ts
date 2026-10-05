import { query } from "./_generated/server";
import { v } from "convex/values";
import { viewOwnedStrategy } from "./authz";
import { marketAssets } from "@kanon/spec";
import type { QueryCtx } from "./_generated/server";
import {
  MAX_TICKS_READ,
  candlesToSeries,
  TICKER_WINDOW_SECONDS,
  clampLimit,
  isAllowedBucketSeconds,
  normalizeAsset,
  tickerFrom,
  ticksToSeries,
  tradesToMarkers,
  windowStartSeconds,
  type ChartMarker,
  type SeriesResult,
  type TickerResult,
} from "./seriesLogic";

/**
 * Candles for one asset, from the `candles` table (or, before its backfill
 * finishes, bucketed from the canonical tick series).
 *
 * The tick path reads the newest ticks first, so the window always ends at the latest print
 * and reaches back `limit` buckets. Never invents a price: empty buckets come
 * back flat and flagged `synthetic`, and an asset with no ticks returns no
 * candles. See `seriesLogic.ts` for the bucket rules and the read ceiling.
 */
export const getSeries = query({
  args: {
    asset: v.string(),
    bucketSeconds: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SeriesResult> => {
    if (!isAllowedBucketSeconds(args.bucketSeconds)) {
      throw new Error(`unsupported bucketSeconds: ${args.bucketSeconds}`);
    }
    const asset = normalizeAsset(args.asset);
    const limit = clampLimit(args.limit);

    // Pre-aggregated candles once the asset's backfill is done: at most `limit`
    // rows, and only a change to a candle re-runs a subscriber. Until then (a
    // fresh deploy) fall back to bucketing ticks.
    const meta = await ctx.db
      .query("candleMeta")
      .withIndex("by_asset", (q) => q.eq("asset", asset))
      .first();
    if (meta?.state === "ready") {
      const newest = await ctx.db
        .query("candles")
        .withIndex("by_asset_width_start", (q) => q.eq("asset", asset).eq("bucketSeconds", args.bucketSeconds))
        .order("desc")
        .first();
      if (!newest) return { asset, bucketSeconds: args.bucketSeconds, candles: [], truncated: false };
      const rows = await ctx.db
        .query("candles")
        .withIndex("by_asset_width_start", (q) =>
          q
            .eq("asset", asset)
            .eq("bucketSeconds", args.bucketSeconds)
            .gte("start", newest.start - (limit - 1) * args.bucketSeconds),
        )
        .order("asc")
        .take(limit);
      return candlesToSeries({ asset, bucketSeconds: args.bucketSeconds, rows });
    }

    const latest = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", asset))
      .order("desc")
      .first();
    if (!latest) return { asset, bucketSeconds: args.bucketSeconds, candles: [], truncated: false };

    const from = windowStartSeconds(latest.publishTime, args.bucketSeconds, limit);
    // One row past the ceiling, so hitting it is detected rather than guessed.
    const rows = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", asset).gte("publishTime", from))
      .order("desc")
      .take(MAX_TICKS_READ + 1);
    const truncated = rows.length > MAX_TICKS_READ;

    return ticksToSeries({
      asset,
      bucketSeconds: args.bucketSeconds,
      ticks: rows.slice(0, MAX_TICKS_READ).reverse(),
      truncated,
    });
  },
});

/**
 * Executed and refused trades of a strategy, each pinned to the start of the
 * candle it landed in at `bucketSeconds`, ready to draw on `getSeries`'s bars.
 * The signed-in owner's only: anyone else gets no markers.
 */
export const getChartMarkers = query({
  args: {
    strategyId: v.id("strategies"),
    asset: v.string(),
    bucketSeconds: v.number(),
  },
  handler: async (ctx, args): Promise<ChartMarker[]> => {
    if (!isAllowedBucketSeconds(args.bucketSeconds)) {
      throw new Error(`unsupported bucketSeconds: ${args.bucketSeconds}`);
    }
    if (!(await viewOwnedStrategy(ctx, args.strategyId))) return [];
    const trades = await ctx.db
      .query("trades")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
      .order("desc")
      .take(1000);
    return tradesToMarkers(trades, { asset: args.asset, bucketSeconds: args.bucketSeconds });
  },
});

/**
 * One asset's newest print and its move over the last 24 hours. Two index
 * reads, whatever the history holds, and the second (the first print in the
 * window) is not invalidated by a newer print arriving, so a subscriber is
 * only re-run when the price itself changes.
 */
async function readTicker(ctx: QueryCtx, asset: string): Promise<TickerResult | null> {
  const latest = await ctx.db
    .query("ticks")
    .withIndex("by_asset_and_time", (q) => q.eq("asset", asset))
    .order("desc")
    .first();
  if (!latest) return null;
  const open = await ctx.db
    .query("ticks")
    .withIndex("by_asset_and_time", (q) =>
      q.eq("asset", asset).gte("publishTime", latest.publishTime - TICKER_WINDOW_SECONDS),
    )
    .order("asc")
    .first();
  return tickerFrom({
    asset,
    latest: { price: latest.price, publishTime: latest.publishTime },
    open: open ? { price: open.price, publishTime: open.publishTime } : null,
  });
}

/**
 * The price for one pair. A component that shows a single price subscribes to
 * this rather than to the whole list, so another pair's tick does not re-run it.
 */
export const getTicker = query({
  args: { asset: v.string() },
  handler: async (ctx, args): Promise<TickerResult | null> => {
    return await readTicker(ctx, normalizeAsset(args.asset));
  },
});

/** Every tradeable pair's price and 24-hour move: what a pair list renders. */
export const listTickers = query({
  args: {},
  handler: async (ctx): Promise<TickerResult[]> => {
    const out: TickerResult[] = [];
    for (const asset of marketAssets()) {
      const ticker = await readTicker(ctx, asset);
      if (ticker) out.push(ticker);
    }
    return out;
  },
});
