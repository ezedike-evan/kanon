import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  DEFAULT_HERMES_URL,
  extractPriceUpdates,
  fedAssets,
  fetchHermesLatest,
  fetchPythOnChain,
  type PriceUpdate,
  type SkippedUpdate,
} from "@kanon/spec";
import { internalAction, internalMutation, type MutationCtx } from "./_generated/server";
import { decimal } from "./schema";
import {
  ALLOWED_BUCKET_SECONDS,
  BACKFILL_BATCH,
  PRUNE_BATCH,
  TICK_RETENTION_DAYS,
  foldTickIntoCandle,
  mergeCandles,
  sameCandle,
  type CandleRow,
} from "./seriesLogic";

/**
 * Off-chain canonical series ingestion: Pyth -> `ticks`.
 *
 * Both functions are internal, so no client can call them. The cron in
 * `crons.ts` runs `ingest` every couple of minutes. `recordTicks` also folds
 * each new tick into the `candles` table, and `pruneTicks` (daily) drops ticks
 * past `TICK_RETENTION_DAYS`.
 *
 * Default source: the Pyth PriceFeed contract on Monad, read with plain
 * JSON-RPC `eth_call` (`getPriceUnsafe`). Keyless, and the very contract
 * `CanonicalSeries` samples, so the chart and the on-chain series agree. Pyth
 * pushes the sponsored feeds itself (1h heartbeat, 0.02% deviation), so most
 * minutes re-read the last price with an unchanged `publishTime`, which
 * `recordTicks` drops as a duplicate.
 *
 * Optional alternate source: Pyth Hermes, used only when `HERMES_API_KEY` is
 * set. Unset, Hermes is never called, so it cannot fail every minute (the
 * public Hermes endpoint answers 401 without credentials).
 *
 * Config is read from the Convex deployment's environment, never a client:
 *   MONAD_RPC_URL           default https://rpc.monad.xyz
 *   HERMES_API_KEY          set to switch to Hermes
 *   HERMES_URL              default https://hermes.pyth.network
 *   HERMES_API_KEY_HEADER   default `Authorization` (sent as Bearer)
 */

type TickInput = {
  asset: string;
  feedId: string;
  price: { atoms: string; decimals: number };
  publishTime: number;
};

// `_generated/api.d.ts` is stale until `npx convex dev` regenerates it, so the
// mutation is referenced by name instead of through `internal`.
const recordTicksRef = makeFunctionReference<
  "mutation",
  { ticks: TickInput[] },
  { inserted: number; duplicates: number }
>("ticks:recordTicks");
const backfillRef = makeFunctionReference<"mutation", { asset: string }, null>("ticks:backfillCandles");
const pruneRef = makeFunctionReference<"mutation", Record<string, never>, null>("ticks:pruneTicks");

type FoldInput = { publishTime: number; price: { atoms: string; decimals: number } };

/**
 * Folds ticks into the stored candles of every width. Ticks are first
 * aggregated in memory per (width, bucket), so each candle is read once and
 * written once (and not at all when nothing changed).
 */
async function foldIntoCandles(ctx: MutationCtx, asset: string, ticks: readonly FoldInput[]): Promise<void> {
  for (const width of ALLOWED_BUCKET_SECONDS) {
    const folded = new Map<number, CandleRow>();
    for (const t of ticks) {
      const start = Math.floor(t.publishTime / width) * width;
      folded.set(start, foldTickIntoCandle(folded.get(start) ?? null, t, width));
    }
    for (const [start, row] of folded) {
      const existing = await ctx.db
        .query("candles")
        .withIndex("by_asset_width_start", (q) => q.eq("asset", asset).eq("bucketSeconds", width).eq("start", start))
        .first();
      if (!existing) {
        await ctx.db.insert("candles", { asset, bucketSeconds: width, ...row });
        continue;
      }
      const current: CandleRow = {
        start: existing.start,
        open: existing.open,
        high: existing.high,
        low: existing.low,
        close: existing.close,
        openTime: existing.openTime,
        closeTime: existing.closeTime,
      };
      const merged = mergeCandles(current, row);
      if (!sameCandle(current, merged)) {
        const { start: _s, ...fields } = merged;
        await ctx.db.patch(existing._id, fields);
      }
    }
  }
}

/**
 * Inserts ticks, skipping any (asset, publishTime) already stored. Pyth only
 * moves `publishTime` when it has a new aggregate, so a minute with no new
 * print re-delivers the last one and must not become a second row.
 */
export const recordTicks = internalMutation({
  args: {
    ticks: v.array(
      v.object({
        asset: v.string(),
        feedId: v.string(),
        price: decimal,
        publishTime: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    let inserted = 0;
    let duplicates = 0;
    const fresh: typeof args.ticks = [];
    for (const tick of args.ticks) {
      const existing = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) =>
          q.eq("asset", tick.asset).eq("publishTime", tick.publishTime),
        )
        .first();
      if (existing) {
        duplicates += 1;
        continue;
      }
      await ctx.db.insert("ticks", tick);
      inserted += 1;
      fresh.push(tick);
    }

    const byAsset = new Map<string, typeof fresh>();
    for (const t of fresh) byAsset.set(t.asset, [...(byAsset.get(t.asset) ?? []), t]);
    for (const [asset, group] of byAsset) {
      await foldIntoCandles(ctx, asset, group);
    }
    // First sight of an asset: rebuild its candle history from the stored ticks.
    for (const asset of new Set(args.ticks.map((t) => t.asset))) {
      const meta = await ctx.db
        .query("candleMeta")
        .withIndex("by_asset", (q) => q.eq("asset", asset))
        .first();
      if (meta) continue;
      await ctx.db.insert("candleMeta", { asset, state: "backfilling", cursor: 0 });
      await ctx.scheduler.runAfter(0, backfillRef, { asset });
    }
    return { inserted, duplicates };
  },
});

/**
 * Rebuilds an asset's candles from stored ticks, `BACKFILL_BATCH` at a time,
 * rescheduling itself until done and then marking the asset `ready` so
 * `getSeries` starts reading candles. Folding is idempotent and
 * order-independent, so it is safe alongside live writes and safe to re-run
 * (`npx convex run ticks:backfillCandles '{"asset":"BTC/USD"}'`).
 */
export const backfillCandles = internalMutation({
  args: { asset: v.string() },
  handler: async (ctx, args): Promise<null> => {
    let meta = await ctx.db
      .query("candleMeta")
      .withIndex("by_asset", (q) => q.eq("asset", args.asset))
      .first();
    if (!meta) {
      const id = await ctx.db.insert("candleMeta", { asset: args.asset, state: "backfilling", cursor: 0 });
      meta = (await ctx.db.get(id))!;
    } else if (meta.state === "ready") {
      // An explicit re-run: start over.
      await ctx.db.patch(meta._id, { state: "backfilling", cursor: 0 });
      meta = { ...meta, state: "backfilling", cursor: 0 };
    }
    const rows = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", args.asset).gt("publishTime", meta.cursor))
      .order("asc")
      .take(BACKFILL_BATCH);
    if (rows.length > 0) await foldIntoCandles(ctx, args.asset, rows);
    if (rows.length < BACKFILL_BATCH) {
      await ctx.db.patch(meta._id, { state: "ready" });
    } else {
      await ctx.db.patch(meta._id, { cursor: rows[rows.length - 1]!.publishTime });
      await ctx.scheduler.runAfter(0, backfillRef, { asset: args.asset });
    }
    return null;
  },
});

/**
 * Daily: deletes ticks older than `TICK_RETENTION_DAYS`, `PRUNE_BATCH` per
 * asset per call, and reschedules itself while any asset has more. An asset's
 * newest tick is never deleted, so a long outage cannot erase the reference
 * price. Candles are kept: charts do not depend on old ticks.
 */
export const pruneTicks = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const cutoff = Math.floor(Date.now() / 1000) - TICK_RETENTION_DAYS * 86_400;
    let more = false;
    for (const { symbol } of fedAssets()) {
      const old = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) => q.eq("asset", symbol).lt("publishTime", cutoff))
        .order("asc")
        .take(PRUNE_BATCH);
      if (old.length === 0) continue;
      const newest = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) => q.eq("asset", symbol))
        .order("desc")
        .first();
      for (const t of old) {
        if (newest && t._id === newest._id) continue;
        await ctx.db.delete(t._id);
      }
      if (old.length === PRUNE_BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, pruneRef, {});
    return null;
  },
});

async function readPrices(): Promise<{ updates: PriceUpdate[]; skipped: SkippedUpdate[] }> {
  const feeds = fedAssets();
  const apiKey = process.env.HERMES_API_KEY || undefined;
  if (apiKey) {
    const response = await fetchHermesLatest(
      fetch,
      {
        baseUrl: process.env.HERMES_URL || DEFAULT_HERMES_URL,
        apiKey,
        apiKeyHeader: process.env.HERMES_API_KEY_HEADER || undefined,
      },
      feeds.map((f) => f.feedId),
    );
    return extractPriceUpdates(response);
  }
  return await fetchPythOnChain(fetch, { rpcUrl: process.env.MONAD_RPC_URL || undefined }, feeds);
}

export const ingest = internalAction({
  args: {},
  handler: async (ctx) => {
    const { updates, skipped } = await readPrices();
    for (const s of skipped) console.warn(`ticks:ingest skipped ${s.id}: ${s.reason}`);
    if (updates.length === 0) return { inserted: 0, duplicates: 0 };

    return await ctx.runMutation(recordTicksRef, {
      ticks: updates.map((u) => ({
        asset: u.asset,
        feedId: u.feedId,
        price: u.price,
        publishTime: u.publishTime,
      })),
    });
  },
});
