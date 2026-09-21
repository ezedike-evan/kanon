import { describe, expect, it, vi } from 'vitest';
import { formatDecimal, parseDecimal } from '@kanon/spec';
import { PaperExecutionClient } from './paper';

const DP = 2;
function p(value: string) {
  return parseDecimal(value, DP);
}

describe('PaperExecutionClient', () => {
  it('fills a market order instantly at the last pushed price', async () => {
    const client = new PaperExecutionClient();
    client.pushTick('BTC/USD', { timestamp: 1000, price: p('68000.00') });

    const result = await client.placeOrder({
      clientOrderId: 'o1',
      asset: 'BTC/USD',
      side: 'buy',
      kind: 'market',
      size: p('0.50'),
    });

    expect(result.venue).toBe('paper');
    expect(result.status).toBe('filled');
    expect(formatDecimal(result.avgFillPrice!)).toBe('68,000.00');
    expect(formatDecimal(result.filledSize!)).toBe('0.50');
  });

  it('fills a limit order at its own limit price, not the last tick', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('68000.00') } });

    const result = await client.placeOrder({
      clientOrderId: 'o2',
      asset: 'BTC/USD',
      side: 'sell',
      kind: 'limit',
      price: p('69000.00'),
      size: p('0.25'),
    });

    expect(result.status).toBe('filled');
    expect(formatDecimal(result.avgFillPrice!)).toBe('69,000.00');
  });

  it('rejects an order for an asset with no known price and never fills it', async () => {
    const client = new PaperExecutionClient();
    const result = await client.placeOrder({
      clientOrderId: 'o3',
      asset: 'ETH/USD',
      side: 'buy',
      kind: 'market',
      size: p('1.00'),
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/no known price/);
  });

  it('tracks a position across fills, long size increasing on buys', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('68000.00') } });
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('1.00') });
    await client.placeOrder({ clientOrderId: 'b', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('0.50') });

    const position = await client.getPosition('BTC/USD');
    expect(position).not.toBeNull();
    expect(formatDecimal(position!.size)).toBe('1.50');
  });

  it('reduces a long position on a sell fill', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('68000.00') } });
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('1.00') });
    await client.placeOrder({ clientOrderId: 'b', asset: 'BTC/USD', side: 'sell', kind: 'market', size: p('0.40') });

    const position = await client.getPosition('BTC/USD');
    expect(formatDecimal(position!.size)).toBe('0.60');
  });

  it('returns null for a position that was never opened', async () => {
    const client = new PaperExecutionClient();
    expect(await client.getPosition('BTC/USD')).toBeNull();
  });

  it('reports every filled order as uncancellable, since fills are instant', async () => {
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('68000.00') } });
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('1.00') });
    const cancel = await client.cancelOrder('a');
    expect(cancel.cancelled).toBe(false);
  });

  it('notifies market-data subscribers on pushTick and honours unsubscribe', () => {
    const client = new PaperExecutionClient();
    const onTick = vi.fn();
    const unsubscribe = client.subscribeMarketData('BTC/USD', onTick);

    client.pushTick('BTC/USD', { timestamp: 1, price: p('100.00') });
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith({ timestamp: 1, price: p('100.00') });

    unsubscribe();
    client.pushTick('BTC/USD', { timestamp: 2, price: p('101.00') });
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('never calls fetch or opens a network connection', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('PaperExecutionClient must never call fetch');
    }) as typeof fetch;
    try {
      const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('1.00') } });
      await client.placeOrder({ clientOrderId: 'x', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('1.00') });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('logs every fill with a [paper] prefix so it cannot be mistaken for a live trade', async () => {
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = new PaperExecutionClient({ initialPrices: { 'BTC/USD': p('68000.00') } });
    await client.placeOrder({ clientOrderId: 'a', asset: 'BTC/USD', side: 'buy', kind: 'market', size: p('1.00') });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[paper]'));
    logSpy.mockRestore();
  });
});
