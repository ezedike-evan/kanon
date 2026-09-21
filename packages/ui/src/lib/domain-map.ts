/**
 * Rows -> the shapes the per-domain hooks return. Pure: rows in, display data
 * out, no clock and no I/O, so every mapping is pinned down in
 * `domain-map.test.ts`. Nothing here invents a figure: a pair with no earlier
 * print has a `null` move, a strategy whose spec no longer parses has a `null`
 * name, and neither is dressed up as a number.
 */

import { adherenceBps, predicateSymbol, type Decimal } from '@kanon/spec';
import type {
  ActivityItem,
  BehaviourStats,
  PairTicker,
  ProfileFollow,
  RuleHistoryItem,
} from './domain-types';
import { safeSpec, type LiveStrategy } from './live-map';

// ---------------------------------------------------------------------------
// Wire shapes: what `series.listTickers`, `trades.listRecentActivity` and the
// copy queries return.
// ---------------------------------------------------------------------------

export interface TickerRow {
  asset: string;
  price: Decimal;
  publishTime: number;
  open: Decimal | null;
  openTime: number | null;
  changeBps: number | null;
}

export interface ActivityRow {
  _id: string;
  strategyId: string;
  asset: string;
  direction: 'long' | 'short';
  status: 'proposed' | 'executed' | 'refused' | 'undone';
  entry: Decimal;
  size: Decimal;
  stop: Decimal;
  createdAt: number;
  executedAt?: number | undefined;
  failedSymbol?: string | undefined;
}

export interface FollowRow {
  _id: string;
  leaderStrategyId: string;
  allocationBps: number;
  address?: string | undefined;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

export function pairFromTicker(row: TickerRow): PairTicker {
  const [base = row.asset, quote = ''] = row.asset.split('/');
  return {
    asset: row.asset,
    base,
    quote,
    price: row.price,
    changeBps: row.changeBps,
    publishTime: row.publishTime,
  };
}

/** Equal in everything a pair row draws. Used to keep a row's reference when only another pair moved. */
export function samePair(a: PairTicker, b: PairTicker): boolean {
  return (
    a.asset === b.asset &&
    a.price.atoms === b.price.atoms &&
    a.price.decimals === b.price.decimals &&
    a.changeBps === b.changeBps &&
    a.publishTime === b.publishTime
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export function activityFromRows(rows: readonly ActivityRow[]): ActivityItem[] {
  return rows.map((r) => ({
    id: r._id,
    kind: r.status === 'refused' ? 'refused' : r.status,
    asset: r.asset,
    direction: r.direction,
    entry: r.entry,
    size: r.size,
    at: r.executedAt ?? r.createdAt,
    ...(r.status === 'refused' && r.failedSymbol ? { refusedBy: r.failedSymbol } : {}),
  }));
}

export function sameActivity(a: ActivityItem, b: ActivityItem): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.at === b.at &&
    a.refusedBy === b.refusedBy &&
    a.entry.atoms === b.entry.atoms &&
    a.size.atoms === b.size.atoms
  );
}

// ---------------------------------------------------------------------------
// Behaviour and rules
// ---------------------------------------------------------------------------

export function behaviourFrom(taken: number, blocked: number): BehaviourStats {
  return {
    taken,
    blocked,
    attempts: taken + blocked,
    adherenceBps: adherenceBps(taken, blocked) ?? 0,
  };
}

/** Every strategy the user has had, newest first, with the one enforcing now marked. */
export function ruleHistory(
  strategies: readonly LiveStrategy[] | undefined,
  activeId: string | undefined,
): RuleHistoryItem[] {
  return [...(strategies ?? [])]
    .sort((a, b) => b._creationTime - a._creationTime)
    .map((s) => {
      const spec = safeSpec(s.spec ?? s.pendingSpec);
      return {
        id: s._id,
        status: s.status,
        specHash: s.specHash,
        pinnedAt: s.pinnedAt ?? null,
        name: spec ? spec.predicates.map((p) => predicateSymbol(p)).join(' + ') : null,
        asset: spec ? spec.series.asset : null,
        active: s._id === activeId,
        ...(s.pinTxHash ? { pinTxHash: s.pinTxHash } : {}),
      };
    });
}

export function followsFromRows(rows: readonly FollowRow[] | undefined): ProfileFollow[] {
  return (rows ?? []).map((r) => ({
    address: r.address ?? null,
    leaderStrategyId: r.leaderStrategyId,
    allocationBps: r.allocationBps,
    active: r.active,
  }));
}
