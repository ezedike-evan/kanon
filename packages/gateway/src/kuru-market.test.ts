import type { KuruMarketView } from '@kanon/execution/kuru-market-view';
import { loadConfig } from './config';
import { KURU_BOOK_TTL_MS, KURU_MARKET_PATH, KURU_MESSAGES, createKuruMarketRoute } from './kuru-market';
import { silentLogger } from './log';
import { createGateway, type Gateway } from './server';
import { FakeVenue } from './test-helpers';

/**
 * The Kuru market route: what is listed is served, what is not is said not to
 * be, and a read that fails is never papered over with an older book.
 */

const view = (blockNumber: number): KuruMarketView => ({
  ok: true,
  asset: 'tkBTC/USDC',
  network: 'testnet',
  chainId: 10143,
  market: '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41',
  base: { address: '0x85495222Fd7069B987Ca38C2142732EbBFb7175D', name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
  quote: { address: '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C', name: 'Mock USDC', symbol: 'USDC', decimals: 6, kind: 'mock, open mint' },
  note: 'tkBTC is a test token. It is not bitcoin.',
  priceDecimals: 4,
  sizeDecimals: 9,
  minSize: { atoms: '100000', decimals: 9 },
  maxSize: { atoms: '1000000000', decimals: 9 },
  takerFeeBps: 30,
  bids: [{ price: { atoms: '824475248', decimals: 4 }, size: { atoms: '250000000', decimals: 9 } }],
  asks: [{ price: { atoms: '832720000', decimals: 4 }, size: { atoms: '248756210', decimals: 9 } }],
  blockNumber,
  readAt: 0,
  listing: { marketTx: `0x${'b2'.repeat(32)}`, tokenTx: `0x${'a1'.repeat(32)}` },
});

describe('createKuruMarketRoute', () => {
  it('says nothing is listed where there is no listing, and reads nothing', async () => {
    const route = createKuruMarketRoute({ read: null, log: silentLogger });
    expect(await route.get()).toEqual({ ok: false, code: 'not_listed', message: KURU_MESSAGES.notListed });
  });

  it('answers many callers from one read, for as long as a read is fresh', async () => {
    let clock = 1_000;
    let reads = 0;
    const route = createKuruMarketRoute({
      read: async () => view(++reads),
      log: silentLogger,
      now: () => clock,
    });
    // Three at once share the read that is out.
    const first = await Promise.all([route.get(), route.get(), route.get()]);
    expect(first.map((a) => a.ok && a.blockNumber)).toEqual([1, 1, 1]);
    clock += KURU_BOOK_TTL_MS - 1;
    expect(await route.get()).toMatchObject({ blockNumber: 1 });
    expect(reads).toBe(1);
    clock += 1;
    expect(await route.get()).toMatchObject({ blockNumber: 2 });
    expect(reads).toBe(2);
  });

  it('a read that fails is said to have failed: an older book is not served as the book', async () => {
    let clock = 0;
    let fail = false;
    const route = createKuruMarketRoute({
      read: async () => {
        if (fail) throw new Error('rpc down');
        return view(7);
      },
      log: silentLogger,
      now: () => clock,
    });
    expect(await route.get()).toMatchObject({ ok: true, blockNumber: 7 });
    fail = true;
    clock += KURU_BOOK_TTL_MS;
    expect(await route.get()).toEqual({ ok: false, code: 'unreachable', message: KURU_MESSAGES.unreachable });
    // And the next read is tried again, not remembered as failed.
    fail = false;
    expect(await route.get()).toMatchObject({ ok: true, blockNumber: 7 });
  });
});

describe('GET /kuru/market', () => {
  let gateway: Gateway;
  let port: number;
  const start = async (kuru?: ReturnType<typeof createKuruMarketRoute>) => {
    const venue = new FakeVenue();
    gateway = createGateway({
      config: loadConfig({ PORT: '0', HOST: '127.0.0.1' }),
      log: silentLogger,
      socketFactory: venue.factory,
      fetchImpl: (async () => new Response(JSON.stringify({ markets: [{ id: 16 }] }))) as typeof fetch,
      ...(kuru ? { kuru } : {}),
    });
    port = await gateway.listen();
    venue.last.open();
  };
  afterEach(async () => {
    await gateway.close();
  });
  const get = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${KURU_MARKET_PATH}`, { headers });

  it('serves the listed market to anybody, with no sign-in, and is not cached by a browser', async () => {
    await start(createKuruMarketRoute({ read: async () => view(9), log: silentLogger }));
    const res = await get({ origin: 'http://localhost:3000' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(await res.json()).toMatchObject({ ok: true, asset: 'tkBTC/USDC', blockNumber: 9 });
  });

  it('with nothing listed it answers 200 and says so, and the venue is not asked for it', async () => {
    await start();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, code: 'not_listed', message: KURU_MESSAGES.notListed });
  });

  it('is read-only: a POST is not an order', async () => {
    await start(createKuruMarketRoute({ read: async () => view(9), log: silentLogger }));
    const res = await fetch(`http://127.0.0.1:${port}${KURU_MARKET_PATH}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
  });
});
