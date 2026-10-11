import type { Decimal } from '@kanon/spec';

/**
 * Predict, as a timed trade, as the screen sees it.
 *
 * The market is not a price, it is a time: UP is a long, DOWN is a short,
 * opened at market now and closed at market by the server when the time is up.
 *
 * The first half mirrors what the servers answer with: the gateway's `/predict`
 * routes (`packages/execution/src/timed-policy.ts` has the shapes) and the
 * backend's `timedData.listMine`. It is written out by hand because this
 * package imports neither. The second half is what the data source hands a
 * screen.
 *
 * Like every order the server places, a timed trade goes to ONE exchange
 * account, shared by everyone signed in, on testnet. Nothing here is the
 * viewer's own funds. A market holds one position per account, so a market
 * takes one timed trade at a time.
 */

export type TimedDirection = 'up' | 'down';
export type TimedNetwork = 'testnet' | 'mainnet';

// --- What the server answers with ---------------------------------------------

/** Every limit a timed trade is held to. The screen shows these; it never hard-codes one. */
export interface TimedLimits {
  /** Whole dollars. The stake is the trade's collateral: the most it can lose. */
  stakesUsd: number[];
  /** Seconds a trade may run before the server closes it. */
  durations: number[];
  /** Whole multiple. A market that opens lower uses its own. */
  maxLeverage: number;
  /** The furthest the opening or closing order may fill from the mark price. */
  slippageBps: number;
}

export interface TimedMarketView {
  /** `BTC/USD`. */
  asset: string;
  open: boolean;
  /** The whole multiple a trade on this market uses. Its size is the stake times this. */
  leverage: number;
  /**
   * Null when a trade can be opened. Otherwise the shared account already holds
   * a position here. `until` is when the timed trade holding it ends
   * (milliseconds), or null when the position came from the chart's ticket.
   */
  busy: { until: number | null } | null;
}

export type TimedStateView =
  /** Trading is not connected, nobody is signed in, or the venue could not be read. */
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      venue: 'perpl';
      network: TimedNetwork;
      limits: TimedLimits;
      markets: TimedMarketView[];
    };

export interface TimedRequest {
  asset: string;
  direction: TimedDirection;
  /** Whole dollars, one of `limits.stakesUsd`. */
  stakeUsd: number;
  /** One of `limits.durations`. */
  seconds: number;
}

/** A trade that has just been opened, as the answer to the request states it. */
export interface TimedTradeView {
  id: string;
  asset: string;
  direction: TimedDirection;
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
  /** The limits, the market or the venue said no. Nothing was opened. Not a fault. */
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

export type TimedTradeStatus = 'live' | 'closing' | 'closed';

/** One row of `timedData.listMine`. Optional fields are absent, not null. */
export interface TimedTradeRow {
  _id: string;
  _creationTime: number;
  network: TimedNetwork;
  asset: string;
  direction: TimedDirection;
  stakeUsd: number;
  leverage: number;
  seconds: number;
  status: TimedTradeStatus;
  /** Milliseconds. */
  openedAt: number;
  expiresAt: number;
  closedAt?: number;
  endedBy?: TimedEnd;
  size: Decimal;
  entryPrice: Decimal;
  /** Arrives a few seconds after `status` becomes `closed`. */
  exitPrice?: Decimal;
  /** AUSD, six decimals, signed, net of fees. Arrives with `exitPrice`. */
  result?: Decimal;
  fees?: Decimal;
  /** Transaction hashes: the evidence. */
  openTx?: string;
  closeTx?: string;
  /** Why closing is delayed, in the server's words. */
  reason?: string;
}

// --- What a screen is handed --------------------------------------------------

/** `loading` until the first read answers. After that it is whatever the server last said. */
export type TimedState = { status: 'loading' } | TimedStateView;

/**
 * What can be traded and whether each market is free. It is a request, not a
 * subscription: read when the screen mounts, after every open or close, on
 * `refresh()` and on a slow interval while the screen is mounted. Never per
 * render.
 */
export interface TimedStateRead {
  state: TimedState;
  /** A read is on its way. The last answer stays in `state` until it lands. */
  refreshing: boolean;
  /** Reads the state again. Does nothing while nobody is signed in. */
  refresh(): void;
}

/** A row of the caller's own trades, with every absent field made null. */
export interface TimedTrade {
  id: string;
  network: TimedNetwork;
  asset: string;
  direction: TimedDirection;
  stakeUsd: number;
  leverage: number;
  seconds: number;
  status: TimedTradeStatus;
  /** Milliseconds. */
  openedAt: number;
  expiresAt: number;
  closedAt: number | null;
  endedBy: TimedEnd | null;
  size: Decimal;
  entryPrice: Decimal;
  exitPrice: Decimal | null;
  result: Decimal | null;
  fees: Decimal | null;
  openTx: string | null;
  closeTx: string | null;
  reason: string | null;
}

/** Signed out it is `empty`: a trade list is never filled with made-up trades. */
export type TimedTradesState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; trades: TimedTrade[] };

/**
 * What is on its way to the server: a trade being opened, or a request to end
 * one early. Null when nothing is. One thing goes out at a time, since every
 * trade is on the same account.
 */
export type TimedSending =
  | { action: 'open'; asset: string; direction: TimedDirection; stakeUsd: number; seconds: number }
  | { action: 'close'; tradeId: string }
  | null;
