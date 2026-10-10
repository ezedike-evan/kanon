/**
 * The pure half of what this backend does for venue orders. It sends none: the
 * venue's trading API answers HTTP 451 from the region Convex runs in, so
 * orders go out from the gateway (`packages/gateway`, `/trade`). What stays
 * here is who may send one, the lock that lets one out at a time, and the
 * record of each (`http.ts`, `venueData.ts`).
 */

import { z } from "zod";

/**
 * How long an order that never reported back keeps the next one out. Longer
 * than the gateway waits for a fill, so two orders never read the same request
 * id from the venue.
 */
export const ORDER_LOCK_MS = 45_000;

/** Whether an order still being sent keeps the next one out. A row older than the lock is abandoned, not waited on. */
export function isLocked(pendingCreatedAt: number | null, nowMs: number): boolean {
  return pendingCreatedAt !== null && nowMs - pendingCreatedAt < ORDER_LOCK_MS && nowMs >= pendingCreatedAt;
}

/** The header the gateway presents `VENUE_RECORDER_KEY` in. */
export const RECORDER_HEADER = "x-kanon-recorder";

/**
 * Whether a caller presented the recorder key. Compared without stopping at
 * the first difference, so the time it takes says nothing about the key.
 */
export function recorderKeyMatches(presented: string | null | undefined, expected: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= presented.charCodeAt(i % presented.length) ^ expected.charCodeAt(i);
  return diff === 0;
}

const decimal = z.object({ atoms: z.string().regex(/^-?\d+$/), decimals: z.number().int().min(0).max(36) });
const side = z.enum(["long", "short"]);

/** What the gateway says about an order it is about to send. */
export const BeginBody = z.strictObject({
  network: z.enum(["testnet", "mainnet"]),
  asset: z.string().min(1).max(32),
  action: z.enum(["open", "close"]),
  side: side.optional(),
  notionalUsd: z.number().int().positive().max(1_000_000).optional(),
  leverage: z.number().int().positive().max(100).optional(),
});
export type BeginBody = z.infer<typeof BeginBody>;

/** What the gateway says became of it. */
export const SettleBody = z.strictObject({
  orderId: z.string().min(1).max(64),
  status: z.enum(["filled", "unfilled", "refused", "failed"]),
  side: side.optional(),
  requestId: z.number().int().nonnegative().optional(),
  size: decimal.optional(),
  fillPrice: decimal.optional(),
  fee: decimal.optional(),
  block: z.number().int().nonnegative().optional(),
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  reason: z.string().max(500).optional(),
});
export type SettleBody = z.infer<typeof SettleBody>;
