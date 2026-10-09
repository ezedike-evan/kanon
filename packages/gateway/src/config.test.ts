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
