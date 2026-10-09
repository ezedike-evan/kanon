import WebSocket from 'ws';
import { loadConfig } from './config';
import { silentLogger } from './log';
import { WS_PATH, createGateway, type Gateway } from './server';
import { FakeVenue } from './test-helpers';

/**
 * The whole process over real loopback sockets, with the venue faked: a client
 * connects the way a browser tab would and the test plays Perpl.
 */

const ORIGIN = 'http://localhost:3000';
let gateway: Gateway;
let venue: FakeVenue;
let port: number;
let fetched: string[];

beforeEach(async () => {
  venue = new FakeVenue();
  fetched = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return String(url).endsWith('/v1/pub/context')
      ? new Response(JSON.stringify({ markets: [{ id: 16 }, { id: 32 }] }))
      : new Response('{"mt":12,"r":900,"d":[]}');
  }) as typeof fetch;
  gateway = createGateway({
    config: loadConfig({ PORT: '0', HOST: '127.0.0.1' }),
    log: silentLogger,
    socketFactory: venue.factory,
    fetchImpl,
  });
  port = await gateway.listen();
  venue.last.open();
});
afterEach(async () => {
  await gateway.close();
});

/** Connects and collects parsed frames; `next` resolves once `count` have arrived. */
function connect(origin: string | undefined = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, origin ? { headers: { origin } } : {});
  const frames: Array<Record<string, unknown>> = [];
  let wake: (() => void) | null = null;
  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()));
    wake?.();
  });
  const next = async (count: number) => {
    while (frames.length < count) await new Promise<void>((r) => (wake = r));
    return frames;
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, frames, next, opened };
}

const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

it('relays venue frames to a subscribed browser client, and a snapshot to the next one', async () => {
  const a = connect();
  await a.opened;
  a.ws.send(JSON.stringify({ mt: 5, subs: [{ stream: 'candles@16*900', subscribe: true }] }));
  await a.next(1);
  expect(a.frames[0]).toEqual({ mt: 6, subs: [{ stream: 'candles@16*900', status: { code: 0 } }] });

  // The gateway asked the venue; now the venue answers.
  await vi.waitFor(() => expect(venue.last.subscribed()).toContain('candles@16*900'));
  venue.last.ack([{ stream: 'candles@16*900', sid: 300001603 }]);
  const snapshot = { mt: 11, sid: 300001603, at: { b: 1, t: 1 }, r: 900, d: [{ t: 0, o: 1, c: 2, h: 3, l: 1, v: '5', n: 1 }] };
  venue.last.frame(snapshot);
  await a.next(2);
  expect(a.frames[1]).toEqual({ stream: 'candles@16*900', ...snapshot });

  const b = connect(undefined); // a native app sends no Origin
  await b.opened;
  b.ws.send(JSON.stringify({ mt: 5, subs: [{ stream: 'candles@16*900', subscribe: true }] }));
  await b.next(2);
  expect(b.frames[1]).toEqual({ stream: 'candles@16*900', ...snapshot });
  expect(venue.sockets).toHaveLength(1);
  a.ws.close();
  b.ws.close();
});

it('answers an application-level ping', async () => {
  const a = connect();
  await a.opened;
  a.ws.send('{"mt":1}');
  expect((await a.next(1))[0]).toEqual({ mt: 2 });
  a.ws.close();
});

it('refuses a socket from an origin that is not allowed, or on another path', async () => {
  await expect(connect('https://evil.example').opened).rejects.toThrow(/403/);
  const elsewhere = new WebSocket(`ws://127.0.0.1:${port}/ws/v1/trading`, { headers: { origin: ORIGIN } });
  await expect(new Promise((_, reject) => elsewhere.once('error', reject))).rejects.toThrow(/404/);
});

it('closes a client that sends something other than JSON', async () => {
  const a = connect();
  await a.opened;
  const closed = new Promise<number>((resolve) => a.ws.once('close', (code) => resolve(code)));
  a.ws.send('subscribe please');
  expect(await closed).toBe(1007);
});

it('serves candle history over HTTP with CORS for an allowed origin, from memory the second time', async () => {
  const path = '/v1/market-data/16/candles/900/1000000000000-1000900000000';
  const first = await get(path, { origin: ORIGIN });
  expect(first.status).toBe(200);
  expect(first.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(first.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(first.headers.get('x-kanon-cache')).toBe('miss');
  expect(await first.json()).toEqual({ mt: 12, r: 900, d: [] });

  expect((await get(path, { origin: ORIGIN })).headers.get('x-kanon-cache')).toBe('hit');
  expect(fetched.filter((u) => u.endsWith(path))).toEqual([`https://testnet.perpl.xyz/api${path}`]);
});

it('refuses HTTP from an origin that is not allowed, writes of any kind, and paths it does not serve', async () => {
  expect((await get('/v1/market-data/ticker', { origin: 'https://evil.example' })).status).toBe(403);
  expect((await fetch(`http://127.0.0.1:${port}/v1/market-data/ticker`, { method: 'POST' })).status).toBe(405);
  expect((await get('/v1/trading/orders')).status).toBe(404);
});

it('reports health from the state of the venue connection', async () => {
  const up = await get('/healthz');
  expect(up.status).toBe(200);
  expect(await up.json()).toMatchObject({ ok: true, network: 'testnet', clients: 0 });

  venue.last.drop(1006, '');
  expect((await get('/healthz')).status).toBe(503);
  // The host's liveness check does not follow the venue down.
  expect((await get('/livez')).status).toBe(200);
});
