/**
 * Guarded AI Agent Vault: the pure side.
 *
 * The contract (`GuardedVault.sol`) fixes an asset whitelist and a daily
 * drawdown cap at construction, with no setter. Everything in here is integer
 * arithmetic that mirrors what the contract will decide, so the UI can show a
 * user the exact number a proposal would fail on before anything is signed.
 *
 * Amounts are `bigint` atoms of the collateral token. Percentages are basis
 * points. Nothing here is a float, and nothing here calls a model.
 */

import { ASSETS } from './assets';
import { COOLING_OFF_SECONDS } from './diff';
import { dec, formatDecimal } from './decimal';

export const BPS_DENOMINATOR = 10_000n;
export const MAX_DAILY_DRAWDOWN_BPS = 10_000;
export const SECONDS_PER_DAY = 86_400;

/**
 * The drawdown limit the form starts on. Not hidden: it is shown, labelled as
 * a starting value, and editable before anything is signed.
 */
export const SUGGESTED_DAILY_DRAWDOWN_BPS = 200;

/** The hold a looser vault waits out. Same figure as loosening a rule. */
export const VAULT_LOOSENING_HOLD_SECONDS = COOLING_OFF_SECONDS;

export interface VaultLimits {
  /** Asset symbols as the spec knows them, e.g. `BTC/USD`. */
  assets: readonly string[];
  maxDailyDrawdownBps: number;
}

/** `BTC/USD` -> `BTC-USD`: the string the contract hashes into an asset id. */
export function vaultAssetKey(symbol: string): string {
  return symbol.trim().replace('/', '-').toUpperCase();
}

export function vaultAssetSymbol(key: string): string {
  return key.replace('-', '/');
}

export const VAULT_ASSET_UNIVERSE: readonly string[] = ASSETS.map((a) => a.symbol);

/** Deduplicated, in the universe's own order, unknown symbols dropped. */
export function normalizeAssets(
  assets: readonly string[],
  universe: readonly string[] = VAULT_ASSET_UNIVERSE,
): string[] {
  const wanted = new Set(assets.map((a) => a.trim().toUpperCase()));
  return universe.filter((s) => wanted.has(s.toUpperCase()));
}

export interface VaultIssue {
  field: 'assets' | 'maxDailyDrawdownBps';
  message: string;
}

/** Mirrors the constructor's own reverts, plus "is this a known asset". */
export function validateVaultLimits(
  limits: VaultLimits,
  universe: readonly string[] = VAULT_ASSET_UNIVERSE,
): VaultIssue[] {
  const issues: VaultIssue[] = [];
  if (limits.assets.length === 0) {
    issues.push({ field: 'assets', message: 'Whitelist at least one asset.' });
  }
  const known = new Set(universe.map((s) => s.toUpperCase()));
  const unknown = limits.assets.filter((a) => !known.has(a.trim().toUpperCase()));
  if (unknown.length > 0) {
    issues.push({ field: 'assets', message: `Not a listed asset: ${unknown.join(', ')}.` });
  }
  const bps = limits.maxDailyDrawdownBps;
  if (!Number.isInteger(bps) || bps <= 0 || bps > MAX_DAILY_DRAWDOWN_BPS) {
    issues.push({
      field: 'maxDailyDrawdownBps',
      message: `Daily drawdown must be a whole number of basis points from 1 to ${MAX_DAILY_DRAWDOWN_BPS}.`,
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Tightening is immediate; loosening waits                            */
/* ------------------------------------------------------------------ */

export type ChangeDirection = 'tighten' | 'loosen';

export type VaultChangeItem =
  | { field: 'assets'; direction: ChangeDirection; added: string[]; removed: string[] }
  | { field: 'maxDailyDrawdownBps'; direction: ChangeDirection; before: number; after: number };

export interface VaultChange {
  /** `loosen` if anything at all gets looser: a mixed edit waits as a whole. */
  kind: 'none' | ChangeDirection;
  items: VaultChangeItem[];
  /** Seconds the change waits. Zero for a tightening. */
  holdSeconds: number;
}

/**
 * Compares two sets of limits. More assets, or a bigger drawdown, is looser.
 * Fewer assets, or a smaller drawdown, is tighter. A mixed edit is a loosening
 * because the loosening half is the half that needs friction.
 */
export function classifyVaultChange(
  current: VaultLimits,
  next: VaultLimits,
  holdSeconds: number = VAULT_LOOSENING_HOLD_SECONDS,
): VaultChange {
  const items: VaultChangeItem[] = [];

  const cur = new Set(normalizeAssets(current.assets));
  const nxt = new Set(normalizeAssets(next.assets));
  const added = [...nxt].filter((a) => !cur.has(a));
  const removed = [...cur].filter((a) => !nxt.has(a));
  if (added.length > 0) items.push({ field: 'assets', direction: 'loosen', added, removed: [] });
  if (removed.length > 0) items.push({ field: 'assets', direction: 'tighten', added: [], removed });

  if (next.maxDailyDrawdownBps !== current.maxDailyDrawdownBps) {
    items.push({
      field: 'maxDailyDrawdownBps',
      direction: next.maxDailyDrawdownBps > current.maxDailyDrawdownBps ? 'loosen' : 'tighten',
      before: current.maxDailyDrawdownBps,
      after: next.maxDailyDrawdownBps,
    });
  }

  const kind: VaultChange['kind'] = items.some((i) => i.direction === 'loosen')
    ? 'loosen'
    : items.length > 0
      ? 'tighten'
      : 'none';
  return { kind, items, holdSeconds: kind === 'loosen' ? holdSeconds : 0 };
}

/** A staged loosening, and when it may be applied. Milliseconds. */
export interface PendingLoosening {
  limits: VaultLimits;
  requestedAt: number;
  endsAt: number;
}

export function stageLoosening(
  limits: VaultLimits,
  requestedAtMs: number,
  holdSeconds: number = VAULT_LOOSENING_HOLD_SECONDS,
): PendingLoosening {
  return { limits, requestedAt: requestedAtMs, endsAt: requestedAtMs + holdSeconds * 1000 };
}

export function looseningRemainingMs(pending: PendingLoosening, nowMs: number): number {
  return Math.max(0, pending.endsAt - nowMs);
}

/* ------------------------------------------------------------------ */
/* Daily drawdown guard, over the vault's equity history               */
/* ------------------------------------------------------------------ */

/**
 * One recorded moment in a vault's life.
 *
 * `equity` is the vault balance *before* this point's own `realizedPnl`
 * applies, which is what `GuardedVault` snapshots at the first proposal of a
 * UTC day. `realizedPnl` is the signed P&L an allowed proposal realized then;
 * it is zero for a plain deposit or withdrawal.
 */
export interface VaultEquityPoint {
  /** Unix seconds. */
  at: number;
  equity: bigint;
  realizedPnl: bigint;
}

export function utcDay(atSeconds: number): number {
  return Math.floor(atSeconds / SECONDS_PER_DAY);
}

export interface DrawdownState {
  utcDay: number;
  /** The day's opening balance, the base the cap is a percentage of. */
  referenceBalance: bigint;
  /** Signed. Cumulative realized P&L so far today. */
  realizedToday: bigint;
  /** The most a day may lose: `floor(reference * bps / 10_000)`. Never negative. */
  lossBudget: bigint;
  /** What is left of the budget. Zero once it is spent. */
  remaining: bigint;
  /** Loss so far today, in bps of the reference balance, rounded down. Compare with the cap. */
  usedBps: number;
}

const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;

export function drawdownState(input: {
  history: readonly VaultEquityPoint[];
  nowSeconds: number;
  /** Balance to snapshot if nothing has happened yet today. */
  currentEquity: bigint;
  maxDailyDrawdownBps: number;
}): DrawdownState {
  const day = utcDay(input.nowSeconds);
  const today = input.history
    .filter((p) => utcDay(p.at) === day)
    .sort((a, b) => a.at - b.at);

  const referenceBalance = today.length > 0 ? today[0]!.equity : input.currentEquity;
  const realizedToday = today.reduce((sum, p) => sum + p.realizedPnl, 0n);
  const lossBudget = mulDivFloor(referenceBalance, BigInt(input.maxDailyDrawdownBps), BPS_DENOMINATOR);

  const loss = realizedToday < 0n ? -realizedToday : 0n;
  const remaining = loss >= lossBudget ? 0n : lossBudget - loss;
  const usedBps = referenceBalance === 0n ? 0 : Number(mulDivFloor(loss, BPS_DENOMINATOR, referenceBalance));

  return { utcDay: day, referenceBalance, realizedToday, lossBudget, remaining, usedBps };
}

export interface DrawdownVerdict {
  allowed: boolean;
  /** `realizedToday + projectedPnl`: the number the cap is compared against. */
  projectedCumulative: bigint;
  /** The floor the cumulative may not go below: `-lossBudget`. */
  floor: bigint;
}

/**
 * The contract's own test: refuse iff `projectedCumulative < -lossBudget`.
 * Landing exactly on the floor is allowed, as it is on chain.
 */
export function checkDrawdown(state: DrawdownState, projectedPnl: bigint): DrawdownVerdict {
  const projectedCumulative = state.realizedToday + projectedPnl;
  const floor = -state.lossBudget;
  return { allowed: projectedCumulative >= floor, projectedCumulative, floor };
}

/* ------------------------------------------------------------------ */
/* What a refusal reads as                                             */
/* ------------------------------------------------------------------ */

export const VAULT_REFUSAL_REASONS = [
  'ASSET_NOT_WHITELISTED',
  'PREDICATE_NOT_SATISFIED',
  'DAILY_DRAWDOWN_EXCEEDED',
] as const;
export type VaultRefusalReason = (typeof VAULT_REFUSAL_REASONS)[number];

export function isVaultRefusalReason(text: string): text is VaultRefusalReason {
  return (VAULT_REFUSAL_REASONS as readonly string[]).includes(text);
}

/** Text out of a right-padded `bytes32`, e.g. a refusal reason or predicate symbol. */
export function decodeBytes32Text(hex: string): string {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  let out = '';
  for (let i = 0; i + 1 < body.length; i += 2) {
    const code = parseInt(body.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** A vault refusal as the UI shows it: the predicate by name, and the number that failed it. */
export interface VaultRefusalView {
  reason: VaultRefusalReason | string;
  /** The named predicate. */
  predicate: string;
  /** The number that failed it. */
  failing: string;
  /** What it had to satisfy. */
  required: string;
}

export interface DescribeRefusalInput {
  reason: string;
  /** The vault's own `decidingValue`. Signed collateral atoms for a drawdown refusal. */
  decidingValue: bigint;
  collateralDecimals: number;
  limits: VaultLimits;
  /** The refused asset, as a symbol if it could be resolved, else an abbreviated id. */
  assetLabel: string;
  /** For a predicate refusal: the `RefusalGate` log from the same transaction. */
  gate?: { symbol: string; decidingValue: bigint; decimals: number } | undefined;
  /** For a drawdown refusal: the floor the cumulative P&L had to stay above, signed. */
  floor?: bigint | undefined;
}

export function describeVaultRefusal(input: DescribeRefusalInput): VaultRefusalView {
  const { reason, decidingValue, collateralDecimals, limits, assetLabel, gate, floor } = input;
  const money = (atoms: bigint, decimals = collateralDecimals) =>
    formatDecimal(dec(atoms, decimals), { signed: false });

  if (reason === 'ASSET_NOT_WHITELISTED') {
    return {
      reason,
      predicate: 'asset ∈ whitelist',
      failing: assetLabel,
      required: limits.assets.join(' · ') || 'empty whitelist',
    };
  }

  if (reason === 'DAILY_DRAWDOWN_EXCEEDED') {
    const bps = limits.maxDailyDrawdownBps;
    return {
      reason,
      predicate: `daily_pnl ≥ −${(bps / 100).toFixed(2)}% of opening balance`,
      failing: money(decidingValue),
      required: floor === undefined ? `≥ −${(bps / 100).toFixed(2)}%` : `≥ ${money(floor)}`,
    };
  }

  if (reason === 'PREDICATE_NOT_SATISFIED') {
    if (gate) {
      return {
        reason,
        predicate: gate.symbol,
        failing: money(gate.decidingValue, gate.decimals),
        required: 'the pinned predicate',
      };
    }
    return { reason, predicate: 'pinned strategy predicates', failing: 'see evidence', required: 'every predicate' };
  }

  return { reason, predicate: reason, failing: money(decidingValue), required: 'the vault gate' };
}

/** The dollar-scale figure for the floor a drawdown refusal fell below. */
export function drawdownFloorFor(referenceBalance: bigint, maxDailyDrawdownBps: number): bigint {
  return -mulDivFloor(referenceBalance, BigInt(maxDailyDrawdownBps), BPS_DENOMINATOR);
}
