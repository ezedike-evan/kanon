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

/**
 * A venue as the order code sees it. An accepted order is forwarded after
 * `forwardAfterLooks` reads of the positions; from then the position is `after`
 * (undefined: unchanged) and the request counter has moved. The history lists
 * the fill `historyAfterReads` reads of it later, which is the lag that matters.
 */
function fakeRest(opts: {
  history?: PerplFill[];
  fill?: PerplFill | null;
  /** Reads of the history, after the order was forwarded, before the fill is listed. Default 0. */
  historyAfterReads?: number;
  submit?: (orders: PerplOrderSpec[]) => Promise<Array<{ code: number; error?: string }>>;
  positions?: PerplPosition[];
  /** What the account holds once the order is forwarded. Undefined leaves `positions` as they were. */
  after?: PerplPosition[];
  forwardAfterLooks?: number;
  /** The venue never forwards the order. */
  neverForwards?: boolean;
  wallet?: () => Promise<{ sn: number; addr: string; as: PerplAccount[] }>;
}) {
  const sent: PerplOrderSpec[] = [];
  let looks = 0;
  let historyReads = 0;
  let accepted: PerplOrderSpec | null = null;
  const forwarded = () =>
    accepted !== null && !opts.neverForwards && looks > (opts.forwardAfterLooks ?? 0);
  const rest: PerplRest = {
    wallet:
      opts.wallet ??
      (async () => ({ sn: 1, addr: '0xabc', as: [{ ...ACCOUNT, lfr: forwarded() && accepted ? accepted.rq : ACCOUNT.lfr }] })),
    positions: async () => {
      if (accepted) looks += 1;
      return forwarded() && opts.after ? opts.after : (opts.positions ?? []);
    },
    fills: async () => {
      const history = opts.history ?? [];
      if (!forwarded() || !opts.fill) return history;
      historyReads += 1;
      return historyReads > (opts.historyAfterReads ?? 0) ? [opts.fill, ...history] : history;
    },
    submit: async (orders) => {
      sent.push(...orders);
      const statuses = opts.submit ? await opts.submit(orders) : [{ code: 0 }];
      if (statuses[0]?.code === 0) accepted = orders[0] ?? null;
      return statuses;
    },
  };
  return { rest, sent, looks: () => looks };
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
  const open = { market: BTC, account: ACCOUNT, side: 'long', size: 30, leverage: 200, slippageBps: 100 } as const;

  it('sends the encoding the venue filled on testnet, with the next request id', async () => {
    const { rest, sent } = fakeRest({ after: [POSITION], fill: LIVE_FILL });
    const out = await openAtMarket({ rest, ...fakeTime() }, open);
    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.openLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(out).toMatchObject({
      status: 'filled',
      requestId: 8,
      position: POSITION,
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
    const { rest, sent } = fakeRest({ after: [{ ...POSITION, sd: 2 }], fill: { ...LIVE_FILL, t: 2 } });
    const fresh: PerplAccount = { id: 1049, b: '100000000' };
    await openAtMarket({ rest, ...fakeTime() }, { ...open, account: fresh, side: 'short', leverage: 300, slippageBps: 50 });
    expect(sent[0]).toMatchObject({ rq: 1, t: PERPL_ORDER_TYPE.openShort, lv: 300, ms: 50 });
  });

  it('reports the fill as soon as the position appears, without waiting on the history', async () => {
    // What happened on testnet, 2026-10-10: the position moved in three seconds, the history took over twenty.
    const time = fakeTime();
    const { rest, looks } = fakeRest({ after: [POSITION], fill: LIVE_FILL, forwardAfterLooks: 2, historyAfterReads: 3 });
    const started = time.now();
    const out = await openAtMarket({ rest, ...time, pollMs: 600 }, open);
    expect(out).toMatchObject({ status: 'filled', requestId: 8, fill: null, position: POSITION });
    expect(looks()).toBe(3);
    expect(time.now() - started).toBe(1_800);
    // The record of the fill is still there to be asked for, and arrives when the history has it.
    if (out.status !== 'filled') throw new Error('unreachable');
    expect(await out.findFill()).toBeNull();
    expect(await out.findFill()).toBeNull();
    expect(await out.findFill()).toMatchObject({ block: 69784237, price: 828471 });
  });

  it('takes a fill already in the history, or on another market or account, as no record of this order', async () => {
    const old = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 5 }, oid: 1 };
    for (const fill of [{ ...LIVE_FILL, mkt: 32, oid: 9 }, { ...LIVE_FILL, acc: 7, oid: 10 }]) {
      const { rest } = fakeRest({ history: [old], after: [POSITION], fill });
      const out = await openAtMarket({ rest, ...fakeTime() }, open);
      expect(out).toMatchObject({ status: 'filled', fill: null });
    }
    const mine = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 900 }, oid: 2 };
    const { rest } = fakeRest({ history: [old], after: [POSITION], fill: mine });
    expect(await openAtMarket({ rest, ...fakeTime() }, open)).toMatchObject({ status: 'filled', fill: { block: 900 } });
  });

  it('uses a history the caller already read instead of reading it again', async () => {
    const { rest } = fakeRest({ after: [POSITION], fill: LIVE_FILL });
    let reads = 0;
    const counted = { ...rest, fills: (n: number) => ((reads += 1), rest.fills(n)) };
    await openAtMarket({ rest: counted, ...fakeTime() }, { ...open, history: [] });
    // One read: the look for the fill once the position moved. None before the order.
    expect(reads).toBe(1);
  });

  it('adds to a position held on the same side, and waits for it to grow', async () => {
    const grown = { ...POSITION, s: 42 };
    const { rest, sent } = fakeRest({ positions: [POSITION], after: [grown], fill: { ...LIVE_FILL, s: 12 }, forwardAfterLooks: 1 });
    const out = await openAtMarket({ rest, ...fakeTime() }, { ...open, size: 12, held: POSITION });
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.openLong, s: 12 });
    expect(out).toMatchObject({ status: 'filled', position: { s: 42 }, fill: { size: 12 } });
  });

  it('says nothing filled only once the venue has forwarded the order and the position has not moved', async () => {
    const time = fakeTime();
    const { rest } = fakeRest({ fill: null });
    const started = time.now();
    const out = await openAtMarket({ rest, ...time, pollMs: 600 }, open);
    expect(out).toEqual({ status: 'unfilled', requestId: 8 });
    // Seen forwarded on the third look, then two more looks: five in all, well inside the wait.
    expect(time.now() - started).toBe(3_000);
  });

  it('still reports a fill the history lists when the position shows none', async () => {
    // Opened and gone again before it was looked at. Rare, and still a fill.
    const { rest } = fakeRest({ fill: LIVE_FILL });
    expect(await openAtMarket({ rest, ...fakeTime() }, open)).toMatchObject({ status: 'filled', position: null, fill: { block: 69784237 } });
  });

  it('claims nothing about an order the venue has not reported on when the wait runs out', async () => {
    const time = fakeTime();
    const { rest } = fakeRest({ neverForwards: true, fill: LIVE_FILL });
    const started = time.now();
    const out = await openAtMarket({ rest, ...time, settleTimeoutMs: 6_000, pollMs: 600 }, open);
    expect(out).toEqual({ status: 'pending', requestId: 8 });
    expect(time.now() - started).toBe(6_000);
  });

  it("returns the venue's own refusal for an order it will not take", async () => {
    const { rest } = fakeRest({ submit: async () => [{ code: 403, error: 'invalid account' }] });
    expect(await openAtMarket({ rest, ...fakeTime() }, open)).toEqual({ status: 'refused', code: 403, reason: 'invalid account' });
  });

  it('returns a refusal when the whole request is rejected, and rethrows anything that is not the venue', async () => {
    const rejected = fakeRest({ submit: async () => Promise.reject(new PerplRestError(401, '/v1/trading/orders', 'key revoked')) });
    expect(await openAtMarket({ rest: rejected.rest, ...fakeTime() }, open)).toMatchObject({ status: 'refused', code: 401 });

    const broken = fakeRest({ submit: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(openAtMarket({ rest: broken.rest, ...fakeTime() }, open)).rejects.toThrow('fetch failed');
  });
});

describe('closing at market', () => {
  it('closes the whole position at its own leverage, as the venue accepted on testnet', async () => {
    const closeFill = { ...LIVE_FILL, at: { ...LIVE_FILL.at, b: 69786982, txid: '0x52c1' }, t: 3, p: 828134, oid: 77 };
    const { rest, sent } = fakeRest({ positions: [POSITION], after: [], fill: closeFill });
    const out = await closeAtMarket({ rest, ...fakeTime() }, { account: { ...ACCOUNT, lfr: 1 }, position: POSITION, slippageBps: 100 });
    expect(sent).toEqual([
      { rq: 2, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.closeLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(out).toMatchObject({ status: 'filled', requestId: 2, position: null, fill: { price: 828134, txHash: '0x52c1', block: 69786982 } });
  });

  it('closes a short with the short close type', async () => {
    const short = { ...POSITION, sd: 2 };
    const { rest, sent } = fakeRest({ positions: [short], after: [], fill: { ...LIVE_FILL, t: 4 } });
    await closeAtMarket({ rest, ...fakeTime() }, { account: ACCOUNT, position: short, slippageBps: 100 });
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.closeShort, s: 30, lv: 200 });
  });

  it('reports the close when the position is gone, whatever the history says', async () => {
    // The close that was wrongly reported as not filled on 2026-10-10: gone in seconds, unlisted for twenty.
    const { rest } = fakeRest({ positions: [POSITION], after: [], fill: LIVE_FILL, historyAfterReads: 50 });
    const out = await closeAtMarket({ rest, ...fakeTime() }, { account: ACCOUNT, position: POSITION, slippageBps: 100 });
    expect(out).toMatchObject({ status: 'filled', fill: null, position: null });
  });

  it('reports a close that only part filled, with what is left', async () => {
    const left = { ...POSITION, s: 10 };
    const { rest } = fakeRest({ positions: [POSITION], after: [left], fill: { ...LIVE_FILL, t: 3, s: 20 } });
    const out = await closeAtMarket({ rest, ...fakeTime() }, { account: ACCOUNT, position: POSITION, slippageBps: 100 });
    expect(out).toMatchObject({ status: 'filled', position: { s: 10 }, fill: { size: 20 } });
  });

  it('says nothing filled when the venue forwarded the close and the position is as it was', async () => {
    const { rest } = fakeRest({ positions: [POSITION], fill: null });
    const out = await closeAtMarket({ rest, ...fakeTime() }, { account: ACCOUNT, position: POSITION, slippageBps: 100 });
    expect(out).toEqual({ status: 'unfilled', requestId: 8 });
  });
});
