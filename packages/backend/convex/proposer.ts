import { action, type ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  TIMEFRAME_SECONDS,
  parseSpec,
  type Decimal,
  type Series,
  type StrategySpec,
} from "@kanon/spec";
import { requireSubject } from "./authz";
import { AUTOPILOT_STAKE_USD, holdSecondsFor } from "./autopilotLogic";
import {
  PAPER_EQUITY,
  bucketsNeeded,
  modelRefusedOutcome,
  proposeTrade,
  requiredCandles,
  summariseBlocked,
  type ModelledOutcome,
  type PredicateOutcome,
  type BlockedSummary,
} from "./proposerLogic";

/**
 * The action around `proposeTrade`. It does the I/O the pure function may not:
 * reads the strategy and the price series, calls the proposer, and writes the
 * `trades` row. It never calls a model and never decides anything itself.
 *
 * `evaluateStrategy` is that I/O. A button press reaches it through
 * `runProposer`; autopilot reaches it from its sweep (`autopilot.ts`), once per
 * closed candle. Both get the same reads, the same arithmetic and the same row.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

type SeriesResult = Series & { truncated: boolean };

// The caller is authenticated from their token (`requireSubject`), and the
// strategy is read through an internal query that returns it only when that
// Privy DID owns it. The client never names a user.
const getContext = makeFunctionReference<
  "query",
  { strategyId: Id<"strategies">; subject: string },
  { strategy: Doc<"strategies">; collateral: Decimal | null } | null
>("proposerData:context");

const getSeries = makeFunctionReference<
  "query",
  { asset: string; bucketSeconds: number; limit?: number },
  SeriesResult
>("series:getSeries");

const listRefused = makeFunctionReference<
  "query",
  { strategyId: Id<"strategies">; subject: string },
  Doc<"trades">[]
>("trades:refusedForSubject");

// Null only for autopilot: the candle was already judged, or it passed while the strategy's last
// autopilot trade was still open. A button press is always written.
const recordEvaluation = makeFunctionReference<
  "mutation",
  Record<string, unknown>,
  Id<"trades"> | null
>("trades:recordEvaluation");

export type RunProposerResult =
  | { status: "proposed" | "refused"; tradeId: Id<"trades"> }
  | { status: "unavailable"; reason: string; message: string }
  | { status: "blocked"; message: string };

/** What one evaluation came to. `unavailable` wrote nothing and claims nothing: a gap in the data is not a rule failing. */
export type Evaluated =
  | { status: "proposed" | "refused"; tradeId: Id<"trades"> }
  | { status: "unavailable"; reason: string; message: string }
  /** Autopilot only: the verdict was reached and no row was written for it (`trades:recordEvaluation` says when). */
  | { status: "skipped"; verdict: "proposed" | "refused" };

export interface EvaluateInput {
  /** A strategy with an enforced spec. The caller has already settled whose it is. */
  strategy: Doc<"strategies">;
  /** The owner's account collateral, or null to size against paper equity. */
  collateral: Decimal | null;
  /** Set by the sweep: the start of the closed candle being judged, unix seconds. */
  autopilot?: { bucket: number };
}

/** The candle-coordinate evidence pointer for one predicate's deciding candle. */
function evidenceRef(feed: string, bucketSeconds: number, o: PredicateOutcome): string {
  return `${feed}#${bucketSeconds}s@${o.at}`;
}

/**
 * One evaluation of a pinned rule, start to finish: reads the series each
 * predicate is written on, hands them to `proposeTrade`, and writes the row
 * for the verdict. The verdict is `proposeTrade`'s alone. Who asked changes
 * only what is written beside it.
 */
export async function evaluateStrategy(ctx: ActionCtx, input: EvaluateInput): Promise<Evaluated> {
  const { strategy, autopilot } = input;
  const spec: StrategySpec = parseSpec(strategy.spec);

  const source: Record<number, Series> = {};
  for (const bucketSeconds of bucketsNeeded(spec)) {
    const series = await ctx.runQuery(getSeries, {
      asset: spec.series.asset,
      bucketSeconds,
      limit: requiredCandles(spec, bucketSeconds),
    });
    source[bucketSeconds] = series;
  }

  const equity = input.collateral ?? undefined;

  const now = Date.now();
  const out = proposeTrade(spec, source, now, {
    equity: equity ?? PAPER_EQUITY,
    equitySource: equity ? "account" : "paper",
  });

  if (out.kind === "unavailable") {
    return { status: "unavailable", reason: out.reason, message: out.message };
  }

  const bucketOf = (o: PredicateOutcome): number => {
    const tf = spec.predicates.find((p) => p.id === o.predicateId)?.timeframe.value;
    return tf ? TIMEFRAME_SECONDS[tf] : spec.series.bucketSeconds;
  };

  const common = {
    strategyId: strategy._id,
    direction: out.setup.direction,
    asset: out.setup.asset,
    entry: out.setup.entry,
    size: out.setup.size,
    stop: out.setup.stop,
    results: out.results,
    specHash: strategy.specHash,
    scan: out.scan,
    equity: out.setup.equity,
    equitySource: out.setup.equitySource,
    riskBps: out.setup.riskBps,
    feed: spec.series.feed,
    evidenceRefs: out.results.map((r) => evidenceRef(spec.series.feed, bucketOf(r), r)),
    // What the gateway is asked to open if this passes, stated on the row from the backend's own table.
    ...(autopilot
      ? {
          autopilot: {
            bucket: autopilot.bucket,
            stakeUsd: AUTOPILOT_STAKE_USD,
            holdSeconds: holdSecondsFor(spec.series.bucketSeconds),
          },
        }
      : {}),
  };

  if (out.kind === "proposal") {
    const tradeId = await ctx.runMutation(recordEvaluation, {
      ...common,
      status: "proposed",
      satisfiedPredicateIds: out.results.map((r) => r.predicateId),
      // The undo window is for the person who pressed the button. Nobody is there for an autopilot
      // proposal, and it does not run on paper when a window lapses: the gateway opens it.
      ...(autopilot ? {} : { undoExpiresAt: out.undoExpiresAt }),
    });
    return tradeId ? { status: "proposed", tradeId } : { status: "skipped", verdict: "proposed" };
  }

  const tradeId = await ctx.runMutation(recordEvaluation, {
    ...common,
    status: "refused",
    satisfiedPredicateIds: out.results.filter((r) => r.satisfied).map((r) => r.predicateId),
    failedPredicateId: out.failed.predicateId,
    failedSymbol: out.failed.symbol,
    failingValue: out.failed.decidingValue,
    requiredValue: out.failed.referenceValue,
  });
  return tradeId ? { status: "refused", tradeId } : { status: "skipped", verdict: "refused" };
}

export const runProposer = action({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args): Promise<RunProposerResult> => {
    const subject = await requireSubject(ctx);
    const owned = await ctx.runQuery(getContext, { strategyId: args.strategyId, subject });
    if (!owned) return { status: "blocked", message: "Strategy not found." };
    const { strategy } = owned;
    // Enforcement is the product: an unpinned draft is judged by nothing.
    if (strategy.status === "draft" || strategy.spec === undefined) {
      return { status: "blocked", message: "Pin the rule before it can judge a trade." };
    }
    const out = await evaluateStrategy(ctx, { strategy, collateral: owned.collateral });
    // Only autopilot's write can be skipped. A button press is always written.
    if (out.status === "skipped") return { status: "blocked", message: "The verdict was not recorded. Try again." };
    return out;
  },
});

export interface BlockedReport {
  summary: BlockedSummary;
  /** By trade id. `pending` until a candle has printed after the refusal. */
  outcomes: Record<string, ModelledOutcome>;
}

/**
 * What the refusals would have cost, played forward over the candles that
 * printed after each one. The arithmetic is `modelRefusedOutcome`, tested;
 * this only fetches the later data and hands it over.
 */
export const blockedReport = action({
  args: { strategyId: v.id("strategies") },
  handler: async (ctx, args): Promise<BlockedReport> => {
    const subject = await requireSubject(ctx);
    const owned = await ctx.runQuery(getContext, { strategyId: args.strategyId, subject });
    if (!owned) return { summary: summariseBlocked([]), outcomes: {} };
    const { strategy } = owned;
    const spec = parseSpec(strategy.spec ?? strategy.pendingSpec);
    const refused = await ctx.runQuery(listRefused, { strategyId: args.strategyId, subject });
    if (refused.length === 0) return { summary: summariseBlocked([]), outcomes: {} };

    const bucketSeconds = spec.series.bucketSeconds;
    const series = await ctx.runQuery(getSeries, {
      asset: spec.series.asset,
      bucketSeconds,
      limit: 500,
    });

    const outcomes: Record<string, ModelledOutcome> = {};
    for (const t of refused) {
      outcomes[t._id] = modelRefusedOutcome(
        { direction: t.direction, entry: t.entry, stop: t.stop, size: t.size, at: t.createdAt },
        series.candles,
      );
    }
    return { summary: summariseBlocked(Object.values(outcomes)), outcomes };
  },
});
