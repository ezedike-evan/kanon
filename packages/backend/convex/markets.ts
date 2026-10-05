import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  MARKET_TEMPLATES,
  assetClassOf,
  evidenceFor,
  hashMarketTerms,
  hashSettlementEvidence,
  isMarketAsset,
  marketAssets,
  resolveMarket,
  resultForSide,
  type MarketResolution,
  type MarketTerms,
  type NewMarket,
  type ReferenceTick,
} from "@kanon/spec";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { requireUser } from "./authz";
import { decimal, marketParams } from "./schema";
import { MAX_TICKS_READ } from "./seriesLogic";
import {
  DIRECTIONS,
  FEED_OPEN_LIMIT,
  FEED_SETTLED_LIMIT,
  SETTLE_POSITIONS_BATCH,
  SETTLE_POSITIONS_MAX_ROUNDS,
  SWEEP_MARKET_LIMIT,
  isStreamLive,
  liveStreamKeys,
  needsCheck,
  planNewMarkets,
  seriesForMarket,
  settlementFields,
  sliceWindowRead,
  streamKey,
  unionRange,
  windowReadRange,
  type StoredTick,
  type WindowRead,
} from "./marketsLogic";

/**
 * Predict-tab market lifecycle: open, watch, settle.
 *
 * Everything that writes a market or its result is internal: the `sweep`
 * action, run once a minute from `crons.ts`, is the only path. No client can
 * open a market, move a threshold or record an outcome.
 *
 * Markets are built from the `ticks` series (see `ticks.ts`) by the rules in
 * `@kanon/spec`'s `market.ts`, and decided by `settleThreshold` through
 * `resolveMarket`, the same functions the UI reads. There is no second source
 * for a price and no second implementation of a hit.
 *
 * Internal functions are called by name through `makeFunctionReference`
 * because `_generated/api.d.ts` is stale until `npx convex dev` regenerates it.
 */

const marketInput = v.object({
  asset: v.string(),
  direction: v.union(v.literal("above"), v.literal("below")),
  thresholdPrice: decimal,
  windowStart: v.number(),
  windowEnd: v.number(),
  bucketSeconds: v.number(),
  template: v.string(),
  params: marketParams,
  termsHash: v.string(),
});

type Market = Doc<"markets">;
type Tick = { price: { atoms: string; decimals: number }; publishTime: number; feedId: string };

const termsOf = (m: Pick<Market, "asset" | "direction" | "thresholdPrice" | "windowStart" | "windowEnd" | "bucketSeconds">): MarketTerms => ({
  asset: m.asset,
  direction: m.direction,
  thresholdPrice: m.thresholdPrice,
  windowStart: m.windowStart,
  windowEnd: m.windowEnd,
  bucketSeconds: m.bucketSeconds,
});

// ---------------------------------------------------------------------------
// Reads a client may make.
// ---------------------------------------------------------------------------

/**
 * The feed: every market still open, soonest to expire first, then the latest
 * results. Each carries the asset's newest print, so a card can show where the
 * price is against the threshold. Only assets with a Pyth feed are ever
 * returned.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const open = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "open"))
      .order("asc")
      .take(FEED_OPEN_LIMIT);
    const settled = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "settled"))
      .order("desc")
      .take(FEED_SETTLED_LIMIT);
    const unresolvable = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "unresolvable"))
      .order("desc")
      .take(FEED_SETTLED_LIMIT);

    const recent = [...settled, ...unresolvable]
      .sort((a, b) => b.windowEnd - a.windowEnd)
      .slice(0, FEED_SETTLED_LIMIT);
    const markets = [...open, ...recent].filter((m) => isMarketAsset(m.asset));

    const latest: Record<string, { price: Tick["price"]; publishTime: number } | null> = {};
    for (const asset of new Set(markets.map((m) => m.asset))) {
      const tick = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) => q.eq("asset", asset))
        .order("desc")
        .first();
      latest[asset] = tick ? { price: tick.price, publishTime: tick.publishTime } : null;
    }

    return markets.map((m) => ({ ...m, latest: latest[m.asset] ?? null }));
  },
});

/**
 * Ties a market to the `ThresholdMarket` it was opened as on-chain. The first
 * link wins and later ones are refused. This is a claim, not a proof: the
 * chain is the truth, and a client checks the on-chain terms against this row's
 * before it stakes (`MarketClient.ensureMarket`). A wrong link is caught there
 * and never stakes on the wrong market.
 */
export const linkChainMarket = mutation({
  args: {
    marketId: v.id("markets"),
    chainId: v.number(),
    address: v.string(),
    chainMarketId: v.string(),
    txHash: v.string(),
  },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    if (!/^0x[0-9a-fA-F]{40}$/.test(args.address)) throw new Error("not an address");
    if (!/^\d+$/.test(args.chainMarketId)) throw new Error("not a market id");
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) throw new Error("not a transaction hash");
    const market = await ctx.db.get(args.marketId);
    if (!market) throw new Error("no such market");
    if (market.status !== "open") throw new Error("market is no longer open");
    if (market.chain) return { linked: false as const, chain: market.chain };
    const chain = {
      chainId: args.chainId,
      address: args.address,
      marketId: args.chainMarketId,
      txHash: args.txHash,
    };
    await ctx.db.patch(args.marketId, { chain });
    return { linked: true as const, chain };
  },
});

// ---------------------------------------------------------------------------
// Internal reads and writes, called only by `sweep`.
// ---------------------------------------------------------------------------

/**
 * Everything the sweep decides on besides tick windows, in one call: the open
 * markets (soonest to expire first) and each market asset's newest print.
 */
export const sweepSnapshot = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ open: Market[]; latest: Record<string, Tick | null> }> => {
    const open = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "open"))
      .order("asc")
      .take(SWEEP_MARKET_LIMIT);
    const latest: Record<string, Tick | null> = {};
    for (const asset of marketAssets()) {
      const tick = await ctx.db
        .query("ticks")
        .withIndex("by_asset_and_time", (q) => q.eq("asset", asset))
        .order("desc")
        .first();
      latest[asset] = tick
        ? { price: tick.price, publishTime: tick.publishTime, feedId: tick.feedId }
        : null;
    }
    return { open, latest };
  },
});

/** The `streamKey`s that already have a running window. */
export const liveStreams = internalQuery({
  args: { nowSeconds: v.number() },
  handler: async (ctx, args): Promise<string[]> => {
    const live: string[] = [];
    for (const asset of marketAssets()) {
      for (const template of MARKET_TEMPLATES) {
        for (const direction of DIRECTIONS) {
          const head = await ctx.db
            .query("markets")
            .withIndex("by_stream", (q) =>
              q.eq("asset", asset).eq("template", template.id).eq("direction", direction),
            )
            .order("desc")
            .first();
          if (isStreamLive(head, args.nowSeconds)) live.push(streamKey(asset, template.id, direction));
        }
      }
    }
    return live;
  },
});

/**
 * The recorded ticks in `[from, to)` for an asset, oldest first, and the first
 * tick at or after `to` (which is what says the window's last bucket is
 * complete). `truncated` when the window holds more ticks than one read allows:
 * a settlement made from a partial window would depend on where the read
 * stopped, so the sweep declines to settle it.
 */
export const windowTicks = internalQuery({
  args: { asset: v.string(), from: v.number(), to: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ticks: StoredTick[]; closing: StoredTick | null; truncated: boolean }> => {
    const rows = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) =>
        q.eq("asset", args.asset).gte("publishTime", args.from).lt("publishTime", args.to),
      )
      .order("asc")
      .take(MAX_TICKS_READ + 1);
    const closing = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", args.asset).gte("publishTime", args.to))
      .order("asc")
      .first();
    return {
      ticks: rows.slice(0, MAX_TICKS_READ).map((t) => ({ price: t.price, publishTime: t.publishTime })),
      closing: closing ? { price: closing.price, publishTime: closing.publishTime } : null,
      truncated: rows.length > MAX_TICKS_READ,
    };
  },
});

/**
 * Every window of one asset in a single read: the ticks in the union of the
 * ranges, ascending, and the first tick after it. The sweep cuts each market's
 * own window out of this (`sliceWindowRead`) rather than paying a function call
 * and a second index read per market. `truncated` when the union holds more
 * ticks than one read allows, in which case the caller reads market by market.
 */
export const windowTicksByAsset = internalQuery({
  args: { asset: v.string(), ranges: v.array(v.object({ from: v.number(), to: v.number() })) },
  handler: async (
    ctx,
    args,
  ): Promise<{ union: StoredTick[]; afterUnion: StoredTick | null; truncated: boolean }> => {
    const range = unionRange(args.ranges);
    if (!range) return { union: [], afterUnion: null, truncated: false };
    const rows = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) =>
        q.eq("asset", args.asset).gte("publishTime", range.from).lt("publishTime", range.to),
      )
      .order("asc")
      .take(MAX_TICKS_READ + 1);
    const after = await ctx.db
      .query("ticks")
      .withIndex("by_asset_and_time", (q) => q.eq("asset", args.asset).gte("publishTime", range.to))
      .order("asc")
      .first();
    return {
      union: rows.slice(0, MAX_TICKS_READ).map((t) => ({ price: t.price, publishTime: t.publishTime })),
      afterUnion: after ? { price: after.price, publishTime: after.publishTime } : null,
      truncated: rows.length > MAX_TICKS_READ,
    };
  },
});

/**
 * Inserts markets, re-checking under the write lock that each stream is still
 * without a running window, so two overlapping sweeps cannot both open one.
 */
export const openMarkets = internalMutation({
  args: { markets: v.array(marketInput), nowSeconds: v.number() },
  handler: async (ctx, args) => {
    let inserted = 0;
    for (const m of args.markets) {
      if (!isMarketAsset(m.asset)) continue;
      const assetClass = assetClassOf(m.asset);
      if (!assetClass) continue;
      const head = await ctx.db
        .query("markets")
        .withIndex("by_stream", (q) =>
          q.eq("asset", m.asset).eq("template", m.template).eq("direction", m.direction),
        )
        .order("desc")
        .first();
      if (isStreamLive(head, args.nowSeconds)) continue;
      await ctx.db.insert("markets", {
        ...m,
        assetClass,
        createdAt: Date.now(),
        status: "open",
      });
      inserted += 1;
    }
    return { inserted };
  },
});

export const markCrossed = internalMutation({
  args: { marketId: v.id("markets"), price: decimal, at: v.number() },
  handler: async (ctx, args) => {
    const market = await ctx.db.get(args.marketId);
    if (!market || market.status !== "open" || market.crossed) return { marked: false };
    await ctx.db.patch(args.marketId, { crossed: { price: args.price, at: args.at } });
    return { marked: true };
  },
});

/**
 * Records, per market, the newest tick time and side of `windowEnd` its latest
 * resolution was made against, so the next sweep can skip it while neither has
 * changed. Only open markets are touched.
 */
export const markChecked = internalMutation({
  args: {
    items: v.array(v.object({ marketId: v.id("markets"), tickAt: v.number(), ended: v.boolean() })),
  },
  handler: async (ctx, args) => {
    for (const item of args.items) {
      const market = await ctx.db.get(item.marketId);
      if (!market || market.status !== "open") continue;
      if (market.checkedTickAt === item.tickAt && market.checkedEnded === item.ended) continue;
      await ctx.db.patch(item.marketId, { checkedTickAt: item.tickAt, checkedEnded: item.ended });
    }
  },
});

/**
 * Writes a market's result. Idempotent: a market that already has one is left
 * alone, and a result is refused before the window has ended by the server's
 * own clock, whatever the caller believes.
 */
export const recordSettlement = internalMutation({
  args: {
    marketId: v.id("markets"),
    status: v.union(v.literal("settled"), v.literal("unresolvable")),
    outcome: v.optional(v.union(v.literal("hit"), v.literal("miss"))),
    decidingPrice: v.optional(decimal),
    decidingAt: v.optional(v.number()),
    windowExtreme: v.optional(v.object({ price: decimal, at: v.number() })),
    recordedCandles: v.number(),
    evidenceHash: v.string(),
  },
  handler: async (ctx, args) => {
    const market = await ctx.db.get(args.marketId);
    if (!market || market.status !== "open") return { recorded: false };
    if (Math.floor(Date.now() / 1000) <= market.windowEnd) return { recorded: false };
    const { marketId, ...fields } = args;
    await ctx.db.patch(marketId, { ...fields, settledAt: Date.now() });
    return { recorded: true };
  },
});

async function settleBatch(
  ctx: MutationCtx,
  marketId: Id<"markets">,
  limit: number,
): Promise<{ settled: number; remaining: boolean }> {
  const market = await ctx.db.get(marketId);
  if (!market || market.status === "open") return { settled: 0, remaining: false };
  const resolution: { kind: "settled"; hit: boolean } | { kind: "unresolvable" } =
    market.status === "unresolvable"
      ? { kind: "unresolvable" }
      : { kind: "settled", hit: market.outcome === "hit" };

  const batch = await ctx.db
    .query("predictions")
    .withIndex("by_market_and_status", (q) => q.eq("marketId", marketId).eq("status", "open"))
    .take(limit);
  for (const p of batch) {
    await ctx.db.patch(p._id, {
      status: "settled",
      result: resultForSide(market.direction, p.side, resolution),
      ...(market.decidingPrice ? { decidingPrice: market.decidingPrice } : {}),
      ...(market.decidingAt !== undefined ? { decidingAt: market.decidingAt } : {}),
    });
  }
  return { settled: batch.length, remaining: batch.length === limit };
}

/**
 * Settles the stakes on a resolved market, one batch per call. `remaining` is
 * true when the batch was full, so the caller asks again.
 */
export const settlePositions = internalMutation({
  args: { marketId: v.id("markets") },
  handler: async (ctx, args): Promise<{ settled: number; remaining: boolean }> => {
    return await settleBatch(ctx, args.marketId, SETTLE_POSITIONS_BATCH);
  },
});

/**
 * The same, for the most recently resolved markets in one call: the sweep's
 * safety net for stakes an interrupted sweep left open. Almost always there is
 * nothing to settle, and this costs one function call instead of one per
 * market. Stops when a market's batch fills, and says so, so a busy market is
 * settled by asking again.
 */
export const settleRecentPositions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ settled: number; remaining: boolean }> => {
    const settled = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "settled"))
      .order("desc")
      .take(FEED_SETTLED_LIMIT);
    const unresolvable = await ctx.db
      .query("markets")
      .withIndex("by_status_and_windowEnd", (q) => q.eq("status", "unresolvable"))
      .order("desc")
      .take(FEED_SETTLED_LIMIT);
    let total = 0;
    for (const market of [...settled, ...unresolvable]) {
      const { settled: n, remaining } = await settleBatch(ctx, market._id, SETTLE_POSITIONS_BATCH);
      total += n;
      if (remaining) return { settled: total, remaining: true };
    }
    return { settled: total, remaining: false };
  },
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

const sweepSnapshotRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { open: Market[]; latest: Record<string, Tick | null> }
>("markets:sweepSnapshot");
const liveStreamsRef = makeFunctionReference<"query", { nowSeconds: number }, string[]>("markets:liveStreams");
const windowTicksRef = makeFunctionReference<
  "query",
  { asset: string; from: number; to: number },
  { ticks: StoredTick[]; closing: StoredTick | null; truncated: boolean }
>("markets:windowTicks");
const windowTicksByAssetRef = makeFunctionReference<
  "query",
  { asset: string; ranges: { from: number; to: number }[] },
  { union: StoredTick[]; afterUnion: StoredTick | null; truncated: boolean }
>("markets:windowTicksByAsset");
const settleRecentPositionsRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { settled: number; remaining: boolean }
>("markets:settleRecentPositions");
const openMarketsRef = makeFunctionReference<
  "mutation",
  { markets: Array<NewMarket & { termsHash: string }>; nowSeconds: number },
  { inserted: number }
>("markets:openMarkets");
const markCheckedRef = makeFunctionReference<
  "mutation",
  { items: Array<{ marketId: Id<"markets">; tickAt: number; ended: boolean }> },
  null
>("markets:markChecked");
const markCrossedRef = makeFunctionReference<
  "mutation",
  { marketId: Id<"markets">; price: { atoms: string; decimals: number }; at: number },
  { marked: boolean }
>("markets:markCrossed");
const recordSettlementRef = makeFunctionReference<
  "mutation",
  {
    marketId: Id<"markets">;
    status: "settled" | "unresolvable";
    outcome?: "hit" | "miss";
    decidingPrice?: { atoms: string; decimals: number };
    decidingAt?: number;
    windowExtreme?: { price: { atoms: string; decimals: number }; at: number };
    recordedCandles: number;
    evidenceHash: string;
  },
  { recorded: boolean }
>("markets:recordSettlement");
const settlePositionsRef = makeFunctionReference<
  "mutation",
  { marketId: Id<"markets"> },
  { settled: number; remaining: boolean }
>("markets:settlePositions");

export interface SweepReport {
  checked: number;
  crossed: number;
  settled: number;
  unresolvable: number;
  awaiting: number;
  declined: number;
  opened: number;
  skipped: number;
}

/**
 * Every few minutes (`crons.ts`): settle what has ended, note what has already been touched,
 * open what is missing. Every market's fate is decided by one call to
 * `resolveMarket` over ticks read from the canonical series.
 */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<SweepReport> => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const report: SweepReport = {
      checked: 0,
      crossed: 0,
      settled: 0,
      unresolvable: 0,
      awaiting: 0,
      declined: 0,
      opened: 0,
      skipped: 0,
    };

    const { open, latest: latestByAsset } = await ctx.runQuery(sweepSnapshotRef, {});
    // A window that has not begun has nothing to read, and one already
    // marked crossed has nothing new to learn until it ends. A market whose
    // newest tick and side of `windowEnd` are unchanged since its last
    // resolution would resolve identically (`needsCheck`), so it is skipped
    // without a single tick read.
    const due = open.filter(
      (m) =>
        m.windowStart <= nowSeconds &&
        !(m.crossed && nowSeconds <= m.windowEnd) &&
        needsCheck(m, latestByAsset[m.asset]?.publishTime ?? null, nowSeconds),
    );
    const checked: Array<{ marketId: Id<"markets">; tickAt: number; ended: boolean }> = [];
    const remember = (m: Market) => {
      const tickAt = latestByAsset[m.asset]?.publishTime;
      if (tickAt !== undefined) checked.push({ marketId: m._id, tickAt, ended: nowSeconds > m.windowEnd });
    };

    // One read per asset covering every due window, cut per market below. A
    // market falls back to its own read when the union was too big for one.
    const byAsset = new Map<string, { from: number; to: number }[]>();
    for (const m of due) {
      const ranges = byAsset.get(m.asset) ?? [];
      ranges.push(windowReadRange(m));
      byAsset.set(m.asset, ranges);
    }
    const unions = new Map<string, { union: StoredTick[]; afterUnion: StoredTick | null } | null>();
    for (const [asset, ranges] of byAsset) {
      try {
        const read = await ctx.runQuery(windowTicksByAssetRef, { asset, ranges });
        unions.set(asset, read.truncated ? null : { union: read.union, afterUnion: read.afterUnion });
      } catch (err) {
        console.error(`markets:sweep union read failed for ${asset}`, err);
        unions.set(asset, null);
      }
    }

    for (const market of due) {
      report.checked += 1;

      try {
        const range = windowReadRange(market);
        const shared = unions.get(market.asset);
        const read: WindowRead = shared
          ? sliceWindowRead({ ...shared, range, maxTicks: MAX_TICKS_READ })
          : await ctx.runQuery(windowTicksRef, { asset: market.asset, ...range });
        if (read.truncated) {
          // Deciding on a partial window would make the answer depend on where the read stopped.
          console.warn(`markets:sweep declined ${market.asset} ${market.template}: window exceeds one read`);
          report.declined += 1;
          continue;
        }
        const series = seriesForMarket({
          asset: market.asset,
          window: market,
          windowTicks: read.ticks,
          closingTick: read.closing,
        });
        const terms = termsOf(market);
        const resolution: MarketResolution = resolveMarket(series, terms, nowSeconds);

        if (resolution.kind === "crossed") {
          await ctx.runMutation(markCrossedRef, {
            marketId: market._id,
            price: resolution.decidingPrice,
            at: resolution.decidingAt,
          });
          report.crossed += 1;
          remember(market);
        } else if (resolution.kind === "awaiting") {
          report.awaiting += 1;
          remember(market);
        } else if (resolution.kind === "open") {
          remember(market);
        } else if (resolution.kind === "settled" || resolution.kind === "unresolvable") {
          const fields = settlementFields(resolution);
          if (!fields) continue;
          const evidenceHash = await hashSettlementEvidence(evidenceFor(terms, resolution));
          const { recorded } = await ctx.runMutation(recordSettlementRef, {
            marketId: market._id,
            ...fields,
            evidenceHash,
          });
          if (!recorded) continue;
          if (resolution.kind === "settled") report.settled += 1;
          else report.unresolvable += 1;

          for (let round = 0; round < SETTLE_POSITIONS_MAX_ROUNDS; round += 1) {
            const { remaining } = await ctx.runMutation(settlePositionsRef, { marketId: market._id });
            if (!remaining) break;
          }
        }
      } catch (err) {
        // One bad market must not stop the rest from settling.
        console.error(`markets:sweep failed on ${market._id}`, err);
        report.declined += 1;
      }
    }

    if (checked.length > 0) await ctx.runMutation(markCheckedRef, { items: checked });

    // Stakes left open on a market an earlier, interrupted sweep had already resolved.
    // Nothing to do on a fully settled market, so this is one cheap call.
    for (let round = 0; round < SETTLE_POSITIONS_MAX_ROUNDS; round += 1) {
      const { remaining } = await ctx.runMutation(settleRecentPositionsRef, {});
      if (!remaining) break;
    }

    // The open markets already say which streams are live. Past the read cap
    // they might not be the whole set, so ask each stream (`openMarkets` also
    // re-checks under the write lock).
    const live =
      open.length < SWEEP_MARKET_LIMIT
        ? liveStreamKeys(open, nowSeconds)
        : new Set(await ctx.runQuery(liveStreamsRef, { nowSeconds }));
    const latest: Record<string, ReferenceTick | null> = {};
    for (const [asset, tick] of Object.entries(latestByAsset)) {
      latest[asset] = tick
        ? {
            price: tick.price,
            publishTime: tick.publishTime,
            feedId: tick.feedId,
          }
        : null;
    }

    const plan = planNewMarkets({ nowSeconds, latest, live });
    report.skipped = plan.skipped.length;
    if (plan.toOpen.length > 0) {
      const withHash = await Promise.all(
        plan.toOpen.map(async (m) => ({ ...m, termsHash: await hashMarketTerms(m) })),
      );
      const { inserted } = await ctx.runMutation(openMarketsRef, {
        markets: withHash,
        nowSeconds,
      });
      report.opened = inserted;
    }
    return report;
  },
});
