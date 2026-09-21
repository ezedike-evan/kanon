import { useMemo } from 'react';
import { useKanonSelector } from './data';
import { useActivity, useProfile } from './domains';
import type { RuleHistoryItem } from './domain-types';
import { DEMO_RECORDS, DEMO_RULES } from './profile-demo';
import { mergeRecords, stakeRecords, tradeRecords, type LedgerRecord } from './profile-logic';

/**
 * What the Profile sub-screens read, built on the per-domain hooks. Each keeps
 * the four states (`loading`, `empty`, `ready`, `demo`) and, signed out, swaps
 * the data layer's short fixtures for the richer ones in `profile-demo.ts`, so
 * a first look at the app shows a lived-in account rather than one row.
 */

/** The server caps a trade read at this many (`MAX_ACTIVITY` in `trades.ts`). */
export const RECORDS_LIMIT = 50;

export type RecordsState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready' | 'demo';
      records: LedgerRecord[];
      /** More trades exist than one read returns: the oldest are not shown. */
      truncated: boolean;
    };

/**
 * Trades (executed and refused) and the person's prediction stakes, newest first.
 * Subscribes to the trade read and the Predict feed only while the caller is mounted.
 */
export function useRecords(): RecordsState {
  const activity = useActivity(RECORDS_LIMIT);
  const feed = useKanonSelector((s) => s.usePredict)();
  const markets = feed.markets;

  return useMemo<RecordsState>(() => {
    if (activity.status === 'loading') return { status: 'loading' };
    if (activity.status === 'demo') return { status: 'demo', records: DEMO_RECORDS, truncated: false };
    const trades = activity.status === 'ready' ? activity.items : [];
    const records = mergeRecords(tradeRecords(trades), stakeRecords(markets));
    if (records.length === 0) return { status: 'empty' };
    return { status: 'ready', records, truncated: trades.length >= RECORDS_LIMIT };
  }, [activity, markets]);
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
