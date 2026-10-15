/**
 * Autopilot's pure half: when a bucket is judged, what the gateway is asked to
 * open for a proposal, how long a proposal may wait, and the shapes the gateway
 * sends (`http.ts`, `/autopilot/*`). No clock, no database.
 *
 * Autopilot decides nothing. The verdict on a bucket is the on-chain gate's,
 * the same transaction a button press sends (`proposer.ts`, `gate.ts`); this
 * file only says when it is asked and what follows a pass.
 */

import { z } from "zod";
import { StrategySpec } from "@kanon/spec";
import { StartBody as TimedStartBody } from "./timedLogic";
import { ORDER_LOCK_MS } from "./venueLogic";

// ---------------------------------------------------------------------------
// What is opened for a proposal
// ---------------------------------------------------------------------------

/**
 * The stake and the hold times an autopilot trade may use. These restate
 * `TIMED_LIMITS` in `@kanon/execution` (`timed-policy.ts`): the smallest stake
 * on offer there, and its durations. This backend does not import that package,
 * so the two values are kept here by hand. The gateway holds every timed trade
 * to its own limits whatever is asked, so a value that drifts from them is
 * refused there, never widened here.
 */
export const AUTOPILOT_STAKE_USD = 10;
export const AUTOPILOT_DURATIONS = [60, 300, 900, 3600] as const;

/** The shortest hold on offer that is not shorter than one candle, or the longest on offer for a candle longer than that. */
export function holdSecondsFor(candleSeconds: number): number {
  return AUTOPILOT_DURATIONS.find((seconds) => seconds >= candleSeconds) ?? Math.max(...AUTOPILOT_DURATIONS);
}

/** A long is a call up, a short a call down. */
export const directionOf = (side: "long" | "short"): "up" | "down" => (side === "long" ? "up" : "down");

/** `BTC/USD`, `btc / usd` and the bare `BTC` name one market: the venue quotes everything in dollars. */
export function sameMarket(a: string, b: string): boolean {
  const base = (asset: string): string => asset.replace(/\s+/g, "").toUpperCase().replace(/\/USD$/, "");
  return base(a) !== "" && base(a) === base(b);
}

// ---------------------------------------------------------------------------
// When a candle is judged
// ---------------------------------------------------------------------------

/** How many strategies one autopilot pass reads. */
export const MAX_ARMED = 200;

/**
 * The keeper tick judges a bucket for autopilot only in its first five
 * minutes, right after the bucket's sample: that sample is the close of the
 * candle before it, and later in the bucket it is old news.
 */
export const AUTOPILOT_JUDGE_WINDOW_SECONDS = 300;

/** The candle length of a stored spec, or null for one that does not parse. */
export function candleSecondsOf(spec: unknown): number | null {
  const parsed = StrategySpec.safeParse(spec);
  return parsed.success ? parsed.data.series.bucketSeconds : null;
}

/** Unix seconds: the start of the newest candle that has closed. */
export function lastClosedBucket(nowSeconds: number, candleSeconds: number): number {
  return (Math.floor(nowSeconds / candleSeconds) - 1) * candleSeconds;
}

/**
 * What autopilot does with a strategy, given the bucket it last judged
 * (`autopilotData:claim`).
 *
 *   arm    nothing is remembered (a rule turned on before buckets were remembered): remember this one, judge nothing
 *   judge  a bucket has begun since the one remembered
 *   wait   this bucket is the one already judged
 */
export function sweepStep(judgedBucket: number | null | undefined, closedBucket: number): "arm" | "judge" | "wait" {
  if (judgedBucket === null || judgedBucket === undefined) return "arm";
  return closedBucket > judgedBucket ? "judge" : "wait";
}

// ---------------------------------------------------------------------------
// How long a proposal waits for the gateway
// ---------------------------------------------------------------------------

/**
 * How long after a proposal is written the gateway may still begin its opening
 * order. A proposal is a verdict on one candle; opened late it would be a trade
 * on prices the rule never judged.
 */
export const HANDOFF_WINDOW_MS = 120_000;

/**
 * When a proposal still `pending` is finished as not opened. Later than the
 * window by more than an order can take, so one whose order was begun in the
 * window's last second is never finished while that order is still on its way.
 */
export const HANDOFF_EXPIRY_MS = HANDOFF_WINDOW_MS + 2 * ORDER_LOCK_MS;

/** Whether the gateway may still begin a proposal's opening order. */
export function withinHandoff(createdAt: number, nowMs: number): boolean {
  return nowMs >= createdAt && nowMs - createdAt < HANDOFF_WINDOW_MS;
}

/** Whether a proposal still pending has waited past any order that could be on its way. */
export function handoffExpired(createdAt: number, nowMs: number): boolean {
  return nowMs - createdAt >= HANDOFF_EXPIRY_MS;
}

export const HANDOFF_MESSAGES = {
  turnedOff: "Autopilot was turned off before this was opened. Nothing was sent.",
  stillOpen: "The rule passed while its last autopilot trade was still open, so nothing was opened. Autopilot runs one trade at a time.",
  notPickedUp: "The gateway did not pick this up in time. Nothing was sent.",
  noAnswer: "No answer was recorded for this proposal's order. Check the position on the venue.",
} as const;

/**
 * What a proposal's row becomes once a timed trade has opened for it. It reads
 * as every executed proposal does, and stays `paper`: the row's size is the
 * rule's own sizing against the account's equity, which is not what was sent.
 * The position that was opened is the timed trade's, at its fixed stake, and
 * `timedTradeId` is where its fill is. Marking this row `live` would present a
 * size nobody traded as a real one.
 */
export function openedPatch<TimedId>(timedTradeId: TimedId, nowMs: number) {
  return {
    handoff: "opened" as const,
    status: "executed" as const,
    executedAt: nowMs,
    executionMode: "paper" as const,
    timedTradeId,
  };
}

/**
 * What a proposal's row becomes when nothing was opened for it. `undone` is
 * what a proposal that never met the market already is; the reason says why.
 */
export function notOpenedPatch(reason: string) {
  return { handoff: "not_opened" as const, status: "undone" as const, handoffReason: reason };
}

// ---------------------------------------------------------------------------
// What the gateway sends
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);

/**
 * The order lock for a proposal's own order. Who it is for comes from the
 * proposal, never from here: the body names a `trades` row and nobody else.
 */
export const BeginBody = z.strictObject({
  proposalId: id,
  network: z.enum(["testnet", "mainnet"]),
  asset: z.string().min(1).max(32),
  action: z.enum(["open", "close"]),
  side: z.enum(["long", "short"]).optional(),
  notionalUsd: z.number().int().positive().max(1_000_000).optional(),
  leverage: z.number().int().positive().max(100).optional(),
});
export type BeginBody = z.infer<typeof BeginBody>;

/** A timed trade that has just opened for a proposal: the same facts a person's trade carries, and the proposal. */
export const StartBody = TimedStartBody.extend({ proposalId: id });
export type StartBody = z.infer<typeof StartBody>;

/** What became of a proposal. After either, it is finished. */
export const ReportBody = z.discriminatedUnion("outcome", [
  z.strictObject({ proposalId: id, outcome: z.literal("opened"), timedTradeId: id }),
  z.strictObject({ proposalId: id, outcome: z.literal("not_opened"), reason: z.string().min(1).max(500) }),
]);
export type ReportBody = z.infer<typeof ReportBody>;
