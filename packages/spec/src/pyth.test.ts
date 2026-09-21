import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSETS } from './assets';
import { formatDecimal } from './decimal';
import {
  HermesLatestResponse,
  PYTH_FEEDS,
  extractPriceUpdates,
  fetchHermesLatest,
  fedAssets,
  feedIdForSymbol,
  hermesLatestUrl,
  hermesUpdateData,
  normalizeFeedId,
  pythPriceToDecimal,
} from './pyth';

const BTC = PYTH_FEEDS['BTC/USD']!;
const ETH = PYTH_FEEDS['ETH/USD']!;

describe('pythPriceToDecimal', () => {
  it('keeps price atoms and reads expo as the decimal count', () => {
    expect(pythPriceToDecimal('6841234000000', -8)).toEqual({ atoms: '6841234000000', decimals: 8 });
    expect(formatDecimal(pythPriceToDecimal('6841234000000', -8))).toBe('68,412.34000000');
  });

  it('is exact where a float is not', () => {
    // 0.1 + 0.2 style: 30000000000000004 has no exact float form. Atoms must survive intact.
    const d = pythPriceToDecimal('9007199254740993', -8);
    expect(d.atoms).toBe('9007199254740993');
    expect(d.decimals).toBe(8);
  });

  it('handles expo 0 and positive expo by scaling atoms, never decimals', () => {
    expect(pythPriceToDecimal('42', 0)).toEqual({ atoms: '42', decimals: 0 });
    expect(pythPriceToDecimal('42', 3)).toEqual({ atoms: '42000', decimals: 0 });
  });

  it('keeps a negative price negative', () => {
    expect(pythPriceToDecimal('-5', -2)).toEqual({ atoms: '-5', decimals: 2 });
  });

  it('accepts expo of exactly -18', () => {
    expect(pythPriceToDecimal('1', -18)).toEqual({ atoms: '1', decimals: 18 });
  });

  it('drops trailing zeros to fit 18 decimals only when the value is unchanged', () => {
    expect(pythPriceToDecimal('12300', -20)).toEqual({ atoms: '123', decimals: 18 });
    expect(() => pythPriceToDecimal('12345', -20)).toThrow(RangeError);
  });

  it('rejects non-integer input rather than guess', () => {
    expect(() => pythPriceToDecimal('1.5', -2)).toThrow();
    expect(() => pythPriceToDecimal('', -2)).toThrow();
    expect(() => pythPriceToDecimal('12', -2.5)).toThrow();
    expect(() => pythPriceToDecimal('12', 99)).toThrow(RangeError);
  });

  it('normalises -0 to 0', () => {
    expect(pythPriceToDecimal('-0', -8)).toEqual({ atoms: '0', decimals: 8 });
  });
});

describe('feeds', () => {
  it('matches PythMonad.sol id for id', () => {
    const sol = readFileSync(
      new URL('../../contracts/script/PythMonad.sol', import.meta.url),
      'utf8',
    );
    const constants = new Map<string, string>();
    for (const m of sol.matchAll(/bytes32 internal constant (\w+_USD) = (0x[0-9a-fA-F]{64});/g)) {
      constants.set(m[1]!.replace(/_USD$/, '/USD'), m[2]!.toLowerCase());
    }
    expect(constants.size).toBeGreaterThan(0);
    for (const [symbol, id] of Object.entries(PYTH_FEEDS)) {
      expect(constants.get(symbol), `${symbol} missing from PythMonad.sol`).toBe(id);
    }
  });

  it('has only normalised ids', () => {
    for (const id of Object.values(PYTH_FEEDS)) expect(normalizeFeedId(id)).toBe(id);
  });

  it('only feeds assets the spec lists, and skips the ones without a sponsored feed', () => {
    const listed = new Set(ASSETS.map((a) => a.symbol));
    for (const symbol of Object.keys(PYTH_FEEDS)) expect(listed.has(symbol)).toBe(true);
    expect(feedIdForSymbol('AVAX/USD')).toBeUndefined();
    expect(fedAssets().map((a) => a.symbol)).toEqual(['BTC/USD', 'ETH/USD', 'SOL/USD', 'MON/USD']);
  });

  it('normalizeFeedId strips 0x, lowercases, and rejects the wrong length', () => {
    expect(normalizeFeedId(BTC.slice(2).toUpperCase())).toBe(BTC);
    expect(() => normalizeFeedId('0x1234')).toThrow();
  });
});

describe('hermesLatestUrl', () => {
  it('writes ids[] literally and trims a trailing slash', () => {
    const url = hermesLatestUrl('https://hermes.example/', [BTC, ETH.slice(2)]);
    expect(url).toBe(
      `https://hermes.example/v2/updates/price/latest?encoding=hex&parsed=true&ids[]=${BTC}&ids[]=${ETH}`,
    );
  });
});

const response = (over: Partial<HermesLatestResponse> = {}): HermesLatestResponse =>
  HermesLatestResponse.parse({
    binary: { encoding: 'hex', data: ['deadbeef', '0xcafe00'] },
    parsed: [
      { id: BTC.slice(2), price: { price: '6841234000000', conf: '1', expo: -8, publish_time: 1_760_000_000 } },
      { id: ETH.slice(2), price: { price: '350012000000', conf: '1', expo: -8, publish_time: 1_760_000_001 } },
    ],
    ...over,
  });

describe('extractPriceUpdates', () => {
  it('maps parsed entries to assets with exact decimals', () => {
    const { updates, skipped } = extractPriceUpdates(response());
    expect(skipped).toEqual([]);
    expect(updates).toEqual([
      {
        asset: 'BTC/USD',
        feedId: BTC,
        price: { atoms: '6841234000000', decimals: 8 },
        publishTime: 1_760_000_000,
      },
      {
        asset: 'ETH/USD',
        feedId: ETH,
        price: { atoms: '350012000000', decimals: 8 },
        publishTime: 1_760_000_001,
      },
    ]);
  });

  it('skips an untracked feed, a non-positive price and an inexact one without dropping the rest', () => {
    const r = HermesLatestResponse.parse({
      binary: { encoding: 'hex', data: [] },
      parsed: [
        { id: 'aa'.repeat(32), price: { price: '1', conf: '0', expo: -8, publish_time: 1 } },
        { id: BTC.slice(2), price: { price: '0', conf: '0', expo: -8, publish_time: 2 } },
        { id: ETH.slice(2), price: { price: '12345', conf: '0', expo: -20, publish_time: 3 } },
        { id: PYTH_FEEDS['SOL/USD']!.slice(2), price: { price: '15000000000', conf: '0', expo: -8, publish_time: 4 } },
      ],
    });
    const { updates, skipped } = extractPriceUpdates(r);
    expect(updates.map((u) => u.asset)).toEqual(['SOL/USD']);
    expect(skipped.map((s) => s.reason)).toEqual([
      'untracked feed',
      'non-positive price',
      expect.stringContaining('more than 18 decimals'),
    ]);
  });

  it('returns nothing when the response carries no parsed section', () => {
    const r = HermesLatestResponse.parse({ binary: { encoding: 'hex', data: [] } });
    expect(extractPriceUpdates(r)).toEqual({ updates: [], skipped: [] });
  });
});

describe('hermesUpdateData', () => {
  it('prefixes bare hex and keeps prefixed hex', () => {
    expect(hermesUpdateData(response())).toEqual(['0xdeadbeef', '0xcafe00']);
  });

  it('refuses base64 and malformed hex', () => {
    expect(() => hermesUpdateData(response({ binary: { encoding: 'base64', data: ['AAAA'] } }))).toThrow();
    expect(() => hermesUpdateData(response({ binary: { encoding: 'hex', data: ['abc'] } }))).toThrow();
    expect(() => hermesUpdateData(response({ binary: { encoding: 'hex', data: ['zz'] } }))).toThrow();
  });
});

describe('fetchHermesLatest', () => {
  const ok = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const body = { binary: { encoding: 'hex', data: ['ab'] }, parsed: [] };

  it('requests the latest update url and validates the body', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const r = await fetchHermesLatest(fetchFn, { baseUrl: 'https://h.example' }, [BTC]);
    expect(r.binary.data).toEqual(['ab']);
    expect(seen!.url).toContain(`ids[]=${BTC}`);
    expect(seen!.headers.Authorization).toBeUndefined();
  });

  it('sends the key as a bearer by default and bare under a custom header', async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    await fetchHermesLatest(fetchFn, { baseUrl: 'https://h.example', apiKey: 'k' }, [BTC]);
    await fetchHermesLatest(fetchFn, { baseUrl: 'https://h.example', apiKey: 'k', apiKeyHeader: 'x-api-key' }, [BTC]);
    expect(seen[0]!.Authorization).toBe('Bearer k');
    expect(seen[1]!['x-api-key']).toBe('k');
  });

  it('names missing credentials on 401', async () => {
    await expect(fetchHermesLatest(ok('unauthorized', 401), { baseUrl: 'https://h.example' }, [BTC])).rejects.toThrow(
      /401.*credentials/,
    );
  });

  it('rejects a body of the wrong shape', async () => {
    await expect(fetchHermesLatest(ok({ nope: 1 }), { baseUrl: 'https://h.example' }, [BTC])).rejects.toThrow(
      /expected shape/,
    );
  });
});
