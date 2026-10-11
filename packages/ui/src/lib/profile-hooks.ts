import { useMemo } from 'react';
import { useKanonSelector } from './data';
import { useActivity, useProfile, useTimedTrades, useVenueOrders } from './domains';
import type { RuleHistoryItem } from './domain-types';
import { DEMO_RECORDS, DEMO_RULES } from './profile-demo';
import { chartRecords, mergeRecords, stakeRecords, timedRecords, tradeRecords, type LedgerRecord } from './profile-logic';
import { chartTrades } from './trade-records';
import type { TimedTrade } from './timed-types';
import type { VenueOrder } from './venue-types';

/**
 * What the Profile sub-screens read, built on the per-domain hooks. Each keeps
 * the four states (`loading`, `empty`, `ready`, `demo`) and, signed out, swaps
 * the data layer's short fixtures for the richer ones in `profile-demo.ts`, so
 * a first look at the app shows a lived-in account rather than one row.
 */

/** Each of the three reads behind the record is capped at this many: `MAX_ACTIVITY`, `MAX_ORDERS`, `MAX_TRADES` on the server. */
export const RECORDS_LIMIT = 50;

export type RecordsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready' | 'demo';
      records: LedgerRecord[];
      /** One of the reads came back full: older rows exist that are not shown. */
      truncated: boolean;
    };

const NO_ORDERS: VenueOrder[] = [];
const NO_TIMED: TimedTrade[] = [];

export type OwnTradesState = { status: 'loading' } | { status: 'ready'; records: LedgerRecord[]; truncated: boolean };

/**
 * The trades the person took by hand, newest first: positions from the chart's
 * ticket (paired from their orders) and timed trades from Predict. Signed out
 * it is ready and empty: this list is never filled with made-up trades.
 */
export function useOwnTrades(): OwnTradesState {
  const orders = useVenueOrders();
  const timed = useTimedTrades();
  return useMemo<OwnTradesState>(() => {
    if (orders.status === 'loading' || timed.status === 'loading') return { status: 'loading' };
    const placed = orders.status === 'ready' ? orders.orders : NO_ORDERS;
    const trades = timed.status === 'ready' ? timed.trades : NO_TIMED;
    return {
      status: 'ready',
      records: mergeRecords(chartRecords(chartTrades(placed, trades)), timedRecords(trades)),
      truncated: placed.length >= RECORDS_LIMIT || trades.length >= RECORDS_LIMIT,
    };
  }, [orders, timed]);
}

/**
 * Everything the person traded, newest first, however it was taken: by hand on
 * the chart, on a timer in Predict, or through their rule (executed and
 * refused), with any stake left from the earlier threshold markets.
 * Subscribes to its reads only while the caller is mounted.
 */
export function useRecords(): RecordsState {
  const activity = useActivity(RECORDS_LIMIT);
  const own = useOwnTrades();
  const feed = useKanonSelector((s) => s.usePredict)();
  const markets = feed.markets;

  return useMemo<RecordsState>(() => {
    if (activity.status === 'loading' || own.status === 'loading') return { status: 'loading' };
    if (activity.status === 'demo') return { status: 'demo', records: DEMO_RECORDS, truncated: false };
    const trades = activity.status === 'ready' ? activity.items : [];
    const records = mergeRecords(own.records, tradeRecords(trades), stakeRecords(markets));
    if (records.length === 0) return { status: 'empty' };
    return { status: 'ready', records, truncated: own.truncated || trades.length >= RECORDS_LIMIT };
  }, [activity, own, markets]);
}

export type RecentRecordsState =
  | { status: 'loading' }
  | { status: 'ready' | 'demo'; records: LedgerRecord[] };

/**
 * The newest few trades of every kind, for the Profile tab: the person's chart
 * and Predict trades with the newest setups put to their rule. Lighter than
 * `useRecords`: it reads no market feed and only as many rule trades as it shows.
 */
export function useRecentRecords(limit: number): RecentRecordsState {
  const activity = useActivity(limit);
  const own = useOwnTrades();
  return useMemo<RecentRecordsState>(() => {
    if (activity.status === 'loading' || own.status === 'loading') return { status: 'loading' };
    if (activity.status === 'demo') {
      return { status: 'demo', records: DEMO_RECORDS.slice(0, limit) };
    }
    const records = mergeRecords(own.records, tradeRecords(activity.status === 'ready' ? activity.items : []));
    return { status: 'ready', records: records.slice(0, limit) };
  }, [activity, own, limit]);
}

export type RulesState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready' | 'demo'; rules: RuleHistoryItem[] };

/** Every rule the person has had, newest first, with the one enforcing marked. */
export function useRules(): RulesState {
  const profile = useProfile();
  return useMemo<RulesState>(() => {
    if (profile.status === 'loading') return { status: 'loading' };
    if (profile.status === 'empty') return { status: 'empty' };
    if (profile.status === 'demo') return { status: 'demo', rules: DEMO_RULES };
    return profile.rules.length === 0 ? { status: 'empty' } : { status: 'ready', rules: profile.rules };
  }, [profile]);
}
