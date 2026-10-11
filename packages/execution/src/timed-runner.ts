/**
 * Runs timed trades: opens a position when somebody calls a direction, closes
 * it when its time is up, and ends it early when it has lost its stake or its
 * owner asks. `timed-policy.ts` says what may be asked for and how a result is
 * worked out; this file does the doing, through the same order service the
 * chart's ticket uses (`venue-service.ts`).
 *
 * What it holds in memory is only a copy. The record of every running trade is
 * in the store (the backend), and `resume()` reads it back, so a process that
 * restarts still closes the trades an earlier one opened.
 *
 * The closing order is not sent on anybody's sign-in token: the person may
 * have left by then. The store vouches for it by the trade's own id.
 */

import type { Decimal } from '@kanon/spec';
import { findPerplMarket, type PerplMarketInfo, type PerplNetwork } from './perpl-trade';
import {
  TIMED_LIMITS,
  checkTimedRequest,
  durationLabel,
  lossReachesStake,
  moveAtoms,
  sideOf,
  timedLeverage,
  type Direction,
  type TimedCloseResult,
  type TimedEnd,
  type TimedLimits,
  type TimedOpenResult,
  type TimedRequest,
  type TimedStateView,
  type TimedTradeView,
} from './timed-policy';
import { COLLATERAL_DECIMALS } from './venue-policy';
import type { FillDetailsRecord, VenueRecorder, VenueService } from './venue-service';

export * from './timed-policy';

export const TIMED_MESSAGES = {
  testnetOnly: 'Timed trades run on testnet only for now.',
  notRecorded: 'The trade opened but could not be recorded, so it was closed again.',
  noPrice: 'The order filled but the venue did not report its price, so no timed trade is running. Check the position on the chart.',
  notYours: 'That trade is not one of yours, or it has already ended.',
  unread: 'The venue could not be read. Try again.',
  openFeeMissing: 'The opening fee was not reported. The result leaves it out.',
} as const;

/** A running trade as the store keeps it. */
export interface TimedRecord {
  id: string;
  network: PerplNetwork;
  asset: string;
  direction: Direction;
  stakeUsd: number;
  leverage: number;
  seconds: number;
  /** Milliseconds. */
  openedAt: number;
  expiresAt: number;
  size: Decimal;
  entryPrice: Decimal;
  openFee?: Decimal;
}

/** What is added to a trade's row as it ends. Optional fields are left out, not nulled. */
export interface TimedUpdate {
  tradeId: string;
  status?: 'closing' | 'closed';
  endedBy?: TimedEnd;
  closedAt?: number;
  exitPrice?: Decimal;
  /** Collateral atoms, signed, net of the fees that were reported. */
  result?: Decimal;
  fees?: Decimal;
  openFee?: Decimal;
  openTx?: string;
  closeTx?: string;
  reason?: string;
}

/** The backend, as the runner needs it. */
export interface TimedStore {
  /** Writes the row for a trade that has just opened, for the holder of `token`. Null when it could not be written. */
  start(token: string, trade: Omit<TimedRecord, 'id'> & { openTx?: string }): Promise<string | null>;
  /** The recorder for a trade's closing order, vouched for by the trade's id instead of a sign-in token. */
  closerFor(tradeId: string): VenueRecorder;
  update(update: TimedUpdate): Promise<void>;
  /** Every trade that has not ended. Read when the process starts. */
  running(): Promise<TimedRecord[]>;
  /** Whether the holder of `token` owns this running trade. */
  owns(token: string, tradeId: string): Promise<boolean>;
}

type Timer = ReturnType<typeof setTimeout>;

export interface TimedRunnerDeps {
  network: PerplNetwork;
  service: VenueService;
  /** The recorder for an order placed on a caller's own sign-in token: the opening order. */
  recorderFor(token: string): VenueRecorder;
  store: TimedStore;
  loadMarkets(): Promise<PerplMarketInfo[]>;
  readMarkPrice(marketId: number): Promise<number>;
  limits?: TimedLimits;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often running trades are checked against the mark price. */
  cutCheckMs?: number;
  /** How long to wait before trying again to close a trade the venue would not take. */
  retryMs?: number;
  onError?: (scope: string, err: unknown) => void;
}

export interface TimedRunner {
  /** The markets a trade can be opened on, which are taken, and every limit. */
  state(): Promise<TimedStateView>;
  open(request: TimedRequest, token: string): Promise<TimedOpenResult>;
  /** Ends the caller's own trade before its time. */
  close(tradeId: string, token: string): Promise<TimedCloseResult>;
  /** Picks up the trades an earlier process left running. */
  resume(): Promise<void>;
  /** Stops every timer. Running trades stay in the store for the next process. */
  stop(): void;
}

interface Running extends TimedRecord {
  timer: Timer | null;
  ending: boolean;
}

/** How many times a close the venue would not take is tried again before it is left for the next sweep. */
const CLOSE_TRIES = 8;

const atoms = (d: Decimal): number => Number(d.atoms);

export function createTimedRunner(deps: TimedRunnerDeps): TimedRunner {
  const { network, service, store } = deps;
  const limits = deps.limits ?? TIMED_LIMITS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report = deps.onError ?? (() => {});
  const cutCheckMs = deps.cutCheckMs ?? 5_000;
  const retryMs = deps.retryMs ?? 5_000;

  const running = new Map<string, Running>();
  let watcher: Timer | null = null;
  let stopped = false;

  // The order limits a timed trade's opening order is held to: its size is the stake times the
  // leverage, already checked against `limits` here, so these only have to let that size through.
  const top = Math.max(...limits.stakesUsd) * limits.maxLeverage;
  const orderLimits = {
    minNotionalUsd: 1,
    maxNotionalUsd: top,
    maxLeverage: limits.maxLeverage,
    slippageBps: limits.slippageBps,
    maxPositionUsd: top,
  };

  const write = (update: TimedUpdate): Promise<void> =>
    store.update(update).catch((err: unknown) => report('timed.update', err));

  function track(record: TimedRecord): Running {
    const trade: Running = { ...record, timer: null, ending: false };
    running.set(trade.id, trade);
    trade.timer = setTimer(() => void end(trade, 'time'), Math.max(0, trade.expiresAt - now()));
    watch();
    return trade;
  }

  function forget(trade: Running): void {
    if (trade.timer) clearTimer(trade.timer);
    trade.timer = null;
    running.delete(trade.id);
  }

  /** Checks every running trade against the mark price, and ends one that has lost its stake. */
  async function checkCuts(): Promise<void> {
    if (running.size === 0) return;
    let markets: PerplMarketInfo[];
    try {
      markets = await deps.loadMarkets();
    } catch (err) {
      report('timed.cut: the market list could not be read', err);
      return;
    }
    for (const trade of [...running.values()]) {
      if (trade.ending) continue;
      const market = findPerplMarket(markets, trade.asset);
      if (!market) continue;
      try {
        const mark = await deps.readMarkPrice(market.id);
        const lost = lossReachesStake({
          direction: trade.direction,
          size: atoms(trade.size),
          entryPrice: atoms(trade.entryPrice),
          markPrice: mark,
          sizeDecimals: trade.size.decimals,
          priceDecimals: trade.entryPrice.decimals,
          stakeUsd: trade.stakeUsd,
        });
        if (lost) void end(trade, 'cut');
      } catch (err) {
        report(`timed.cut: the ${trade.asset} mark price could not be read`, err);
      }
    }
  }

  function watch(): void {
    if (watcher || stopped) return;
    const tick = (): void => {
      watcher = null;
      void checkCuts().finally(() => {
        if (running.size > 0 && !stopped) watcher = setTimer(tick, cutCheckMs);
      });
    };
    watcher = setTimer(tick, cutCheckMs);
  }

  /** The result of a trade once its exit fill is known: the move, less the fees that were reported. */
  function finalFigures(trade: Running, details: FillDetailsRecord): Partial<TimedUpdate> {
    const out: Partial<TimedUpdate> = {};
    if (details.txHash) out.closeTx = details.txHash;
    const exit = details.fillPrice;
    if (!exit) return out;
    out.exitPrice = exit;
    const moved = moveAtoms({
      direction: trade.direction,
      size: atoms(trade.size),
      fromPrice: atoms(trade.entryPrice),
      toPrice: atoms(exit),
      sizeDecimals: trade.size.decimals,
      priceDecimals: trade.entryPrice.decimals,
    });
    const closeFee = details.fee ? BigInt(details.fee.atoms) : 0n;
    const openFee = trade.openFee ? BigInt(trade.openFee.atoms) : 0n;
    const fees = closeFee + openFee;
    out.result = { atoms: (moved - fees).toString(), decimals: COLLATERAL_DECIMALS };
    if (trade.openFee && details.fee) out.fees = { atoms: fees.toString(), decimals: COLLATERAL_DECIMALS };
    else if (!trade.openFee) out.reason = TIMED_MESSAGES.openFeeMissing;
    return out;
  }

  /**
   * Closes a trade's position and writes how it ended. Tried again when the
   * venue will not take the close just now; a position that is already gone is
   * a trade that ended elsewhere.
   */
  async function end(trade: Running, endedBy: TimedEnd): Promise<void> {
    if (trade.ending || !running.has(trade.id)) return;
    trade.ending = true;
    if (trade.timer) clearTimer(trade.timer);
    trade.timer = null;
    await write({ tradeId: trade.id, status: 'closing' });

    // The closing order's own record is completed by the service when the venue's history lists
    // the fill. The same figures finish the trade.
    const closer = store.closerFor(trade.id);
    let figuresWritten = false;
    const finish = async (details: FillDetailsRecord): Promise<void> => {
      if (figuresWritten) return;
      const figures = finalFigures(trade, details);
      if (!figures.exitPrice && !figures.closeTx) return;
      figuresWritten = figures.exitPrice !== undefined;
      await write({ tradeId: trade.id, ...figures });
    };
    const recorder: VenueRecorder = {
      begin: (order) => closer.begin(order),
      settle: (outcome) => closer.settle(outcome),
      amend: async (details) => {
        await closer.amend?.(details);
        await finish(details);
      },
    };

    for (let attempt = 1; attempt <= CLOSE_TRIES && !stopped; attempt++) {
      let result;
      try {
        result = await service.closePosition(trade.asset, recorder);
      } catch (err) {
        report('timed.close', err);
        result = { status: 'unavailable' as const, message: TIMED_MESSAGES.unread };
      }

      if (result.status === 'filled') {
        await write({ tradeId: trade.id, status: 'closed', endedBy, closedAt: now() });
        await finish({
          orderId: result.orderId,
          ...(result.price ? { fillPrice: result.price } : {}),
          ...(result.fee ? { fee: result.fee } : {}),
          ...(result.txHash ? { txHash: result.txHash } : {}),
        });
        forget(trade);
        return;
      }
      if (result.status === 'refused') {
        // A refusal ends the trade only when there is nothing left to close: the position was
        // closed from the chart's ticket, or the venue liquidated it. That is read, not assumed.
        const account = await service.account().catch(() => null);
        if (account?.status === 'ready' && !account.positions.some((p) => p.asset === trade.asset)) {
          await write({ tradeId: trade.id, status: 'closed', endedBy: 'venue', closedAt: now() });
          forget(trade);
          return;
        }
      }
      // Refused with the position still there, busy, unreachable, sent and unreported, forwarded
      // and unfilled: the position may still be open, so the close is tried again.
      const why = result.status === 'refused' ? result.reason : 'message' in result ? result.message : TIMED_MESSAGES.unread;
      await write({ tradeId: trade.id, reason: why });
      await sleep(result.status === 'busy' ? Math.min(retryMs, 2_000) : retryMs);
    }
    // Left for the next sweep: still in the store as closing, and still in hand here.
    trade.ending = false;
    if (!stopped) trade.timer = setTimer(() => void end(trade, endedBy), retryMs * 6);
  }

  return {
    async state() {
      let markets: PerplMarketInfo[];
      let account;
      try {
        [markets, account] = await Promise.all([deps.loadMarkets(), service.account()]);
      } catch (err) {
        report('timed.state', err);
        return { status: 'unavailable', message: TIMED_MESSAGES.unread };
      }
      if (account.status !== 'ready') return account;
      if (network !== 'testnet') return { status: 'unavailable', message: TIMED_MESSAGES.testnetOnly };
      const held = new Set(account.positions.map((p) => p.asset));
      const until = new Map<string, number>();
      for (const trade of running.values()) until.set(trade.asset, trade.expiresAt);
      return {
        status: 'ready',
        venue: 'perpl',
        network,
        limits: { ...limits, stakesUsd: [...limits.stakesUsd], durations: [...limits.durations] },
        markets: markets.map((m) => {
          const asset = `${m.symbol}/USD`;
          const ends = until.get(asset);
          return {
            asset,
            open: m.open,
            leverage: timedLeverage(m, limits),
            busy: ends !== undefined ? { until: ends } : held.has(asset) ? { until: null } : null,
          };
        }),
      };
    },

    async open(request, token) {
      if (network !== 'testnet') return { status: 'unavailable', message: TIMED_MESSAGES.testnetOnly };
      let market: PerplMarketInfo | null;
      try {
        market = findPerplMarket(await deps.loadMarkets(), request.asset);
      } catch (err) {
        report('timed.open: the market list could not be read', err);
        return { status: 'unavailable', message: TIMED_MESSAGES.unread };
      }
      const checked = checkTimedRequest(request, market, limits);
      if (!checked.ok || !market) return { status: 'refused', reason: checked.ok ? 'No market.' : checked.reason };

      const asset = `${market.symbol}/USD`;
      const taken = [...running.values()].find((t) => t.asset === asset);
      if (taken) {
        const left = Math.max(1, Math.ceil((taken.expiresAt - now()) / 1000));
        return {
          status: 'refused',
          reason: `${market.symbol} is in a timed trade on the shared account. It ends in about ${left} seconds.`,
        };
      }

      const leverage = timedLeverage(market, limits);
      // Captured for the trade once it exists: the opening order's fee can arrive after its answer.
      let opened: Running | null = null;
      let openFee: Decimal | undefined;
      const mine = deps.recorderFor(token);
      const recorder: VenueRecorder = {
        begin: (order) => mine.begin(order),
        settle: (outcome) => mine.settle(outcome),
        amend: async (details) => {
          await mine.amend?.(details);
          if (details.fee) openFee = details.fee;
          if (opened && details.fee) opened.openFee = details.fee;
          if (opened && (details.fee || details.txHash)) {
            await write({
              tradeId: opened.id,
              ...(details.fee ? { openFee: details.fee } : {}),
              ...(details.txHash ? { openTx: details.txHash } : {}),
            });
          }
        },
      };

      const result = await service.placeOrder(
        { asset, side: sideOf(request.direction), usd: request.stakeUsd * leverage, leverage },
        recorder,
        { limits: orderLimits, freshOnly: true },
      );
      if (result.status !== 'filled') return result;
      if (!result.price) return { status: 'pending', message: TIMED_MESSAGES.noPrice };
      if (result.fee) openFee = result.fee;

      const openedAt = now();
      const record: Omit<TimedRecord, 'id'> = {
        network,
        asset,
        direction: request.direction,
        stakeUsd: request.stakeUsd,
        leverage,
        seconds: request.seconds,
        openedAt,
        expiresAt: openedAt + request.seconds * 1000,
        size: result.size,
        entryPrice: result.price,
        ...(openFee ? { openFee } : {}),
      };
      let tradeId: string | null = null;
      try {
        tradeId = await store.start(token, { ...record, ...(result.txHash ? { openTx: result.txHash } : {}) });
      } catch (err) {
        report('timed.start', err);
      }
      if (!tradeId) {
        // A position nobody is timing must not be left open.
        await service.closePosition(asset, deps.recorderFor(token)).catch((err: unknown) => report('timed.unwind', err));
        return { status: 'unavailable', message: TIMED_MESSAGES.notRecorded };
      }
      opened = track({ ...record, id: tradeId });
      if (openFee) opened.openFee = openFee;
      const view: TimedTradeView = {
        id: tradeId,
        asset,
        direction: record.direction,
        stakeUsd: record.stakeUsd,
        leverage,
        seconds: record.seconds,
        openedAt,
        expiresAt: record.expiresAt,
        size: record.size,
        entryPrice: record.entryPrice,
      };
      return { status: 'opened', trade: view };
    },

    async close(tradeId, token) {
      const trade = running.get(tradeId);
      let owns = false;
      try {
        owns = trade !== undefined && (await store.owns(token, tradeId));
      } catch (err) {
        report('timed.owns', err);
        return { status: 'unavailable', message: TIMED_MESSAGES.unread };
      }
      if (!trade || !owns) return { status: 'refused', reason: TIMED_MESSAGES.notYours };
      void end(trade, 'owner');
      return { status: 'closing', tradeId };
    },

    async resume() {
      let records: TimedRecord[];
      try {
        records = await store.running();
      } catch (err) {
        report('timed.resume', err);
        return;
      }
      for (const record of records) {
        if (record.network !== network || running.has(record.id)) continue;
        // A trade whose time passed while nothing was running is closed at once.
        track(record);
      }
    },

    stop() {
      stopped = true;
      if (watcher) clearTimer(watcher);
      watcher = null;
      for (const trade of running.values()) {
        if (trade.timer) clearTimer(trade.timer);
        trade.timer = null;
      }
    },
  };
}

/** `1m`, `1h`: re-exported for a caller that words a duration. */
export { durationLabel };
