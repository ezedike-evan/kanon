import { query, type QueryCtx } from "./_generated/server";
import { MAX_LIST_ROWS } from "./limits";
import { v } from "convex/values";
import { viewOwnedStrategy } from "./authz";
import { parseSpec, type AnalyticsReport, type Decimal } from "@kanon/spec";
import {
  buildReport,
  type AnalyticsTrade,
  type AssetCandles,
  type MarginPosition,
} from "./analyticsLogic";
import {
  MAX_LIMIT,
  MAX_TICKS_READ,
  isAllowedBucketSeconds,
  normalizeAsset,
  ticksToSeries,
  windowStartSeconds,
} from "./seriesLogic";

/**
 * The analytics screen's read: one reactive query over a strategy's trades, the
 * owner's margin account and positions, and the tick series.
 *
 * All arithmetic is `analyticsLogic.ts`, tested against the contract's own
 * vectors. This file only fetches rows and hands them over. It calls no model
 * and writes nothing.
 *
 * Trade history is read from the `trades` table. The indexer
 * (`packages/indexer/src/client.ts`) carries the on-chain log of the same
 * events and could replace this read once a deployment exists to query; nothing
 * here depends on it.
 */

/** Trades read per report. Newest first, so the ceiling drops the oldest rather than the latest. */
const MAX_TRADES = 1000;

/**
 * Candles for `asset`, reaching back far enough to cover the oldest trade in
 * view (up to the series read's own ceiling). A verdict about a trade the
 * candles do not reach is withheld by `modelTrade`, not guessed.
 */
async function readCandles(
  ctx: QueryCtx,
  asset: string,
  bucketSeconds: number,
  oldestTradeMs: number | undefined,
  now: number,
): Promise<{ series: AssetCandles; truncated: boolean }> {
  const empty = { series: { bucketSeconds, candles: [] }, truncated: false };
  if (!isAllowedBucketSeconds(bucketSeconds)) return empty;

  const key = normalizeAsset(asset);
  const latest = await ctx.db
    .query("ticks")
    .withIndex("by_asset_and_time", (q) => q.eq("asset", key))
    .order("desc")
    .first();
  if (!latest) return empty;

  const wanted =
    oldestTradeMs === undefined
      ? 120
      : Math.ceil(Math.max(0, now - oldestTradeMs) / 1000 / bucketSeconds) + 2;
  const limit = Math.min(MAX_LIMIT, Math.max(2, wanted));
  const from = windowStartSeconds(latest.publishTime, bucketSeconds, limit);

  const rows = await ctx.db
    .query("ticks")
    .withIndex("by_asset_and_time", (q) => q.eq("asset", key).gte("publishTime", from))
    .order("desc")
    .take(MAX_TICKS_READ + 1);
  const truncated = rows.length > MAX_TICKS_READ;

  const result = ticksToSeries({
    asset: key,
    bucketSeconds,
    ticks: rows.slice(0, MAX_TICKS_READ).reverse(),
    truncated,
  });
  return { series: { bucketSeconds, candles: result.candles }, truncated };
}

async function latestPrice(ctx: QueryCtx, asset: string): Promise<Decimal | null> {
  const tick = await ctx.db
    .query("ticks")
    .withIndex("by_asset_and_time", (q) => q.eq("asset", normalizeAsset(asset)))
    .order("desc")
    .first();
  return tick ? tick.price : null;
}

export const report = query({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args): Promise<AnalyticsReport | null> => {
    const owned = await viewOwnedStrategy(ctx, args.strategyId);
    if (!owned) return null;
    const { user, strategy } = owned;

    let asset: string;
    let bucketSeconds: number;
    try {
      const spec = parseSpec(strategy.spec ?? strategy.pendingSpec);
      asset = spec.series.asset;
      bucketSeconds = spec.series.bucketSeconds;
    } catch {
      // A strategy with no readable spec has nothing to report on.
      return null;
    }

    const now = Date.now();

    const rows = await ctx.db
      .query("trades")
      .withIndex("by_strategy", (q) => q.eq("strategyId", args.strategyId))
      .order("desc")
      .take(MAX_TRADES);
    const trades: AnalyticsTrade[] = rows.map((t) => ({
      id: String(t._id),
      direction: t.direction,
      asset: t.asset,
      entry: t.entry,
      size: t.size,
      stop: t.stop,
      status: t.status,
      failedPredicateId: t.failedPredicateId,
      failedSymbol: t.failedSymbol,
      results: t.results,
      createdAt: t.createdAt,
      executedAt: t.executedAt,
      equity: t.equity,
    }));
    const oldest = trades.reduce<number | undefined>(
      (m, t) => (m === undefined || t.createdAt < m ? t.createdAt : m),
      undefined,
    );

    const { series, truncated } = await readCandles(ctx, asset, bucketSeconds, oldest, now);

    // The owner's margin account, if they have one. The newest, as `proposer`
    // reads it; the schema has no explicit "active account".
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();

    const positions: MarginPosition[] = [];
    const marks: Record<string, Decimal> = {};
    if (account) {
      const open = await ctx.db
        .query("positions")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .take(MAX_LIST_ROWS);
      for (const p of open) {
        positions.push({ asset: p.asset, side: p.side, size: p.size, entryPrice: p.entryPrice });
        const key = normalizeAsset(p.asset);
        if (!(key in marks)) {
          const price = await latestPrice(ctx, p.asset);
          if (price) marks[key] = price;
        }
      }
    }

    return buildReport({
      now,
      strategy: {
        id: String(strategy._id),
        status: strategy.status,
        specHash: strategy.specHash,
        asset,
        cooldownEndsAt: strategy.cooldownEndsAt,
      },
      trades,
      series: { [normalizeAsset(asset)]: series },
      truncated,
      // `debt` is not mirrored into Convex, so it is absent (zero) here. The
      // on-chain `debtOf` is authoritative and is stated as untracked on screen.
      account: account ? { collateral: account.collateral } : null,
      positions,
      marks,
    });
  },
});
