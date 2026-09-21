/**
 * Chain state and stored rows -> what the vault and copy screens render.
 *
 * Pure: state in, display data out, the clock passed in. A figure that was not
 * read is `null` or absent, never made up, and a refusal is worded as a
 * refusal: the predicate that named it and the number that failed it.
 */

import {
  abbreviateHash,
  adherenceBps,
  assetLabel,
  dec,
  describeVaultRefusal,
  drawdownFloorFor,
  drawdownState,
  formatDecimal,
  parseSpec,
  predicateSymbol,
  shareSummary,
  timeframeLabel,
  type Decimal,
  type VaultEquityPoint,
} from '@kanon/spec';
import type { CopyVaultState, GuardedVaultState, RawRefusal } from './vault-client';
import { symbolOfAssetId } from './vault-client';
import type {
  CopyFollowView,
  CopyLeadView,
  PendingLooseningView,
  VaultRefusalRow,
  VaultView,
} from './vault-types';

export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** `YYYY-MM-DD HH:MM` in UTC, from unix seconds. */
export function utcMinute(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export type ParsedAmount = { ok: true; atoms: bigint } | { ok: false; error: string };

/**
 * A typed amount -> integer atoms at the token's decimals. Strict on purpose:
 * more digits than the token has is refused rather than rounded, so what the
 * user typed is what moves.
 */
export function parseAmount(text: string, decimals: number): ParsedAmount {
  const clean = text.replace(/[,\s_]/g, '');
  if (clean === '') return { ok: false, error: 'Enter an amount.' };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, error: 'Enter a number.' };
  const whole = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) return { ok: false, error: `At most ${decimals} decimal places.` };
  const atoms = BigInt(whole + frac.padEnd(decimals, '0'));
  if (atoms === 0n) return { ok: false, error: 'Enter an amount above zero.' };
  return { ok: true, atoms };
}

export const toDecimal = (atoms: bigint, decimals: number): Decimal => dec(atoms, decimals);

/** Money to two places for display, without ever converting through a float. */
export function formatMoney(d: Decimal, opts: { signed?: boolean; places?: number } = {}): string {
  const places = Math.min(opts.places ?? 2, d.decimals);
  const drop = d.decimals - places;
  const atoms = BigInt(d.atoms);
  const q = drop > 0 ? atoms / 10n ** BigInt(drop) : atoms; // truncates toward zero
  return formatDecimal(dec(q, places), { signed: opts.signed ?? false });
}

export function refusalRow(input: {
  raw: RawRefusal;
  state: GuardedVaultState;
  collateralDecimals: number;
  seriesDecimals: number;
  blockTimeSeconds: number | undefined;
}): VaultRefusalRow {
  const { raw, state, collateralDecimals, seriesDecimals } = input;
  const symbol = symbolOfAssetId(raw.assetId);
  const asset = symbol ?? abbreviateHash(raw.assetId, 6, 4);

  // The floor a drawdown refusal fell below is the day's reference balance at the moment; the day's
  // snapshot is the best figure the vault still exposes, and it is the same base the contract used.
  const floor =
    raw.reason === 'DAILY_DRAWDOWN_EXCEEDED'
      ? drawdownFloorFor(state.today.referenceBalance, state.limits.maxDailyDrawdownBps)
      : undefined;

  const view = describeVaultRefusal({
    reason: raw.reason,
    decidingValue: raw.decidingValue,
    collateralDecimals,
    limits: state.limits,
    assetLabel: asset,
    gate: raw.gate ? { ...raw.gate, decimals: seriesDecimals } : undefined,
    floor,
  });

  return {
    id: `${raw.txHash}:${raw.blockNumber}`,
    at: input.blockTimeSeconds !== undefined ? utcMinute(input.blockTimeSeconds) : `BLOCK ${raw.blockNumber}`,
    asset,
    predicate: view.predicate,
    failing: view.failing,
    required: view.required,
    txAbbrev: abbreviateHash(raw.txHash, 6, 4),
    evidence: [
      ['REFUSED BY', raw.reason],
      ['VAULT', state.address],
      ['TRANSACTION', raw.txHash],
      ['BLOCK', raw.blockNumber.toString()],
      ['ASSET ID', raw.assetId],
      ['DECIDING VALUE', raw.gate ? raw.gate.decidingValue.toString() : raw.decidingValue.toString()],
    ],
  };
}

export function vaultView(input: {
  state: GuardedVaultState;
  strategyLabel: string;
  collateralDecimals: number;
  refusals: VaultRefusalRow[];
  pending: PendingLooseningView | null;
  /** Rows stored by the app. When present the guard is evaluated over them; otherwise over the vault's own ledger. */
  history?: readonly VaultEquityPoint[];
  nowSeconds: number;
}): VaultView {
  const { state, collateralDecimals: d } = input;

  const guard = input.history && input.history.length > 0
    ? drawdownState({
        history: input.history,
        nowSeconds: input.nowSeconds,
        currentEquity: state.balance,
        maxDailyDrawdownBps: state.limits.maxDailyDrawdownBps,
      })
    : drawdownState({
        // The vault's own ledger: today's snapshot and realized P&L, which is exactly what it checks a trade against.
        history: [{ at: input.nowSeconds, equity: state.today.referenceBalance, realizedPnl: state.today.realizedPnl }],
        nowSeconds: input.nowSeconds,
        currentEquity: state.balance,
        maxDailyDrawdownBps: state.limits.maxDailyDrawdownBps,
      });

  return {
    address: state.address,
    addressShort: shortAddress(state.address),
    strategyLabel: input.strategyLabel,
    assets: [...state.limits.assets],
    maxDailyDrawdownBps: state.limits.maxDailyDrawdownBps,
    executor: state.executor,
    executorShort: shortAddress(state.executor),
    balance: dec(state.balance, d),
    guard: {
      referenceBalance: dec(guard.referenceBalance, d),
      lossBudget: dec(guard.lossBudget, d),
      remaining: dec(guard.remaining, d),
      realizedToday: dec(guard.realizedToday, d),
      usedBps: guard.usedBps,
    },
    refusals: input.refusals,
    pending: input.pending,
  };
}

export function copyFollowView(input: {
  state: CopyVaultState;
  leadId: string;
  leadName: string;
  collateralDecimals: number;
}): CopyFollowView {
  const { state } = input;
  return {
    address: state.address,
    addressShort: shortAddress(state.address),
    leadId: input.leadId,
    leadName: input.leadName,
    allocationBps: state.allocationBps,
    feeShareBps: state.feeShareBps,
    active: state.active,
    balance: dec(state.balance, input.collateralDecimals),
    mirrored: state.mirroredPositions,
    feeRecipientShort: shortAddress(state.feeRecipient),
  };
}

/** A `copyLeads` row as `copyRelationships.listLeads` returns it, with its strategy joined on. */
export interface LiveLeadRow {
  leadId: string;
  strategyId: string;
  chainStrategyId: string | null;
  specHash: string | null;
  spec: unknown;
  profitShareBps: number;
  leaderExecutor: string;
  feeRecipient: string;
  taken: number;
  blocked: number;
}

/**
 * A lead as the copy screen shows it. `blocker` says, in words, why a lead
 * cannot be followed right now; empty means it can. A lead whose spec cannot
 * be read is still shown, by hash, so nothing is hidden and nothing is invented.
 */
export function leadView(row: LiveLeadRow, opts: { alreadyFollowing: boolean; deployed: boolean }): CopyLeadView {
  let spec: ReturnType<typeof parseSpec> | null = null;
  try {
    spec = row.spec ? parseSpec(row.spec) : null;
  } catch {
    spec = null;
  }

  const blocker = !opts.deployed
    ? 'Vault contracts are not deployed on this network.'
    : opts.alreadyFollowing
      ? 'You already follow this strategy.'
      : !row.chainStrategyId
        ? 'This strategy has no registry entry to follow.'
        : '';

  return {
    id: row.leadId,
    strategyId: row.strategyId,
    name: spec ? spec.predicates.map((p) => predicateSymbol(p)).join(' + ') : 'STRATEGY',
    asset: spec ? assetLabel(spec) : '',
    timeframe: spec ? timeframeLabel(spec) : '',
    summary: spec ? shareSummary(spec) : [],
    specHash: row.specHash ? abbreviateHash(row.specHash, 6, 4) : '',
    adherenceBps: adherenceBps(row.taken, row.blocked),
    taken: row.taken,
    blocked: row.blocked,
    profitShareBps: row.profitShareBps,
    executorShort: shortAddress(row.leaderExecutor),
    blocker,
  };
}
