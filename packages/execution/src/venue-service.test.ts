import { describe, expect, it } from 'vitest';
import { PERPL_FLAG, PERPL_ORDER_TYPE } from './perpl-constants';
import {
  PerplRestError,
  sizeForNotional,
  type PerplAccount,
  type PerplFill,
  type PerplOrderSpec,
  type PerplPosition,
  type PerplRest,
} from './perpl-rest';
import type { PerplMarketInfo } from './perpl-trade';
import {
  VENUE_MESSAGES,
  createVenueService,
  type BeginResult,
  type OrderOutcomeRecord,
  type OrderRecord,
  type VenueRecorder,
  type VenueServiceDeps,
} from './venue-service';

const BTC: PerplMarketInfo = { id: 16, symbol: 'BTC', priceDecimals: 1, sizeDecimals: 5, maxLeverage: 1500, open: true };
const MON: PerplMarketInfo = { id: 64, symbol: 'MON', priceDecimals: 5, sizeDecimals: 1, maxLeverage: 300, open: true };
const ACCOUNT: PerplAccount = { id: 1049, fr: false, fw: true, lfr: 7, b: '100000000', lb: '0' };
const MARK = 828_000;

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

interface VenueOpts {
  account?: PerplAccount;
  positions?: PerplPosition[];
  /** The fill an accepted order produces. Null: nothing fills. */
  fill?: PerplFill | null;
  wallet?: () => Promise<{ sn: number; addr: string; as: PerplAccount[] }>;
  submit?: (orders: PerplOrderSpec[]) => Promise<Array<{ code: number; error?: string }>>;
  /** The history read after an order was accepted throws. */
  historyFailsAfterSend?: boolean;
}

function fakeVenue(opts: VenueOpts = {}) {
  const sent: PerplOrderSpec[] = [];
  let accepted = false;
  const rest: PerplRest = {
    wallet: opts.wallet ?? (async () => ({ sn: 1, addr: '0xabc', as: [opts.account ?? ACCOUNT] })),
    positions: async () => opts.positions ?? [],
    fills: async () => {
      if (!accepted) return [];
      if (opts.historyFailsAfterSend) throw new PerplRestError(502, '/v1/trading/fills', 'Bad Gateway');
      return opts.fill ? [opts.fill] : [];
    },
    submit: async (orders) => {
      sent.push(...orders);
      const statuses = opts.submit ? await opts.submit(orders) : [{ code: 0 }];
      accepted = statuses[0]?.code === 0;
      return statuses;
    },
  };
  return { rest, sent };
}

function fakeRecorder(begin: BeginResult = { ok: true, orderId: 'order-1' }) {
  const begun: OrderRecord[] = [];
  const settled: OrderOutcomeRecord[] = [];
  const recorder: VenueRecorder = {
    begin: async (order) => {
      begun.push(order);
      return begin;
    },
    settle: async (outcome) => {
      settled.push(outcome);
    },
  };
  return { recorder, begun, settled };
}

function service(venue: VenueOpts = {}, over: Partial<VenueServiceDeps> = {}) {
  const fake = fakeVenue(venue);
  const errors: string[] = [];
  let clock = 1_000_000;
  const svc = createVenueService({
    network: 'testnet',
    rest: fake.rest,
    loadMarkets: async () => [BTC, MON],
    readMarkPrice: async () => MARK,
    // Every look at the clock moves it on, so a wait for a fill that never comes ends.
    trade: { sleep: async () => {}, settleTimeoutMs: 5_000, now: () => (clock += 1_000) },
    onError: (scope) => errors.push(scope),
    ...over,
  });
  return { svc, sent: fake.sent, errors };
}

const open = { asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 } as const;

describe('account', () => {
  it('answers with the account, its markets, its positions and every limit', async () => {
    const { svc } = service({ positions: [POSITION] });
    expect(await svc.account()).toEqual({
      status: 'ready',
      venue: 'perpl',
      network: 'testnet',
      wallet: '0xabc',
      accountId: 1049,
      balance: { atoms: '100000000', decimals: 6 },
      canTrade: true,
      limits: { minNotionalUsd: 10, maxNotionalUsd: 100, maxLeverage: 5, slippageBps: 100 },
      markets: [
        { asset: 'BTC/USD', maxLeverage: 5, open: true },
        { asset: 'MON/USD', maxLeverage: 3, open: true },
      ],
      positions: [
        {
          asset: 'BTC/USD',
          side: 'long',
          size: { atoms: '30', decimals: 5 },
          entryPrice: { atoms: '828471', decimals: 1 },
          leverage: 2,
          collateral: { atoms: '12439905', decimals: 6 },
          openedAt: 1791622915000,
        },
      ],
    });
  });

  it('says the account cannot trade while forwarding is off or it is frozen', async () => {
    for (const account of [{ ...ACCOUNT, fw: false }, { ...ACCOUNT, fr: true }]) {
      const view = await service({ account }).svc.account();
      expect(view.status === 'ready' && view.canTrade).toBe(false);
    }
  });

  it('turns a venue failure into a line a person can act on', async () => {
    const failing = (status: number) => ({
      wallet: async () => {
        throw new PerplRestError(status, '/v1/trading/wallet', 'no');
      },
    });
    expect(await service(failing(404)).svc.account()).toEqual({ status: 'unavailable', message: VENUE_MESSAGES.noAccount });
    expect(await service(failing(401)).svc.account()).toEqual({
      status: 'unavailable',
      message: "Perpl testnet did not accept the server's API key.",
    });
    expect(await service(failing(451)).svc.account()).toEqual({
      status: 'unavailable',
      message: 'Perpl does not serve the region this server runs in.',
    });
    const other = service(failing(500));
    expect(await other.svc.account()).toEqual({ status: 'unavailable', message: VENUE_MESSAGES.unread });
    expect(other.errors).toEqual(['venue.account: the venue could not be read']);
  });

  it('reads the market list once a minute, not once a call', async () => {
    let loads = 0;
    let clock = 0;
    const { svc } = service({}, { loadMarkets: async () => (loads++, [BTC]), now: () => clock });
    await svc.account();
    clock = 59_000;
    await svc.account();
    expect(loads).toBe(1);
    clock = 61_000;
    await svc.account();
    expect(loads).toBe(2);
  });
});

describe('placeOrder', () => {
  it('opens at market and reports the fill with its transaction', async () => {
    const { svc, sent } = service({ fill: LIVE_FILL });
    const { recorder, begun, settled } = fakeRecorder();
    const result = await svc.placeOrder(open, recorder);

    const size = sizeForNotional({ usdNotional: 25, scaledPrice: MARK, priceDecimals: 1, sizeDecimals: 5 });
    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.openLong, p: 0, s: size, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(begun).toEqual([{ network: 'testnet', asset: 'BTC/USD', action: 'open', side: 'long', notionalUsd: 25, leverage: 2 }]);
    const tx = '0xc533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5';
    expect(settled).toEqual([
      {
        orderId: 'order-1',
        status: 'filled',
        side: 'long',
        requestId: 8,
        size: { atoms: '30', decimals: 5 },
        fee: { atoms: '8575', decimals: 6 },
        block: 69784237,
        fillPrice: { atoms: '828471', decimals: 1 },
        txHash: tx,
      },
    ]);
    expect(result).toEqual({
      status: 'filled',
      orderId: 'order-1',
      asset: 'BTC/USD',
      action: 'open',
      side: 'long',
      size: { atoms: '30', decimals: 5 },
      price: { atoms: '828471', decimals: 1 },
      fee: { atoms: '8575', decimals: 6 },
      block: 69784237,
      txHash: tx,
    });
  });

  it('sends a short as a short', async () => {
    const { svc, sent } = service({ fill: LIVE_FILL });
    await svc.placeOrder({ ...open, side: 'short', leverage: 3 }, fakeRecorder().recorder);
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.openShort, lv: 300 });
  });

  it('places nothing off testnet', async () => {
    const { svc, sent } = service({}, { network: 'mainnet' });
    const { recorder, begun } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({ status: 'unavailable', message: VENUE_MESSAGES.testnetOnly });
    expect(begun).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses an order outside the limits before anything is recorded or sent', async () => {
    const { svc, sent } = service();
    const { recorder, begun } = fakeRecorder();
    expect(await svc.placeOrder({ ...open, usd: 500 }, recorder)).toEqual({
      status: 'refused',
      reason: 'An order here is $10 to $100, in whole dollars.',
    });
    expect(await svc.placeOrder({ ...open, asset: 'MON/USD', leverage: 4 }, recorder)).toEqual({
      status: 'refused',
      reason: 'Leverage on MON here is 1x to 3x, in whole steps.',
    });
    expect(await svc.placeOrder({ ...open, asset: 'DOGE/USD' }, recorder)).toEqual({
      status: 'refused',
      reason: 'Perpl lists no market for DOGE/USD.',
    });
    expect(begun).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('sends nothing when the recorder does not let the order begin', async () => {
    const cases: Array<[BeginResult, unknown]> = [
      [{ ok: false, code: 'unauthenticated' }, { status: 'unavailable', message: VENUE_MESSAGES.signIn }],
      [{ ok: false, code: 'no_user' }, { status: 'unavailable', message: VENUE_MESSAGES.finishSignUp }],
      [{ ok: false, code: 'busy' }, { status: 'busy', message: VENUE_MESSAGES.busy }],
      [{ ok: false, code: 'unreachable' }, { status: 'unavailable', message: VENUE_MESSAGES.notRecorded }],
      [
        { ok: false, code: 'rate_limited', retryAfterMs: 60_000, message: 'Rate limit reached for now.' },
        { status: 'rate_limited', retryAfterMs: 60_000, message: 'Rate limit reached for now.' },
      ],
    ];
    for (const [begin, expected] of cases) {
      const { svc, sent } = service({ fill: LIVE_FILL });
      const { recorder, settled } = fakeRecorder(begin);
      expect(await svc.placeOrder(open, recorder)).toEqual(expected);
      expect(sent).toEqual([]);
      expect(settled).toEqual([]);
    }
  });

  it('refuses, on the record, what the account cannot take', async () => {
    const cases: Array<[VenueOpts, string]> = [
      [{ positions: [POSITION] }, 'The account already holds a BTC position. Close it before opening another.'],
      [{ account: { ...ACCOUNT, fr: true } }, 'The trading account is frozen.'],
      [{ account: { ...ACCOUNT, fw: false } }, 'One-click trading is off for the trading account.'],
      [{ account: { ...ACCOUNT, b: '5000000' } }, 'The trading account has 5.00 AUSD free. This order needs 12.50.'],
    ];
    for (const [venue, reason] of cases) {
      const { svc, sent } = service(venue);
      const { recorder, settled } = fakeRecorder();
      expect(await svc.placeOrder(open, recorder)).toEqual({ status: 'refused', reason });
      expect(settled).toEqual([{ orderId: 'order-1', status: 'refused', reason }]);
      expect(sent).toEqual([]);
    }
  });

  it("passes on the venue's own refusal", async () => {
    const { svc } = service({ submit: async () => [{ code: 12, error: 'insufficient margin' }] });
    const { recorder, settled } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({ status: 'refused', reason: 'insufficient margin' });
    expect(settled).toEqual([{ orderId: 'order-1', status: 'refused', side: 'long', reason: 'insufficient margin' }]);
  });

  it('says nothing filled when the venue took the order and no fill came', async () => {
    const { svc } = service({ fill: null });
    const { recorder, settled } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({
      status: 'unfilled',
      orderId: 'order-1',
      message: VENUE_MESSAGES.nothingFilled,
    });
    expect(settled).toEqual([{ orderId: 'order-1', status: 'unfilled', side: 'long', requestId: 8 }]);
  });

  it('says nothing was sent only when nothing was', async () => {
    const before = service({
      wallet: async () => {
        throw new PerplRestError(500, '/v1/trading/wallet', 'down');
      },
    });
    const first = fakeRecorder();
    expect(await before.svc.placeOrder(open, first.recorder)).toEqual({
      status: 'unavailable',
      message: VENUE_MESSAGES.notSent,
    });
    expect(first.settled).toEqual([{ orderId: 'order-1', status: 'failed', reason: VENUE_MESSAGES.notSent }]);
    expect(before.sent).toEqual([]);

    const after = service({ historyFailsAfterSend: true });
    const second = fakeRecorder();
    expect(await after.svc.placeOrder(open, second.recorder)).toEqual({
      status: 'unfilled',
      orderId: 'order-1',
      message: VENUE_MESSAGES.sentUnread,
    });
    expect(second.settled).toEqual([{ orderId: 'order-1', status: 'failed', reason: VENUE_MESSAGES.sentUnread }]);
    expect(after.sent).toHaveLength(1);
  });

  it('still reports a fill whose row could not be written', async () => {
    const { svc, errors } = service({ fill: LIVE_FILL });
    const recorder: VenueRecorder = {
      begin: async () => ({ ok: true, orderId: 'order-1' }),
      settle: async () => {
        throw new Error('the record store is down');
      },
    };
    expect((await svc.placeOrder(open, recorder)).status).toBe('filled');
    expect(errors).toEqual(['venue.settle']);
  });
});

describe('closePosition', () => {
  it('closes the whole position at market, at its own leverage', async () => {
    const closing: PerplFill = { ...LIVE_FILL, t: 3, p: 828134 };
    const { svc, sent } = service({ positions: [POSITION], fill: closing });
    const { recorder, begun, settled } = fakeRecorder();
    const result = await svc.closePosition('BTC/USD', recorder);

    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.closeLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(begun).toEqual([{ network: 'testnet', asset: 'BTC/USD', action: 'close' }]);
    expect(settled[0]).toMatchObject({ status: 'filled', side: 'long', fillPrice: { atoms: '828134', decimals: 1 } });
    expect(result).toMatchObject({ status: 'filled', action: 'close', side: 'long', asset: 'BTC/USD' });
  });

  it('closes a short with a short close', async () => {
    const { svc, sent } = service({ positions: [{ ...POSITION, sd: 2 }], fill: LIVE_FILL });
    const result = await svc.closePosition('BTC', fakeRecorder().recorder);
    expect(sent[0]?.t).toBe(PERPL_ORDER_TYPE.closeShort);
    expect(result).toMatchObject({ status: 'filled', side: 'short' });
  });

  it('refuses when there is nothing to close, and for an asset the venue does not list', async () => {
    const { svc, sent } = service();
    const held = fakeRecorder();
    expect(await svc.closePosition('BTC/USD', held.recorder)).toEqual({
      status: 'refused',
      reason: 'The account holds no BTC position.',
    });
    expect(held.settled).toEqual([{ orderId: 'order-1', status: 'refused', reason: 'The account holds no BTC position.' }]);

    const unlisted = fakeRecorder();
    expect(await svc.closePosition('DOGE/USD', unlisted.recorder)).toEqual({
      status: 'refused',
      reason: 'Perpl lists no market for DOGE/USD.',
    });
    expect(unlisted.begun).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('closes nothing off testnet', async () => {
    const { svc } = service({ positions: [POSITION] }, { network: 'mainnet' });
    const { recorder, begun } = fakeRecorder();
    expect(await svc.closePosition('BTC/USD', recorder)).toEqual({
      status: 'unavailable',
      message: VENUE_MESSAGES.testnetOnly,
    });
    expect(begun).toEqual([]);
  });
});
