/**
 * "Native advanced orders" — stop-loss, take-profit, trailing stop, TWAP,
 * iceberg — from the App-2 scope. Perpl documents stop market, stop limit
 * and take profit as real venue order types today (TWAP is listed in its
 * own docs as "coming soon"); Kuru has none of these natively, only
 * resting limit and IOC market orders on its order book. So instead of
 * assuming venue support, this is a **watcher layer** sitting on top of any
 * `ExecutionClient`: it watches the canonical price series
 * (`@kanon/spec`'s `Series`/`Candle`, docs/ARCHITECTURE.md's "the contract
 * maintains its own price record... a swing high is defined as the maximum
 * over recorded samples") and fires a plain market or limit order through
 * the underlying client when a trigger condition is met.
 *
 * Split deliberately into pure trigger/slicing functions (no I/O, fully
 * unit-testable against a fixture `Series`) and thin stateful runner
 * classes that call `ExecutionClient.placeOrder`. The pure functions are
 * what `orders.test.ts` exercises.
 */

import type { Candle, Series } from '@kanon/spec';
import { compareDecimal, subDecimal } from '@kanon/spec';
import type { Decimal } from '@kanon/spec';
import type { ExecutionClient, Order, OrderResult, OrderSide } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stop-loss/take-profit/trailing-stop are position-closing orders: which
 * way they close depends on the direction of the position they protect,
 * not a raw buy/sell. `closingSide` below turns this into the `OrderSide`
 * `ExecutionClient.placeOrder` wants. */
export type PositionDirection = 'long' | 'short';

export interface StopLossOrder {
  kind: 'stop_loss';
  id: string;
  asset: string;
  direction: PositionDirection;
  triggerPrice: Decimal;
  size: Decimal;
}

export interface TakeProfitOrder {
  kind: 'take_profit';
  id: string;
  asset: string;
  direction: PositionDirection;
  triggerPrice: Decimal;
  size: Decimal;
}

export interface TrailingStopOrder {
  kind: 'trailing_stop';
  id: string;
  asset: string;
  direction: PositionDirection;
  /** How far price must retrace from its favourable extreme to trigger,
   * in basis points of that extreme. */
  trailingBps: number;
  size: Decimal;
  /** Where the trailing stop starts tracking from — typically the position's entry price. */
  activationPrice: Decimal;
}

/** Orders whose trigger is a price condition against the canonical series,
 * handled by `AdvancedOrderWatcher`. */
export type PriceTriggeredOrder = StopLossOrder | TakeProfitOrder | TrailingStopOrder;

export interface TwapOrder {
  kind: 'twap';
  id: string;
  asset: string;
  side: OrderSide;
  totalSize: Decimal;
  slices: number;
  durationSeconds: number;
  startTimestamp: number;
}

export interface IcebergOrder {
  kind: 'iceberg';
  id: string;
  asset: string;
  side: OrderSide;
  totalSize: Decimal;
  displaySize: Decimal;
  limitPrice: Decimal;
}

export interface TriggerResult {
  triggered: boolean;
  /** The candle that satisfied the trigger, when `triggered`. */
  candle?: Candle;
  /** For trailing stops, the stop price in effect at the moment of the
   * check (moves as the price moves favourably). */
  stopPrice?: Decimal;
}

// ---------------------------------------------------------------------------
// bps arithmetic
//
// packages/spec/src/decimal.ts deliberately has no multiplication — nothing
// in the spec/contract path needs it. Trailing-stop distance does, so it
// lives here rather than being added to the shared Decimal module for one
// caller. BigInt division truncates toward zero, i.e. this floors the
// magnitude of the adjustment; documented rather than silent.
// ---------------------------------------------------------------------------

/** Multiplies a Decimal by `(10_000 ± bps) / 10_000`. `direction: 'down'`
 * shrinks the value (a long's trailing stop below its peak); `'up'` grows
 * it (a short's trailing stop above its trough). */
export function applyBps(value: Decimal, bps: number, direction: 'up' | 'down'): Decimal {
  if (bps < 0) throw new Error(`applyBps: bps must be >= 0, got ${bps}`);
  const numerator = direction === 'down' ? 10_000n - BigInt(bps) : 10_000n + BigInt(bps);
  const atoms = (BigInt(value.atoms) * numerator) / 10_000n;
  return { atoms: atoms.toString(), decimals: value.decimals };
}

// ---------------------------------------------------------------------------
// Pure trigger checks
// ---------------------------------------------------------------------------

/** Long stop-loss triggers when a candle's low touches or breaches the
 * trigger price; short triggers on the high. Scans candles in series order
 * (ascending, per candle.ts) and returns the first one that trips it —
 * later candles cannot un-trigger a stop, matching threshold.ts's
 * first-crossing-decides settlement logic. */
export function checkStopLoss(order: StopLossOrder, series: Series): TriggerResult {
  for (const candle of series.candles) {
    const hit =
      order.direction === 'long'
        ? compareDecimal(candle.low, order.triggerPrice) <= 0
        : compareDecimal(candle.high, order.triggerPrice) >= 0;
    if (hit) return { triggered: true, candle };
  }
  return { triggered: false };
}

/** Take-profit is the mirror of stop-loss: long triggers on the high
 * reaching the target, short on the low. */
export function checkTakeProfit(order: TakeProfitOrder, series: Series): TriggerResult {
  for (const candle of series.candles) {
    const hit =
      order.direction === 'long'
        ? compareDecimal(candle.high, order.triggerPrice) >= 0
        : compareDecimal(candle.low, order.triggerPrice) <= 0;
    if (hit) return { triggered: true, candle };
  }
  return { triggered: false };
}

/**
 * Trailing stop. For a long: tracks the running peak high since
 * `activationPrice`, recomputes `stopPrice = peak * (1 - trailingBps)`
 * after each candle, and triggers when that same candle's low touches or
 * breaches the current stop. Short is the mirror (running trough low,
 * stop above it, triggers on the high).
 *
 * The peak/trough updates using the *current* candle's high/low before
 * that candle's own trigger check — real trailing stops move intrabar, so
 * a candle that makes a new extreme and then reverses hard within itself
 * can trigger on its own bar. This is a modelling choice, not a discovered
 * fact about any venue; documented so it isn't mistaken for one.
 */
export function checkTrailingStop(order: TrailingStopOrder, series: Series): TriggerResult {
  let extreme = order.activationPrice;
  for (const candle of series.candles) {
    if (order.direction === 'long') {
      if (compareDecimal(candle.high, extreme) > 0) extreme = candle.high;
      const stopPrice = applyBps(extreme, order.trailingBps, 'down');
      if (compareDecimal(candle.low, stopPrice) <= 0) return { triggered: true, candle, stopPrice };
    } else {
      if (compareDecimal(candle.low, extreme) < 0) extreme = candle.low;
      const stopPrice = applyBps(extreme, order.trailingBps, 'up');
      if (compareDecimal(candle.high, stopPrice) >= 0) return { triggered: true, candle, stopPrice };
    }
  }
  const finalStop =
    order.direction === 'long'
      ? applyBps(extreme, order.trailingBps, 'down')
      : applyBps(extreme, order.trailingBps, 'up');
  return { triggered: false, stopPrice: finalStop };
}

function evaluateTrigger(order: PriceTriggeredOrder, series: Series): TriggerResult {
  switch (order.kind) {
    case 'stop_loss':
      return checkStopLoss(order, series);
    case 'take_profit':
      return checkTakeProfit(order, series);
    case 'trailing_stop':
      return checkTrailingStop(order, series);
  }
}

function closingSide(direction: PositionDirection): OrderSide {
  return direction === 'long' ? 'sell' : 'buy';
}

// ---------------------------------------------------------------------------
// TWAP slicing
// ---------------------------------------------------------------------------

export interface TwapSlice {
  index: number;
  timestamp: number;
  size: Decimal;
}

/**
 * Splits `totalSize` into `order.slices` equal pieces spaced evenly across
 * `durationSeconds`, starting at `startTimestamp`. Integer division means
 * equal slices may leave a remainder; it is folded entirely into the last
 * slice so the sum always equals `totalSize` exactly — a TWAP that fills
 * every slice must not drift from the size the user approved.
 */
export function sliceTwap(order: TwapOrder): TwapSlice[] {
  if (order.slices < 1) throw new Error('sliceTwap: slices must be >= 1');
  const total = BigInt(order.totalSize.atoms);
  const base = total / BigInt(order.slices);
  const remainder = total - base * BigInt(order.slices);
  const spacing = order.slices > 1 ? order.durationSeconds / (order.slices - 1) : 0;

  const slices: TwapSlice[] = [];
  for (let i = 0; i < order.slices; i++) {
    const isLast = i === order.slices - 1;
    const atoms = isLast ? base + remainder : base;
    slices.push({
      index: i,
      timestamp: order.startTimestamp + Math.round(i * spacing),
      size: { atoms: atoms.toString(), decimals: order.totalSize.decimals },
    });
  }
  return slices;
}

/** The slices of `order` whose scheduled time has arrived as of `now`. */
export function dueTwapSlices(order: TwapOrder, now: number): TwapSlice[] {
  return sliceTwap(order).filter((s) => s.timestamp <= now);
}

// ---------------------------------------------------------------------------
// Iceberg — simplified/approximated, noted per task: re-posting on fills is
// genuinely complex (partial fills on a resting order, front-running of a
// visibly-repeated slice size, etc.) and this does not attempt the full
// problem. See IcebergRunner below for exactly what is and isn't modelled.
// ---------------------------------------------------------------------------

/** The size of the next slice to show: whatever is smaller, the display
 * size or what's left. Pure so the "how big is the next clip" decision is
 * testable without a client. */
export function nextIcebergSlice(remaining: Decimal, displaySize: Decimal): Decimal {
  return compareDecimal(remaining, displaySize) < 0 ? remaining : displaySize;
}

// ---------------------------------------------------------------------------
// Stateful runners — the only parts of this file that touch an
// ExecutionClient. Kept thin and separate from the pure logic above.
// ---------------------------------------------------------------------------

/**
 * Watches stop-loss/take-profit/trailing-stop orders against a series
 * snapshot and fires a reduce-only market order for any that trigger.
 * Call `evaluate` whenever the canonical series advances (e.g. on each new
 * candle close) — this class does not subscribe to anything itself, it
 * only reacts to the series it's handed. Each order fires at most once.
 */
export class AdvancedOrderWatcher {
  private readonly firedIds = new Set<string>();

  constructor(private readonly client: ExecutionClient) {}

  async evaluate(orders: PriceTriggeredOrder[], series: Series): Promise<OrderResult[]> {
    const results: OrderResult[] = [];
    for (const order of orders) {
      if (this.firedIds.has(order.id)) continue;
      const trigger = evaluateTrigger(order, series);
      if (!trigger.triggered) continue;
      this.firedIds.add(order.id);
      const toSend: Order = {
        clientOrderId: `${order.kind}:${order.id}`,
        asset: order.asset,
        side: closingSide(order.direction),
        kind: 'market',
        size: order.size,
        reduceOnly: true,
      };
      results.push(await this.client.placeOrder(toSend));
    }
    return results;
  }

  /** Whether `orderId` has already fired, for callers that persist state
   * elsewhere (e.g. `trades` in packages/backend) and need to avoid
   * double-counting on restart. This watcher's own memory is in-process
   * only and does not survive a restart by itself. */
  hasFired(orderId: string): boolean {
    return this.firedIds.has(orderId);
  }
}

/** Places TWAP slices as their scheduled time arrives. Call `tick(now)` on
 * a caller-owned interval (e.g. once per new candle); it is idempotent per
 * slice within one runner instance. */
export class TwapRunner {
  private readonly sentIndices = new Set<number>();

  constructor(
    private readonly client: ExecutionClient,
    private readonly order: TwapOrder,
  ) {}

  async tick(now: number): Promise<OrderResult[]> {
    const due = dueTwapSlices(this.order, now).filter((s) => !this.sentIndices.has(s.index));
    const results: OrderResult[] = [];
    for (const slice of due) {
      this.sentIndices.add(slice.index);
      results.push(
        await this.client.placeOrder({
          clientOrderId: `twap:${this.order.id}:${slice.index}`,
          asset: this.order.asset,
          side: this.order.side,
          kind: 'market',
          size: slice.size,
        }),
      );
    }
    return results;
  }

  get sentCount(): number {
    return this.sentIndices.size;
  }
}

/**
 * Posts an iceberg's total size as a sequence of display-sized limit
 * order slices. **Simplified approximation, documented explicitly:** it
 * posts one slice, waits synchronously for that slice's `OrderResult`, and
 * only posts the next slice once the previous one reports `status:
 * 'filled'`. It does not react to a *partial* fill on a still-resting
 * order (an order sitting on a real book can fill 30% and stay open;
 * `ExecutionClient.placeOrder`'s single `OrderResult` doesn't model that),
 * and it does not randomise slice size or timing to resist being read as
 * an iceberg by other participants, which real iceberg implementations
 * usually do. Good enough to demonstrate the shape against
 * `PaperExecutionClient`, which fills or nothing instantly; not something
 * to point at a real book without redoing the fill-tracking half of this.
 */
export class IcebergRunner {
  private remaining: Decimal;
  private stopped = false;

  constructor(
    private readonly client: ExecutionClient,
    private readonly order: IcebergOrder,
  ) {
    this.remaining = order.totalSize;
  }

  async run(): Promise<OrderResult[]> {
    const results: OrderResult[] = [];
    while (!this.stopped && BigInt(this.remaining.atoms) > 0n) {
      const sliceSize = nextIcebergSlice(this.remaining, this.order.displaySize);
      const result = await this.client.placeOrder({
        clientOrderId: `iceberg:${this.order.id}:${results.length}`,
        asset: this.order.asset,
        side: this.order.side,
        kind: 'limit',
        price: this.order.limitPrice,
        size: sliceSize,
      });
      results.push(result);
      if (result.status === 'filled' && result.filledSize) {
        this.remaining = subDecimal(this.remaining, result.filledSize);
      } else {
        // Pending or rejected: stop rather than pile another slice on top
        // of an order whose outcome this runner can't confirm.
        this.stopped = true;
      }
    }
    return results;
  }

  get remainingSize(): Decimal {
    return this.remaining;
  }
}
