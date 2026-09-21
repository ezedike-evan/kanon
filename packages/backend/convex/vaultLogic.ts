/**
 * Pure decisions behind the vault and copy modules, kept apart from Convex so
 * they can be tested without a database. The arithmetic itself lives in
 * `@kanon/spec` (`vault.ts`, `copy.ts`), where the UI shares it.
 */

import {
  classifyVaultChange,
  drawdownState,
  normalizeAssets,
  stageLoosening,
  validateCopyTerms,
  validateVaultLimits,
  VAULT_LOOSENING_HOLD_SECONDS,
  type DrawdownState,
  type PendingLoosening,
  type VaultEquityPoint,
  type VaultLimits,
} from "@kanon/spec";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export const isAddress = (s: string | undefined | null): s is string => !!s && ADDRESS.test(s);
export const isTxHash = (s: string | undefined | null): s is string => !!s && TX_HASH.test(s);

/** Lower-cased, so the same vault is never two rows because of checksum casing. */
export const normalizeAddress = (s: string): string => s.toLowerCase();

export interface VaultRecordInput extends VaultLimits {
  address: string;
  chainId: number;
  executor: string;
  txHash: string;
}

/** What must be true of a vault record before it is stored as a mirror of a real one. */
export function validateVaultRecord(input: VaultRecordInput): string[] {
  const problems: string[] = validateVaultLimits(input).map((i) => i.message);
  if (!isAddress(input.address)) problems.push("Vault address is not an address.");
  if (!isAddress(input.executor)) problems.push("Executor is not an address.");
  if (!isTxHash(input.txHash)) problems.push("A vault record needs the transaction that created it.");
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) problems.push("Chain id is not valid.");
  return problems;
}

/* ------------------------------------------------------------------ */
/* Tightening now, loosening after the hold                            */
/* ------------------------------------------------------------------ */

export type VaultChangeDecision =
  /** Nothing differs from the current vault. */
  | { action: "none" }
  /** Tighter limits: a replacement vault may be created at once. */
  | { action: "apply"; reason: "tightening" | "hold_elapsed" }
  /** Looser limits: record the request and start the hold. */
  | { action: "stage"; pending: PendingLoosening }
  /** A hold is running for these limits. */
  | { action: "wait"; pending: PendingLoosening; remainingMs: number }
  /** The invalid input, in words. */
  | { action: "invalid"; problems: string[] };

const sameLimits = (a: VaultLimits, b: VaultLimits): boolean =>
  a.maxDailyDrawdownBps === b.maxDailyDrawdownBps &&
  normalizeAssets(a.assets).join("|") === normalizeAssets(b.assets).join("|");

/**
 * The one rule about changing a vault's limits, decided in one place.
 *
 * - Tighter (fewer assets, smaller drawdown): apply now.
 * - Looser, or mixed: stage a hold, and apply only once the same limits are
 *   asked for again after it has run. Asking for different limits restarts the
 *   hold. There is no argument that shortens it.
 */
export function decideVaultChange(input: {
  current: VaultLimits;
  requested: VaultLimits;
  pending: PendingLoosening | null;
  nowMs: number;
  holdSeconds?: number;
}): VaultChangeDecision {
  const { current, requested, pending, nowMs } = input;
  const holdSeconds = input.holdSeconds ?? VAULT_LOOSENING_HOLD_SECONDS;

  const problems = validateVaultLimits(requested).map((i) => i.message);
  if (problems.length > 0) return { action: "invalid", problems };

  const change = classifyVaultChange(current, requested, holdSeconds);
  if (change.kind === "none") return { action: "none" };
  if (change.kind === "tighten") return { action: "apply", reason: "tightening" };

  if (pending && sameLimits(pending.limits, requested)) {
    if (nowMs >= pending.endsAt) return { action: "apply", reason: "hold_elapsed" };
    return { action: "wait", pending, remainingMs: pending.endsAt - nowMs };
  }
  return { action: "stage", pending: stageLoosening(requested, nowMs, holdSeconds) };
}

/* ------------------------------------------------------------------ */
/* Drawdown guard over stored equity rows                              */
/* ------------------------------------------------------------------ */

export interface EquityRow {
  at: number;
  equityAtoms: string;
  realizedPnlAtoms: string;
}

export const equityPointsFromRows = (rows: readonly EquityRow[]): VaultEquityPoint[] =>
  rows.map((r) => ({ at: r.at, equity: BigInt(r.equityAtoms), realizedPnl: BigInt(r.realizedPnlAtoms) }));

export function guardFromRows(input: {
  rows: readonly EquityRow[];
  nowSeconds: number;
  currentEquityAtoms: string;
  maxDailyDrawdownBps: number;
}): DrawdownState {
  return drawdownState({
    history: equityPointsFromRows(input.rows),
    nowSeconds: input.nowSeconds,
    currentEquity: BigInt(input.currentEquityAtoms),
    maxDailyDrawdownBps: input.maxDailyDrawdownBps,
  });
}

/* ------------------------------------------------------------------ */
/* Copy relationships                                                  */
/* ------------------------------------------------------------------ */

export interface FollowInput {
  allocationBps: number;
  /** What the follower's vault will charge. Must equal the lead's listed share. */
  feeShareBps: number;
}

/**
 * A follow is refused (as a form problem, not an error state) if the terms are
 * out of range or the fee is anything other than the one the lead listed: the
 * vault takes `feeShareBps` as a plain argument, so the app is where a fee the
 * follower did not see could otherwise slip in.
 */
export function validateFollow(input: {
  terms: FollowInput;
  lead: { profitShareBps: number; leaderExecutor: string; feeRecipient: string; active: boolean };
}): string[] {
  const problems = validateCopyTerms(input.terms).map((i) => i.message);
  const { lead, terms } = input;
  if (!lead.active) problems.push("This strategy is no longer listed for copying.");
  if (terms.feeShareBps !== lead.profitShareBps) {
    problems.push("Profit share does not match the one this lead listed.");
  }
  if (!isAddress(lead.leaderExecutor)) problems.push("This lead has not set an executor address.");
  if (!isAddress(lead.feeRecipient)) problems.push("This lead has not set a fee address.");
  return problems;
}

export interface ListLeadInput {
  profitShareBps: number;
  leaderExecutor: string;
  feeRecipient: string;
}

export function validateListing(input: ListLeadInput): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.profitShareBps) || input.profitShareBps < 0 || input.profitShareBps > 10_000) {
    problems.push("Profit share must be a whole number of basis points from 0 to 10000.");
  }
  if (!isAddress(input.leaderExecutor)) problems.push("Executor is not an address.");
  if (!isAddress(input.feeRecipient)) problems.push("Fee address is not an address.");
  return problems;
}
