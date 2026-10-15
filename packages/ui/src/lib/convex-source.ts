import { useMemo, useState } from 'react';
import { createChartReads } from './chart-reads';
import { createAnalyticsReads } from './analytics-reads';
import { demoDataSource, type KanonDataSource } from './data';
import {
  useLiveKanonSource,
  type LiveActions,
} from './live';
import { pickStrategies, type LiveStrategy, type LiveTrade } from './live-map';
import type { PinClient } from './pin';
import { unavailableMarketClient, type MarketClient } from './market-client';
import { createPredictReads } from './predict-reads';
import { predicateSymbol } from '@kanon/spec';
import type { VaultClient } from './vault-client';
import { createVaultReads } from './vault-reads';
import { resolveVaultConfig, type VaultConfigResult } from './vault-config';
import { safeSpec } from './live-map';
import { createDomainReads } from './domain-reads';
import { createHomeReads } from './home-reads';
import { ruleHistory } from './domain-map';
import type { KanonSession, ProfileSettings } from './domain-types';
import type { MarketFeed } from './market-feed';
import { createVenueChartReads } from './venue-chart-reads';
import { createVenueTickerReads } from './venue-ticker-reads';
import { disconnectedVenueTrade } from './venue-trade-client';
import { createVenueTradeReads, type VenueTradeActions } from './venue-trade-reads';
import { createTimedTradeReads } from './timed-trade-reads';
import { DISCONNECTED_RISK_STORE, createRiskStore, useRiskStore, type PerplRiskState } from './perpl-risk-reads';
import { activeChain } from './monad-chain';
import { unavailableSpotClient, type SpotClient } from './spot-client';
import { DISCONNECTED_SPOT_STORE, createSpotStore, useSpotStore, type SpotMarketState } from './spot-reads';
import { createOnchainRecordReads, createOnchainRecordStores, type IndexerPost } from './onchain-record-reads';

/**
 * Convex, wired to the live data source, once for both clients.
 *
 * `packages/ui` must not depend on Convex, so each app injects the three hooks
 * it already has (`useQuery`, `useMutation`, `useAction`) and its `api` object.
 * Everything else — which strategy is active, which trades to subscribe to,
 * which action each flow calls — lives here, so the web and the phone cannot
 * drift.
 *
 * What subscribes where. The app root holds only what every screen needs and
 * that is small and rarely changes: the caller's `users` row, their strategies
 * and the active strategy's trades. Everything else is a screen-scoped hook on
 * the source (`useSeries`, `usePredict`, `useAnalytics`, `useMarkets`,
 * `useActivity`, `useVaults`, `useBlockedLog`, `useVenueAccount`, `useTimedState`, ...): it
 * subscribes, and reads the chain or the venue, only while the component that
 * shows it is mounted. The returned source is memoised, so it changes only
 * when something it exposes changed.
 *
 * `api` is passed loosely typed on purpose: `convex/_generated/api.d.ts` is
 * stale until `npx convex dev` regenerates it, and at runtime `api` resolves
 * any module path.
 */

export interface ConvexHooks {
  useQuery(ref: unknown, args: unknown): unknown;
  useMutation(ref: unknown): (args: any) => Promise<any>;
  useAction(ref: unknown): (args: any) => Promise<any>;
}

export interface ConvexSession {
  /** Privy, or Convex confirming its token, has not said yet whether anyone is signed in. */
  pending: boolean;
  /**
   * Convex has accepted the person's Privy access token. Nothing below is
   * queried before this is true, so a logged-out visitor makes no Convex
   * calls and sees the demo fixtures. Who they are is never sent: the server
   * derives it from that token.
   */
  signedIn: boolean;
}

/** The fallback when an app passes no vault config: a stable object, so it never rebuilds the vault reads. */
const NO_VAULT_CONFIG = resolveVaultConfig({});

export function useConvexKanonSource(input: {
  hooks: ConvexHooks;
  api: any;
  session: ConvexSession;
  pinClient: PinClient;
  /** The ThresholdMarket client. Absent, taking a side reports that nothing is deployed. */
  marketClient?: MarketClient | undefined;
  /** The vault factory client. Absent, vaults and copy trading report that nothing is deployed. */
  vaultClient?: VaultClient | null | undefined;
  vaultConfig?: VaultConfigResult | undefined;
  /** Whether a signer exists, so an action can say why it cannot run before it is tried. */
  hasWallet?: boolean | undefined;
  /**
   * The market data gateway's client. Present, candles and pair prices are read
   * from the venue through it; trade markers and everything else stay on Convex.
   * Absent, nothing changes. Only the value at first render is used.
   */
  marketFeed?: MarketFeed | undefined;
  /**
   * The order ticket's calls to the gateway's `/trade` routes, and Predict's to
   * its `/predict` routes. Orders go out from the gateway, not from Convex;
   * Convex keeps the list of them. Absent, the ticket and Predict say trading
   * is not connected. Only the value at first render is used.
   */
  venueTrade?: VenueTradeActions | undefined;
  /**
   * The Kanon indexer on Envio, as one GraphQL request (`resolveIndexer`).
   * Present, Profile's on-chain record is read from it for the signed-in
   * wallet. Absent, the record says it is not connected. Only the value at
   * first render is used.
   */
  indexer?: IndexerPost | undefined;
  /**
   * The spot market's wallet client (`createViemSpotClient`), built by the app
   * over the same signer the pin uses. Absent, the spot screen shows the book
   * and says there is no wallet to trade from.
   */
  spotClient?: SpotClient | undefined;
}): KanonDataSource {
  const { hooks, api, session, pinClient } = input;
  // Fixed for the life of the source. `useSeries`, `useMarkets` and `useTicker` are hooks that
  // mounted components call on every render, and the venue's call different hooks inside than
  // Convex's do, so the two must never be swapped under a component.
  const [marketFeed] = useState(() => input.marketFeed);
  const [venueTrade] = useState(() => input.venueTrade ?? disconnectedVenueTrade);
  // One store per wallet for the life of the source, so a change of session does not drop a record
  // already read. The chain is asked for at each read: the app configures it before any screen renders.
  const [onchainStores] = useState(() =>
    input.indexer ? createOnchainRecordStores({ post: input.indexer, chainId: () => activeChain().id }) : null,
  );

  // The caller's own `users` row, found from the token. `userId` is only a
  // gate ("signed in, and signup has created a row"); it is never an argument.
  const dbUser = hooks.useQuery(api.users.me, session.signedIn ? {} : 'skip') as
    | { _id: string; _creationTime?: number; name?: string; username?: string; email?: string }
    | null
    | undefined;
  const userId = dbUser?._id;

  const strategies = hooks.useQuery(
    api.strategies.listStrategiesByOwner,
    userId ? {} : 'skip',
  ) as LiveStrategy[] | undefined;
  const picked = useMemo(() => pickStrategies(strategies), [strategies]);
  const activeId = picked.active?._id;

  const trades = hooks.useQuery(
    api.trades.listTradesByStrategy,
    activeId ? { strategyId: activeId } : 'skip',
  ) as LiveTrade[] | undefined;

  const compile = hooks.useAction(api.compiler.compileStrategy);
  const saveDraft = hooks.useMutation(api.strategies.saveDraft);
  // Actions, not mutations: each reads the transaction from the chain before it saves anything.
  const pinStrategy = hooks.useAction(api.strategies.pinStrategy);
  const amendStrategy = hooks.useAction(api.strategies.amendStrategy);
  const finalizeAmendment = hooks.useAction(api.strategies.finalizeAmendment);
  const withdrawAmendment = hooks.useMutation(api.strategies.withdrawAmendment);
  // The text a wallet signs to link itself to the account: the pin asks for it, and so does Predict.
  const walletLinkMessage = hooks.useAction(api.users.walletLinkChallenge);
  const runProposer = hooks.useAction(api.proposer.runProposer);
  const blockedReport = hooks.useAction(api.proposer.blockedReport);
  const undoTrade = hooks.useMutation(api.trades.undoTrade);
  const confirmTrade = hooks.useMutation(api.trades.confirmTrade);
  const setAutopilot = hooks.useMutation(api.strategies.setAutopilot);

  const actions = useMemo<LiveActions>(
    () => ({
      compile: (args) => compile(args),
      saveDraft: (args) => saveDraft(args),
      pinStrategy: (args) => pinStrategy(args),
      amendStrategy: (args) => amendStrategy(args),
      finalizeAmendment: (args) => finalizeAmendment(args),
      withdrawAmendment: (args) => withdrawAmendment(args),
      walletLinkMessage: () => walletLinkMessage({}) as Promise<{ message: string }>,
      runProposer: (args) => runProposer(args),
      blockedReport: (args) => blockedReport(args),
      undoTrade: (args) => undoTrade(args),
      confirmTrade: (args) => confirmTrade(args),
      setAutopilot: (args) => setAutopilot(args),
    }),
    [
      compile,
      saveDraft,
      pinStrategy,
      amendStrategy,
      finalizeAmendment,
      withdrawAmendment,
      walletLinkMessage,
      runProposer,
      blockedReport,
      undoTrade,
      confirmTrade,
      setAutopilot,
    ],
  );

  // Candles and trade markers: live once signed in, the demo fixture only while signed out.
  const chartStrategyId = activeId ?? strategies?.[strategies.length - 1]?._id;
  const chartReads = useMemo(
    () => {
      const chartSession = {
        pending: session.pending,
        signedIn: session.signedIn,
        strategyId: chartStrategyId,
      };
      const fromConvex = createChartReads({
        useQuery: hooks.useQuery,
        getSeries: api.series.getSeries,
        getChartMarkers: api.series.getChartMarkers,
        session: chartSession,
        demo: demoDataSource,
      });
      // With a gateway the candles are the venue's. The markers are the user's own trades, which only Convex has.
      return marketFeed
        ? { ...fromConvex, ...createVenueChartReads({ feed: marketFeed, session: chartSession }) }
        : fromConvex;
    },
    // `hooks` and `api` are module-level in both apps; the session is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, session.pending, session.signedIn, chartStrategyId, marketFeed],
  );

  // Predict: real markets and the person's stakes, once signed in; the demo cards while signed out.
  const marketClient = useMemo(
    () => input.marketClient ?? unavailableMarketClient({ marketAddress: undefined, hasWallet: false }),
    [input.marketClient],
  );
  const linkChainMarket = hooks.useMutation(api.markets.linkChainMarket);
  const recordPosition = hooks.useAction(api.predictions.recordPosition);
  const predictReads = useMemo(
    () =>
      createPredictReads({
        useQuery: hooks.useQuery,
        listMarkets: api.markets.list,
        listPositions: api.predictions.listMarketPositions,
        actions: {
          linkChainMarket: (args) => linkChainMarket(args),
          recordPosition: (args) => recordPosition(args),
          walletLinkMessage: () => walletLinkMessage({}) as Promise<{ message: string }>,
        },
        marketClient,
        session: { pending: session.pending, signedIn: session.signedIn, userId },
        demo: demoDataSource,
      }),
    // `hooks` and `api` are module-level in both apps; the session and the client are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, linkChainMarket, recordPosition, walletLinkMessage, marketClient, session.pending, session.signedIn, userId],
  );

  // Analytics: the owner's own report and Nansen flow once signed in; the demo report while signed out.
  const analyticsReads = useMemo(
    () =>
      createAnalyticsReads({
        useQuery: hooks.useQuery,
        useAction: hooks.useAction,
        report: api.analytics.report,
        smartMoneyFlow: api.nansen.smartMoneyFlow,
        session: {
          pending: session.pending,
          signedIn: session.signedIn,
          strategyId: chartStrategyId,
          userId,
        },
        demo: demoDataSource,
      }),
    // `hooks` and `api` are module-level in both apps; the session and the strategy are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, hooks.useAction, session.pending, session.signedIn, chartStrategyId, userId],
  );

  // Per-domain reads that need no root subscription: pairs, activity, follows.
  const domainReads = useMemo(
    () => {
      const fromConvex = createDomainReads({
        useQuery: hooks.useQuery,
        listTickers: api.series.listTickers,
        getTicker: api.series.getTicker,
        listRecentActivity: api.trades.listRecentActivity,
        listFollows: api.copyRelationships.listCopyRelationshipsByOwner,
        session: { pending: session.pending, signedIn: session.signedIn, userId },
      });
      // With a gateway a pair's price is the venue's, the same one its chart closes on.
      return marketFeed
        ? {
            ...fromConvex,
            ...createVenueTickerReads({
              feed: marketFeed,
              session: { pending: session.pending, signedIn: session.signedIn },
            }),
          }
        : fromConvex;
    },
    // `hooks` and `api` are module-level in both apps; the session is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, session.pending, session.signedIn, userId, marketFeed],
  );

  // Home's own reads: a pair's last-day line and the copy carousel. Market data, screen-scoped.
  const homeReads = useMemo(
    () =>
      createHomeReads({
        useQuery: hooks.useQuery,
        sparkline: api.homeFeed.sparkline,
        leadSummaries: api.homeFeed.leadSummaries,
        session: { pending: session.pending, signedIn: session.signedIn },
      }),
    // `hooks` and `api` are module-level in both apps; the session is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, session.pending, session.signedIn],
  );

  // The order ticket: the shared trading account, an order on it, and the caller's own orders.
  // The account and the orders go through the gateway (`venueTrade`); the list of them is a
  // Convex query. Nothing here runs at the root: the account is read only while a ticket is mounted.
  const venueTradeReads = useMemo(
    () =>
      createVenueTradeReads({
        useQuery: hooks.useQuery,
        listMyOrders: api.venueData.listMyOrders,
        actions: venueTrade,
        session: { pending: session.pending, signedIn: session.signedIn },
      }),
    // `hooks` and `api` are module-level in both apps; the session is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, venueTrade, session.pending, session.signedIn],
  );

  // Predict's timed trades: what can be traded and the open and the early end go through the
  // gateway (the same `venueTrade` calls object); the caller's trades are a Convex query.
  // Nothing here runs at the root: the state is read only while the Predict screen is mounted.
  const timedTradeReads = useMemo(
    () =>
      createTimedTradeReads({
        useQuery: hooks.useQuery,
        listMine: api.timedData.listMine,
        actions: venueTrade,
        session: { pending: session.pending, signedIn: session.signedIn },
      }),
    // `hooks` and `api` are module-level in both apps; the session is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hooks.useQuery, venueTrade, session.pending, session.signedIn],
  );

  // Perpl's public market data for the risk screen, through the gateway. No session is involved:
  // one store for the life of the calls object, polling only while the screen is mounted.
  const perplRiskReads = useMemo(() => {
    const get = venueTrade.publicGet;
    const store = get ? createRiskStore({ get: (path) => get(path) }) : DISCONNECTED_RISK_STORE;
    return {
      usePerplRisk(): PerplRiskState {
        return useRiskStore(store);
      },
    };
  }, [venueTrade]);

  // The spot market Kanon listed on Kuru testnet, through the gateway's one public route. No session
  // is involved in the read. The wallet client is the app's own, or one that says there is no wallet.
  const spotReads = useMemo(() => {
    const get = venueTrade.publicGet;
    const store = get ? createSpotStore({ get: (path) => get(path) }) : DISCONNECTED_SPOT_STORE;
    return {
      useSpotMarket(): SpotMarketState {
        return useSpotStore(store);
      },
    };
  }, [venueTrade]);
  const spotClient = useMemo(
    () => input.spotClient ?? unavailableSpotClient({ chainId: activeChain().id }),
    [input.spotClient],
  );

  // Profile's on-chain record, from the Kanon indexer on Envio: public data keyed by the wallet's
  // address, so Convex is not involved. Read only while the record is mounted, and only signed in.
  const onchainRecordReads = useMemo(
    () =>
      createOnchainRecordReads({
        stores: onchainStores,
        session: { pending: session.pending, signedIn: session.signedIn },
      }),
    [onchainStores, session.pending, session.signedIn],
  );

  // Guarded vaults and copy trading: the chain for what is true on-chain, Convex for finding it again.
  // Read only while a vault or copy screen is mounted (`useVaults`), never at the root.
  const vaultStrategy = useMemo(() => {
    const active = picked.active;
    const spec = safeSpec(active?.spec);
    if (!active || !spec) return null;
    return {
      id: active._id,
      chainStrategyId: active.chainStrategyId,
      symbol: spec.series.asset,
      name: spec.predicates.map((p) => predicateSymbol(p)).join(' + '),
    };
  }, [picked.active]);

  const vaultConfig = input.vaultConfig ?? NO_VAULT_CONFIG;
  const vaultReads = useMemo(
    () =>
      createVaultReads({
        hooks,
        api,
        session: { pending: session.pending, userId },
        config: vaultConfig,
        client: input.vaultClient ?? null,
        hasWallet: Boolean(input.hasWallet),
        strategy: vaultStrategy,
      }),
    // `hooks` and `api` are module-level in both apps; the rest is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.pending, userId, vaultConfig, input.vaultClient, input.hasWallet, vaultStrategy],
  );

  const kanonSession = useMemo<KanonSession>(
    () => ({
      mode: userId ? 'live' : 'demo',
      pending: session.pending,
      signedIn: session.signedIn,
      hasWallet: Boolean(input.hasWallet),
    }),
    [userId, session.pending, session.signedIn, input.hasWallet],
  );
  const settings = useMemo<ProfileSettings | null>(
    () =>
      dbUser
        ? {
            name: dbUser.name ?? '',
            username: dbUser.username ?? '',
            email: dbUser.email ?? null,
            hasWallet: Boolean(input.hasWallet),
            ...(dbUser._creationTime ? { joinedAt: dbUser._creationTime } : {}),
          }
        : null,
    [dbUser, input.hasWallet],
  );
  const history = useMemo(() => ruleHistory(strategies, activeId), [strategies, activeId]);

  const live = useLiveKanonSource({ userId, strategies, trades, actions, pinClient, chartReads, predictReads });

  // One object, rebuilt only when a part of it is: spreading these inline would hand every
  // consumer a new source on every render of the bridge, whatever had actually changed.
  return useMemo<KanonDataSource>(
    () => ({
      ...live,
      ...analyticsReads,
      ...domainReads,
      ...homeReads,
      ...vaultReads,
      ...venueTradeReads,
      ...timedTradeReads,
      ...perplRiskReads,
      ...onchainRecordReads,
      ...spotReads,
      spotClient,
      session: kanonSession,
      settings: userId ? settings : live.settings,
      ruleHistory: userId ? history : live.ruleHistory,
    }),
    [
      live,
      analyticsReads,
      domainReads,
      homeReads,
      vaultReads,
      venueTradeReads,
      timedTradeReads,
      perplRiskReads,
      onchainRecordReads,
      spotReads,
      spotClient,
      kanonSession,
      settings,
      history,
      userId,
    ],
  );
}
