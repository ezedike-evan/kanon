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
      /** Null when the venue reported the fill without a price. */
      price: Decimal | null;
      /** AUSD. Negative atoms are a rebate. */
      fee: Decimal;
      block: number;
      /** The settling transaction: the evidence for this fill. */
      txHash: string | null;
    }
  /** The venue took the order and nothing filled. Nothing is left resting. */
  | { status: 'unfilled'; orderId: string; message: string }
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

/** What is on its way to the venue: an open on one side, or a close. Null when nothing is. */
export type TicketSending = { action: 'open'; side: VenueSide } | { action: 'close' } | null;

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
