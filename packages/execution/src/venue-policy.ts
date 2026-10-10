/**
 * What the server decides about an order before it reaches the venue, and the
 * shapes it answers with. Pure: no network, no clock. `venue-service.ts` makes
 * the calls; this file says yes or no and why.
 *
 * Orders placed through the service all go to ONE exchange account: the one
 * the server's API key belongs to. Every signed-in user trades that same
 * account. That is why the limits below are small, why one order goes out at a
 * time, and why none of this is custody of anybody's funds.
 */

import type { Decimal } from '@kanon/spec';

/**
 * Every limit applied to an order. Returned to the client with the account, so
 * the ticket shows the same numbers the server enforces and none of them is
 * hidden.
 */
export const VENUE_LIMITS = {
  /** Whole dollars of notional, both ends included. */
  minNotionalUsd: 10,
  maxNotionalUsd: 100,
  /** Whole multiples. A market that opens lower caps it further. */
  maxLeverage: 5,
  /** The furthest a market order may fill from the mark price. */
  slippageBps: 100,
} as const;

export interface VenueLimits {
  minNotionalUsd: number;
  maxNotionalUsd: number;
  maxLeverage: number;
  slippageBps: number;
}

/** Perpl's collateral, AUSD, has six decimals. */
export const COLLATERAL_DECIMALS = 6;

export type OrderSide = 'long' | 'short';

export interface OrderRequest {
  asset: string;
  side: OrderSide;
  /** Whole dollars of notional. */
  usd: number;
  /** Whole multiple. */
  leverage: number;
}

/** As much of a venue market as the checks read. `maxLeverage` is in hundredths. */
export interface MarketFacts {
  symbol: string;
  maxLeverage: number;
  open: boolean;
}

export type Check = { ok: true } | { ok: false; reason: string };

/** The highest whole leverage an order may ask for on a market: the lower of ours and the venue's. */
export function leverageCeiling(market: MarketFacts, limits: VenueLimits = VENUE_LIMITS): number {
  return Math.max(1, Math.min(limits.maxLeverage, Math.floor(market.maxLeverage / 100)));
}

/**
 * Whether a request is one this server sends. The reason is written for the
 * person who asked: it states the bound, it does not apologise.
 */
export function checkOrderRequest(
  req: OrderRequest,
  market: MarketFacts | null,
  limits: VenueLimits = VENUE_LIMITS,
): Check {
  if (!market) return { ok: false, reason: `Perpl lists no market for ${req.asset}.` };
  if (!market.open) return { ok: false, reason: `The ${market.symbol} market is closed.` };
  if (!Number.isInteger(req.usd) || req.usd < limits.minNotionalUsd || req.usd > limits.maxNotionalUsd) {
    return {
      ok: false,
      reason: `An order here is $${limits.minNotionalUsd} to $${limits.maxNotionalUsd}, in whole dollars.`,
    };
  }
  const ceiling = leverageCeiling(market, limits);
  if (!Number.isInteger(req.leverage) || req.leverage < 1 || req.leverage > ceiling) {
    return { ok: false, reason: `Leverage on ${market.symbol} here is 1x to ${ceiling}x, in whole steps.` };
  }
  return { ok: true };
}

/** The collateral an order ties up: notional over leverage, in collateral atoms, rounded up. */
export function marginAtoms(usd: number, leverage: number): bigint {
  const scale = 10n ** BigInt(COLLATERAL_DECIMALS);
  return (BigInt(usd) * scale + BigInt(leverage) - 1n) / BigInt(leverage);
}

/** Collateral atoms as a two-place figure, rounded down: `12.43`. */
export function formatCollateral(atoms: bigint): string {
  const negative = atoms < 0n;
  const cents = (negative ? -atoms : atoms) / 10n ** BigInt(COLLATERAL_DECIMALS - 2);
  return `${negative ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/**
 * Whether the account's free balance covers the order's margin. The venue
 * would refuse it too; this says so in plain words and before anything is sent.
 */
export function checkMargin(balanceAtoms: string, lockedAtoms: string | undefined, usd: number, leverage: number): Check {
  let free: bigint;
  try {
    free = BigInt(balanceAtoms) - BigInt(lockedAtoms ?? '0');
  } catch {
    return { ok: false, reason: "The trading account's balance could not be read." };
  }
  const need = marginAtoms(usd, leverage);
  if (free >= need) return { ok: true };
  return {
    ok: false,
    reason: `The trading account has ${formatCollateral(free)} AUSD free. This order needs ${formatCollateral(need)}.`,
  };
}

/** A venue integer and its scale as the app's `Decimal`. Never a float. */
export function scaled(value: number | string, decimals: number): Decimal {
  return { atoms: String(value), decimals };
}

// ---------------------------------------------------------------------------
// What the service answers with
// ---------------------------------------------------------------------------

export interface VenuePositionView {
  asset: string;
  side: OrderSide;
  size: Decimal;
  entryPrice: Decimal;
  /** Whole or fractional multiple: 2 is 2x. */
  leverage: number;
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
  /** Trading is not connected, the caller is not signed in, or the venue could not be read. */
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready';
      venue: 'perpl';
      network: 'testnet' | 'mainnet';
      /** The one account every order goes to. */
      wallet: string;
      accountId: number;
      balance: Decimal;
      /** False while the account is frozen or has order forwarding off. */
      canTrade: boolean;
      limits: VenueLimits;
      markets: VenueMarketView[];
      positions: VenuePositionView[];
    };

export type VenueOrderResult =
  | {
      status: 'filled';
      orderId: string;
      asset: string;
      action: 'open' | 'close';
      side: OrderSide;
      size: Decimal;
      /** Null when the venue reported the fill without a price. */
      price: Decimal | null;
      fee: Decimal;
      block: number;
      /** The settling transaction: the evidence for this fill. */
      txHash: string | null;
    }
  /** The venue took the order and nothing filled. Nothing is left resting. */
  | { status: 'unfilled'; orderId: string; message: string }
  /** The server's limits or the venue said no. Nothing was opened. */
  | { status: 'refused'; reason: string }
  /** Another order is on its way to the same account. */
  | { status: 'busy'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'rate_limited'; retryAfterMs: number; message: string };
