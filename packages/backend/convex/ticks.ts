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
import { internalAction, internalMutation } from "./_generated/server";
import { decimal } from "./schema";

/**
 * Off-chain canonical series ingestion: Pyth -> `ticks`.
 *
 * Both functions are internal, so no client can call them. The cron in
 * `crons.ts` runs `ingest` once a minute.
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
    }
    return { inserted, duplicates };
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
