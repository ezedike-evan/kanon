import { internalMutation } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

/**
 * Fixed-window rate limits per signed-in user and key, for calls that spend
 * money (model tokens, Nansen credits) or reach a venue with the server's own
 * key. Configured here, in one place.
 */
export const RATE_LIMITS = {
  compile: { limit: 10, windowMs: 60 * 60 * 1000 },
  nansen: { limit: 30, windowMs: 60 * 60 * 1000 },
  /** Orders sent to the venue: opens and closes together. */
  venueOrder: { limit: 30, windowMs: 60 * 60 * 1000 },
  /** Reads of the trading account. Each is three requests to the venue. */
  venueAccount: { limit: 600, windowMs: 60 * 60 * 1000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;

export interface WindowState {
  windowStart: number;
  count: number;
}

export type WindowDecision =
  | { allowed: true; next: WindowState; retryAfterMs: 0 }
  | { allowed: false; next: WindowState; retryAfterMs: number };

/**
 * Pure. A call is allowed while the window holds fewer than `limit`; a call
 * after the window has run starts a new one. A clock that moved backwards
 * starts a new window rather than locking the user out.
 */
export function decideWindow(
  state: WindowState | null,
  nowMs: number,
  limit: number,
  windowMs: number,
): WindowDecision {
  const fresh = !state || nowMs < state.windowStart || nowMs - state.windowStart >= windowMs;
  const current: WindowState = fresh ? { windowStart: nowMs, count: 0 } : state;
  if (current.count >= limit) {
    return {
      allowed: false,
      next: current,
      retryAfterMs: Math.max(1, current.windowStart + windowMs - nowMs),
    };
  }
  return { allowed: true, next: { windowStart: current.windowStart, count: current.count + 1 }, retryAfterMs: 0 };
}

/** Internal: only an action that has already authenticated the caller spends a slot. */
export const consume = internalMutation({
  args: { subject: v.string(), key: v.string(), limit: v.number(), windowMs: v.number() },
  handler: async (ctx, args): Promise<{ allowed: boolean; retryAfterMs: number }> => {
    const row = await ctx.db
      .query("rateLimits")
      .withIndex("by_subject_and_key", (q) => q.eq("subject", args.subject).eq("key", args.key))
      .first();
    const decision = decideWindow(
      row ? { windowStart: row.windowStart, count: row.count } : null,
      Date.now(),
      args.limit,
      args.windowMs,
    );
    if (row) await ctx.db.patch(row._id, decision.next);
    else await ctx.db.insert("rateLimits", { subject: args.subject, key: args.key, ...decision.next });
    return { allowed: decision.allowed, retryAfterMs: decision.retryAfterMs };
  },
});

const consumeRef = makeFunctionReference<
  "mutation",
  { subject: string; key: string; limit: number; windowMs: number },
  { allowed: boolean; retryAfterMs: number }
>("rateLimit:consume");

/** What an action returns to the UI when a limit is hit. */
export interface RateLimited {
  status: "rate_limited";
  retryAfterMs: number;
  message: string;
}

export function rateLimitedResult(retryAfterMs: number): RateLimited {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return {
    status: "rate_limited",
    retryAfterMs,
    message: `Rate limit reached for now. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  };
}

/** Spends one slot for `subject`. Returns `null` when allowed, the typed failure when not. */
export async function checkRateLimit(
  ctx: { runMutation: (ref: typeof consumeRef, args: { subject: string; key: string; limit: number; windowMs: number }) => Promise<{ allowed: boolean; retryAfterMs: number }> },
  subject: string,
  key: RateLimitKey,
): Promise<RateLimited | null> {
  const cfg = RATE_LIMITS[key];
  const res = await ctx.runMutation(consumeRef, { subject, key, limit: cfg.limit, windowMs: cfg.windowMs });
  return res.allowed ? null : rateLimitedResult(res.retryAfterMs);
}
