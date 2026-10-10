import type { Decimal } from '@kanon/spec';

/**
 * The trading venue as the order ticket sees it.
 *
 * The first half mirrors what the servers answer with: the gateway's `/trade`
 * routes (`packages/execution/src/venue-policy.ts` has the shapes) and the
 * backend's `venueData.listMyOrders`. It is written out by hand because this
 * package imports neither. The second half is what the data source hands a
 * screen.
 *
 * Every order goes to ONE exchange account, shared by everyone signed in, on
 * testnet. Nothing here is the viewer's own funds, and nothing here is a profit
 * or a loss: the server computes none and the ticket shows none.
 */

export type VenueSide = 'long' | 'short';
export type VenueNetwork = 'testnet' | 'mainnet';

// --- What the server answers with ---------------------------------------------

/** Every limit an order is held to. The ticket shows these; it never hard-codes one. */
export interface VenueLimits {
  /** Whole dollars of notional, both ends included. */
  minNotionalUsd: number;
  maxNotionalUsd: number;
  /** Whole multiples. A market that opens lower caps it further. */
  maxLeverage: number;
  /** The furthest a market order may fill from the mark price. */
  slippageBps: number;
  /** Whole dollars. The most a position on one market may reach, at its entry price, through orders that add to it. */
  maxPositionUsd: number;
}

export interface VenuePositionView {
  /** `BTC/USD`. */
  asset: string;
  side: VenueSide;
  size: Decimal;
  entryPrice: Decimal;
  /** A multiple: 2 is 2x. */
  leverage: number;
  /** AUSD, six decimals. */
  collateral: Decimal;
  /**
   * Size times entry price, in dollars to two places. What `maxPositionUsd` is
   * measured against. It is the position at the price it was entered at, not at
   * the market's price now, so it says nothing about how the position is doing.
   */
  notional: Decimal;
  /** Milliseconds, or null when the venue did not say. */
  openedAt: number | null;
}

export interface VenueMarketView {
  asset: string;
  /** The highest whole leverage an order may ask for on it. */
  maxLeverage: number;
  open: boolean;
}

export type VenueAccountView =
  /** Trading is not connected, nobody is signed in, or the venue could not be read. */
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      venue: 'perpl';
      network: VenueNetwork;
      /** The one account every order goes to. */
      wallet: string;
      accountId: number;
      /** AUSD, six decimals. */
      balance: Decimal;
      /** False while the account is frozen or has order forwarding off. */
      canTrade: boolean;
      limits: VenueLimits;
      markets: VenueMarketView[];
      positions: VenuePositionView[];
    };

export interface VenueOrderRequest {
  asset: string;
  side: VenueSide;
  /** Whole dollars of notional. */
  usd: number;
  /** Whole multiple. */
  leverage: number;
}

export type VenueOrderResult =
  | {
      status: 'filled';
      orderId: string;
      asset: string;
      action: 'open' | 'close';
      side: VenueSide;
      size: Decimal;
      /**
       * The fill's own figures, from the venue's history. The position moves
       * first and the history follows seconds later, so any of these is null in
       * an answer that came back before the history listed the fill. The order's
       * row (`VenueOrderRow`, same id) gains them when it does.
       */
      price: Decimal | null;
      /** AUSD. Negative atoms are a rebate. */
      fee: Decimal | null;
      block: number | null;
      /** The settling transaction: the evidence for this fill. */
      txHash: string | null;
    }
  /** The venue took the order and nothing filled. Nothing is left resting. */
  | { status: 'unfilled'; orderId: string; message: string }
  /** The order was sent and the venue has not said what became of it. It may still fill. */
  | { status: 'pending'; orderId: string; message: string }
  /** The server's limits or the venue said no. Nothing was opened. Not a fault. */
  | { status: 'refused'; reason: string }
  /** Another order is on its way to the same account. */
  | { status: 'busy'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'rate_limited'; retryAfterMs: number; message: string };

export type VenueOrderStatus = 'submitting' | 'filled' | 'unfilled' | 'refused' | 'failed';

/** One row of `venueData.listMyOrders`. Optional fields are absent, not null. */
export interface VenueOrderRow {
  _id: string;
  _creationTime: number;
  venue: 'perpl';
  network: VenueNetwork;
  asset: string;
  action: 'open' | 'close';
  side?: VenueSide;
  status: VenueOrderStatus;
  createdAt: number;
  settledAt?: number;
  notionalUsd?: number;
  leverage?: number;
  requestId?: number;
  size?: Decimal;
  fillPrice?: Decimal;
  fee?: Decimal;
  block?: number;
  txHash?: string;
  reason?: string;
}

// --- What a screen is handed --------------------------------------------------

/** `loading` until the first read answers. After that it is whatever the server last said. */
export type VenueAccountState = { status: 'loading' } | VenueAccountView;

/**
 * The trading account, which is an action and not a subscription: it is read
 * when a ticket mounts, after every order, on `refresh()` and on a slow interval
 * while a ticket is mounted. Never per render.
 */
export interface VenueAccountRead {
  state: VenueAccountState;
  /** A read is on its way. The last answer stays in `state` until it lands. */
  refreshing: boolean;
  /** Reads the account again. Does nothing while nobody is signed in. */
  refresh(): void;
}

/**
 * What is on its way to the venue: an order on one side (an open, or an add to
 * the position held on that side), or the close of one market's position. Null
 * when nothing is. A close names its market, since one can be sent for a
 * market that is not the one on the chart.
 */
export type TicketSending = { action: 'open'; side: VenueSide } | { action: 'close'; asset: string } | null;

/** A row of the caller's own orders, with every absent field made null. */
export interface VenueOrder {
  id: string;
  network: VenueNetwork;
  asset: string;
  action: 'open' | 'close';
  /** Null on a close that was refused before the position was read. */
  side: VenueSide | null;
  status: VenueOrderStatus;
  /** Milliseconds. */
  createdAt: number;
  settledAt: number | null;
  notionalUsd: number | null;
  leverage: number | null;
  requestId: number | null;
  size: Decimal | null;
  fillPrice: Decimal | null;
  fee: Decimal | null;
  block: number | null;
  txHash: string | null;
  reason: string | null;
}

/** Signed out it is `empty`: an order list is never filled with made-up fills. */
export type VenueOrdersState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; orders: VenueOrder[] };
