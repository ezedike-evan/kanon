import { describe, expect, it } from 'vitest';
import { PERPL_FLAG, PERPL_ORDER_TYPE } from './perpl-constants';
import { PerplRestError, type PerplAccount, type PerplFill, type PerplOrderSpec, type PerplPosition, type PerplRest } from './perpl-rest';
import {
  closeAtMarket,
  findPerplMarket,
  loadPerplMarkets,
  openAtMarket,
  readPerplAccount,
  readPerplMarkPrice,
  type PerplMarketInfo,
} from './perpl-trade';

const BTC: PerplMarketInfo = { id: 16, symbol: 'BTC', priceDecimals: 1, sizeDecimals: 5, maxLeverage: 1500, open: true };
const ACCOUNT: PerplAccount = { id: 1049, fr: false, fw: true, lfr: 7, b: '100000000', lb: '0' };

/** The fill testnet reported for the first order this code placed, 2026-10-10. */
const LIVE_FILL: PerplFill = {
  at: { b: 69784237, t: 1791622915000, tx: 3, txid: 'c533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5', l: 4 },
  mkt: 16,
  acc: 1049,
  oid: 4573379756032,
  t: 1,
  l: 2,
  p: 828471,
  s: 30,
  f: '8575',
  bfa: '0',
};

const POSITION: PerplPosition = {
  at: {},
  ots: { b: 69784237, t: 1791622915000 },
  mkt: 16,
  acc: 1049,
  pid: 4573379756033,
  st: 1,
  sd: 1,
  ep: 828471,
  s: 30,
  lv: 200,
  c: '12439905',
};

/** A venue that fills an accepted order after `fillAfterPolls` reads of the history. */
function fakeRest(opts: {
  history?: PerplFill[];
  fill?: PerplFill | null;
  fillAfterPolls?: number;
  submit?: (orders: PerplOrderSpec[]) => Promise<Array<{ code: number; error?: string }>>;
  positions?: PerplPosition[];
  wallet?: () => Promise<{ sn: number; addr: string; as: PerplAccount[] }>;
}) {
  const sent: PerplOrderSpec[] = [];
  let polls = 0;
  let accepted = false;
  const rest: PerplRest = {
    wallet: opts.wallet ?? (async () => ({ sn: 1, addr: '0xabc', as: [ACCOUNT] })),
    positions: async () => opts.positions ?? [],
    fills: async () => {
      const history = opts.history ?? [];
      if (!accepted || !opts.fill) return history;
      polls += 1;
      return polls > (opts.fillAfterPolls ?? 0) ? [opts.fill, ...history] : history;
    },
    submit: async (orders) => {
      sent.push(...orders);
      const statuses = opts.submit ? await opts.submit(orders) : [{ code: 0 }];
      accepted = statuses[0]?.code === 0;
      return statuses;
    },
  };
  return { rest, sent, polls: () => polls };
}

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 1_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('markets and prices', () => {
  const context = {
    markets: [
      { id: 16, symbol: 'BTC', name: 'BTC Perp', config: { price_decimals: 1, size_decimals: 5, is_open: true, initial_margin: 1500 } },
      { id: 1, symbol: '', name: 'ETH Perp', config: { price_decimals: 2, size_decimals: 3, is_open: false, initial_margin: 1000 } },
      { id: 10, symbol: ' ', name: 'MON', config: { price_decimals: 5, size_decimals: 0, is_open: true, initial_margin: 500 } },
    ],
  };
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('/v1/pub/context')) return new Response(JSON.stringify(context));
    if (String(url).endsWith('/v1/market-data/16/ticker')) return new Response(JSON.stringify({ d: { '16': { mrk: 827899, lst: 827529 } } }));
    if (String(url).endsWith('/v1/market-data/10/ticker')) return new Response(JSON.stringify({ d: {} }));
    return new Response('nope', { status: 503, statusText: 'Service Unavailable' });
  }) as typeof fetch;

  it('reads the market list, taking the base from the name where the symbol is blank', async () => {
    const markets = await loadPerplMarkets({ network: 'testnet', fetchImpl });
    expect(markets).toEqual([
      BTC,
      { id: 1, symbol: 'ETH', priceDecimals: 2, sizeDecimals: 3, maxLeverage: 1000, open: false },
      { id: 10, symbol: 'MON', priceDecimals: 5, sizeDecimals: 0, maxLeverage: 500, open: true },
    ]);
  });

  it('finds a market by app asset or bare base, in dollars only', () => {
    const markets = [BTC];
    expect(findPerplMarket(markets, 'BTC/USD')).toBe(BTC);
    expect(findPerplMarket(markets, ' btc / usd ')).toBe(BTC);
    expect(findPerplMarket(markets, 'BTC')).toBe(BTC);
    expect(findPerplMarket(markets, 'BTC/EUR')).toBeNull();
    expect(findPerplMarket(markets, 'DOGE/USD')).toBeNull();
    expect(findPerplMarket(markets, 'BTC/USD/X')).toBeNull();
    expect(findPerplMarket(markets, '')).toBeNull();
  });

  it('reads the mark price as the scaled integer, and refuses to make one up', async () => {
    expect(await readPerplMarkPrice({ network: 'testnet', fetchImpl }, 16)).toBe(827899);
    await expect(readPerplMarkPrice({ network: 'testnet', fetchImpl }, 10)).rejects.toThrow(/no mark price/);
    await expect(readPerplMarkPrice({ network: 'testnet', fetchImpl }, 99)).rejects.toBeInstanceOf(PerplRestError);
  });
});

describe('the account', () => {
  it('returns the first account and only the positions it still holds', async () => {
    const closed = { ...POSITION, pid: 2, st: 2 };
    const other = { ...POSITION, pid: 3, acc: 5 };
    const { rest } = fakeRest({ positions: [POSITION, closed, other] });
    const state = await readPerplAccount(rest);
    expect(state?.wallet).toBe('0xabc');
    expect(state?.account.id).toBe(1049);
    expect(state?.positions.map((p) => p.pid)).toEqual([POSITION.pid]);
  });

  it('is null for a wallet with no exchange account, and lets any other failure through', async () => {
    const none = fakeRest({ wallet: async () => Promise.reject(new PerplRestError(404, '/v1/trading/wallet', 'account not found')) });
    expect(await readPerplAccount(none.rest)).toBeNull();
    const empty = fakeRest({ wallet: async () => ({ sn: 1, addr: '0xabc', as: [] }) });
    expect(await readPerplAccount(empty.rest)).toBeNull();
    const denied = fakeRest({ wallet: async () => Promise.reject(new PerplRestError(401, '/v1/trading/wallet', 'bad signature')) });
    await expect(readPerplAccount(denied.rest)).rejects.toMatchObject({ status: 401 });
  });
});

describe('opening at market', () => {
  it('sends the encoding the venue filled on testnet, with the next request id', async () => {
    const { rest, sent } = fakeRest({ fill: LIVE_FILL });
    const out = await openAtMarket({ rest, ...fakeTime() }, { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 });
    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.openLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(out).toEqual({
      status: 'filled',
      requestId: 8,
      fill: {
        price: 828471,
        size: 30,
        fee: '8575',
        block: 69784237,
        time: 1791622915000,
        txHash: '0xc533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5',
      },
    });
  });

  it('opens a short with the short order type, and starts at request 1 on a fresh account', async () => {
    const { rest, sent } = fakeRest({ fill: { ...LIVE_FILL, t: 2 } });
    const fresh: PerplAccount = { id: 1049, b: '100000000' };
    await openAtMarket({ rest, ...fakeTime() }, { market: BTC, account: fresh, side: 'short', size: 30, leverage: 300, slippageBps: 50 });
    expect(sent[0]).toMatchObject({ rq: 1, t: PERPL_ORDER_TYPE.openShort, lv: 300, ms: 50 });
  });

  it('waits for the fill to appear, and ignores fills that were already in the history', async () => {
    const old = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 5 }, oid: 1 };
    const mine = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 900 }, oid: 2 };
    const { rest, polls } = fakeRest({ history: [old], fill: mine, fillAfterPolls: 3 });
    const out = await openAtMarket({ rest, ...fakeTime() }, { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 });
    expect(out).toMatchObject({ status: 'filled', fill: { block: 900 } });
    expect(polls()).toBe(4);
  });

  it('takes no fill from another market or another account as its own', async () => {
    const elsewhere = [
      { ...LIVE_FILL, mkt: 32, oid: 9 },
      { ...LIVE_FILL, acc: 7, oid: 10 },
    ];
    for (const fill of elsewhere) {
      const { rest } = fakeRest({ fill });
      const out = await openAtMarket(
        { rest, ...fakeTime(), settleTimeoutMs: 6_000 },
        { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 },
      );
      expect(out).toEqual({ status: 'unfilled', requestId: 8 });
    }
  });

  it('reports an accepted order that never fills as unfilled, after the wait and not before', async () => {
    const time = fakeTime();
    const { rest } = fakeRest({ fill: null });
    const started = time.now();
    const out = await openAtMarket(
      { rest, ...time, settleTimeoutMs: 6_000, pollMs: 1_500 },
      { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 },
    );
    expect(out).toEqual({ status: 'unfilled', requestId: 8 });
    expect(time.now() - started).toBe(6_000);
  });

  it("returns the venue's own refusal for an order it will not take", async () => {
    const { rest } = fakeRest({ submit: async () => [{ code: 403, error: 'invalid account' }] });
    const out = await openAtMarket({ rest, ...fakeTime() }, { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 });
    expect(out).toEqual({ status: 'refused', code: 403, reason: 'invalid account' });
  });

  it('returns a refusal when the whole request is rejected, and rethrows anything that is not the venue', async () => {
    const rejected = fakeRest({ submit: async () => Promise.reject(new PerplRestError(401, '/v1/trading/orders', 'key revoked')) });
    const out = await openAtMarket(
      { rest: rejected.rest, ...fakeTime() },
      { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 },
    );
    expect(out).toMatchObject({ status: 'refused', code: 401 });

    const broken = fakeRest({ submit: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(
      openAtMarket({ rest: broken.rest, ...fakeTime() }, { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 }),
    ).rejects.toThrow('fetch failed');
  });
});

describe('closing at market', () => {
  it('closes the whole position at its own leverage, as the venue accepted on testnet', async () => {
    const closeFill = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 69786982, txid: '0x52c1' }, t: 3, p: 828134, oid: 77 };
    const { rest, sent } = fakeRest({ fill: closeFill });
    const out = await closeAtMarket({ rest, ...fakeTime() }, { account: { ...ACCOUNT, lfr: 1 }, position: POSITION, slippageBps: 100 });
    expect(sent).toEqual([
      { rq: 2, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.closeLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(out).toMatchObject({ status: 'filled', requestId: 2, fill: { price: 828134, txHash: '0x52c1', block: 69786982 } });
  });

  it('closes a short with the short close type', async () => {
    const { rest, sent } = fakeRest({ fill: { ...LIVE_FILL, t: 4 } });
    await closeAtMarket({ rest, ...fakeTime() }, { account: ACCOUNT, position: { ...POSITION, sd: 2 }, slippageBps: 100 });
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.closeShort, s: 30, lv: 200 });
  });
});
