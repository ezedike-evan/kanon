import { describe, expect, it, vi } from 'vitest';
import {
  NANSEN_BASE_URL,
  NANSEN_NETFLOW_PATH,
  NANSEN_TOKENS,
  buildNetflowRequest,
  classifyHttpStatus,
  fetchSmartMoneyFlow,
  isFresh,
  nansenTokenFor,
  type FetchLike,
} from './nansenLogic';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const WBTC = NANSEN_TOKENS['BTC/USD']!;

const row = (over: Record<string, unknown> = {}) => ({
  token_address: WBTC.address,
  token_symbol: 'WBTC',
  chain: 'ethereum',
  net_flow_1h_usd: -1_204.5,
  net_flow_24h_usd: 4_820_113.37,
  net_flow_7d_usd: -12_000_000,
  net_flow_30d_usd: 91_250_000.005,
  trader_count: 41,
  token_sectors: ['Bitcoin'],
  token_age_days: 2400,
  market_cap_usd: 9_000_000_000,
  ...over,
});

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const mock = (res: ReturnType<typeof respond> | Error) =>
  vi.fn<FetchLike>(async () => {
    if (res instanceof Error) throw res;
    return res;
  });

const call = (fetch: FetchLike, apiKey: string | undefined = 'test-key', asset = 'BTC/USD') =>
  fetchSmartMoneyFlow(asset, { apiKey, fetch, now: NOW });

describe('no key', () => {
  it('is not_connected and makes no request', async () => {
    const f = mock(respond(200, { data: [row()] }));
    const keyless = () => fetchSmartMoneyFlow('BTC/USD', { apiKey: undefined, fetch: f, now: NOW });
    expect(await keyless()).toEqual({ status: 'not_connected' });
    expect(await call(f, '')).toEqual({ status: 'not_connected' });
    expect(await call(f, '   ')).toEqual({ status: 'not_connected' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('asset mapping', () => {
  it('names the on-chain token an asset is read through', () => {
    expect(nansenTokenFor('btc / usd')).toMatchObject({ chain: 'ethereum', symbol: 'WBTC' });
    expect(nansenTokenFor('ETH/USD')).toMatchObject({ symbol: 'WETH' });
  });

  it('is unsupported for an asset with no honest proxy, without asking Nansen', async () => {
    const f = mock(respond(200, { data: [] }));
    expect(await call(f, 'k', 'DOGE/USD')).toEqual({ status: 'unsupported', asset: 'DOGE/USD' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('request', () => {
  it('posts the documented body with the apikey header', async () => {
    const f = mock(respond(200, { data: [row()] }));
    await call(f, 'secret');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${NANSEN_BASE_URL}${NANSEN_NETFLOW_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('secret');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(buildNetflowRequest(WBTC));
    expect(JSON.parse(init.body)).toEqual({
      chains: ['ethereum'],
      filters: { token_address: WBTC.address, include_native_tokens: true },
      pagination: { page: 1, per_page: 10 },
    });
  });
});

describe('a successful read', () => {
  it('converts every flow to integer cents at the boundary', async () => {
    const f = mock(respond(200, { data: [row()] }, { 'x-request-id': 'req-123' }));
    const out = await call(f);
    expect(out).toEqual({
      status: 'ok',
      asset: 'BTC/USD',
      token: WBTC,
      flows: {
        h1: { atoms: '-120450', decimals: 2 },
        h24: { atoms: '482011337', decimals: 2 },
        d7: { atoms: '-1200000000', decimals: 2 },
        d30: { atoms: '9125000001', decimals: 2 },
      },
      traderCount: 41,
      fetchedAt: NOW,
      requestId: 'req-123',
    });
  });

  it('reads only the row for the token asked about, whatever case the address is in', async () => {
    const other = row({ token_address: '0xdeadbeef', net_flow_24h_usd: 999 });
    const f = mock(
      respond(200, { data: [other, row({ token_address: WBTC.address.toLowerCase() })] }),
    );
    const out = await call(f);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(out.flows.h24.atoms).toBe('482011337');
  });

  it('has a null request id when Nansen sends none, and zero traders when unstated', async () => {
    const f = mock(respond(200, { data: [row({ trader_count: null })] }));
    const out = await call(f);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.requestId).toBeNull();
    expect(out.traderCount).toBe(0);
  });
});

describe('no figure is invented', () => {
  it('is no_data when Nansen has no row for the token', async () => {
    const f = mock(respond(200, { data: [row({ token_address: '0xother' })] }));
    expect(await call(f)).toEqual({ status: 'no_data', asset: 'BTC/USD', token: WBTC });
    const empty = mock(respond(200, { data: [] }));
    expect((await call(empty)).status).toBe('no_data');
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'credits'],
    [429, 'rate_limited'],
    [422, 'bad_request'],
    [400, 'bad_request'],
    [500, 'upstream'],
    [503, 'upstream'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const out = await call(mock(respond(status, { error: 'x' })));
    expect(out).toMatchObject({ status: 'error', kind });
    expect(classifyHttpStatus(status).kind).toBe(kind);
  });

  it('is a network error when the request cannot be made', async () => {
    expect(await call(mock(new Error('ECONNRESET')))).toMatchObject({
      status: 'error',
      kind: 'network',
    });
  });

  it('is a timeout, reported as a network error, when the request is aborted', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = await call(mock(abort));
    expect(out).toMatchObject({ status: 'error', kind: 'network', message: 'Nansen did not answer in time.' });
  });

  it('is invalid_response for a body that is not JSON', async () => {
    const out = await call(mock(respond(200, new Error('Unexpected token <'))));
    expect(out).toMatchObject({ status: 'error', kind: 'invalid_response' });
  });

  it.each([
    ['no data array', {}],
    ['data not an array', { data: 'nope' }],
    ['a flow that is not a number', { data: [row({ net_flow_24h_usd: '4.8m' })] }],
    ['a flow that is missing', { data: [row({ net_flow_7d_usd: undefined })] }],
    ['a flow that is not finite', { data: [row({ net_flow_1h_usd: null })] }],
  ])('is invalid_response for %s', async (_name, body) => {
    const out = await call(mock(respond(200, body)));
    expect(out).toMatchObject({ status: 'error', kind: 'invalid_response' });
  });

  it('never puts the api key in an error message', async () => {
    const out = await call(mock(respond(401, {})), 'sk-very-secret');
    expect(JSON.stringify(out)).not.toContain('sk-very-secret');
  });
});

describe('cache freshness', () => {
  it('serves a read for ten minutes and no longer', () => {
    expect(isFresh(NOW, NOW + 9 * 60_000)).toBe(true);
    expect(isFresh(NOW, NOW + 10 * 60_000)).toBe(false);
  });

  it('does not trust a read stamped in the future', () => {
    expect(isFresh(NOW + 1, NOW)).toBe(false);
  });
});
