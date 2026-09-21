/**
 * `ExecutionService`: takes an approved trade and places the entry plus its
 * protective stop (and optional take-profit), returning an `ExecutionReport`
 * that is plain JSON, so a Convex action can store it as trade evidence
 * without translation.
 *
 * "Approved" means the contract already accepted the trade against the
 * pinned spec (docs/ARCHITECTURE.md). This service does not re-litigate that.
 * It refuses only what it cannot execute safely: a stop on the wrong side of
 * the entry, an asset no venue lists, a short on spot. Those come back as
 * `outcome: 'refused'` with a reason, which is a success state, not an error.
 *
 * Where protection lives depends on the venue, and the report says which:
 *   - `venue_native`: Perpl holds a linked trigger order. It survives this
 *     process dying and activates only if the entry trades.
 *   - `client_watcher`: the venue has no trigger orders (Kuru, paper), so the
 *     stop is an `AdvancedOrderWatcher` order in this process. That is weaker,
 *     and `evaluateProtection` must be called as the series advances.
 *
 * A position without its stop is the failure this product exists to prevent.
 * So if the entry fills and the protective leg is then rejected, the service
 * flattens with a reduce-only market order by default and reports
 * `outcome: 'flattened'`.
 */

import { compareDecimal, type Decimal, type Series } from '@kanon/spec';
import { AdvancedOrderWatcher, type PriceTriggeredOrder } from './orders';
import { PaperExecutionClient } from './paper';
import type { ExecutionMode, Instrument, RoutedVenue, VenueRouter } from './router';
import { isNativeTriggerCapable } from './types';
import type { ExecutionClient, Order, OrderResult, OrderSide, OrderStatus, TriggerOrder } from './types';

export interface ApprovedTrade {
  /** Stable id from the trade record; prefixes every client order id. */
  tradeId: string;
  /** Kanon asset symbol, e.g. "BTC/USD". */
  asset: string;
  /** `buy` opens a long, `sell` opens a short. */
  side: OrderSide;
  size: Decimal;
  entry: Decimal;
  stop: Decimal;
  takeProfit?: Decimal | undefined;
  /** `perp` (Perpl) or `spot` (Kuru). Defaults to `perp`: spot must be asked for. */
  instrument?: Instrument | undefined;
  /** `market` (default) enters at the venue price; `limit` rests at `entry`. */
  entryKind?: 'market' | 'limit' | undefined;
  leverageX?: number | undefined;
  maxSlippageBps?: number | undefined;
}

export type LegRole = 'entry' | 'stop_loss' | 'take_profit' | 'emergency_close';
export type LegStatus = OrderStatus | 'registered';

export interface ExecutionLeg {
  role: LegRole;
  clientOrderId: string;
  /** Where the protection lives; absent on entry and emergency legs. */
  protection?: 'venue_native' | 'client_watcher';
  status: LegStatus;
  venueOrderId?: string;
  filledSize?: Decimal;
  avgFillPrice?: Decimal;
  triggerPrice?: Decimal;
  reason?: string;
  timestamp: number;
}

export type ExecutionOutcome = 'executed' | 'pending' | 'rejected' | 'refused' | 'flattened';

export interface ExecutionReport {
  tradeId: string;
  outcome: ExecutionOutcome;
  /** Whether orders really went to a venue or were simulated. */
  mode?: ExecutionMode;
  venue?: RoutedVenue;
  /** The client that actually handled the orders ("paper" in paper mode). */
  executedOn?: string;
  instrument: Instrument;
  asset: string;
  side: OrderSide;
  requested: { size: Decimal; entry: Decimal; stop: Decimal; takeProfit?: Decimal };
  refusal?: { code: string; reason: string };
  legs: ExecutionLeg[];
  notes: string[];
  startedAt: number;
  finishedAt: number;
}

export interface ExecutionServiceOptions {
  router: VenueRouter;
  now?: () => number;
  /** What to do when the entry filled but a protective leg was rejected.
   * `flatten` (default) closes the position; `report` leaves it and says so. */
  onProtectiveFailure?: 'flatten' | 'report';
}

interface WatchedTrade {
  tradeId: string;
  asset: string;
  client: ExecutionClient;
  orders: PriceTriggeredOrder[];
  armed: boolean;
}

function directionOf(side: OrderSide): 'long' | 'short' {
  return side === 'buy' ? 'long' : 'short';
}

/** Validates that stop and take-profit sit on the correct sides of the entry. */
export function validateProtection(trade: ApprovedTrade): string | undefined {
  const long = trade.side === 'buy';
  if (BigInt(trade.size.atoms) <= 0n) return 'size must be positive';
  if (BigInt(trade.entry.atoms) <= 0n) return 'entry must be positive';
  const stopCmp = compareDecimal(trade.stop, trade.entry);
  if (long ? stopCmp >= 0 : stopCmp <= 0) {
    return `a ${long ? 'long' : 'short'} stop must sit ${long ? 'below' : 'above'} the entry; refusing an unprotected or inverted trade`;
  }
  if (trade.takeProfit) {
    const tpCmp = compareDecimal(trade.takeProfit, trade.entry);
    if (long ? tpCmp <= 0 : tpCmp >= 0) {
      return `a ${long ? 'long' : 'short'} take-profit must sit ${long ? 'above' : 'below'} the entry`;
    }
  }
  return undefined;
}

export class ExecutionService {
  private readonly router: VenueRouter;
  private readonly now: () => number;
  private readonly onProtectiveFailure: 'flatten' | 'report';
  private readonly watchers = new Map<ExecutionClient, AdvancedOrderWatcher>();
  private readonly watched = new Map<string, WatchedTrade>();
  private readonly legIndex = new Map<string, { tradeId: string; role: LegRole }>();

  constructor(opts: ExecutionServiceOptions) {
    this.router = opts.router;
    this.now = opts.now ?? Date.now;
    this.onProtectiveFailure = opts.onProtectiveFailure ?? 'flatten';
  }

  async execute(trade: ApprovedTrade): Promise<ExecutionReport> {
    const startedAt = this.now();
    const instrument: Instrument = trade.instrument ?? 'perp';
    const requested: ExecutionReport['requested'] = {
      size: trade.size,
      entry: trade.entry,
      stop: trade.stop,
      ...(trade.takeProfit ? { takeProfit: trade.takeProfit } : {}),
    };
    const report: ExecutionReport = {
      tradeId: trade.tradeId,
      outcome: 'refused',
      instrument,
      asset: trade.asset,
      side: trade.side,
      requested,
      legs: [],
      notes: [],
      startedAt,
      finishedAt: startedAt,
    };
    const finish = (outcome: ExecutionOutcome): ExecutionReport => {
      report.outcome = outcome;
      report.finishedAt = this.now();
      return report;
    };

    const invalid = validateProtection(trade);
    if (invalid) {
      report.refusal = { code: 'invalid_protection', reason: invalid };
      return finish('refused');
    }

    const decision = this.router.route({ asset: trade.asset, instrument, side: trade.side });
    if (!decision.ok) {
      report.refusal = { code: decision.code, reason: decision.reason };
      return finish('refused');
    }
    const { client, venueAsset } = decision;
    report.mode = decision.mode;
    report.venue = decision.venue;
    report.executedOn = client.venue;
    if (decision.mode === 'paper') {
      report.notes.push('PAPER: no order reached a venue. Fills are simulated against the approved entry price.');
      if (client instanceof PaperExecutionClient && !client.getLastPrice(venueAsset)) {
        client.pushTick(venueAsset, { timestamp: Math.floor(this.now() / 1000), price: trade.entry });
      }
    }

    // ---- entry -----------------------------------------------------------
    const entryId = `${trade.tradeId}:entry`;
    const entryOrder: Order = {
      clientOrderId: entryId,
      asset: venueAsset,
      side: trade.side,
      kind: trade.entryKind ?? 'market',
      size: trade.size,
      ...(trade.entryKind === 'limit' ? { price: trade.entry } : {}),
      ...(trade.leverageX !== undefined ? { leverageX: trade.leverageX } : {}),
      ...(trade.maxSlippageBps !== undefined ? { maxSlippageBps: trade.maxSlippageBps } : {}),
    };
    const entry = await client.placeOrder(entryOrder);
    report.legs.push(this.leg('entry', entry));
    if (entry.status === 'rejected') return finish('rejected');

    const protectedSize = entry.filledSize ?? trade.size;
    const direction = directionOf(trade.side);
    const closingSide: OrderSide = trade.side === 'buy' ? 'sell' : 'buy';

    // ---- protection ------------------------------------------------------
    const protective: Array<{ role: 'stop_loss' | 'take_profit'; price: Decimal }> = [
      { role: 'stop_loss', price: trade.stop },
      ...(trade.takeProfit ? [{ role: 'take_profit' as const, price: trade.takeProfit }] : []),
    ];
    const placed: ExecutionLeg[] = [];
    let protectionFailure: string | undefined;

    if (isNativeTriggerCapable(client)) {
      for (const p of protective) {
        const id = `${trade.tradeId}:${p.role === 'stop_loss' ? 'stop' : 'tp'}`;
        const trigger: TriggerOrder = {
          clientOrderId: id,
          asset: venueAsset,
          kind: p.role,
          direction,
          size: protectedSize,
          triggerPrice: p.price,
          linkedToClientOrderId: entryId,
          ...(trade.leverageX !== undefined ? { leverageX: trade.leverageX } : {}),
          ...(trade.maxSlippageBps !== undefined ? { maxSlippageBps: trade.maxSlippageBps } : {}),
        };
        const result = await client.placeTriggerOrder(trigger);
        const leg = this.leg(p.role, result, { protection: 'venue_native', triggerPrice: p.price });
        report.legs.push(leg);
        if (result.status === 'rejected') {
          protectionFailure = `${p.role} rejected: ${result.reason ?? 'no reason given'}`;
          break;
        }
        placed.push(leg);
      }
    } else {
      // No venue-side triggers: register client-side watcher orders.
      const orders: PriceTriggeredOrder[] = protective.map((p) => ({
        kind: p.role,
        id: `${trade.tradeId}:${p.role === 'stop_loss' ? 'stop' : 'tp'}`,
        asset: venueAsset,
        direction,
        triggerPrice: p.price,
        size: protectedSize,
      }));
      for (const [i, order] of orders.entries()) {
        const p = protective[i];
        if (!p) continue;
        this.legIndex.set(`${order.kind}:${order.id}`, { tradeId: trade.tradeId, role: p.role });
        report.legs.push({
          role: p.role,
          clientOrderId: order.id,
          protection: 'client_watcher',
          status: 'registered',
          triggerPrice: p.price,
          reason: 'held by the client-side watcher in this process: call evaluateProtection as the price series advances',
          timestamp: this.now(),
        });
      }
      this.watched.set(trade.tradeId, {
        tradeId: trade.tradeId,
        asset: trade.asset,
        client,
        orders,
        armed: entry.status === 'filled',
      });
      if (entry.status !== 'filled') {
        report.notes.push('entry not yet filled: client-side protection is armed only after markEntryFilled(tradeId)');
      }
    }

    // ---- a position must not be left without its stop ---------------------
    if (protectionFailure) {
      report.notes.push(`protection failed: ${protectionFailure}`);
      for (const leg of placed) {
        const cancelled = await client.cancelOrder(leg.clientOrderId);
        report.notes.push(`cancelled ${leg.role} ${leg.clientOrderId}: ${cancelled.cancelled ? 'ok' : (cancelled.reason ?? 'not cancelled')}`);
      }
      if (this.onProtectiveFailure === 'flatten' && entry.status === 'filled') {
        const close = await client.placeOrder({
          clientOrderId: `${trade.tradeId}:close`,
          asset: venueAsset,
          side: closingSide,
          kind: 'market',
          size: protectedSize,
          reduceOnly: true,
          ...(trade.leverageX !== undefined ? { leverageX: trade.leverageX } : {}),
        });
        report.legs.push(this.leg('emergency_close', close));
        report.notes.push('entry filled but protection could not be placed: position flattened with a reduce-only market order');
        return finish('flattened');
      }
      if (entry.status !== 'filled') {
        const cancelled = await client.cancelOrder(entryId);
        report.notes.push(`entry cancelled because protection could not be placed: ${cancelled.cancelled ? 'ok' : (cancelled.reason ?? 'not cancelled')}`);
        return finish('rejected');
      }
      report.notes.push('entry filled and protection is missing (onProtectiveFailure=report): needs attention');
      return finish('pending');
    }

    return finish(entry.status === 'filled' ? 'executed' : 'pending');
  }

  /** Arms client-side protection once an entry that was pending has filled. */
  markEntryFilled(tradeId: string): boolean {
    const w = this.watched.get(tradeId);
    if (!w) return false;
    w.armed = true;
    return true;
  }

  /**
   * Evaluates client-side protection against a price series and fires any
   * stop / take-profit that has been crossed. Returns the legs that fired.
   * Once one leg of a trade fires the rest are dropped (one-cancels-other).
   */
  async evaluateProtection(series: Series): Promise<Array<{ tradeId: string; leg: ExecutionLeg }>> {
    const fired: Array<{ tradeId: string; leg: ExecutionLeg }> = [];
    for (const w of [...this.watched.values()]) {
      if (!w.armed || w.asset !== series.asset) continue;
      let watcher = this.watchers.get(w.client);
      if (!watcher) {
        watcher = new AdvancedOrderWatcher(w.client);
        this.watchers.set(w.client, watcher);
      }
      const results = await watcher.evaluate(w.orders, series);
      for (const result of results) {
        const meta = this.legIndex.get(result.clientOrderId);
        if (!meta) continue;
        fired.push({ tradeId: meta.tradeId, leg: this.leg(meta.role, result, { protection: 'client_watcher' }) });
      }
      if (results.length > 0) this.watched.delete(w.tradeId);
    }
    return fired;
  }

  /** Trades whose protection is still held in this process. Persist this if
   * the process may restart: the watcher's memory does not survive one. */
  pendingProtection(): Array<{ tradeId: string; asset: string; armed: boolean; orders: PriceTriggeredOrder[] }> {
    return [...this.watched.values()].map((w) => ({ tradeId: w.tradeId, asset: w.asset, armed: w.armed, orders: w.orders }));
  }

  private leg(
    role: LegRole,
    r: OrderResult,
    extra: { protection?: 'venue_native' | 'client_watcher'; triggerPrice?: Decimal } = {},
  ): ExecutionLeg {
    return {
      role,
      clientOrderId: r.clientOrderId,
      ...(extra.protection ? { protection: extra.protection } : {}),
      status: r.status,
      ...(r.venueOrderId !== undefined ? { venueOrderId: r.venueOrderId } : {}),
      ...(r.filledSize ? { filledSize: r.filledSize } : {}),
      ...(r.avgFillPrice ? { avgFillPrice: r.avgFillPrice } : {}),
      ...(extra.triggerPrice ? { triggerPrice: extra.triggerPrice } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      timestamp: r.timestamp,
    };
  }
}
