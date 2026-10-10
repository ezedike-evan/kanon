import { ConfigError, loadConfig, originAllowed } from './config';

describe('loadConfig', () => {
  it('defaults to Perpl testnet and the local dev origins', () => {
    expect(loadConfig({})).toEqual({
      network: 'testnet',
      chainId: 10143,
      restUrl: 'https://testnet.perpl.xyz/api',
      wsUrl: 'wss://testnet.perpl.xyz/ws/v1/market-data',
      port: 8787,
      host: '0.0.0.0',
      allowedOrigins: ['http://localhost:3000', 'http://localhost:8081'],
      warmStreams: [],
      maxUpstreamConnections: 3,
      lingerMs: 300_000,
      maxClients: 2000,
      forceIpv4: false,
      trade: null,
    });
  });

  it('reads mainnet, overrides and lists', () => {
    const cfg = loadConfig({
      PERPL_NETWORK: 'mainnet',
      PERPL_REST_URL: 'https://example.test/api/',
      PORT: '9000',
      GATEWAY_ALLOWED_ORIGINS: 'https://kanon.example, https://www.kanon.example',
      GATEWAY_WARM_STREAMS: 'candles@1*900, trades@1',
      GATEWAY_LINGER_SECONDS: '30',
      FORCE_IPV4: 'true',
    });
    expect(cfg).toMatchObject({
      network: 'mainnet',
      chainId: 143,
      restUrl: 'https://example.test/api',
      wsUrl: 'wss://app.perpl.xyz/ws/v1/market-data',
      port: 9000,
      allowedOrigins: ['https://kanon.example', 'https://www.kanon.example'],
      warmStreams: ['candles@1*900', 'trades@1'],
      lingerMs: 30_000,
      forceIpv4: true,
    });
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ PORT: '', PERPL_NETWORK: '' })).toMatchObject({ port: 8787, network: 'testnet' });
  });

  it('accepts any origin only when told to', () => {
    expect(loadConfig({ GATEWAY_ALLOWED_ORIGINS: '*' }).allowedOrigins).toBe('*');
  });

  it.each([
    ['an unknown network', { PERPL_NETWORK: 'devnet' }],
    ['an origin with a path', { GATEWAY_ALLOWED_ORIGINS: 'https://kanon.example/app' }],
    ['a warm stream on the wrong chain', { GATEWAY_WARM_STREAMS: 'market-state@143' }],
    ['a warm stream that is not one', { GATEWAY_WARM_STREAMS: 'candles@16*61' }],
    ['a port out of range', { PORT: '70000' }],
    ['a socket URL that is not one', { PERPL_WS_URL: 'https://app.perpl.xyz' }],
  ])('refuses %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe('trading settings', () => {
  const trade = {
    PERPL_API_KEY: 'pk_test_example',
    PERPL_API_KEY_SECRET: 'ab'.repeat(32),
    CONVEX_SITE_URL: 'https://example-123.convex.site/',
    VENUE_RECORDER_KEY: 'r'.repeat(48),
  };

  it('is off, and holds no key, when none of them is set', () => {
    expect(loadConfig({}).trade).toBeNull();
    expect(loadConfig({ PERPL_TRADE_NETWORK: 'mainnet' }).trade).toBeNull();
  });

  it('is on with all four, on testnet unless told otherwise', () => {
    expect(loadConfig(trade).trade).toEqual({
      apiKey: 'pk_test_example',
      secret: 'ab'.repeat(32),
      network: 'testnet',
      convexSiteUrl: 'https://example-123.convex.site',
      recorderKey: 'r'.repeat(48),
    });
    expect(loadConfig({ ...trade, PERPL_TRADE_NETWORK: 'mainnet' }).trade?.network).toBe('mainnet');
  });

  it('keeps the order network apart from the market data network', () => {
    const cfg = loadConfig({ ...trade, PERPL_NETWORK: 'mainnet' });
    expect(cfg.network).toBe('mainnet');
    expect(cfg.trade?.network).toBe('testnet');
  });

  it('refuses to start half-connected, and names what is missing', () => {
    const { VENUE_RECORDER_KEY: _key, ...partial } = trade;
    expect(() => loadConfig(partial)).toThrow(/Not set: VENUE_RECORDER_KEY$/);
    expect(() => loadConfig({ PERPL_API_KEY: trade.PERPL_API_KEY })).toThrow(
      /Not set: PERPL_API_KEY_SECRET, CONVEX_SITE_URL, VENUE_RECORDER_KEY$/,
    );
  });

  it('never repeats a value in what it reports', () => {
    for (const env of [
      { ...trade, VENUE_RECORDER_KEY: 'too-short-recorder-key' },
      { ...trade, PERPL_API_KEY_SECRET: 'too-short-secret' },
      { ...trade, CONVEX_SITE_URL: 'not-a-url-but-secretish' },
    ]) {
      let message = '';
      try {
        loadConfig(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toMatch(/too-short|secretish/);
    }
  });
});

describe('originAllowed', () => {
  it('allows listed origins, and requests that carry none', () => {
    const allowed = ['https://kanon.example'];
    expect(originAllowed('https://kanon.example', allowed)).toBe(true);
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
    expect(originAllowed('https://kanon.example.evil.example', allowed)).toBe(false);
    expect(originAllowed(undefined, allowed)).toBe(true);
    expect(originAllowed('https://anything.example', '*')).toBe(true);
  });
});
