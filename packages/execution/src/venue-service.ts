/**
 * Real orders on Perpl, placed by a server with its own API key.
 *
 * What this is, plainly: the server holds ONE Perpl API key, which belongs to
 * one exchange account. Every signed-in user who places an order here trades
 * that same account. It exists so the app can place a real order end to end
 * before per-user keys do (Perpl only lets a whitelisted origin enroll one). It
 * is not custody: nobody deposits through this, and an API key cannot withdraw.
 *
 * Because the account is shared, the service keeps it small and orderly:
 *   - testnet only;
 *   - every limit is in `VENUE_LIMITS` and returned with the account, so the
 *     ticket shows the numbers the server enforces;
 *   - one position per market, one order on its way at a time (the recorder's
 *     `begin` is the lock), since the venue numbers an account's requests in
 *     sequence;
 *   - market orders only, sent IOC with a slippage bound: an order fills in the
 *     next block or two, or not at all. Nothing rests on the book.
 *
 * The rule is not consulted here. This is a plain order ticket.
 *
 * Where it runs matters: Perpl answers its trading API with HTTP 451 from
 * regions it does not serve (United States cloud addresses among them), so
 * this cannot run inside a backend hosted there. It is framework-free for that
 * reason. The process that runs it supplies two things: the signed REST client
 * for the account, and a `VenueRecorder`, which knows who is asking, keeps the
 * one-order-at-a-time lock and writes each order down.
 */

import type { Decimal } from '@kanon/spec';
import {
  PERPL_COLLATERAL_DECIMALS,
  PerplRestError,
  closeAtMarket,
  findPerplMarket,
  loadPerplMarkets,
  openAtMarket,
  readPerplAccount,
  readPerplMarkPrice,
  sizeForNotional,
  type MarketOrderOutcome,
  type PerplMarketInfo,
  type PerplNetwork,
  type PerplRest,
  type TradeDeps,
} from './perpl-trade';
import {
  VENUE_LIMITS,
  checkMargin,
  checkOrderRequest,
  leverageCeiling,
  scaled,
  type OrderRequest,
  type OrderSide,
  type VenueAccountView,
  type VenueLimits,
  type VenueOrderResult,
} from './venue-policy';

export * from './venue-policy';

export const VENUE_MESSAGES = {
  signIn: 'Sign in to trade.',
  finishSignUp: 'Finish signing up to trade.',
  testnetOnly: 'Orders are placed on testnet only for now.',
  busy: 'Another order is on its way to this account. Try again in a moment.',
  notSent: 'The venue could not be reached. Nothing was sent.',
  notRecorded: 'The order could not be recorded, so it was not sent.',
  sentUnread:
    'The order was sent, but the venue could not be read afterwards. Check the position before sending another.',
  nothingFilled: 'The venue took the order and nothing filled. Nothing is left on the book.',
  noAccount: 'The trading account does not exist on Perpl yet.',
  unread: 'The venue could not be read. Try again.',
} as const;

/** What the recorder is told before an order goes out. */
export interface OrderRecord {
  network: PerplNetwork;
  asset: string;
  action: 'open' | 'close';
  side?: OrderSide;
  notionalUsd?: number;
  leverage?: number;
}

/** What became of an order. Optional fields are left out, not nulled. */
export interface OrderOutcomeRecord {
  orderId: string;
  status: 'filled' | 'unfilled' | 'refused' | 'failed';
  side?: OrderSide;
  requestId?: number;
  size?: Decimal;
  fillPrice?: Decimal;
  fee?: Decimal;
  block?: number;
  txHash?: string;
  reason?: string;
}

export type BeginResult =
  | { ok: true; orderId: string }
  /** No valid sign-in, no account row yet, another order on its way, or the record could not be written. */
  | { ok: false; code: 'unauthenticated' | 'no_user' | 'busy' | 'unreachable' }
  | { ok: false; code: 'rate_limited'; retryAfterMs: number; message: string };

/**
 * Who is asking, the lock, and the written record, for one caller. `begin`
 * decides whether this caller may send an order now and, if so, takes the lock
 * and writes the row. `settle` writes what became of it and lets the lock go.
 */
export interface VenueRecorder {
  begin(order: OrderRecord): Promise<BeginResult>;
  settle(outcome: OrderOutcomeRecord): Promise<void>;
}

export interface VenueServiceDeps {
  network: PerplNetwork;
  /** The signed client for the one shared account. */
  rest: PerplRest;
  limits?: VenueLimits;
  /** Public reads of the venue. Default: Perpl's REST for `network`. */
  loadMarkets?: () => Promise<PerplMarketInfo[]>;
  readMarkPrice?: (marketId: number) => Promise<number>;
  fetchImpl?: typeof fetch;
  /** Handed to the wait for a fill: sleep, timeouts and its clock. */
  trade?: Omit<TradeDeps, 'rest'>;
  now?: () => number;
  /** Told what failed and where. A venue error carries a path and a status, never a key. */
  onError?: (scope: string, err: unknown) => void;
}

export interface VenueService {
  /** The trading account: its balance, what it holds open, its markets and every limit. No profit or loss. */
  account(): Promise<VenueAccountView>;
  /** Opens a position at market. A refusal comes back as a value, with its reason. */
  placeOrder(request: OrderRequest, recorder: VenueRecorder): Promise<VenueOrderResult>;
  /** Closes the whole of the account's position on a market, at market. */
  closePosition(asset: string, recorder: VenueRecorder): Promise<VenueOrderResult>;
}

/** The market list changes rarely; one read serves a minute of calls. */
const MARKETS_TTL_MS = 60_000;

const assetOf = (market: PerplMarketInfo): string => `${market.symbol}/USD`;

export function createVenueService(deps: VenueServiceDeps): VenueService {
  const { network, rest } = deps;
  const limits = deps.limits ?? VENUE_LIMITS;
  const now = deps.now ?? Date.now;
  const publicOpts = { network, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const loadMarkets = deps.loadMarkets ?? (() => loadPerplMarkets(publicOpts));
  const readMarkPrice = deps.readMarkPrice ?? ((id: number) => readPerplMarkPrice(publicOpts, id));
  const report = deps.onError ?? (() => {});

  let cache: { at: number; markets: PerplMarketInfo[] } | null = null;
  async function markets(): Promise<PerplMarketInfo[]> {
    const at = now();
    if (cache && at - cache.at < MARKETS_TTL_MS && at >= cache.at) return cache.markets;
    const fresh = await loadMarkets();
    cache = { at, markets: fresh };
    return fresh;
  }

  /** Never throws: an order that filled is still reported as filled when its row could not be written. */
  async function settle(recorder: VenueRecorder, outcome: OrderOutcomeRecord): Promise<void> {
    try {
      await recorder.settle(outcome);
    } catch (err) {
      report('venue.settle', err);
    }
  }

  function notBegun(begun: Exclude<BeginResult, { ok: true }>): VenueOrderResult {
    switch (begun.code) {
      case 'rate_limited':
        return { status: 'rate_limited', retryAfterMs: begun.retryAfterMs, message: begun.message };
      case 'busy':
        return { status: 'busy', message: VENUE_MESSAGES.busy };
      case 'unauthenticated':
        return { status: 'unavailable', message: VENUE_MESSAGES.signIn };
      case 'no_user':
        return { status: 'unavailable', message: VENUE_MESSAGES.finishSignUp };
      case 'unreachable':
        return { status: 'unavailable', message: VENUE_MESSAGES.notRecorded };
    }
  }

  /** Writes what the venue did with an order to its row and returns the same thing to the caller. */
  async function record(
    recorder: VenueRecorder,
    orderId: string,
    outcome: MarketOrderOutcome,
    order: { market: PerplMarketInfo; action: 'open' | 'close'; side: OrderSide },
  ): Promise<VenueOrderResult> {
    const { market, side } = order;
    if (outcome.status === 'refused') {
      await settle(recorder, { orderId, status: 'refused', side, reason: outcome.reason });
      return { status: 'refused', reason: outcome.reason };
    }
    if (outcome.status === 'unfilled') {
      await settle(recorder, { orderId, status: 'unfilled', side, requestId: outcome.requestId });
      return { status: 'unfilled', orderId, message: VENUE_MESSAGES.nothingFilled };
    }
    const { fill } = outcome;
    const size = scaled(fill.size, market.sizeDecimals);
    const price = fill.price === null ? null : scaled(fill.price, market.priceDecimals);
    const fee = scaled(fill.fee, PERPL_COLLATERAL_DECIMALS);
    await settle(recorder, {
      orderId,
      status: 'filled',
      side,
      requestId: outcome.requestId,
      size,
      fee,
      block: fill.block,
      ...(price ? { fillPrice: price } : {}),
      ...(fill.txHash ? { txHash: fill.txHash } : {}),
    });
    return {
      status: 'filled',
      orderId,
      asset: assetOf(market),
      action: order.action,
      side,
      size,
      price,
      fee,
      block: fill.block,
      txHash: fill.txHash,
    };
  }

  /**
   * The venue could not be reached or read. Whether the order had already gone
   * out decides what is said: "nothing was sent" is only said when it is true.
   */
  async function failed(
    recorder: VenueRecorder,
    orderId: string,
    sent: boolean,
    scope: string,
    err: unknown,
  ): Promise<VenueOrderResult> {
    report(`${scope}: ${sent ? 'the order was sent and its result could not be read' : 'nothing was sent'}`, err);
    const reason = sent ? VENUE_MESSAGES.sentUnread : VENUE_MESSAGES.notSent;
    await settle(recorder, { orderId, status: 'failed', reason });
    return sent
      ? { status: 'unfilled', orderId, message: VENUE_MESSAGES.sentUnread }
      : { status: 'unavailable', message: VENUE_MESSAGES.notSent };
  }

  /** The signed client, with a flag that turns true the moment an order leaves. */
  function tracked(): { deps: TradeDeps; sent: () => boolean } {
    let sent = false;
    return {
      deps: { ...deps.trade, rest: { ...rest, submit: (orders) => ((sent = true), rest.submit(orders)) } },
      sent: () => sent,
    };
  }

  return {
    async account() {
      try {
        const [list, state] = await Promise.all([markets(), readPerplAccount(rest)]);
        if (!state) return { status: 'unavailable', message: VENUE_MESSAGES.noAccount };
        const byId = new Map(list.map((m) => [m.id, m]));
        return {
          status: 'ready',
          venue: 'perpl',
          network,
          wallet: state.wallet,
          accountId: state.account.id,
          balance: scaled(state.account.b, PERPL_COLLATERAL_DECIMALS),
          canTrade: state.account.fw === true && state.account.fr !== true,
          limits: { ...limits },
          markets: list.map((m) => ({ asset: assetOf(m), maxLeverage: leverageCeiling(m, limits), open: m.open })),
          positions: state.positions.flatMap((p) => {
            const market = byId.get(p.mkt);
            if (!market) return [];
            return [
              {
                asset: assetOf(market),
                side: p.sd === 2 ? ('short' as const) : ('long' as const),
                size: scaled(p.s, market.sizeDecimals),
                entryPrice: scaled(p.ep, market.priceDecimals),
                leverage: p.lv / 100,
                collateral: scaled(p.c, PERPL_COLLATERAL_DECIMALS),
                openedAt: p.ots?.t ?? null,
              },
            ];
          }),
        };
      } catch (err) {
        report('venue.account: the venue could not be read', err);
        if (err instanceof PerplRestError && (err.status === 401 || err.status === 403)) {
          return {
            status: 'unavailable',
            message: `Perpl ${network} did not accept the server's API key.`,
          };
        }
        if (err instanceof PerplRestError && err.status === 451) {
          return { status: 'unavailable', message: 'Perpl does not serve the region this server runs in.' };
        }
        return { status: 'unavailable', message: VENUE_MESSAGES.unread };
      }
    },

    async placeOrder(request, recorder) {
      if (network !== 'testnet') return { status: 'unavailable', message: VENUE_MESSAGES.testnetOnly };

      let market: PerplMarketInfo | null;
      try {
        market = findPerplMarket(await markets(), request.asset);
      } catch (err) {
        report('venue.placeOrder: the market list could not be read', err);
        return { status: 'unavailable', message: VENUE_MESSAGES.notSent };
      }
      const checked = checkOrderRequest(request, market, limits);
      if (!checked.ok || !market) return { status: 'refused', reason: checked.ok ? 'No market.' : checked.reason };

      const begun = await recorder.begin({
        network,
        asset: assetOf(market),
        action: 'open',
        side: request.side,
        notionalUsd: request.usd,
        leverage: request.leverage,
      });
      if (!begun.ok) return notBegun(begun);
      const { orderId } = begun;
      const refuse = async (reason: string): Promise<VenueOrderResult> => {
        await settle(recorder, { orderId, status: 'refused', reason });
        return { status: 'refused', reason };
      };

      const venue = tracked();
      try {
        const state = await readPerplAccount(rest);
        if (!state) return await refuse(VENUE_MESSAGES.noAccount);
        if (state.account.fr) return await refuse('The trading account is frozen.');
        if (!state.account.fw) return await refuse('One-click trading is off for the trading account.');
        if (state.positions.some((p) => p.mkt === market.id)) {
          return await refuse(`The account already holds a ${market.symbol} position. Close it before opening another.`);
        }
        const margin = checkMargin(state.account.b, state.account.lb, request.usd, request.leverage);
        if (!margin.ok) return await refuse(margin.reason);

        const mark = await readMarkPrice(market.id);
        const size = sizeForNotional({
          usdNotional: request.usd,
          scaledPrice: mark,
          priceDecimals: market.priceDecimals,
          sizeDecimals: market.sizeDecimals,
        });
        if (size < 1) return await refuse(`$${request.usd} is below the smallest ${market.symbol} order at this price.`);

        const outcome = await openAtMarket(venue.deps, {
          market,
          account: state.account,
          side: request.side,
          size,
          leverage: request.leverage * 100,
          slippageBps: limits.slippageBps,
        });
        return await record(recorder, orderId, outcome, { market, action: 'open', side: request.side });
      } catch (err) {
        return await failed(recorder, orderId, venue.sent(), 'venue.placeOrder', err);
      }
    },

    async closePosition(asset, recorder) {
      if (network !== 'testnet') return { status: 'unavailable', message: VENUE_MESSAGES.testnetOnly };

      let market: PerplMarketInfo | null;
      try {
        market = findPerplMarket(await markets(), asset);
      } catch (err) {
        report('venue.closePosition: the market list could not be read', err);
        return { status: 'unavailable', message: VENUE_MESSAGES.notSent };
      }
      if (!market) return { status: 'refused', reason: `Perpl lists no market for ${asset}.` };

      const begun = await recorder.begin({ network, asset: assetOf(market), action: 'close' });
      if (!begun.ok) return notBegun(begun);
      const { orderId } = begun;
      const refuse = async (reason: string): Promise<VenueOrderResult> => {
        await settle(recorder, { orderId, status: 'refused', reason });
        return { status: 'refused', reason };
      };

      const venue = tracked();
      try {
        const state = await readPerplAccount(rest);
        if (!state) return await refuse(VENUE_MESSAGES.noAccount);
        const position = state.positions.find((p) => p.mkt === market.id);
        if (!position) return await refuse(`The account holds no ${market.symbol} position.`);
        if (state.account.fr) return await refuse('The trading account is frozen.');
        if (!state.account.fw) return await refuse('One-click trading is off for the trading account.');

        const outcome = await closeAtMarket(venue.deps, {
          account: state.account,
          position,
          slippageBps: limits.slippageBps,
        });
        return await record(recorder, orderId, outcome, {
          market,
          action: 'close',
          side: position.sd === 2 ? 'short' : 'long',
        });
      } catch (err) {
        return await failed(recorder, orderId, venue.sent(), 'venue.closePosition', err);
      }
    },
  };
}
