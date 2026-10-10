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
 *   - one order on its way at a time (the recorder's `begin` is the lock),
 *     since the venue numbers an account's requests in sequence;
 *   - a market holds one position per account. An order on the same side adds
 *     to it, at its leverage and up to the stated size. One on the other side
 *     is refused: close first;
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
  type PerplPosition,
  type PerplRest,
  type TradeDeps,
  type VenueFill,
} from './perpl-trade';
import {
  VENUE_LIMITS,
  checkAgainstPosition,
  checkMargin,
  checkOrderRequest,
  leverageCeiling,
  positionCents,
  scaled,
  type OrderRequest,
  type OrderSide,
  type VenueAccountView,
  type VenueLimits,
  type VenueOrderResult,
  type VenuePositionView,
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
  sentUnreported:
    'The order was sent and the venue has not reported its result yet. It may still fill. Check the position before sending another.',
  nothingFilled: 'The venue forwarded the order and nothing filled. Nothing is left on the book.',
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

/** A fill's own figures, added to an order that was recorded as filled before the venue's history listed them. */
export interface FillDetailsRecord {
  orderId: string;
  size?: Decimal;
  fillPrice?: Decimal;
  fee?: Decimal;
  block?: number;
  txHash?: string;
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
 * `amend` completes a fill's record once the venue's history has its figures.
 */
export interface VenueRecorder {
  begin(order: OrderRecord): Promise<BeginResult>;
  settle(outcome: OrderOutcomeRecord): Promise<void>;
  amend?(details: FillDetailsRecord): Promise<void>;
}

/** Where an order's time went, in milliseconds. For the operator's log; never shown as a promise of speed. */
export interface OrderTiming {
  action: 'open' | 'close';
  asset: string;
  status: VenueOrderResult['status'];
  /** The recorder: who is asking, the lock, the row. */
  beginMs: number;
  /** The account, the mark price and the fill history, read together. */
  readMs: number;
  /** Submitting the order and waiting for the position to move. */
  settleMs: number;
  totalMs: number;
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
  onTiming?: (timing: OrderTiming) => void;
  /**
   * Handed the work that goes on after an order has been answered: asking the
   * venue's history for the fill's figures and adding them to the record. The
   * default lets it run; a test waits on it.
   */
  background?: (task: Promise<void>) => void;
}

export interface VenueService {
  /** The trading account: its balance, what it holds open, its markets and every limit. No profit or loss. */
  account(): Promise<VenueAccountView>;
  /** Opens a position at market, or adds to the one held on the same side. A refusal comes back as a value, with its reason. */
  placeOrder(request: OrderRequest, recorder: VenueRecorder): Promise<VenueOrderResult>;
  /** Closes the whole of the account's position on a market, at market. */
  closePosition(asset: string, recorder: VenueRecorder): Promise<VenueOrderResult>;
}

/** The market list changes rarely; one read serves a minute of calls. */
const MARKETS_TTL_MS = 60_000;
/** How often, and how many times, the venue's history is asked for a fill it had not listed when the order was answered. */
const FILL_RECORD_EVERY_MS = 3_000;
const FILL_RECORD_TRIES = 15;
/** How far back the fill history is read before an order. Matches what the wait for a fill reads after it. */
const HISTORY_DEPTH = 20;

const assetOf = (market: PerplMarketInfo): string => `${market.symbol}/USD`;
const sideOf = (position: PerplPosition): OrderSide => (position.sd === 2 ? 'short' : 'long');

function positionView(position: PerplPosition, market: PerplMarketInfo): VenuePositionView {
  return {
    asset: assetOf(market),
    side: sideOf(position),
    size: scaled(position.s, market.sizeDecimals),
    entryPrice: scaled(position.ep, market.priceDecimals),
    leverage: position.lv / 100,
    collateral: scaled(position.c, PERPL_COLLATERAL_DECIMALS),
    notional: {
      atoms: positionCents(position.s, position.ep, market.sizeDecimals, market.priceDecimals).toString(),
      decimals: 2,
    },
    openedAt: position.ots?.t ?? null,
  };
}

export function createVenueService(deps: VenueServiceDeps): VenueService {
  const { network, rest } = deps;
  const limits = deps.limits ?? VENUE_LIMITS;
  const now = deps.now ?? Date.now;
  const sleep = deps.trade?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const publicOpts = { network, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
  const loadMarkets = deps.loadMarkets ?? (() => loadPerplMarkets(publicOpts));
  const readMarkPrice = deps.readMarkPrice ?? ((id: number) => readPerplMarkPrice(publicOpts, id));
  const report = deps.onError ?? (() => {});
  const background = deps.background ?? (() => {});

  let cache: { at: number; markets: PerplMarketInfo[] } | null = null;
  async function markets(): Promise<PerplMarketInfo[]> {
    const at = now();
    if (cache && at - cache.at < MARKETS_TTL_MS && at >= cache.at) return cache.markets;
    const fresh = await loadMarkets();
    cache = { at, markets: fresh };
    return fresh;
  }

  /**
   * Writes to the record that are still on their way. An order is answered once
   * the venue has, not once its row is written: the row is a round trip to the
   * backend that the person at the ticket should not wait on. The next order
   * waits for these instead, so the lock it meets is a true one.
   */
  let recording: Promise<void> = Promise.resolve();

  /** Starts writing what became of an order. Never throws, and is not waited on by the answer. */
  function settle(recorder: VenueRecorder, outcome: OrderOutcomeRecord): void {
    recording = recording
      .then(() => recorder.settle(outcome))
      .catch((err: unknown) => report('venue.settle', err));
    background(recording);
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

  /** A fill's figures as the record and the answer carry them. */
  function figures(fill: VenueFill, market: PerplMarketInfo) {
    return {
      size: scaled(fill.size, market.sizeDecimals),
      price: fill.price === null ? null : scaled(fill.price, market.priceDecimals),
      fee: scaled(fill.fee, PERPL_COLLATERAL_DECIMALS),
      block: fill.block,
      txHash: fill.txHash,
    };
  }

  /**
   * Keeps asking the venue's history for a fill it had not listed when the
   * order was answered, and completes the order's record when it does. The
   * answer has already gone back: nobody waits on this.
   */
  function completeRecordLater(
    recorder: VenueRecorder,
    orderId: string,
    market: PerplMarketInfo,
    findFill: () => Promise<VenueFill | null>,
  ): void {
    const amend = recorder.amend?.bind(recorder);
    if (!amend) return;
    // The row has to say `filled` before figures can be added to it.
    const written = recording;
    background(
      (async () => {
        for (let attempt = 0; attempt < FILL_RECORD_TRIES; attempt++) {
          await sleep(FILL_RECORD_EVERY_MS);
          const fill = await findFill().catch(() => null);
          if (!fill) continue;
          const f = figures(fill, market);
          await written;
          await amend({
            orderId,
            size: f.size,
            fee: f.fee,
            block: f.block,
            ...(f.price ? { fillPrice: f.price } : {}),
            ...(f.txHash ? { txHash: f.txHash } : {}),
          });
          return;
        }
      })().catch((err: unknown) => report('venue.amend', err)),
    );
  }

  /** Starts writing what the venue did with an order to its row, and returns the same thing to the caller. */
  async function record(
    recorder: VenueRecorder,
    orderId: string,
    outcome: MarketOrderOutcome,
    order: {
      market: PerplMarketInfo;
      action: 'open' | 'close';
      side: OrderSide;
      /** The position on the market before the order. Null when there was none. */
      held: PerplPosition | null;
    },
  ): Promise<VenueOrderResult> {
    const { market, side } = order;
    if (outcome.status === 'refused') {
      settle(recorder, { orderId, status: 'refused', side, reason: outcome.reason });
      return { status: 'refused', reason: outcome.reason };
    }
    if (outcome.status === 'unfilled') {
      settle(recorder, { orderId, status: 'unfilled', side, requestId: outcome.requestId });
      return { status: 'unfilled', orderId, message: VENUE_MESSAGES.nothingFilled };
    }
    if (outcome.status === 'pending') {
      const reason = VENUE_MESSAGES.sentUnreported;
      settle(recorder, { orderId, status: 'failed', side, requestId: outcome.requestId, reason });
      return { status: 'pending', orderId, message: reason };
    }

    const filled = { status: 'filled' as const, orderId, asset: assetOf(market), action: order.action, side };
    if (outcome.fill) {
      const f = figures(outcome.fill, market);
      settle(recorder, {
        orderId,
        status: 'filled',
        side,
        requestId: outcome.requestId,
        size: f.size,
        fee: f.fee,
        block: f.block,
        ...(f.price ? { fillPrice: f.price } : {}),
        ...(f.txHash ? { txHash: f.txHash } : {}),
      });
      return { ...filled, ...f };
    }

    // The position moved and the history has not listed the fill yet. What the position itself
    // shows is reported now: how much changed and, for a position that is new, its entry price.
    const before = order.held?.s ?? 0;
    const after = outcome.position?.s ?? 0;
    const size = scaled(Math.abs(after - before), market.sizeDecimals);
    const fresh = order.action === 'open' && !order.held ? outcome.position : null;
    const price = fresh ? scaled(fresh.ep, market.priceDecimals) : null;
    const block = fresh?.ots?.b ?? null;
    settle(recorder, {
      orderId,
      status: 'filled',
      side,
      requestId: outcome.requestId,
      size,
      ...(price ? { fillPrice: price } : {}),
      ...(block !== null ? { block } : {}),
    });
    completeRecordLater(recorder, orderId, market, outcome.findFill);
    return { ...filled, size, price, fee: null, block, txHash: null };
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
    settle(recorder, { orderId, status: 'failed', reason });
    return sent
      ? { status: 'pending', orderId, message: VENUE_MESSAGES.sentUnread }
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

  /** Runs one order and says where its time went. */
  async function timed(
    action: 'open' | 'close',
    asset: string,
    run: (mark: (phase: 'begin' | 'read') => void) => Promise<VenueOrderResult>,
  ): Promise<VenueOrderResult> {
    const started = now();
    const at: { begin?: number; read?: number } = {};
    const result = await run((phase) => void (at[phase] = now()));
    if (deps.onTiming && at.begin !== undefined) {
      const ended = now();
      const read = at.read ?? at.begin;
      deps.onTiming({
        action,
        asset,
        status: result.status,
        beginMs: at.begin - started,
        readMs: read - at.begin,
        settleMs: ended - read,
        totalMs: ended - started,
      });
    }
    return result;
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
            return market ? [positionView(p, market)] : [];
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

      return timed('open', assetOf(market), async (mark) => {
        await recording;
        const begun = await recorder.begin({
          network,
          asset: assetOf(market),
          action: 'open',
          side: request.side,
          notionalUsd: request.usd,
          leverage: request.leverage,
        });
        mark('begin');
        if (!begun.ok) return notBegun(begun);
        const { orderId } = begun;
        const refuse = async (reason: string): Promise<VenueOrderResult> => {
          settle(recorder, { orderId, status: 'refused', reason });
          return { status: 'refused', reason };
        };

        const venue = tracked();
        try {
          // Read together: three round trips that do not wait on each other.
          const [state, markPrice, history] = await Promise.all([
            readPerplAccount(rest),
            readMarkPrice(market.id),
            rest.fills(HISTORY_DEPTH),
          ]);
          mark('read');
          if (!state) return await refuse(VENUE_MESSAGES.noAccount);
          if (state.account.fr) return await refuse('The trading account is frozen.');
          if (!state.account.fw) return await refuse('One-click trading is off for the trading account.');

          const held = state.positions.find((p) => p.mkt === market.id) ?? null;
          const room = checkAgainstPosition(
            request,
            market.symbol,
            held && {
              side: sideOf(held),
              cents: positionCents(held.s, held.ep, market.sizeDecimals, market.priceDecimals),
              leverage: held.lv,
            },
            limits,
          );
          if (!room.ok) return await refuse(room.reason);
          const margin = checkMargin(state.account.b, state.account.lb, request.usd, request.leverage);
          if (!margin.ok) return await refuse(margin.reason);

          const size = sizeForNotional({
            usdNotional: request.usd,
            scaledPrice: markPrice,
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
            held,
            history,
          });
          return await record(recorder, orderId, outcome, { market, action: 'open', side: request.side, held });
        } catch (err) {
          return await failed(recorder, orderId, venue.sent(), 'venue.placeOrder', err);
        }
      });
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

      return timed('close', assetOf(market), async (mark) => {
        await recording;
        const begun = await recorder.begin({ network, asset: assetOf(market), action: 'close' });
        mark('begin');
        if (!begun.ok) return notBegun(begun);
        const { orderId } = begun;
        const refuse = async (reason: string): Promise<VenueOrderResult> => {
          settle(recorder, { orderId, status: 'refused', reason });
          return { status: 'refused', reason };
        };

        const venue = tracked();
        try {
          const [state, history] = await Promise.all([readPerplAccount(rest), rest.fills(HISTORY_DEPTH)]);
          mark('read');
          if (!state) return await refuse(VENUE_MESSAGES.noAccount);
          const position = state.positions.find((p) => p.mkt === market.id);
          if (!position) return await refuse(`The account holds no ${market.symbol} position.`);
          if (state.account.fr) return await refuse('The trading account is frozen.');
          if (!state.account.fw) return await refuse('One-click trading is off for the trading account.');

          const outcome = await closeAtMarket(venue.deps, {
            account: state.account,
            position,
            slippageBps: limits.slippageBps,
            history,
          });
          return await record(recorder, orderId, outcome, {
            market,
            action: 'close',
            side: sideOf(position),
            held: position,
          });
        } catch (err) {
          return await failed(recorder, orderId, venue.sent(), 'venue.closePosition', err);
        }
      });
    },
  };
}
