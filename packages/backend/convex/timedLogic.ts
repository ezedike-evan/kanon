/**
 * The shapes the gateway sends about a timed trade (`http.ts`, `/timed/*`).
 * Pure. What a timed trade is, and its limits, are in `@kanon/execution`
 * (`timed-policy.ts`); this backend keeps the record and who it belongs to.
 */

import { z } from "zod";

const decimal = z.object({ atoms: z.string().regex(/^-?\d+$/), decimals: z.number().int().min(0).max(36) });
const tx = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const id = z.string().min(1).max(64);
const network = z.enum(["testnet", "mainnet"]);
const asset = z.string().min(1).max(32);
const ms = z.number().int().positive();

/** A trade that has just opened. Who it belongs to comes from the caller's token, never from here. */
export const StartBody = z.strictObject({
  network,
  asset,
  direction: z.enum(["up", "down"]),
  stakeUsd: z.number().int().positive().max(1_000_000),
  leverage: z.number().int().positive().max(100),
  seconds: z.number().int().positive().max(86_400),
  openedAt: ms,
  expiresAt: ms,
  size: decimal,
  entryPrice: decimal,
  openFee: decimal.optional(),
  openTx: tx.optional(),
});
export type StartBody = z.infer<typeof StartBody>;

/** What is added to a trade as it ends. It cannot change whose trade it is or what was asked for. */
export const UpdateBody = z.strictObject({
  tradeId: id,
  status: z.enum(["closing", "closed"]).optional(),
  endedBy: z.enum(["time", "cut", "owner", "venue"]).optional(),
  closedAt: ms.optional(),
  exitPrice: decimal.optional(),
  result: decimal.optional(),
  fees: decimal.optional(),
  openFee: decimal.optional(),
  openTx: tx.optional(),
  closeTx: tx.optional(),
  reason: z.string().max(500).optional(),
});
export type UpdateBody = z.infer<typeof UpdateBody>;

/** The closing order of a trade: vouched for by the trade, not by a sign-in token. */
export const BeginCloseBody = z.strictObject({ tradeId: id, network, asset });
export const OwnsBody = z.strictObject({ tradeId: id });

/** Whether a row may take a status. A trade that has closed is never reopened. */
export function mayMoveTo(current: "live" | "closing" | "closed", next: "closing" | "closed"): boolean {
  return current !== "closed" || next === "closed";
}
