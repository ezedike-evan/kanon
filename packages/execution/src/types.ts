/**
 * Venue-agnostic execution layer.
 *
 * docs/ARCHITECTURE.md: "Perpl for perps, Kuru for spot... Latency:
 * verification adds a block or two. SMC swing trading tolerates this easily.
 * Do not design for high frequency." Nothing here assumes sub-block latency.
 *
 * `ExecutionClient` is the one seam every venue integration (`PerplClient`,
 * `KuruClient`, `PaperExecutionClient`) implements identically, so the rest
 * of the app — the advanced-order watcher in `orders.ts`, and eventually the
 * UI — never branches on which venue it is talking to.
 *
 * Prices and sizes are `Decimal` (packages/spec/src/decimal.ts): integer
 * atoms with an explicit decimal count. Never a float, never a `number`,
 * because the contract and the UI must agree with execution at the last
 * digit.
 */

import type { Decimal } from '@kanon/spec';
import type { PriceTick } from '@kanon/spec';

/** Which venue produced or will consume an order. Used for logging and for
 * routing a spec's trades to the right client — perps vs. spot per
 * docs/ARCHITECTURE.md, never decided inside the contract. */
export type Venue = 'perpl' | 'kuru' | 'paper';

export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'market' | 'limit';

/**
 * A plain order. This is the thing `ExecutionClient.placeOrder` accepts —
 * deliberately not the advanced-order types in `orders.ts` (stop-loss,
 * TWAP, ...), which are a layer *above* this one and eventually resolve to
 * one or more of these.
 */
export interface Order {
  /** Caller-assigned idempotency key. Venues that support one get it as a
   * client order id; venues that don't (see PerplClient) get it echoed back
   * only in-process. */
  clientOrderId: string;
  asset: string;
  side: OrderSide;
  kind: OrderKind;
  size: Decimal;
  /** Required for `kind: 'limit'`, absent for `kind: 'market'`. */
  price?: Decimal | undefined;
  /** Close-only. Venues that don't support it natively should reject rather
   * than silently ignore it — a reduce-only order that opens a position is
   * exactly the kind of silent behaviour change this product exists to
   * refuse elsewhere in the stack. */
  reduceOnly?: boolean | undefined;
  /** Whole-number leverage multiple for perps (1 = 1x). Ignored by spot.
   * Comes from the approved trade / spec risk parameters, never chosen by a
   * venue client. Absent means the client's configured default. */
  leverageX?: number | undefined;
  /** Maximum slippage for `kind: 'market'`, in basis points. Absent means
   * the client's configured default (surfaced in its options, not hidden). */
  maxSlippageBps?: number | undefined;
}

/**
 * A venue-native protective order: a stop-loss or take-profit that the
 * *venue* holds and triggers, so the protection survives this process dying.
 * Only clients that implement `NativeTriggerCapable` accept these; for every
 * other venue the protection lives in the client-side `AdvancedOrderWatcher`
 * (orders.ts), which is weaker and is labelled as such in the evidence.
 */
export interface TriggerOrder {
  clientOrderId: string;
  asset: string;
  kind: 'stop_loss' | 'take_profit';
  /** Direction of the position being protected. The order that fires closes it. */
  direction: 'long' | 'short';
  size: Decimal;
  triggerPrice: Decimal;
  /** Client id of the entry order this protection hangs off. When the venue
   * can link requests, protection activates only if that entry trades and is
   * cancelled if it fails. */
  linkedToClientOrderId?: string | undefined;
  leverageX?: number | undefined;
  maxSlippageBps?: number | undefined;
}

export type OrderStatus = 'filled' | 'rejected' | 'pending';

/**
 * The result of placing (or the terminal state of) an order. `status:
 * 'pending'` means the venue accepted it for forwarding but has not yet
 * reported a fill or rejection — see PerplClient's `mt: 3` vs. `mt: 24`
 * distinction. Callers that need the eventual outcome of a pending order
 * must watch fills via `subscribeMarketData` or a venue-specific fills
 * stream; this layer does not promise to resolve that for you.
 */
export interface OrderResult {
  venue: Venue;
  clientOrderId: string;
  /** The venue's own identifier for the order, once it has assigned one.
   * `| undefined` (not just `?`) because callers assign this straight from
   * things like `array[0]` under `noUncheckedIndexedAccess`, and this
   * package's `exactOptionalPropertyTypes` treats "optional" and
   * "optional-or-explicitly-undefined" as different types. */
  venueOrderId?: string | undefined;
  status: OrderStatus;
  filledSize?: Decimal | undefined;
  avgFillPrice?: Decimal | undefined;
  /** Present when `status: 'rejected'`. */
  reason?: string | undefined;
  timestamp: number;
}

export interface CancelResult {
  clientOrderId: string;
  venueOrderId?: string | undefined;
  cancelled: boolean;
  reason?: string | undefined;
}

/** Signed by convention: positive size is long/held-base, negative is
 * short. Venues that only ever go long (spot) never return a negative. */
export interface Position {
  venue: Venue;
  asset: string;
  size: Decimal;
  /** Absent when the venue does not report a cost basis (spot balances) and
   * this client has not recorded its own fills. Never fabricated as zero. */
  entryPrice?: Decimal | undefined;
}

/** Returned by `subscribeMarketData`; call it to stop receiving ticks. */
export type Unsubscribe = () => void;

export interface ExecutionClient {
  readonly venue: Venue;
  placeOrder(order: Order): Promise<OrderResult>;
  cancelOrder(clientOrderId: string): Promise<CancelResult>;
  getPosition(asset: string): Promise<Position | null>;
  /** Streams best-effort price ticks for `asset`. Backed by a venue
   * WebSocket for real clients, by `pushTick` for `PaperExecutionClient`. */
  subscribeMarketData(asset: string, onTick: (tick: PriceTick) => void): Unsubscribe;
}

/** Implemented by venues that hold stop-loss / take-profit orders themselves. */
export interface NativeTriggerCapable {
  readonly supportsNativeTriggers: true;
  placeTriggerOrder(order: TriggerOrder): Promise<OrderResult>;
}

export function isNativeTriggerCapable(client: ExecutionClient): client is ExecutionClient & NativeTriggerCapable {
  return (client as Partial<NativeTriggerCapable>).supportsNativeTriggers === true;
}
