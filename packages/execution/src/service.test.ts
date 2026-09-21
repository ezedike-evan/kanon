import { describe, expect, it, vi } from 'vitest';
import { dec, formatDecimal, type Candle, type Series } from '@kanon/spec';
import { PaperExecutionClient } from './paper';
import { VenueRouter } from './router';
import { ExecutionService, validateProtection, type ApprovedTrade } from './service';
import type { CancelResult, ExecutionClient, NativeTriggerCapable, Order, OrderResult, TriggerOrder } from './types';

const NOW = 1_760_000_000_000;
const DP = 2;
const p = (atoms: bigint) => dec(atoms, DP);
const size = (atoms: bigint) => dec(atoms, 8);

/** A long BTC trade: 0.5 BTC at 68,000.00, stop 67,000.00, take-profit 70,000.00. */
const longTrade: ApprovedTrade = {
  tradeId: 't1',
  asset: 'BTC/USD',
  side: 'buy',
  size: size(50_000_000n),
  entry: p(6_800_000n),
  stop: p(6_700_000n),
  takeProfit: p(7_000_000n),
};

function candle(low: bigint, high: bigint, ts: number): Candle {
  return { bucketIndex: ts, timestamp: ts, open: p(6_800_000n), high: p(high), low: p(low), close: p(6_800_000n), synthetic: false };
}
const series = (asset: string, candles: Candle[]): Series => ({ asset, bucketSeconds: 900, candles });

function paperRouter(paper: PaperExecutionClient) {
  return new VenueRouter({
    paper,
    perpl: { network: 'mainnet', mode: 'paper' },
    kuru: { network: 'mainnet', mode: 'paper' },
  });
}

/** A recording native-trigger venue with scriptable results. */
class NativeVenue implements ExecutionClient, NativeTriggerCapable {
  readonly venue = 'perpl' as const;
  readonly supportsNativeTriggers = true as const;
  orders: Order[] = [];
  triggers: TriggerOrder[] = [];
  cancels: string[] = [];
  entryStatus: OrderResult['status'] = 'filled';
  rejectTrigger?: TriggerOrder['kind'];

  private result(id: string, status: OrderResult['status'], extra: Partial<OrderResult> = {}): OrderResult {
    return { venue: 'perpl', clientOrderId: id, status, timestamp: NOW, ...extra };
  }
  async placeOrder(order: Order) {
    this.orders.push(order);
    return this.result(order.clientOrderId, order.reduceOnly ? 'filled' : this.entryStatus, {
      venueOrderId: `oid-${order.clientOrderId}`,
      ...(this.entryStatus === 'filled' || order.reduceOnly ? { filledSize: order.size, avgFillPrice: p(6_800_100n) } : {}),
    });
  }
  async placeTriggerOrder(t: TriggerOrder) {
    this.triggers.push(t);
    if (this.rejectTrigger === t.kind) return this.result(t.clientOrderId, 'rejected', { reason: 'venue said no' });
    return this.result(t.clientOrderId, 'pending', { venueOrderId: `oid-${t.clientOrderId}` });
  }
  async cancelOrder(id: string): Promise<CancelResult> {
    this.cancels.push(id);
    return { clientOrderId: id, cancelled: true };
  }
  async getPosition() {
    return null;
  }
  subscribeMarketData() {
    return () => {};
  }
}

function nativeRouter(venue: NativeVenue) {
  return new VenueRouter({
    paper: new PaperExecutionClient(),
    perpl: { network: 'mainnet', mode: 'live', client: venue },
    kuru: { network: 'mainnet', mode: 'paper' },
  });
}

describe('validateProtection', () => {
  it('accepts a correctly protected long and short', () => {
    expect(validateProtection(longTrade)).toBeUndefined();
    expect(validateProtection({ ...longTrade, side: 'sell', stop: p(6_900_000n), takeProfit: p(6_500_000n) })).toBeUndefined();
  });

  it('refuses a stop on the wrong side, an equal stop, and a take-profit on the wrong side', () => {
    expect(validateProtection({ ...longTrade, stop: p(6_900_000n) })).toContain('below the entry');
    expect(validateProtection({ ...longTrade, stop: p(6_800_000n) })).toContain('below the entry');
    expect(validateProtection({ ...longTrade, takeProfit: p(6_700_000n) })).toContain('above the entry');
    expect(validateProtection({ ...longTrade, side: 'sell', stop: p(6_700_000n) })).toContain('above the entry');
  });
});

describe('ExecutionService in paper mode', () => {
  it('fills the entry, registers client-side protection, and labels everything as paper', async () => {
    const paper = new PaperExecutionClient();
    const svc = new ExecutionService({ router: paperRouter(paper), now: () => NOW });
    const report = await svc.execute(longTrade);

    expect(report).toMatchObject({ tradeId: 't1', outcome: 'executed', mode: 'paper', venue: 'perpl', executedOn: 'paper' });
    expect(report.notes[0]).toContain('PAPER');
    const [entry, stop, tp] = report.legs;
    expect(entry).toMatchObject({ role: 'entry', clientOrderId: 't1:entry', status: 'filled' });
    expect(formatDecimal(entry!.avgFillPrice!)).toBe('68,000.00');
    expect(stop).toMatchObject({ role: 'stop_loss', protection: 'client_watcher', status: 'registered' });
    expect(formatDecimal(stop!.triggerPrice!)).toBe('67,000.00');
    expect(tp).toMatchObject({ role: 'take_profit', protection: 'client_watcher' });
    expect(svc.pendingProtection()).toHaveLength(1);
    // The report is plain JSON a Convex action can store as-is.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('fires the stop when the series breaches it, and drops the take-profit (OCO)', async () => {
    const paper = new PaperExecutionClient();
    const svc = new ExecutionService({ router: paperRouter(paper), now: () => NOW });
    await svc.execute(longTrade);

    expect(await svc.evaluateProtection(series('BTC/USD', [candle(6_750_000n, 6_850_000n, 1)]))).toEqual([]);
    const fired = await svc.evaluateProtection(series('BTC/USD', [candle(6_690_000n, 6_850_000n, 2)]));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ tradeId: 't1', leg: { role: 'stop_loss', status: 'filled', protection: 'client_watcher' } });
    expect(svc.pendingProtection()).toHaveLength(0);
    expect(await svc.evaluateProtection(series('BTC/USD', [candle(6_000_000n, 8_000_000n, 3)]))).toEqual([]);
    expect((await paper.getPosition('BTC/USD'))?.size.atoms).toBe('0'); // flat again
  });

  it('ignores a series for a different asset', async () => {
    const svc = new ExecutionService({ router: paperRouter(new PaperExecutionClient()), now: () => NOW });
    await svc.execute(longTrade);
    expect(await svc.evaluateProtection(series('ETH/USD', [candle(1n, 999_999_999n, 1)]))).toEqual([]);
  });

  it('works for a short: stop above, take-profit below', async () => {
    const paper = new PaperExecutionClient();
    const svc = new ExecutionService({ router: paperRouter(paper), now: () => NOW });
    const report = await svc.execute({ ...longTrade, tradeId: 's1', side: 'sell', stop: p(6_900_000n), takeProfit: p(6_500_000n) });
    expect(report.outcome).toBe('executed');
    const fired = await svc.evaluateProtection(series('BTC/USD', [candle(6_490_000n, 6_800_000n, 1)]));
    expect(fired[0]?.leg.role).toBe('take_profit');
  });
});

describe('ExecutionService refusals', () => {
  it('refuses an inverted stop before touching any client', async () => {
    const paper = new PaperExecutionClient();
    const spy = vi.spyOn(paper, 'placeOrder');
    const svc = new ExecutionService({ router: paperRouter(paper), now: () => NOW });
    const report = await svc.execute({ ...longTrade, stop: p(6_900_000n) });
    expect(report.outcome).toBe('refused');
    expect(report.refusal?.code).toBe('invalid_protection');
    expect(report.legs).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an unroutable asset with the router\'s reason', async () => {
    const svc = new ExecutionService({ router: paperRouter(new PaperExecutionClient()), now: () => NOW });
    const report = await svc.execute({ ...longTrade, asset: 'AVAX/USD' });
    expect(report).toMatchObject({ outcome: 'refused', refusal: { code: 'no_perp_market' } });
    expect(report.legs).toEqual([]);
  });

  it('refuses BTC on spot and a short on spot', async () => {
    const svc = new ExecutionService({ router: paperRouter(new PaperExecutionClient()), now: () => NOW });
    expect((await svc.execute({ ...longTrade, instrument: 'spot' })).refusal?.code).toBe('no_spot_market');
    const short = await svc.execute({ ...longTrade, asset: 'MON/USD', instrument: 'spot', side: 'sell', stop: p(6_900_000n), takeProfit: p(6_500_000n) });
    expect(short.refusal?.code).toBe('spot_short_unsupported');
  });

  it('routes a MON/USD spot buy to the AUSD market in paper mode', async () => {
    const paper = new PaperExecutionClient();
    const svc = new ExecutionService({ router: paperRouter(paper), now: () => NOW });
    const report = await svc.execute({ ...longTrade, asset: 'MON/USD', instrument: 'spot' });
    expect(report).toMatchObject({ outcome: 'executed', venue: 'kuru' });
    expect(await paper.getPosition('MON/AUSD')).not.toBeNull();
  });
});

describe('ExecutionService on a venue with native triggers', () => {
  it('places the entry, then venue-native stop and take-profit linked to it', async () => {
    const venue = new NativeVenue();
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute({ ...longTrade, leverageX: 3, maxSlippageBps: 40 });

    expect(report).toMatchObject({ outcome: 'executed', mode: 'live', venue: 'perpl', executedOn: 'perpl' });
    expect(venue.orders[0]).toMatchObject({ clientOrderId: 't1:entry', side: 'buy', kind: 'market', leverageX: 3, maxSlippageBps: 40 });
    expect(venue.triggers.map((t) => [t.kind, t.direction, t.linkedToClientOrderId, t.leverageX])).toEqual([
      ['stop_loss', 'long', 't1:entry', 3],
      ['take_profit', 'long', 't1:entry', 3],
    ]);
    expect(formatDecimal(venue.triggers[0]!.triggerPrice)).toBe('67,000.00');
    expect(report.legs.map((l) => [l.role, l.protection ?? '-', l.status, l.venueOrderId])).toEqual([
      ['entry', '-', 'filled', 'oid-t1:entry'],
      ['stop_loss', 'venue_native', 'pending', 'oid-t1:stop'],
      ['take_profit', 'venue_native', 'pending', 'oid-t1:tp'],
    ]);
    expect(svc.pendingProtection()).toHaveLength(0); // nothing held client-side
  });

  it('sizes protection to what actually filled', async () => {
    const venue = new NativeVenue();
    venue.placeOrder = async (o) => {
      venue.orders.push(o);
      return { venue: 'perpl', clientOrderId: o.clientOrderId, status: 'filled', filledSize: size(30_000_000n), avgFillPrice: p(6_800_000n), timestamp: NOW };
    };
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    await svc.execute(longTrade);
    expect(venue.triggers[0]?.size).toEqual(size(30_000_000n));
  });

  it('reports a rejected entry and places no protection', async () => {
    const venue = new NativeVenue();
    venue.placeOrder = async (o) => ({ venue: 'perpl', clientOrderId: o.clientOrderId, status: 'rejected', reason: 'insufficient collateral', timestamp: NOW });
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute(longTrade);
    expect(report.outcome).toBe('rejected');
    expect(report.legs[0]?.reason).toBe('insufficient collateral');
    expect(venue.triggers).toEqual([]);
  });

  it('flattens the position when the stop is rejected after the entry filled', async () => {
    const venue = new NativeVenue();
    venue.rejectTrigger = 'stop_loss';
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute(longTrade);

    expect(report.outcome).toBe('flattened');
    const close = venue.orders.at(-1)!;
    expect(close).toMatchObject({ clientOrderId: 't1:close', side: 'sell', kind: 'market', reduceOnly: true });
    expect(report.legs.map((l) => l.role)).toEqual(['entry', 'stop_loss', 'emergency_close']);
    expect(report.notes.join(' ')).toContain('flattened');
  });

  it('cancels an already-placed take-profit if the second protective leg fails, then flattens', async () => {
    const venue = new NativeVenue();
    venue.rejectTrigger = 'take_profit';
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute(longTrade);
    expect(report.outcome).toBe('flattened');
    expect(venue.cancels).toEqual(['t1:stop']);
  });

  it('can be told to report instead of flatten', async () => {
    const venue = new NativeVenue();
    venue.rejectTrigger = 'stop_loss';
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW, onProtectiveFailure: 'report' });
    const report = await svc.execute(longTrade);
    expect(report.outcome).toBe('pending');
    expect(venue.orders).toHaveLength(1); // no close sent
    expect(report.notes.join(' ')).toContain('protection is missing');
  });

  it('cancels a still-pending entry rather than leave it resting unprotected', async () => {
    const venue = new NativeVenue();
    venue.entryStatus = 'pending';
    venue.rejectTrigger = 'stop_loss';
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute({ ...longTrade, entryKind: 'limit' });
    expect(report.outcome).toBe('rejected');
    expect(venue.cancels).toContain('t1:entry');
    expect(venue.orders[0]).toMatchObject({ kind: 'limit', price: longTrade.entry });
  });

  it('reports a resting entry with linked protection as pending', async () => {
    const venue = new NativeVenue();
    venue.entryStatus = 'pending';
    const svc = new ExecutionService({ router: nativeRouter(venue), now: () => NOW });
    const report = await svc.execute({ ...longTrade, entryKind: 'limit' });
    expect(report.outcome).toBe('pending');
    expect(venue.triggers).toHaveLength(2);
  });
});

describe('ExecutionService with a pending entry on a watcher venue', () => {
  it('holds client-side protection unarmed until the entry is confirmed filled', async () => {
    const paper = new PaperExecutionClient();
    // A paper client whose entry stays pending.
    const slow: ExecutionClient = Object.assign(Object.create(paper) as ExecutionClient, {
      placeOrder: async (o: Order): Promise<OrderResult> => ({ venue: 'paper', clientOrderId: o.clientOrderId, status: 'pending', timestamp: NOW }),
    });
    const svc = new ExecutionService({
      router: new VenueRouter({ paper: slow, perpl: { network: 'mainnet', mode: 'paper' }, kuru: { network: 'mainnet', mode: 'paper' } }),
      now: () => NOW,
    });
    const report = await svc.execute(longTrade);
    expect(report.outcome).toBe('pending');
    expect(report.notes.join(' ')).toContain('markEntryFilled');
    // Breach while unarmed: nothing fires.
    expect(await svc.evaluateProtection(series('BTC/USD', [candle(6_000_000n, 6_800_000n, 1)]))).toEqual([]);
    expect(svc.markEntryFilled('t1')).toBe(true);
    expect(svc.markEntryFilled('nope')).toBe(false);
  });
});
