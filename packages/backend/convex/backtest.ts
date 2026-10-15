import { action } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import { StrategySpec, specHash as hashSpec } from "@kanon/spec";
import { requireSubject } from "./authz";
import { lastClosedBucket } from "./autopilotLogic";
import { CANDLE_PAGE_SIZE, type Bounds } from "./backtestData";
import {
  ENGINE_VERSION,
  MAX_BACKTEST_CANDLES,
  historyNotReady,
  insufficientHistory,
  noCandles,
  precheckBacktest,
  runBacktest,
  walkWidth,
  type BacktestHalt,
  type BacktestOutcome,
  type BacktestResult,
} from "./backtestLogic";
import { checkRateLimit, type RateLimited } from "./rateLimit";
import { candlesToSeries, normalizeAsset, type CandleRow } from "./seriesLogic";

/**
 * Test on recorded prices: the action around `runBacktest`. It does the I/O the
 * pure engine may not, and decides nothing itself.
 *
 * The deployment is near its database I/O limit, so the order is cheapest first
 * and a candle is read only when nothing cheaper can answer:
 *
 *   1. who is asking (`requireSubject`), and the spec's hash, worked out here
 *      from the spec rather than taken from the client;
 *   2. the halts that need no data (no stated stop or target, more than one
 *      candle width): free;
 *   3. the stored run of this spec. While it ran through the newest closed
 *      candle it is the answer, and no candle is read;
 *   4. with `run` false, that is all: the stored run however old, or nothing;
 *   5. the asset's history bounds (three single-row reads), and the halts they
 *      decide: still being built, no candles, too few. None spends a slot;
 *   6. one slot of the caller's `backtest` rate limit, then every closed candle
 *      of the newest `MAX_BACKTEST_CANDLES` buckets, each row once, the engine,
 *      and the run stored for next time.
 *
 * The candle still forming is never read: everything stops at the newest closed
 * one (`lastClosedBucket`, the same boundary autopilot judges at). No cron, no
 * subscription: a run happens only when somebody asks for one.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

/** A stored run larger than this is returned but not kept: a Convex document holds at most 1 MiB. */
export const MAX_STORED_BYTES = 900_000;

// A type, not an interface: it is also the argument object of `backtestData:store`.
type StoredRun = {
  specHash: string;
  asset: string;
  bucketSeconds: number;
  throughBucket: number;
  computedAt: number;
  engineVersion: number;
  outcome: BacktestOutcome;
};

const cachedRef = makeFunctionReference<"query", { specHash: string }, StoredRun | null>("backtestData:cached");
const boundsRef = makeFunctionReference<
  "query",
  { asset: string; bucketSeconds: number; through: number },
  Bounds
>("backtestData:bounds");
const candlePageRef = makeFunctionReference<
  "query",
  { asset: string; bucketSeconds: number; from: number; through: number },
  CandleRow[]
>("backtestData:candlePage");
const storeRef = makeFunctionReference<"mutation", StoredRun, null>("backtestData:store");

/** A run, stored or just made, and how far behind the newest closed candle it is. */
interface Ran {
  specHash: string;
  /** Unix seconds: the newest closed candle the run read up to. */
  throughBucket: number;
  /** Milliseconds. */
  computedAt: number;
  /** Candles that have closed since. Zero: the answer is current. */
  behindCandles: number;
  /** `stored`: read back from the last run, no candle read. `run`: worked out just now. */
  source: "stored" | "run";
}

export type BacktestReply =
  | ({ status: "result"; result: BacktestResult } & Ran)
  /** No win rate. `ran` is absent for a halt worked out before any candle was read. */
  | { status: "halted"; specHash: string; halt: BacktestHalt; ran?: Ran }
  /** Asked not to run, and nothing is stored for this spec yet. */
  | { status: "not_run"; specHash: string }
  | RateLimited;

function reply(run: StoredRun, through: number, source: Ran["source"]): BacktestReply {
  const ran: Ran = {
    specHash: run.specHash,
    throughBucket: run.throughBucket,
    computedAt: run.computedAt,
    behindCandles: Math.max(0, Math.round((through - run.throughBucket) / run.bucketSeconds)),
    source,
  };
  return run.outcome.kind === "result"
    ? { status: "result", result: run.outcome, ...ran }
    : { status: "halted", specHash: run.specHash, halt: run.outcome, ran };
}

export const run = action({
  args: {
    /** The rule to test, as the review or the pinned rule holds it. Validated here like any client input. */
    spec: v.any(),
    /** False: answer only from what is stored, reading no candle and spending no slot. True: run if the stored answer is not current. */
    run: v.boolean(),
  },
  handler: async (ctx, args): Promise<BacktestReply> => {
    const subject = await requireSubject(ctx);
    const parsed = StrategySpec.safeParse(args.spec);
    if (!parsed.success) {
      throw new ConvexError({ code: "invalid_spec", message: "That is not a rule the test can read." });
    }
    const spec = parsed.data;
    const specHash = await hashSpec(spec);

    const pre = precheckBacktest(spec);
    if (pre) return { status: "halted", specHash, halt: pre };

    const width = walkWidth(spec)!;
    const asset = normalizeAsset(spec.series.asset);
    const through = lastClosedBucket(Math.floor(Date.now() / 1000), width);

    const stored = await ctx.runQuery(cachedRef, { specHash });
    const usable = stored && stored.engineVersion === ENGINE_VERSION ? stored : null;
    if (usable && usable.throughBucket >= through) return reply(usable, through, "stored");
    if (!args.run) return usable ? reply(usable, through, "stored") : { status: "not_run", specHash };

    const b = await ctx.runQuery(boundsRef, { asset, bucketSeconds: width, through });
    if (b.state === "backfilling") return { status: "halted", specHash, halt: historyNotReady(spec) };
    if (b.oldest === null || b.newest === null) return { status: "halted", specHash, halt: noCandles(spec) };
    const from = Math.max(b.oldest, through - (MAX_BACKTEST_CANDLES - 1) * width);
    // Buckets from the first candle read to the newest closed one that has a candle, gaps included.
    const short = insufficientHistory(spec, Math.floor((b.newest - from) / width) + 1);
    if (short) return { status: "halted", specHash, halt: short };

    const limited = await checkRateLimit(ctx, subject, "backtest");
    if (limited) return limited;

    const rows: CandleRow[] = [];
    let cursor = from;
    for (;;) {
      const page = await ctx.runQuery(candlePageRef, { asset, bucketSeconds: width, from: cursor, through });
      rows.push(...page);
      const last = page[page.length - 1];
      if (!last || page.length < CANDLE_PAGE_SIZE || last.start >= through) break;
      cursor = last.start + width;
    }

    const outcome = runBacktest(spec, candlesToSeries({ asset, bucketSeconds: width, rows }));
    const made: StoredRun = {
      specHash,
      asset,
      bucketSeconds: width,
      throughBucket: through,
      computedAt: Date.now(),
      engineVersion: ENGINE_VERSION,
      outcome,
    };
    if (JSON.stringify(outcome).length <= MAX_STORED_BYTES) await ctx.runMutation(storeRef, made);
    return reply(made, through, "run");
  },
});
