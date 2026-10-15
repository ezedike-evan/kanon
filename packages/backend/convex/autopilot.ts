import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { makeFunctionReference } from "convex/server";
import type { Decimal } from "@kanon/spec";
import type { Claim } from "./autopilotData";
import { GATE_BUCKET_SECONDS } from "./gateLogic";
import { evaluateStrategy } from "./proposer";

/**
 * Autopilot: a pinned rule judged on the on-chain gate once per 15-minute
 * bucket, with nobody pressing anything.
 *
 * The keeper tick (`keeper.ts`) runs this once per bucket, after it has
 * sampled the bucket, inside the bucket's first five minutes: the one sample
 * is the close of the candle before it. For each rule autopilot is on for,
 * the bucket is claimed (`autopilotData:claim`) and `evaluateStrategy` sends
 * the same gate transaction a button press sends, and writes the same row. A
 * refusal is recorded as any other. A pass is a proposal the gateway opens a
 * timed trade for (`autopilotData.ts`, `http.ts`): this backend cannot reach
 * the venue, and does not try.
 *
 * A judgment that ends with no transaction gives its claim back, and the next
 * minute's tick tries the bucket again. Once every rule is judged or settled,
 * the keeper remembers the bucket (`keeperData:noteJudged`) and reads nothing
 * more for it: autopilot costs one read per bucket, not one per minute.
 *
 * Nothing here decides anything, and no model is called.
 *
 * Functions are referenced by name because `_generated/api.d.ts` is stale until
 * `npx convex dev` regenerates it (see convex/README.md).
 */

const snapshotRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { strategies: Array<{ strategyId: Id<"strategies">; judgedBucket: number | null }>; legacy: number }
>("autopilotData:snapshot");

const contextRef = makeFunctionReference<
  "query",
  { strategyId: Id<"strategies"> },
  { strategy: Doc<"strategies">; collateral: Decimal | null } | null
>("autopilotData:context");

const claimRef = makeFunctionReference<"mutation", { strategyId: Id<"strategies">; bucket: number }, Claim>("autopilotData:claim");
const unclaimRef = makeFunctionReference<
  "mutation",
  { strategyId: Id<"strategies">; bucket: number; previous: number | null },
  null
>("autopilotData:unclaim");
const expireRef = makeFunctionReference<"mutation", Record<string, never>, number>("autopilotData:expire");

export interface AutopilotPassReport {
  /** The bucket judged: unix seconds over 900, as the keeper counts them. */
  bucket: number;
  /** Proposals handed to the gateway. */
  proposed: number;
  /** Passes not handed over: the last autopilot trade was still open, or autopilot was turned off meanwhile. */
  notOpened: number;
  refused: number;
  /** Rules with no bucket remembered: this one was remembered and nothing judged. */
  armed: number;
  /** Judgments that ended with no verdict. Their claim is given back. */
  unavailable: number;
  /** Judgments that threw. Logged, and tried again on the next tick. */
  failed: number;
  /** Rules autopilot is on for that the gate cannot judge: skipped, never judged off-chain instead. */
  legacy: number;
  /** Proposals finished because the gateway never opened or reported them. */
  expired: number;
  /** Every rule was judged or settled: the keeper remembers the bucket and does not come back to it. */
  clean: boolean;
}

/** One pass over the rules autopilot is on for, for the bucket `bucketIndex`. */
export async function runAutopilotPass(ctx: ActionCtx, bucketIndex: number): Promise<AutopilotPassReport> {
  const bucket = bucketIndex * GATE_BUCKET_SECONDS;
  const report: AutopilotPassReport = {
    bucket: bucketIndex,
    proposed: 0,
    notOpened: 0,
    refused: 0,
    armed: 0,
    unavailable: 0,
    failed: 0,
    legacy: 0,
    expired: 0,
    clean: true,
  };

  report.expired = await ctx.runMutation(expireRef, {});
  const { strategies, legacy } = await ctx.runQuery(snapshotRef, {});
  report.legacy = legacy;

  for (const { strategyId, judgedBucket } of strategies) {
    if (judgedBucket !== null && judgedBucket >= bucket) continue;
    // One rule's failure is its own: the rest are still judged.
    let claim: Claim;
    try {
      claim = await ctx.runMutation(claimRef, { strategyId, bucket });
    } catch (err) {
      console.error(`autopilot: could not claim bucket ${bucketIndex} for ${strategyId}`, err);
      report.failed += 1;
      report.clean = false;
      continue;
    }
    if (!claim.ok) {
      if (claim.why === "armed") report.armed += 1;
      continue;
    }
    const previous = claim.previous;
    const giveBack = () => ctx.runMutation(unclaimRef, { strategyId, bucket, previous });

    try {
      const owned = await ctx.runQuery(contextRef, { strategyId });
      if (!owned) {
        await giveBack();
        continue;
      }
      const out = await evaluateStrategy(ctx, { ...owned, autopilot: { bucket } });
      if (out.status === "unavailable") {
        report.unavailable += 1;
        // A transaction that may still land keeps its claim: a bucket is never sent twice.
        if (out.reason !== "unconfirmed") await giveBack();
        if (out.retryable) report.clean = false;
        console.warn(`autopilot: ${strategyId} was not judged for bucket ${bucketIndex}: ${out.message}`);
        continue;
      }
      if (out.status === "refused") report.refused += 1;
      else if (out.handoff === "pending") report.proposed += 1;
      else report.notOpened += 1;
    } catch (err) {
      console.error(`autopilot: could not judge ${strategyId}`, err);
      report.failed += 1;
      report.clean = false;
      await giveBack().catch(() => undefined);
    }
  }
  return report;
}
