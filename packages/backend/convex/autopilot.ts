import { internalAction } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import type { Decimal } from "@kanon/spec";
import { lastClosedBucket, sweepStep } from "./autopilotLogic";
import { evaluateStrategy } from "./proposer";

/**
 * Autopilot: a pinned rule judged on every closed candle, with nobody pressing
 * anything.
 *
 * Once a minute (`crons.ts`) the sweep looks at every strategy autopilot is on
 * for. When a candle of the spec's own timeframe has closed since the one it
 * last judged, it runs `evaluateStrategy`: the same reads, the same
 * `proposeTrade` and the same `trades` row a button press gets. A predicate
 * that fails is a refusal, recorded as any other. When every predicate passes,
 * the row is a proposal the gateway opens a timed trade for (`autopilotData.ts`,
 * `http.ts`): this backend cannot reach the venue, and does not try.
 *
 * Nothing here decides anything, and no model is called. The sweep only
 * chooses when the arithmetic is run.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

const snapshotRef = makeFunctionReference<
  "query",
  { nowMs: number },
  {
    strategies: Array<{ strategyId: Id<"strategies">; candleSeconds: number | null; judgedBucket: number | null }>;
    expired: number;
  }
>("autopilotData:snapshot");

const contextRef = makeFunctionReference<
  "query",
  { strategyId: Id<"strategies"> },
  { strategy: Doc<"strategies">; collateral: Decimal | null } | null
>("autopilotData:context");

const armRef = makeFunctionReference<"mutation", { strategyId: Id<"strategies">; bucket: number }, null>(
  "autopilotData:arm",
);

const expireRef = makeFunctionReference<"mutation", Record<string, never>, number>("autopilotData:expire");

export interface AutopilotSweepReport {
  /** Strategies whose first sweep this was: the closed candle was remembered and nothing judged. */
  armed: number;
  proposed: number;
  refused: number;
  /** A candle that passed while the strategy's last autopilot trade was still open, or one another sweep judged first. */
  skipped: number;
  /** The series could not support an answer. The candle is tried again on the next sweep. */
  unavailable: number;
  /** An evaluation that threw. Logged, and tried again on the next sweep. */
  failed: number;
  /** Proposals finished because the gateway never opened or reported them. */
  expired: number;
}

export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<AutopilotSweepReport> => {
    const report: AutopilotSweepReport = { armed: 0, proposed: 0, refused: 0, skipped: 0, unavailable: 0, failed: 0, expired: 0 };
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    const { strategies, expired } = await ctx.runQuery(snapshotRef, { nowMs });
    if (expired > 0) report.expired = await ctx.runMutation(expireRef, {});

    for (const { strategyId, candleSeconds, judgedBucket } of strategies) {
      // A stored spec that no longer parses is judged by nothing.
      if (candleSeconds === null) continue;
      const bucket = lastClosedBucket(nowSeconds, candleSeconds);
      const step = sweepStep(judgedBucket, bucket);
      if (step === "wait") continue;

      // One strategy's failure is its own: the rest are still judged.
      try {
        if (step === "arm") {
          await ctx.runMutation(armRef, { strategyId, bucket });
          report.armed += 1;
          continue;
        }
        const owned = await ctx.runQuery(contextRef, { strategyId });
        if (!owned) continue;
        const out = await evaluateStrategy(ctx, { ...owned, autopilot: { bucket } });
        report[out.status] += 1;
      } catch (err) {
        console.error(`autopilot:sweep could not judge ${strategyId}`, err);
        report.failed += 1;
      }
    }
    return report;
  },
});
