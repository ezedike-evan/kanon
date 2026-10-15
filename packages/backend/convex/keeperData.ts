import { internalMutation, internalQuery, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { MAX_LIST_ROWS } from "./limits";
import {
  feedOfSeriesIn,
  feedsInUse,
  holdsLease,
  keeperStatus,
  keeperView,
  leaseDecision,
  utcDayStart,
  withSpend,
} from "./keeperLogic";
import { describeEnvProblem, parseSeriesEnv } from "./serverEnv";

/**
 * The keeper's one row (`schema.ts`, `keeper`): the signer's lease, the feeds a
 * pinned rule uses, what was last sampled, and what the signer has spent today.
 *
 * The tick (`keeper.ts`) reads this row and nothing else, so a minute with
 * nothing to do costs one small read. The feeds in use are written here when a
 * pin changes them (`recomputeKeeperFeeds`), never found by scanning rules.
 *
 * Everything but `publicStatus` is internal: nobody signs in for the keeper.
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

async function keeperRow(db: DatabaseReader): Promise<Doc<"keeper"> | null> {
  return await db.query("keeper").first();
}

/** The row, created empty the first time anything writes it. Two first writers are serialised by Convex. */
async function ensureRow(ctx: MutationCtx): Promise<Doc<"keeper">> {
  const row = await keeperRow(ctx.db);
  if (row) return row;
  const id = await ctx.db.insert("keeper", { feeds: [], sampled: [], spentWeiDay: "0", dayStart: utcDayStart(Date.now()) });
  const made = await ctx.db.get(id);
  if (!made) throw new Error("the keeper row could not be created");
  return made;
}

/**
 * Recomputes the feeds in use from the rules pinned now, once, and writes them
 * to the keeper row. Called where the set can change: a pin (which may also
 * replace an owner's earlier rule), a loosening that moves a rule's series, and
 * by hand through `recomputeFeeds`. A malformed `SERIES_*_ADDRESS` leaves the
 * set as it was rather than empty it.
 */
export async function recomputeKeeperFeeds(ctx: MutationCtx): Promise<string[] | null> {
  const series = parseSeriesEnv(process.env);
  if (!series.ok) {
    console.error(describeEnvProblem("keeper feeds", series.invalid));
    return null;
  }
  const rows: Doc<"strategies">[] = [];
  for (const status of ["pinned", "cooling_off"] as const) {
    rows.push(
      ...(await ctx.db
        .query("strategies")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(MAX_LIST_ROWS)),
    );
  }
  const feeds = feedsInUse(rows, feedOfSeriesIn(series.value));
  const row = await ensureRow(ctx);
  if (JSON.stringify(feeds) !== JSON.stringify(row.feeds)) {
    await ctx.db.patch(row._id, { feeds, sampled: row.sampled.filter((s) => feeds.includes(s.feed)) });
  }
  return feeds;
}

/** The row as the tick reads it. Null before anything was ever written. */
export const state = internalQuery({
  args: {},
  handler: async (ctx) => await keeperRow(ctx.db),
});

/** `npx convex run keeperData:status`: balance, spend, cap, feeds, the lease and what is misconfigured, by name. */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => keeperStatus(await keeperRow(ctx.db), process.env, Date.now()),
});

/** The keeper's health for anyone: no key, no URL, nothing about any user. */
export const publicStatus = query({
  args: {},
  handler: async (ctx) => keeperView(await keeperRow(ctx.db), process.env, Date.now()),
});

/**
 * Takes the signer for `holder` for `LEASE_TTL_MS`, unless someone else holds
 * it. One transaction is in flight at a time under it, and its receipt is
 * awaited before the next.
 */
export const acquire = internalMutation({
  args: { holder: v.string() },
  handler: async (ctx, args) => {
    const row = await ensureRow(ctx);
    const answer = leaseDecision(row, args.holder, Date.now());
    if (answer.ok) await ctx.db.patch(row._id, { leaseHolder: args.holder, leaseUntil: answer.leaseUntil });
    return answer;
  },
});

/**
 * Lets go of the signer, and adds what was spent under it to the day's count.
 * The spend is added even when the lease ran out and passed to someone else:
 * the chain billed it all the same.
 */
export const release = internalMutation({
  args: { holder: v.string(), spentWei: v.string() },
  handler: async (ctx, args) => {
    if (!/^\d{1,40}$/.test(args.spentWei)) throw new Error("spentWei must be a whole number of wei");
    const row = await ensureRow(ctx);
    const spent = BigInt(args.spentWei);
    const patch = {
      ...(spent > 0n ? withSpend(row, Date.now(), spent) : {}),
      ...(holdsLease(row, args.holder) ? { leaseHolder: undefined, leaseUntil: undefined } : {}),
    };
    if (Object.keys(patch).length > 0) await ctx.db.patch(row._id, patch);
    return null;
  },
});

/** What a tick saw, written only when it changed something (`tickNote`). */
export const noteTick = internalMutation({
  args: {
    sampled: v.array(v.object({ feed: v.string(), bucket: v.number() })),
    paused: v.union(v.string(), v.null()),
    error: v.union(v.string(), v.null()),
    balanceWei: v.optional(v.string()),
    signer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ensureRow(ctx);
    const now = Date.now();
    await ctx.db.patch(row._id, {
      sampled: args.sampled,
      paused: args.paused ?? undefined,
      ...(args.balanceWei !== undefined ? { balanceWei: args.balanceWei, balanceAt: now } : {}),
      ...(args.signer !== undefined ? { signer: args.signer } : {}),
      ...(args.error !== null ? { lastError: args.error, lastErrorAt: now } : {}),
    });
    return null;
  },
});

/**
 * Remembers that autopilot judged `bucket` (unix seconds over 900) clean: every
 * rule it is on for was judged or settled. The tick does not hand that bucket
 * to autopilot again. Never moves backwards.
 */
export const noteJudged = internalMutation({
  args: { bucket: v.number() },
  handler: async (ctx, args) => {
    const row = await ensureRow(ctx);
    if (row.judgedBucket === undefined || row.judgedBucket < args.bucket) await ctx.db.patch(row._id, { judgedBucket: args.bucket });
    return null;
  },
});

/**
 * Recomputes the feeds in use by hand: run once after `SERIES_*_ADDRESS` is
 * set, to count rules pinned before the keeper existed.
 *
 *   npx convex run keeperData:recomputeFeeds
 */
export const recomputeFeeds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const feeds = await recomputeKeeperFeeds(ctx);
    if (feeds === null) throw new Error("a SERIES_*_ADDRESS variable is malformed; see the log");
    return { feeds };
  },
});
