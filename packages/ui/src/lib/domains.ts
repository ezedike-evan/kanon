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
import type { BacktestRead, BacktestSubject } from './backtest-types';
import { useKanonSelector } from './data';
import { shallowEqual } from './store';
import type { CopyLeadsState, SparklineState } from './home-types';
import type { VaultSource } from './vault-types';
import type { PerplRiskState } from './perpl-risk-reads';
import type { OnchainRecordState } from './onchain-record-reads';
import type { SpotClient } from './spot-client';
import type { SpotMarketState } from './spot-reads';
import type { TimedStateRead, TimedTradesState } from './timed-types';
import type { VenueAccountRead, VenueOrdersState } from './venue-types';

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

/** Test on recorded prices, for the spec under review or one of the person's rules. See `lib/backtest.ts`. */
export function useBacktest(subject: BacktestSubject): BacktestRead {
  return useKanonSelector((s) => s.useBacktest)(subject);
}

/** The shared trading account orders go to. Read (a server action) only while a ticket is mounted. */
export function useVenueAccount(): VenueAccountRead {
  return useKanonSelector((s) => s.useVenueAccount)();
}

/** The signed-in user's own orders on the venue, newest first. */
export function useVenueOrders(): VenueOrdersState {
  return useKanonSelector((s) => s.useVenueOrders)();
}

/** Predict: what can be traded on a timer and which markets are free. Read (a call to the gateway) only while mounted. */
export function useTimedState(): TimedStateRead {
  return useKanonSelector((s) => s.useTimedState)();
}

/** The signed-in user's own timed trades, running and finished, newest first. */
export function useTimedTrades(): TimedTradesState {
  return useKanonSelector((s) => s.useTimedTrades)();
}

/** Perpl's markets with their terms, funding and newest state. Public data, polled only while mounted. */
export function usePerplRisk(): PerplRiskState {
  return useKanonSelector((s) => s.usePerplRisk)();
}

/** The spot market Kanon listed on Kuru testnet, with its book. Public data, polled only while mounted. */
export function useSpotMarket(): SpotMarketState {
  return useKanonSelector((s) => s.useSpotMarket)();
}

/** The seam to the person's own wallet for the spot market: balances, the open mint, a market order. */
export function useSpotClient(): SpotClient {
  return useKanonSelector((s) => s.spotClient);
}

/**
 * What the chain holds for a wallet's rules, newest first, from the Kanon indexer on Envio.
 * Pass the signed-in wallet (`useAccount().address`). Read only while mounted.
 */
export function useOnchainRecord(address: string | null): OnchainRecordState {
  return useKanonSelector((s) => s.useOnchainRecord)(address);
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
