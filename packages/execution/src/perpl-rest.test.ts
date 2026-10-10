import { describe, expect, it, vi } from 'vitest';
import { buildRestCanonical, createEd25519Signer, generateEd25519KeyPair, sha256Hex, verifyEd25519Base64Url } from './perpl-auth';
import { PERPL_FLAG, PERPL_ORDER_TYPE } from './perpl-constants';
import { PerplRestError, createPerplRest, isOpenPosition, sizeForNotional, type PerplOrderSpec } from './perpl-rest';

const NOW = 1_800_000_000_000;

async function setup(respond: (url: string, init: RequestInit) => Response) {
  const keys = await generateEd25519KeyPair();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  });
  const rest = createPerplRest({
    network: 'testnet',
    apiKey: 'token-123',
    signer: createEd25519Signer(keys.secretKeyHex),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    nonce: () => 'nonce-abc',
  });
  return { rest, calls, keys };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name]!;

const order: PerplOrderSpec = {
  rq: 8,
  mkt: 16,
  acc: 7,
  t: PERPL_ORDER_TYPE.openLong,
  p: 0,
  s: 30,
  ms: 100,
  fl: PERPL_FLAG.ioc,
  lv: 200,
  lb: 0,
};

describe('signing', () => {
  it('signs a GET over the path without the /api prefix and the hash of an empty body', async () => {
    const { rest, calls, keys } = await setup(() => json({ sn: 1, addr: '0xabc', as: [] }));
    await rest.wallet();

    const { url, init } = calls[0]!;
    expect(url).toBe('https://testnet.perpl.xyz/api/v1/trading/wallet');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(header(init, 'X-API-Key')).toBe('token-123');
    expect(header(init, 'X-API-Timestamp')).toBe(String(NOW));
    expect(header(init, 'X-API-Nonce')).toBe('nonce-abc');

    const canonical = buildRestCanonical({
      chainId: 10143,
      method: 'GET',
      target: '/v1/trading/wallet',
      timestamp: String(NOW),
      nonce: 'nonce-abc',
      bodyHashHex: await sha256Hex(''),
    });
    expect(await verifyEd25519Base64Url(keys.publicKeyHex, header(init, 'X-API-Signature'), canonical)).toBe(true);
  });

  it('signs a POST over the exact bytes it sends, and the query string of a GET', async () => {
    const { rest, calls, keys } = await setup((url) =>
      url.includes('/fills') ? json({ d: [], np: '' }) : json({ mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] }),
    );
    await rest.submit([order]);
    await rest.fills(5);

    const post = calls[0]!;
    expect(post.init.body).toBe(JSON.stringify({ d: [order] }));
    const canonical = buildRestCanonical({
      chainId: 10143,
      method: 'POST',
      target: '/v1/trading/orders',
      timestamp: String(NOW),
      nonce: 'nonce-abc',
      bodyHashHex: await sha256Hex(post.init.body as string),
    });
    expect(await verifyEd25519Base64Url(keys.publicKeyHex, header(post.init, 'X-API-Signature'), canonical)).toBe(true);

    const fillsCanonical = buildRestCanonical({
      chainId: 10143,
      method: 'GET',
      target: '/v1/trading/fills?count=5',
      timestamp: String(NOW),
      nonce: 'nonce-abc',
      bodyHashHex: await sha256Hex(''),
    });
    expect(calls[1]!.url).toBe('https://testnet.perpl.xyz/api/v1/trading/fills?count=5');
    expect(await verifyEd25519Base64Url(keys.publicKeyHex, header(calls[1]!.init, 'X-API-Signature'), fillsCanonical)).toBe(true);
  });
});

describe('reading state', () => {
  it('returns the accounts with the forwarding flag and last request id', async () => {
    const { rest } = await setup(() =>
      json({ mt: 19, sn: 5, addr: '0xabc', as: [{ id: 7, fr: false, fw: true, ft: 0, lfr: 41, b: '100000000', lb: '0' }], sts: [] }),
    );
    const wallet = await rest.wallet();
    expect(wallet.as[0]).toMatchObject({ id: 7, fw: true, lfr: 41, b: '100000000' });
  });

  it('reports a wallet with no exchange account as a 404, with no key in the message', async () => {
    const { rest } = await setup(() => new Response('account not found', { status: 404 }));
    const error = await rest.wallet().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PerplRestError);
    expect((error as PerplRestError).status).toBe(404);
    expect((error as PerplRestError).message).not.toContain('token-123');
  });

  it('reads open positions and fills, including the transaction id of a fill', async () => {
    const { rest } = await setup((url) =>
      url.includes('/positions')
        ? json({ mt: 26, sn: 9, d: [{ at: { b: 9, t: 1 }, mkt: 16, acc: 7, pid: 3, sd: 1, ep: 825000, s: 30, lv: 200, c: '12000000' }] })
        : json({ d: [{ at: { b: 9, t: 1, tx: 2, txid: 'ab12' }, mkt: 16, acc: 7, oid: 55, t: 1, l: 2, p: 825010, s: 30, f: '8500' }], np: '' }),
    );
    expect((await rest.positions())[0]).toMatchObject({ pid: 3, ep: 825000, s: 30 });
    expect((await rest.fills(1))[0]).toMatchObject({ oid: 55, p: 825010, f: '8500', at: { txid: 'ab12' } });
  });

  it('reads a position as the live venue sends it: an empty `at`, the open time in `ots`', async () => {
    // The body of GET /v1/trading/positions on testnet, 2026-10-10, after one filled market order.
    const live = {
      mt: 26,
      sid: 50,
      sn: 69784776,
      at: { b: 69784776, t: 1791623078000 },
      d: [
        {
          at: {},
          mkt: 16,
          acc: 1049,
          pid: 4573379756033,
          rq: 0,
          oid: 0,
          st: 1,
          sr: 0,
          sd: 1,
          c: '12439905',
          ep: 828471,
          s: 30,
          fee: '8575',
          cfee: '0',
          efs: 124673,
          lv: 200,
          cpnl: '0',
          dpnl: '0',
          fnd: '0',
          pay: '0',
          xfs: 0,
          ots: { b: 69784237, t: 1791622915000, tx: 3 },
        },
      ],
    };
    const { rest } = await setup(() => json(live));
    const [position] = await rest.positions();
    expect(position).toMatchObject({ pid: 4573379756033, st: 1, sd: 1, ep: 828471, s: 30, lv: 200, c: '12439905', ots: { b: 69784237 } });
    expect(isOpenPosition(position!)).toBe(true);
    expect(isOpenPosition({ ...position!, st: 2 })).toBe(false);
    expect(isOpenPosition({ ...position!, s: 0 })).toBe(false);
  });
});

describe('submitting orders', () => {
  it('returns one status per order, in order: a 200 answer can still carry a refusal', async () => {
    const { rest } = await setup(() =>
      json({ mt: 31, status: { code: 0 }, statuses: [{ code: 0 }, { code: 403, error: 'invalid account' }] }),
    );
    expect(await rest.submit([order, { ...order, rq: 9, acc: 99 }])).toEqual([
      { code: 0 },
      { code: 403, error: 'invalid account' },
    ]);
  });

  it('throws when the batch as a whole was refused', async () => {
    const { rest } = await setup(() => json({ mt: 31, status: { code: 403, error: 'trade scope required' } }, 403));
    await expect(rest.submit([order])).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an empty or oversized batch before calling the venue', async () => {
    const { rest, calls } = await setup(() => json({}));
    await expect(rest.submit([])).rejects.toThrow(/1 to 100/);
    await expect(rest.submit(Array.from({ length: 101 }, () => order))).rejects.toThrow(/1 to 100/);
    expect(calls).toHaveLength(0);
  });
});

describe('sizeForNotional', () => {
  it('sizes in the market units and rounds down, so the order never exceeds the notional', () => {
    // BTC at 82,500.0 with one price decimal and five size decimals: $25 buys 0.00030303…
    expect(sizeForNotional({ usdNotional: 25, scaledPrice: 825000, priceDecimals: 1, sizeDecimals: 5 })).toBe(30);
    // MON at 0.02434 with five price decimals and whole-unit sizes: $25 buys 1027.1…
    expect(sizeForNotional({ usdNotional: 25, scaledPrice: 2434, priceDecimals: 5, sizeDecimals: 0 })).toBe(1027);
  });

  it('is zero when the notional is below one unit of size', () => {
    expect(sizeForNotional({ usdNotional: 1, scaledPrice: 825000, priceDecimals: 1, sizeDecimals: 0 })).toBe(0);
  });

  it('refuses a fractional notional or a non-positive price', () => {
    expect(() => sizeForNotional({ usdNotional: 2.5, scaledPrice: 825000, priceDecimals: 1, sizeDecimals: 5 })).toThrow();
    expect(() => sizeForNotional({ usdNotional: 25, scaledPrice: 0, priceDecimals: 1, sizeDecimals: 5 })).toThrow();
  });
});
