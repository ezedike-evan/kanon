import { describe, expect, it } from 'vitest';
import {
  TRADE_NOT_CONNECTED,
  TRADE_UNREACHABLE,
  createVenueTradeActions,
  disconnectedVenueTrade,
  resolveVenueTrade,
} from './venue-trade-client';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(answer: () => Response | Promise<Response>, token: string | null = 'aaa.bbb.ccc') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return answer();
  }) as typeof fetch;
  const actions = createVenueTradeActions({ baseUrl: ' http://localhost:8787/ ', getToken: async () => token, fetchImpl });
  return { actions, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const order = { asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 } as const;

describe('createVenueTradeActions', () => {
  it("reads the account from the gateway with the caller's own token", async () => {
    const ready = { status: 'ready', network: 'testnet' };
    const { actions, calls } = setup(() => json(ready));
    expect(await actions.account()).toEqual(ready);
    expect(calls).toEqual([
      { url: 'http://localhost:8787/trade/account', method: 'GET', headers: { authorization: 'Bearer aaa.bbb.ccc' }, body: undefined },
    ]);
  });

  it('posts an order and a close, and names nobody in either', async () => {
    const { actions, calls } = setup(() => json({ status: 'refused', reason: 'no' }));
    expect(await actions.placeOrder(order)).toEqual({ status: 'refused', reason: 'no' });
    await actions.closePosition({ asset: 'BTC/USD' });
    expect(calls.map((c) => [c.url, c.method, c.body])).toEqual([
      ['http://localhost:8787/trade/order', 'POST', order],
      ['http://localhost:8787/trade/close', 'POST', { asset: 'BTC/USD' }],
    ]);
    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer aaa.bbb.ccc', 'content-type': 'application/json' });
  });

  it('calls nothing while nobody is signed in', async () => {
    const { actions, calls } = setup(() => json({}), null);
    const signIn = { status: 'unavailable', message: 'Sign in to trade.' };
    expect(await actions.account()).toEqual(signIn);
    expect(await actions.placeOrder(order)).toEqual(signIn);
    expect(await actions.closePosition({ asset: 'BTC/USD' })).toEqual(signIn);
    expect(calls).toEqual([]);
  });

  it('says the service could not be reached when a read of the account fails', async () => {
    const unreachable = { status: 'unavailable', message: TRADE_UNREACHABLE };
    expect(await setup(() => Promise.reject(new TypeError('Failed to fetch'))).actions.account()).toEqual(unreachable);
    expect(await setup(() => json({ error: 'boom' }, 500)).actions.account()).toEqual(unreachable);
  });

  it('throws when an order cannot be read, since it may have gone out', async () => {
    await expect(setup(() => Promise.reject(new TypeError('Failed to fetch'))).actions.placeOrder(order)).rejects.toThrow();
    await expect(setup(() => json({ error: 'boom' }, 500)).actions.closePosition({ asset: 'BTC/USD' })).rejects.toThrow(/500/);
  });
});

describe('with no gateway address', () => {
  it('resolves to nothing, and the stand-in says trading is not connected', async () => {
    expect(resolveVenueTrade(undefined, async () => 'aaa.bbb.ccc')).toBeUndefined();
    expect(resolveVenueTrade('   ', async () => 'aaa.bbb.ccc')).toBeUndefined();
    expect(resolveVenueTrade('http://localhost:8787', async () => null)).toBeDefined();
    const off = { status: 'unavailable', message: TRADE_NOT_CONNECTED };
    expect(await disconnectedVenueTrade.account()).toEqual(off);
    expect(await disconnectedVenueTrade.placeOrder(order)).toEqual(off);
    expect(await disconnectedVenueTrade.closePosition({ asset: 'BTC/USD' })).toEqual(off);
  });
});
