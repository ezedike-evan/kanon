import { silentLogger } from './log';
import { RestProxy, route, type RestProxyOptions } from './rest';

const NOW = 1_800_000_000_000;
const known = (id: number) => id === 16;
const at = (path: string, query = '') => route(path, new URLSearchParams(query), NOW, known);

describe('route', () => {
  it('forwards the public market-data paths', () => {
    expect(at('/v1/pub/context')).toMatchObject({ ok: true, route: { upstream: '/v1/pub/context' } });
    expect(at('/v1/market-data/ticker')).toMatchObject({ ok: true, route: { upstream: '/v1/market-data/ticker' } });
    expect(at('/v1/market-data/16/ticker')).toMatchObject({ ok: true });
    expect(at('/v1/market-data/16/book')).toMatchObject({ ok: true, route: { upstream: '/v1/market-data/16/book' } });
    expect(at('/v1/market-data/16/funding/1-2')).toMatchObject({ ok: true });
    expect(at('/v1/market-data/funding/1-2')).toMatchObject({ ok: true });
  });

  it('keeps a candle range that has fully closed for hours, and one still forming for a second', () => {
    const step = 900_000;
    const closed = at(`/v1/market-data/16/candles/900/${NOW - 500 * step}-${NOW - 2 * step}`);
    expect(closed).toMatchObject({ ok: true, route: { ttlMs: 6 * 3_600_000, maxAgeSeconds: 3_600 } });

    // Ends before now, but a candle that opened inside the range is still forming.
    const forming = at(`/v1/market-data/16/candles/900/${NOW - 500 * step}-${NOW - 60_000}`);
    expect(forming).toMatchObject({ ok: true, route: { ttlMs: 1_000, maxAgeSeconds: 1 } });
  });

  it('passes only a valid levels parameter on, and drops any other query', () => {
    expect(at('/v1/market-data/16/book', 'levels=10&x=1')).toMatchObject({
      ok: true,
      route: { upstream: '/v1/market-data/16/book?levels=10' },
    });
    expect(at('/v1/market-data/16/book', 'levels=500')).toMatchObject({ ok: false, status: 400 });
    expect(at('/v1/market-data/16/ticker', 'a=b')).toMatchObject({ route: { upstream: '/v1/market-data/16/ticker' } });
  });

  it.each([
    ['an unknown market', '/v1/market-data/999/ticker', 400],
    ['an unsupported resolution', '/v1/market-data/16/candles/61/1-2', 400],
    ['a reversed range', '/v1/market-data/16/candles/60/5-2', 400],
    ['more candles than the venue serves at once', `/v1/market-data/16/candles/60/0-${1025 * 60_000}`, 400],
    ['a trading path', '/v1/trading/orders', 404],
    ['a profile path', '/v1/profile/ref-code', 404],
    ['a path under a public one', '/v1/market-data/16/ticker/extra', 404],
    ['a traversal', '/v1/market-data/16/../../trading/orders', 404],
  ])('refuses %s', (_label, path, status) => {
    expect(at(path)).toMatchObject({ ok: false, status });
  });

  it('leaves the market id to the venue while the market list is not loaded', () => {
    expect(route('/v1/market-data/999/ticker', new URLSearchParams(), NOW, () => null)).toMatchObject({ ok: true });
  });
});

describe('RestProxy', () => {
  function setup(overrides: Partial<RestProxyOptions> = {}, respond: () => Response | Promise<Response> = () => new Response('{"d":[]}')) {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => respond());
    const proxy = new RestProxy({
      baseUrl: 'https://venue.test/api',
      log: silentLogger,
      isKnownMarket: known,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...overrides,
    });
    const get = (path: string, query = '') => proxy.get(path, new URLSearchParams(query));
    return { proxy, fetchImpl, get };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the venue once and answers repeats from memory until the entry expires', async () => {
    const { fetchImpl, get } = setup();
    const first = await get('/v1/market-data/16/ticker');
    expect(first).toEqual({ status: 200, body: '{"d":[]}', cacheControl: 'public, max-age=1' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://venue.test/api/v1/market-data/16/ticker');

    expect(await get('/v1/market-data/16/ticker')).toEqual({ ...first, cached: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_100);
    await get('/v1/market-data/16/ticker');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one venue request between callers that arrive together', async () => {
    let release!: (r: Response) => void;
    const { fetchImpl, get } = setup({}, () => new Promise<Response>((r) => (release = r)));
    const a = get('/v1/market-data/ticker');
    const b = get('/v1/market-data/ticker');
    await Promise.resolve();
    release(new Response('{"ok":1}'));
    expect((await a).body).toBe('{"ok":1}');
    expect((await b).body).toBe('{"ok":1}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes a venue refusal through and does not remember it', async () => {
    const { fetchImpl, get } = setup({}, () => new Response('{"error":"not ready"}', { status: 503 }));
    expect(await get('/v1/market-data/16/book')).toEqual({ status: 503, body: '{"error":"not ready"}', cacheControl: 'no-store' });
    await get('/v1/market-data/16/book');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when the venue fails or cannot be reached', async () => {
    const down = setup({}, () => Promise.reject(new TypeError('fetch failed')));
    expect(await down.get('/v1/market-data/ticker')).toMatchObject({ status: 502, cacheControl: 'no-store' });
    const broken = setup({}, () => new Response('oops', { status: 500 }));
    expect(await broken.get('/v1/market-data/ticker')).toMatchObject({ status: 502 });
  });

  it('never calls the venue for a path it does not serve', async () => {
    const { fetchImpl, get } = setup();
    expect((await get('/v1/trading/orders')).status).toBe(404);
    expect((await get('/v1/market-data/999/ticker')).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers 429 instead of exceeding its venue request budget, and recovers', async () => {
    const { fetchImpl, get } = setup({ burst: 2, perSecond: 1 });
    const range = (i: number) => `/v1/market-data/16/candles/60/${i * 60_000}-${(i + 1) * 60_000}`;
    expect((await get(range(1))).status).toBe(200);
    expect((await get(range(2))).status).toBe(200);
    expect((await get(range(3))).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect((await get(range(3))).status).toBe(200);
  });

  it('forgets the entries used least recently once it is full', async () => {
    const { fetchImpl, get } = setup({ maxEntries: 2 });
    const range = (i: number) => `/v1/market-data/16/candles/60/${i * 60_000}-${(i + 1) * 60_000}`;
    await get(range(1));
    await get(range(2));
    await get(range(1)); // now the most recently used
    await get(range(3)); // evicts range 2
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await get(range(1));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await get(range(2));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
