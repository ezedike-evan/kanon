import { action, type ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { parseSpec, type Decimal, type Series, type StrategySpec } from "@kanon/spec";
import { requireSubject } from "./authz";
import { AUTOPILOT_STAKE_USD, holdSecondsFor } from "./autopilotLogic";
import { convexLease, gateSetup, judgeOnChain, keeperRow, readReplay, realClock } from "./gate";
import { gateEligibility, rowFromJudgment, type GateUnavailableReason, type OffchainJudgment } from "./gateLogic";
import { spentToday } from "./keeperLogic";
import {
  PAPER_EQUITY,
  UNDO_WINDOW_MS,
  bucketsNeeded,
  modelRefusedOutcome,
  proposeTrade,
  requiredCandles,
  summariseBlocked,
  type ModelledOutcome,
  type BlockedSummary,
} from "./proposerLogic";
import { checkRateLimit } from "./rateLimit";

/**
 * The action around a judgment. Every judgment, a button press or autopilot's,
 * pass or refusal, is a real `RefusalGate.evaluateOnChain` transaction signed
 * by Kanon's key, and the verdict is the chain's (`gate.ts`). Nothing here
 * decides one, and no model is called.
 *
 * `evaluateStrategy` is the I/O, in this order:
 *
 *   1. Whether the gate can judge the rule at all (`gateEligibility`). If not,
 *      nothing is read and nothing is spent.
 *   2. The off-chain arithmetic, `proposeTrade` over Convex's candles, for the
 *      setup's entry, stop and size: the gate judges a rule, not a price to
 *      trade at. Its verdict is kept beside the chain's as `offchainVerdict`.
 *   3. `judgeOnChain`: the transaction, its receipt and its event.
 *   4. `readReplay`: the verdict explained over the chain's own candles.
 *   5. `trades:recordEvaluation`, the row, with the transaction as its evidence.
 *
 * A button press reaches it through `runProposer`; autopilot through the
 * keeper tick (`autopilot.ts`), once per 15-minute bucket.
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

const recordEvaluation = makeFunctionReference<
  "mutation",
  Record<string, unknown>,
  { tradeId: Id<"trades">; handoff?: "pending" | "not_opened" }
>("trades:recordEvaluation");

export type RunProposerResult =
  | { status: "proposed" | "refused"; tradeId: Id<"trades">; txHash: string }
  | { status: "unavailable"; reason: string; message: string; txHash?: string }
  | { status: "blocked"; message: string };

/**
 * What one evaluation came to. `unavailable` wrote nothing and claims nothing:
 * the rule was not judged, and `message` says why. `txHash` is there when a
 * transaction was sent and carries no verdict (it reverted, or was not
 * confirmed): the evidence of what was spent.
 */
export type Evaluated =
  | { status: "proposed" | "refused"; tradeId: Id<"trades">; txHash: string; handoff?: "pending" | "not_opened" }
  | {
      status: "unavailable";
      reason: GateUnavailableReason | "send_failed" | "no_series" | "insufficient_data" | "stale" | "bad_price";
      message: string;
      /** Whether asking again a minute later can give another answer. */
      retryable: boolean;
      txHash?: string;
    };

export interface EvaluateInput {
  /** A strategy with an enforced spec. The caller has already settled whose it is. */
  strategy: Doc<"strategies">;
  /** The owner's account collateral, or null to size against paper equity. */
  collateral: Decimal | null;
  /** Set by autopilot: the bucket it claimed (its start, unix seconds). */
  autopilot?: { bucket: number };
}

/** The setup's entry, stop and size from Convex's candles, and what that arithmetic said. */
async function offchainSetup(
  ctx: ActionCtx,
  spec: StrategySpec,
  collateral: Decimal | null,
): Promise<{ ok: true; offchain: OffchainJudgment } | { ok: false; reason: "no_series" | "insufficient_data" | "stale" | "bad_price"; message: string }> {
  const source: Record<number, Series> = {};
  for (const bucketSeconds of bucketsNeeded(spec)) {
    source[bucketSeconds] = await ctx.runQuery(getSeries, {
      asset: spec.series.asset,
      bucketSeconds,
      limit: requiredCandles(spec, bucketSeconds),
    });
  }
  const equity = collateral ?? undefined;
  const out = proposeTrade(spec, source, Date.now(), {
    equity: equity ?? PAPER_EQUITY,
    equitySource: equity ? "account" : "paper",
  });
  if (out.kind === "unavailable") return { ok: false, reason: out.reason, message: out.message };
  return {
    ok: true,
    offchain: {
      verdict: out.kind === "proposal" ? "proposed" : "refused",
      setup: out.setup,
      results: out.results,
      scan: out.scan,
    },
  };
}

/** One judgment of a pinned rule on the gate, start to finish, in the order the module comment gives. */
export async function evaluateStrategy(ctx: ActionCtx, input: EvaluateInput): Promise<Evaluated> {
  const { strategy, autopilot } = input;
  const spec: StrategySpec = parseSpec(strategy.spec);

  const setup = gateSetup(process.env);
  if (!setup.ok) return { status: "unavailable", reason: setup.reason, message: setup.message, retryable: false };
  const eligible = gateEligibility(strategy, spec, setup.env);
  if (!eligible.ok) return { status: "unavailable", reason: "not_eligible", message: eligible.message, retryable: false };
  const { target } = eligible;

  const off = await offchainSetup(ctx, spec, input.collateral);
  if (!off.ok) return { status: "unavailable", reason: off.reason, message: off.message, retryable: true };

  const row0 = await keeperRow(ctx);
  const judgment = await judgeOnChain({
    port: setup.port,
    source: setup.source,
    target,
    mockPyth: setup.env.mockPythAddress,
    limits: setup.limits,
    spentTodayWei: spentToday(row0, Date.now()),
    lease: convexLease(ctx, `gate:${crypto.randomUUID()}`),
    clock: realClock,
    log: (level, line) => console[level](line),
    secrets: setup.secrets,
  });
  if (!judgment.ok) {
    return {
      status: "unavailable",
      reason: judgment.reason,
      message: judgment.message,
      retryable: judgment.retryable,
      ...(judgment.txHash ? { txHash: judgment.txHash } : {}),
    };
  }

  const replay = await readReplay(setup.port, spec, target, judgment);
  const row = rowFromJudgment({ strategy, spec, target, offchain: off.offchain, judgment, replay });
  const written = await ctx.runMutation(recordEvaluation, {
    ...row,
    ...(autopilot
      ? {
          // What the gateway is asked to open if this passes, stated on the row from the backend's own table.
          autopilot: { bucket: autopilot.bucket, stakeUsd: AUTOPILOT_STAKE_USD, holdSeconds: holdSecondsFor(spec.series.bucketSeconds) },
        }
      : row.status === "proposed"
        ? // The undo window is for the person who pressed the button, and starts once the verdict is in.
          { undoExpiresAt: Date.now() + UNDO_WINDOW_MS }
        : {}),
  });
  return {
    status: row.status,
    tradeId: written.tradeId,
    txHash: judgment.txHash,
    ...(written.handoff ? { handoff: written.handoff } : {}),
  };
}

/**
 * "Check setup now": the owner asks the gate about their rule. Each press is a
 * transaction Kanon pays for, so it is held to `gateCheck` per hour. It takes
 * 3 to 9 seconds, and up to about 25 near the end of a 15-minute bucket.
 */
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
    const limited = await checkRateLimit(ctx, subject, "gateCheck");
    if (limited) return { status: "unavailable", reason: "rate_limited", message: limited.message };
    const out = await evaluateStrategy(ctx, { strategy, collateral: owned.collateral });
    if (out.status === "unavailable") {
      return { status: "unavailable", reason: out.reason, message: out.message, ...(out.txHash ? { txHash: out.txHash } : {}) };
    }
    return { status: out.status, tradeId: out.tradeId, txHash: out.txHash };
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
