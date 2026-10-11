/**
 * Predict, as a timed trade.
 *
 * The market is not a price, it is a time. Somebody says a pair will go up, or
 * down, over the next minute (or five, fifteen, sixty). That is a position:
 * up is a long, down is a short, opened at market now and closed at market
 * when the time is up. The server does the closing. Nothing here is a bet
 * against another person and nothing is settled by anybody's opinion: the
 * result is the venue's own entry fill and exit fill.
 *
 * This file is the pure half: what may be asked for, the arithmetic of a
 * result, and the shapes the service answers with. No network, no clock.
 * `timed-runner.ts` runs the trades.
 *
 * Like every order placed by the server, a timed trade goes to ONE shared
 * exchange account, on testnet. A market holds one position per account, so a
 * market takes one timed trade at a time, and none while it holds a position
 * opened from the chart's ticket.
 */

import type { Decimal } from '@kanon/spec';
import { COLLATERAL_DECIMALS, type Check, type MarketFacts, type OrderSide } from './venue-policy';

/**
 * Every limit a timed trade is held to. Returned to the client with the state,
 * so the screen shows the numbers the server enforces and none is hidden.
 */
export const TIMED_LIMITS = {
  /** Whole dollars. The stake is the trade's collateral: the most it can lose. */
  stakesUsd: [10, 25, 50, 100],
  /** Seconds a trade may run before the server closes it. */
  durations: [60, 300, 900, 3600],
  /** Whole multiple. A market that opens lower uses its own. The trade's size is stake times this. */
  maxLeverage: 5,
  /** The furthest the opening or closing order may fill from the mark price. */
  slippageBps: 100,
} as const;

export interface TimedLimits {
  stakesUsd: readonly number[];
  durations: readonly number[];
  maxLeverage: number;
  slippageBps: number;
}

export type Direction = 'up' | 'down';

export interface TimedRequest {
  asset: string;
  direction: Direction;
  /** Whole dollars, one of `limits.stakesUsd`. */
  stakeUsd: number;
  /** One of `limits.durations`. */
  seconds: number;
}

/** Up is a long, down is a short. */
export const sideOf = (direction: Direction): OrderSide => (direction === 'up' ? 'long' : 'short');
export const directionOf = (side: OrderSide): Direction => (side === 'long' ? 'up' : 'down');

/** The whole leverage a timed trade on a market uses: the lower of ours and the venue's. `market.maxLeverage` is in hundredths. */
export function timedLeverage(market: MarketFacts, limits: TimedLimits = TIMED_LIMITS): number {
  return Math.max(1, Math.min(limits.maxLeverage, Math.floor(market.maxLeverage / 100)));
}

const listed = (values: readonly number[], unit: (n: number) => string): string => values.map(unit).join(', ');

/** `60` is `1m`, `3600` is `1h`. */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Whether a request is one this server runs. The reason is written for the
 * person who asked: it states what is on offer, it does not apologise.
 */
export function checkTimedRequest(
  req: TimedRequest,
  market: MarketFacts | null,
  limits: TimedLimits = TIMED_LIMITS,
): Check {
  if (!market) return { ok: false, reason: `Perpl lists no market for ${req.asset}.` };
  if (!market.open) return { ok: false, reason: `The ${market.symbol} market is closed.` };
  if (req.direction !== 'up' && req.direction !== 'down') return { ok: false, reason: 'A trade goes up or down.' };
  if (!limits.stakesUsd.includes(req.stakeUsd)) {
    return { ok: false, reason: `A stake here is one of ${listed(limits.stakesUsd, (n) => `$${n}`)}.` };
  }
  if (!limits.durations.includes(req.seconds)) {
    return { ok: false, reason: `A trade here runs for one of ${listed(limits.durations, durationLabel)}.` };
  }
  return { ok: true };
}

/**
 * What a trade made or lost between two prices, in collateral atoms, before
 * fees: the price change times the size, for a long, and the reverse for a
 * short. All three inputs are the venue's scaled integers; the division is
 * rounded toward zero.
 */
export function moveAtoms(args: {
  direction: Direction;
  /** Scaled by `sizeDecimals`. */
  size: number;
  /** Scaled by `priceDecimals`. */
  fromPrice: number;
  toPrice: number;
  sizeDecimals: number;
  priceDecimals: number;
}): bigint {
  const diff = BigInt(args.toPrice) - BigInt(args.fromPrice);
  const signed = args.direction === 'up' ? diff : -diff;
  return (signed * BigInt(args.size) * 10n ** BigInt(COLLATERAL_DECIMALS)) / 10n ** BigInt(args.sizeDecimals + args.priceDecimals);
}

/**
 * Whether a trade has lost its stake at the mark price. The server then closes
 * it without waiting for its time: a trade never loses more than was put on it.
 */
export function lossReachesStake(args: {
  direction: Direction;
  size: number;
  entryPrice: number;
  markPrice: number;
  sizeDecimals: number;
  priceDecimals: number;
  stakeUsd: number;
}): boolean {
  const moved = moveAtoms({ ...args, fromPrice: args.entryPrice, toPrice: args.markPrice });
  return moved <= -(BigInt(args.stakeUsd) * 10n ** BigInt(COLLATERAL_DECIMALS));
}

// ---------------------------------------------------------------------------
// What the service answers with
// ---------------------------------------------------------------------------

export interface TimedMarketView {
  /** `BTC/USD`. */
  asset: string;
  open: boolean;
  /** The whole multiple a trade on this market uses. Its size is the stake times this. */
  leverage: number;
  /**
   * Null when a trade can be opened. Otherwise the shared account already holds
   * a position here. `until` is when the timed trade holding it ends
   * (milliseconds), or null when the position was not opened as a timed trade.
   */
  busy: { until: number | null } | null;
}

export type TimedStateView =
  /** Trading is not connected, the caller is not signed in, or the venue could not be read. */
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      venue: 'perpl';
      network: 'testnet' | 'mainnet';
      limits: TimedLimits;
      markets: TimedMarketView[];
    };

/** A trade that is running. The caller's own trades, past and running, are a backend query (`timedTrades:listMine`). */
export interface TimedTradeView {
  id: string;
  asset: string;
  direction: Direction;
  stakeUsd: number;
  leverage: number;
  seconds: number;
  /** Milliseconds. The trade runs from its entry fill; the server closes it at `expiresAt`. */
  openedAt: number;
  expiresAt: number;
  size: Decimal;
  /** The entry fill's price. */
  entryPrice: Decimal;
}

export type TimedOpenResult =
  | { status: 'opened'; trade: TimedTradeView }
  /** The limits, the market or the venue said no. Nothing was opened. */
  | { status: 'refused'; reason: string }
  /** Another order is on its way to the same account. */
  | { status: 'busy'; message: string }
  /** The venue forwarded the order and nothing filled. */
  | { status: 'unfilled'; message: string }
  /** The order was sent and the venue has not said what became of it. It may still fill. */
  | { status: 'pending'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'rate_limited'; retryAfterMs: number; message: string };

/** Asking to end one's own trade before its time. The result arrives on the trade's row. */
export type TimedCloseResult =
  | { status: 'closing'; tradeId: string }
  | { status: 'refused'; reason: string }
  | { status: 'unavailable'; message: string };

/** Why a trade ended. */
export type TimedEnd =
  /** Its time was up. */
  | 'time'
  /** It had lost its stake at the mark price. */
  | 'cut'
  /** Its owner ended it early. */
  | 'owner'
  /** The position was gone when the server looked: closed from the chart's ticket, or liquidated by the venue. */
  | 'venue';
