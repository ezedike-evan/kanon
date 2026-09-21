import { useMemo } from 'react';
import { behaviourFrom } from './domain-map';
import type {
  ActivityState,
  HomeState,
  KanonSession,
  MarketsState,
  ProfileFollow,
  ProfileState,
  TickerState,
} from './domain-types';
import type { BlockedLogData } from './data';
import { useKanonSelector } from './data';
import { shallowEqual } from './store';
import type { CopyLeadsState, SparklineState } from './home-types';
import type { VaultSource } from './vault-types';

/**
 * The per-domain hooks: how a screen reads data.
 *
 * THE PATTERN. A screen asks for the domain it shows and nothing else:
 *
 *     const home = useHomeData();          // stats + rule + recent activity
 *     const markets = useMarkets();        // pairs, price, 24h move
 *
 * and each hook
 *   1. subscribes only while the component is mounted (nothing is read at the
 *      app root, so a screen that is not open costs nothing),
 *   2. re-renders the component only when its own domain changed (a price tick
 *      does not re-render Home's stats, and a new trade does not re-render the
 *      pair list),
 *   3. returns one of `loading` / `empty` / `ready` / `demo`, the same four in
 *      every domain, so a screen handles them the same way everywhere.
 *
 * For a list of live rows, call the list hook once in the list and the
 * per-item hook in a `React.memo` row, so a tick re-renders one row:
 *
 *     function PairRow({ asset }: { asset: string }) {
 *       const t = useTicker(asset);        // subscribes to this pair only
 *       ...
 *     }
 *
 * `useKanonData()` (the whole source) still works and is what the existing
 * screens use; new screens should use these instead. Never destructure a large
 * object off the whole source when one field is all a component reads: use
 * `useKanonSelector((s) => s.field)`.
 */

// Hook members of the source are stable in behaviour (same hooks in the same order,
// whatever the session), which is what lets a screen call the one it selected.

export function useSession(): KanonSession {
  return useKanonSelector((s) => s.session);
}

/** Every tradeable pair with its newest price and 24-hour move. Re-renders on any pair's tick. */
export function useMarkets(): MarketsState {
  return useKanonSelector((s) => s.useMarkets)();
}

/** One pair. Subscribes to that pair alone: another pair's tick does not re-render the caller. */
export function useTicker(asset: string): TickerState {
  return useKanonSelector((s) => s.useTicker)(asset);
}

/** The user's newest trades across their rules, refused ones included. */
export function useActivity(limit?: number): ActivityState {
  return useKanonSelector((s) => s.useActivity)(limit);
}

/** Copy relationships the user holds. `undefined` while loading. */
export function useFollows(): ProfileFollow[] | undefined {
  return useKanonSelector((s) => s.useFollows)();
}

/** A pair's last day as a line. Subscribes to that pair alone, like `useTicker`. */
export function useSparkline(asset: string): SparklineState {
  return useKanonSelector((s) => s.useSparkline)(asset);
}

/** Strategies listed for copying, as cards: adherence and followers, no P&L. */
export function useCopyLeads(): CopyLeadsState {
  return useKanonSelector((s) => s.useCopyLeads)();
}

/** Guarded vaults and copy trading, with every write. Reads the chain only while mounted. */
export function useVaults(): VaultSource {
  return useKanonSelector((s) => s.useVaults)();
}

/** Refusals and what they would have cost. Works the modelled outcomes out only while mounted. */
export function useBlockedLog(): BlockedLogData {
  return useKanonSelector((s) => s.useBlockedLog)();
}

/**
 * Home: behaviour counts, the rule, and the last few trades. Deliberately no
 * P&L and no price: pairs come from `useMarkets()`, in their own component, so
 * a tick never re-renders this.
 */
export function useHomeData(): HomeState {
  const session = useSession();
  const core = useKanonSelector(
    (s) => ({
      taken: s.home.taken,
      blocked: s.home.blocked,
      hasPinned: s.hasPinned,
      hasDraft: s.hasDraft,
      ordinal: s.rule.ordinal,
      name: s.rule.name,
      asset: s.rule.asset,
      timeframe: s.rule.timeframe,
    }),
    shallowEqual,
  );
  const activity = useActivity(5);

  return useMemo<HomeState>(() => {
    if (session.pending) return { status: 'loading' };
    return {
      status: session.mode === 'live' ? 'ready' : 'demo',
      stats: behaviourFrom(core.taken, core.blocked),
      rule: {
        hasPinned: core.hasPinned,
        hasDraft: core.hasDraft,
        ordinal: core.ordinal,
        name: core.name,
        asset: core.asset,
        timeframe: core.timeframe,
      },
      activity: activity.status === 'ready' || activity.status === 'demo' ? activity.items : [],
    };
  }, [session.pending, session.mode, core, activity]);
}

/**
 * Profile: settings, behaviour counts, every rule the user has had, and their
 * copy relationships. The trade-by-trade record is `useActivity(limit)`.
 */
export function useProfile(): ProfileState {
  const session = useSession();
  const settings = useKanonSelector((s) => s.settings);
  const records = useKanonSelector((s) => behaviourFrom(s.home.taken, s.home.blocked), shallowEqual);
  const rules = useKanonSelector((s) => s.ruleHistory);
  const following = useFollows();

  return useMemo<ProfileState>(() => {
    if (session.pending || following === undefined) return { status: 'loading' };
    if (!settings) return { status: 'empty' };
    return {
      status: session.mode === 'live' ? 'ready' : 'demo',
      settings,
      records,
      rules,
      following,
    };
  }, [session.pending, session.mode, settings, records, rules, following]);
}
