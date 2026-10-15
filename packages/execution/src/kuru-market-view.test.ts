import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KURU_VIEW_DEPTH, KuruListing, kuruMarketView, precisionDecimals, readKuruListing } from './kuru-market-view';

/** The record as `kuru-list-cli.ts` writes it, with the figures of its rehearsal on a fork. */
const record = {
  network: 'testnet',
  chainId: 10143,
  asset: 'tkBTC/USDC',
  note: 'tkBTC is a test token with an open mint. It is not bitcoin.',
  openingPriceUsd: 83272,
  base: {
    address: '0x85495222Fd7069B987Ca38C2142732EbBFb7175D',
    name: 'Kanon Test BTC',
    symbol: 'tkBTC',
    decimals: 8,
    kind: 'test token, open mint',
    deployTx: `0x${'a1'.repeat(32)}`,
  },
  quote: {
    address: '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C',
    name: 'Mock USDC',
    symbol: 'USDC',
    decimals: 6,
    kind: "Kanon's mock collateral token, open mint",
  },
  market: {
    address: '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41',
    vault: '0x5e75af39Aa9E19617055dC5F06A2d5b17c02A000',
    router: '0x7EFbE105Ca7415dE98F96622173458ac1c054630',
    type: 0,
    deployTx: `0x${'b2'.repeat(32)}`,
    pricePrecision: '10000',
    sizePrecision: '1000000000',
    tickSize: '83272',
    minSize: '100000',
    maxSize: '1000000000',
    takerFeeBps: '30',
    makerFeeBps: '10',
    ammSpreadBps: '100',
  },
  liquidity: { base: '50', quote: '4163600.0', tx: `0x${'c3'.repeat(32)}` },
  order: { side: 'buy', size: '0.001', tx: `0x${'d4'.repeat(32)}`, filledSize: '0.001000000', avgFillPrice: '83272' },
};
const listing = KuruListing.parse(record);

/** A book as the SDK hands it back: asks highest first, bids highest first, floats. */
const book = {
  asks: [
    [84945.7672, 0.24628718],
    [84104.72, 0.24751862],
    [83272, 0.24875621],
  ],
  bids: [
    [82447.52475247525, 0.25],
    [81631.21262621312, 0.25125],
  ],
  blockNumber: 70_612_345,
};

describe('precisionDecimals', () => {
  it('reads a power of ten as its number of decimals, and refuses anything else', () => {
    expect(precisionDecimals('1')).toBe(0);
    expect(precisionDecimals('10000')).toBe(4);
    expect(precisionDecimals('1000000000')).toBe(9);
    expect(() => precisionDecimals('5000')).toThrow(/power of ten/);
    expect(() => precisionDecimals('0')).toThrow(/power of ten/);
  });
});

describe('kuruMarketView', () => {
  const view = kuruMarketView(listing, book, 1_791_893_000_000);

  it('names the market, its tokens and what they are, from the record', () => {
    expect(view).toMatchObject({
      ok: true,
      asset: 'tkBTC/USDC',
      network: 'testnet',
      chainId: 10143,
      market: record.market.address,
      note: record.note,
      base: { symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
      quote: { symbol: 'USDC', decimals: 6 },
      priceDecimals: 4,
      sizeDecimals: 9,
      minSize: { atoms: '100000', decimals: 9 },
      maxSize: { atoms: '1000000000', decimals: 9 },
      takerFeeBps: 30,
      blockNumber: 70_612_345,
      readAt: 1_791_893_000_000,
    });
    // A deploy hash is evidence; nothing else of the record's bookkeeping is sent.
    expect(Object.keys(view.base).sort()).toEqual(['address', 'decimals', 'kind', 'name', 'symbol']);
  });

  it('puts the best price of each side first, as integers at the market\'s own decimals', () => {
    expect(view.asks.map((l) => l.price)).toEqual([
      { atoms: '832720000', decimals: 4 },
      { atoms: '841047200', decimals: 4 },
      { atoms: '849457672', decimals: 4 },
    ]);
    expect(view.asks[0]?.size).toEqual({ atoms: '248756210', decimals: 9 });
    // A computed AMM level is rounded to the tick's scale, not passed on with a float's tail.
    expect(view.bids.map((l) => l.price)).toEqual([
      { atoms: '824475248', decimals: 4 },
      { atoms: '816312126', decimals: 4 },
    ]);
    expect(view.bids[0]?.size).toEqual({ atoms: '250000000', decimals: 9 });
  });

  it('leaves out a level that is not a positive price and size, and never sends more than the depth', () => {
    const noisy = {
      blockNumber: 1,
      asks: [[83272, 0], [Number.NaN, 1], [-1, 1], [83272.5, 0.5], [0.00001, 1]],
      bids: Array.from({ length: 20 }, (_, i) => [80000 - i, 1]),
    };
    const out = kuruMarketView(listing, noisy, 0);
    expect(out.asks).toEqual([{ price: { atoms: '832725000', decimals: 4 }, size: { atoms: '500000000', decimals: 9 } }]);
    expect(out.bids).toHaveLength(KURU_VIEW_DEPTH);
    expect(out.bids[0]?.price).toEqual({ atoms: '800000000', decimals: 4 });
  });

  it('links the transactions behind the listing, and only the ones that happened', () => {
    expect(view.listing).toEqual({
      marketTx: record.market.deployTx,
      tokenTx: record.base.deployTx,
      liquidityTx: record.liquidity.tx,
      firstOrderTx: record.order.tx,
    });
    const { liquidity: _l, order: _o, ...early } = record;
    expect(kuruMarketView(KuruListing.parse(early), book, 0).listing).toEqual({
      marketTx: record.market.deployTx,
      tokenTx: record.base.deployTx,
    });
  });

  it('an empty book is an empty book', () => {
    const out = kuruMarketView(listing, { bids: [], asks: [], blockNumber: 5 }, 0);
    expect([out.bids, out.asks]).toEqual([[], []]);
  });
});

describe('readKuruListing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kuru-listing-'));
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  it('reads a record the listing script wrote', () => {
    expect(readKuruListing(write('full.json', JSON.stringify(record)))?.market.address).toBe(record.market.address);
  });

  it('is null where nothing was listed: no file, a run that stopped before the market, or a file that is not a record', () => {
    expect(readKuruListing(join(dir, 'absent.json'))).toBeNull();
    const { market: _m, liquidity: _l, order: _o, ...tokenOnly } = record;
    expect(readKuruListing(write('early.json', JSON.stringify(tokenOnly)))).toBeNull();
    expect(readKuruListing(write('broken.json', '{ not json'))).toBeNull();
    expect(readKuruListing(write('wrong.json', JSON.stringify({ ...record, market: { ...record.market, address: '0x12' } })))).toBeNull();
  });
});
