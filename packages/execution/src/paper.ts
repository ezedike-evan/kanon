/**
 * `PaperExecutionClient implements ExecutionClient` — the SCOPE.md kill
 * criterion made real: "Execution integration blocking by end of week 5 ->
 * demo on paper trades against live prices, and be explicit about it. The
 * refusal path is what matters."
 *
 * Fills every order instantly at the last known price fed in via
 * `pushTick` (or an order's own limit price). No venue call, ever, from
 * this file. Every fill and rejection is logged with a `[paper]` prefix so
 * nothing here can be mistaken for a live trade downstream — this is the
 * one thing this file must never fail to do.
 *
 * This is the DEFAULT client: no live Perpl or Kuru credentials exist in
 * this environment (see perpl.ts / kuru.ts headers), so anywhere this
 * package's execution layer is wired up in this pass, it is wired to this
 * client, not to `PerplClient` or `KuruClient`.
 */

import type { Decimal, PriceTick } from '@kanon/spec';
import { subDecimal } from '@kanon/spec';
import type {
  CancelResult,
  ExecutionClient,
  Order,
  OrderResult,
  Position,
  Unsubscribe,
} from './types';

export interface PaperExecutionClientOptions {
  /** Seeds the last-known price for one or more assets, so an order can
   * fill before the first `pushTick`. Optional — a market order for an
   * asset with no known price is rejected, not silently filled at zero. */
  initialPrices?: Record<string, Decimal>;
}

export class PaperExecutionClient implements ExecutionClient {
  readonly venue = 'paper' as const;

  private readonly lastPrice = new Map<string, Decimal>();
  private readonly positions = new Map<string, Position>();
  private readonly subscribers = new Map<string, Set<(tick: PriceTick) => void>>();
  private readonly filledOrders = new Map<string, OrderResult>();

  constructor(opts: PaperExecutionClientOptions = {}) {
    for (const [asset, price] of Object.entries(opts.initialPrices ?? {})) {
      this.lastPrice.set(asset, price);
    }
  }

  /**
   * Feeds a new price tick for `asset`: updates the price paper fills use
   * and notifies every `subscribeMarketData` listener for that asset.
   * There is no venue behind this client, so this is the only way it ever
   * learns a price — a caller wires it to the same canonical series (or
   * live oracle feed) a real client would watch, keeping the "against live
   * prices" half of the kill-criteria fallback honest.
   */
  pushTick(asset: string, tick: PriceTick): void {
    this.lastPrice.set(asset, tick.price);
    for (const cb of this.subscribers.get(asset) ?? []) cb(tick);
  }

  /** The price this client would fill `asset` at right now, if any. */
  getLastPrice(asset: string): Decimal | undefined {
    return this.lastPrice.get(asset);
  }

  async placeOrder(order: Order): Promise<OrderResult> {
    const fillPrice = order.kind === 'limit' && order.price ? order.price : this.lastPrice.get(order.asset);

    if (!fillPrice) {
      const result: OrderResult = {
        venue: this.venue,
        clientOrderId: order.clientOrderId,
        status: 'rejected',
        reason: `no known price for "${order.asset}" — call pushTick before placing an order`,
        timestamp: Date.now(),
      };
      this.log(order, result);
      return result;
    }

    this.applyFill(order, fillPrice);
    const result: OrderResult = {
      venue: this.venue,
      clientOrderId: order.clientOrderId,
      venueOrderId: `paper-${order.clientOrderId}`,
      status: 'filled',
      filledSize: order.size,
      avgFillPrice: fillPrice,
      timestamp: Date.now(),
    };
    this.filledOrders.set(order.clientOrderId, result);
    this.log(order, result);
    return result;
  }

  async cancelOrder(clientOrderId: string): Promise<CancelResult> {
    // Every paper order fills synchronously inside placeOrder, so by the
    // time cancelOrder could be called there is never anything resting.
    const known = this.filledOrders.has(clientOrderId);
    return {
      clientOrderId,
      cancelled: false,
      reason: known
        ? 'order already filled instantly in paper mode, nothing to cancel'
        : 'unknown clientOrderId',
    };
  }

  async getPosition(asset: string): Promise<Position | null> {
    return this.positions.get(asset) ?? null;
  }

  subscribeMarketData(asset: string, onTick: (tick: PriceTick) => void): Unsubscribe {
    let set = this.subscribers.get(asset);
    if (!set) {
      set = new Set();
      this.subscribers.set(asset, set);
    }
    set.add(onTick);
    return () => set.delete(onTick);
  }

  private applyFill(order: Order, price: Decimal): void {
    const signedDelta = order.side === 'buy' ? order.size : negateDecimal(order.size);
    const existing = this.positions.get(order.asset);
    const newSize = existing ? addDecimal(existing.size, signedDelta) : signedDelta;
    // Simplified deliberately: average-cost accounting and realized P&L on
    // a reduction are not attempted here. Every fill just sets entryPrice
    // to its own fill price — good enough for the watcher-layer tests in
    // this package, not a ledger. That belongs in packages/backend, which
    // owns the `trades`/`positions` tables and can do it properly.
    this.positions.set(order.asset, { venue: this.venue, asset: order.asset, size: newSize, entryPrice: price });
  }

  private log(order: Order, result: OrderResult): void {
    const priceLabel = result.avgFillPrice ? formatAtoms(result.avgFillPrice) : 'n/a';
    console.info(
      `[paper] ${order.side} ${order.kind} ${order.asset} size=${formatAtoms(order.size)} -> ${result.status} @ ${priceLabel}` +
        (result.reason ? ` (${result.reason})` : ''),
    );
  }
}

function formatAtoms(d: Decimal): string {
  return `${d.atoms}e-${d.decimals}`;
}

function negateDecimal(d: Decimal): Decimal {
  return { atoms: (-BigInt(d.atoms)).toString(), decimals: d.decimals };
}

function addDecimal(a: Decimal, b: Decimal): Decimal {
  return subDecimal(a, negateDecimal(b));
}
