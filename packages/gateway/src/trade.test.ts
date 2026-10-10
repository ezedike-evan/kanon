import type { VenueAccountView, VenueOrderResult, VenueRecorder, VenueService } from '@kanon/execution/venue-service';
import { loadConfig } from './config';
import type { Admission, ConvexRecorder } from './convex-recorder';
import { silentLogger } from './log';
import { createGateway, type Gateway } from './server';
import { FakeVenue } from './test-helpers';
import { TRADE_NOT_CONNECTED, createTradeRoutes } from './trade';

/**
 * `/trade` over real loopback sockets, as a browser tab would call it, with the
 * order service and the backend faked. What is under test is the HTTP face:
 * who gets through, what is passed on, and what comes back.
 */

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'aaa.bbb.ccc';
const READY = { status: 'ready', venue: 'perpl', network: 'testnet' } as unknown as VenueAccountView;
const FILLED = { status: 'filled', orderId: 'k17abc', asset: 'BTC/USD' } as unknown as VenueOrderResult;
const REFUSED: VenueOrderResult = { status: 'refused', reason: 'The account holds no BTC position.' };

let gateway: Gateway;
let port: number;
let admission: Admission;
let seen: { admitted: string[]; callers: string[]; accounts: number; orders: unknown[]; closes: string[] };

async function start(withTrade: boolean): Promise<void> {
  const venue = new FakeVenue();
  seen = { admitted: [], callers: [], accounts: 0, orders: [], closes: [] };
  admission = { ok: true };
  const callerRecorder = {} as VenueRecorder;
  const recorder: ConvexRecorder = {
    admit: async (token) => (seen.admitted.push(token), admission),
    forCaller: (token) => (seen.callers.push(token), callerRecorder),
  };
  const service: VenueService = {
    account: async () => (seen.accounts++, READY),
    placeOrder: async (request, r) => (seen.orders.push([request, r === callerRecorder]), FILLED),
    closePosition: async (asset, r) => (seen.closes.push(`${asset}:${r === callerRecorder}`), REFUSED),
  };
  gateway = createGateway({
    config: loadConfig({ PORT: '0', HOST: '127.0.0.1' }),
    log: silentLogger,
    socketFactory: venue.factory,
    fetchImpl: (async () => new Response(JSON.stringify({ markets: [{ id: 16 }] }))) as typeof fetch,
    ...(withTrade ? { trade: createTradeRoutes({ service, recorder, log: silentLogger }) } : {}),
  });
  port = await gateway.listen();
  venue.last.open();
}

afterEach(async () => {
  await gateway.close();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { origin: ORIGIN, ...init.headers } });
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const order = { asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 };

describe('with no key configured', () => {
  beforeEach(() => start(false));

  it('says trading is not connected, on every path the ticket calls', async () => {
    for (const res of [await call('/trade/account', { headers: auth }), await post('/trade/order', order), await post('/trade/close', { asset: 'BTC/USD' })]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'unavailable', message: TRADE_NOT_CONNECTED });
    }
  });

  it('still serves market data', async () => {
    expect((await call('/livez')).status).toBe(200);
  });
});

describe('with a key configured', () => {
  beforeEach(() => start(true));

  it('answers a browser that asks before it posts', async () => {
    const res = await call('/trade/order', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    // Market data stays read-only.
    expect((await call('/v1/pub/context', { method: 'OPTIONS' })).headers.get('access-control-allow-methods')).toBe('GET');
  });

  it('turns away an origin that is not allowed before anything else', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/trade/account`, { headers: { origin: 'https://evil.example', ...auth } });
    expect(res.status).toBe(403);
    expect(seen.admitted).toEqual([]);
  });

  it('reads the account for a caller the backend admits, and never caches it', async () => {
    const res = await call('/trade/account', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual(READY);
    expect(seen.admitted).toEqual([TOKEN]);
    expect(seen.accounts).toBe(1);
  });

  it('reads nothing with no token, or with something that is not one', async () => {
    for (const headers of [{}, { authorization: 'Bearer not-a-token' }, { authorization: `Basic ${TOKEN}` }]) {
      const res = await call('/trade/account', { headers });
      expect(await res.json()).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    }
    expect(seen.admitted).toEqual([]);
    expect(seen.accounts).toBe(0);
  });

  it('reads nothing for a caller the backend does not admit, and says why', async () => {
    const cases: Array<[Admission, string]> = [
      [{ ok: false, code: 'unauthenticated' }, 'Sign in to trade.'],
      [{ ok: false, code: 'rate_limited', retryAfterMs: 60_000, message: 'Rate limit reached for now.' }, 'Rate limit reached for now.'],
      [{ ok: false, code: 'unreachable' }, 'Your sign-in could not be checked. Try again.'],
    ];
    for (const [answer, message] of cases) {
      admission = answer;
      expect(await (await call('/trade/account', { headers: auth })).json()).toEqual({ status: 'unavailable', message });
    }
    expect(seen.accounts).toBe(0);
  });

  it("passes an order to the service with the caller's own recorder", async () => {
    const res = await post('/trade/order', order);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FILLED);
    expect(seen.orders).toEqual([[order, true]]);
    expect(seen.callers).toEqual([TOKEN]);
  });

  it('sends no order without a token', async () => {
    const res = await post('/trade/order', order, {});
    expect(await res.json()).toEqual({ status: 'unavailable', message: 'Sign in to trade.' });
    expect(seen.orders).toEqual([]);
  });

  it('turns away a body that is not an order', async () => {
    for (const body of [
      { ...order, side: 'sideways' },
      { ...order, usd: '25' },
      { ...order, userId: 'someone-else' },
      { asset: 'BTC/USD' },
      'not json',
    ]) {
      expect((await post('/trade/order', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post('/trade/order', { ...order, asset: 'B'.repeat(4000) })).status).toBe(413);
    expect(seen.orders).toEqual([]);
  });

  it('returns a refusal as an answer, not as a fault', async () => {
    const res = await post('/trade/close', { asset: 'BTC/USD' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REFUSED);
    expect(seen.closes).toEqual(['BTC/USD:true']);
  });

  it('knows its three paths and their methods', async () => {
    const wrong = await call('/trade/order', { headers: auth });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await post('/trade/account', {})).status).toBe(405);
    expect((await call('/trade/withdraw', { headers: auth })).status).toBe(404);
    expect(seen.orders).toEqual([]);
  });
});
