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
  type FillDetailsRecord,
  type OrderOutcomeRecord,
  type OrderRecord,
  type OrderTiming,
  type VenueRecorder,
  type VenueServiceDeps,
} from './venue-service';

const BTC: PerplMarketInfo = { id: 16, symbol: 'BTC', priceDecimals: 1, sizeDecimals: 5, maxLeverage: 1500, open: true };
const MON: PerplMarketInfo = { id: 64, symbol: 'MON', priceDecimals: 5, sizeDecimals: 1, maxLeverage: 300, open: true };
const ACCOUNT: PerplAccount = { id: 1049, fr: false, fw: true, lfr: 7, b: '100000000', lb: '0' };
const MARK = 828_000;
const TX = '0xc533b0b04fcf0aa8bbaaea78b810184f8ee609b71248c3082243523d4f3b6cc5';

/** The fill testnet reported for the first order this code placed, 2026-10-10. */
const LIVE_FILL: PerplFill = {
  at: { b: 69784237, t: 1791622915000, tx: 3, txid: TX.slice(2), l: 4 },
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

/** The position that fill opened: 0.00030 BTC long at 82,847.1, 2x. */
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
  /** What the account holds before the order. */
  positions?: PerplPosition[];
  /** What it holds once the order is forwarded. Undefined: unchanged. */
  after?: PerplPosition[];
  /** The fill the order produces in the history. Null: none. */
  fill?: PerplFill | null;
  /** Reads of the history, after the order was forwarded, before it lists the fill. */
  historyAfterReads?: number;
  neverForwards?: boolean;
  wallet?: () => Promise<{ sn: number; addr: string; as: PerplAccount[] }>;
  submit?: (orders: PerplOrderSpec[]) => Promise<Array<{ code: number; error?: string }>>;
  /** Reading the positions after an order was accepted throws. */
  unreadableAfterSend?: boolean;
}

function fakeVenue(opts: VenueOpts = {}) {
  const sent: PerplOrderSpec[] = [];
  const account = opts.account ?? ACCOUNT;
  let accepted: PerplOrderSpec | null = null;
  let historyReads = 0;
  const forwarded = () => accepted !== null && !opts.neverForwards;
  const rest: PerplRest = {
    wallet: opts.wallet ?? (async () => ({ sn: 1, addr: '0xabc', as: [{ ...account, lfr: forwarded() && accepted ? accepted.rq : account.lfr }] })),
    positions: async () => {
      if (accepted && opts.unreadableAfterSend) throw new PerplRestError(502, '/v1/trading/positions', 'Bad Gateway');
      return forwarded() && opts.after ? opts.after : (opts.positions ?? []);
    },
    fills: async () => {
      if (!forwarded() || !opts.fill) return [];
      historyReads += 1;
      return historyReads > (opts.historyAfterReads ?? 0) ? [opts.fill] : [];
    },
    submit: async (orders) => {
      sent.push(...orders);
      const statuses = opts.submit ? await opts.submit(orders) : [{ code: 0 }];
      if (statuses[0]?.code === 0) accepted = orders[0] ?? null;
      return statuses;
    },
  };
  return { rest, sent };
}

function fakeRecorder(begin: BeginResult = { ok: true, orderId: 'order-1' }) {
  const begun: OrderRecord[] = [];
  const settled: OrderOutcomeRecord[] = [];
  const amended: FillDetailsRecord[] = [];
  const recorder: VenueRecorder = {
    begin: async (order) => {
      begun.push(order);
      return begin;
    },
    settle: async (outcome) => {
      settled.push(outcome);
    },
    amend: async (details) => {
      amended.push(details);
    },
  };
  return { recorder, begun, settled, amended };
}

function service(venue: VenueOpts = {}, over: Partial<VenueServiceDeps> = {}) {
  const fake = fakeVenue(venue);
  const errors: string[] = [];
  const timings: OrderTiming[] = [];
  const later: Array<Promise<void>> = [];
  let clock = 1_000_000;
  const svc = createVenueService({
    network: 'testnet',
    rest: fake.rest,
    loadMarkets: async () => [BTC, MON],
    readMarkPrice: async () => MARK,
    // Every look at the clock moves it on, so a wait for an order the venue never reports on ends.
    trade: { sleep: async () => {}, settleTimeoutMs: 5_000, now: () => (clock += 1_000) },
    onError: (scope) => errors.push(scope),
    onTiming: (timing) => timings.push(timing),
    background: (task) => later.push(task),
    ...over,
  });
  /** Waits for what the service left running after it answered: the record, and the fill's figures. */
  const settleBackground = async () => {
    for (let seen = -1; seen !== later.length; ) {
      seen = later.length;
      await Promise.all(later);
    }
  };
  return { svc, sent: fake.sent, errors, timings, settleBackground };
}

const open = { asset: 'BTC/USD', side: 'long', usd: 25, leverage: 2 } as const;
const LIMITS = { minNotionalUsd: 10, maxNotionalUsd: 100, maxLeverage: 5, slippageBps: 100, maxPositionUsd: 300 };

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
      limits: LIMITS,
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
          // 0.00030 BTC at 82,847.1 is $24.85.
          notional: { atoms: '2485', decimals: 2 },
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
    const { svc, sent, timings, settleBackground } = service({ after: [POSITION], fill: LIVE_FILL });
    const { recorder, begun, settled, amended } = fakeRecorder();
    const result = await svc.placeOrder(open, recorder);

    const size = sizeForNotional({ usdNotional: 25, scaledPrice: MARK, priceDecimals: 1, sizeDecimals: 5 });
    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.openLong, p: 0, s: size, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(begun).toEqual([{ network: 'testnet', asset: 'BTC/USD', action: 'open', side: 'long', notionalUsd: 25, leverage: 2 }]);
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
        txHash: TX,
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
      txHash: TX,
    });
    // The record was complete when the order was answered: nothing is left to add.
    await settleBackground();
    expect(amended).toEqual([]);
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ action: 'open', asset: 'BTC/USD', status: 'filled' });
  });

  it('answers as soon as the position appears, and completes the record when the history lists the fill', async () => {
    // Testnet, 2026-10-10: positions moved in about three seconds; the history took far longer.
    const { svc, settleBackground } = service({ after: [POSITION], fill: LIVE_FILL, historyAfterReads: 4 });
    const { recorder, settled, amended } = fakeRecorder();
    const result = await svc.placeOrder(open, recorder);

    // From the position itself: a new position's entry price is its fill price, and it says when it opened.
    expect(result).toEqual({
      status: 'filled',
      orderId: 'order-1',
      asset: 'BTC/USD',
      action: 'open',
      side: 'long',
      size: { atoms: '30', decimals: 5 },
      price: { atoms: '828471', decimals: 1 },
      fee: null,
      block: 69784237,
      txHash: null,
    });
    expect(settled).toEqual([
      {
        orderId: 'order-1',
        status: 'filled',
        side: 'long',
        requestId: 8,
        size: { atoms: '30', decimals: 5 },
        fillPrice: { atoms: '828471', decimals: 1 },
        block: 69784237,
      },
    ]);
    expect(amended).toEqual([]);

    await settleBackground();
    expect(amended).toEqual([
      {
        orderId: 'order-1',
        size: { atoms: '30', decimals: 5 },
        fee: { atoms: '8575', decimals: 6 },
        block: 69784237,
        fillPrice: { atoms: '828471', decimals: 1 },
        txHash: TX,
      },
    ]);
  });

  it('gives up on a history that never lists the fill, without a word', async () => {
    const { svc, errors, settleBackground } = service({ after: [POSITION], fill: null });
    const { recorder, amended } = fakeRecorder();
    expect((await svc.placeOrder(open, recorder)).status).toBe('filled');
    await settleBackground();
    expect(amended).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('sends a short as a short', async () => {
    const { svc, sent } = service({ after: [{ ...POSITION, sd: 2, lv: 300 }], fill: LIVE_FILL });
    await svc.placeOrder({ ...open, side: 'short', leverage: 3 }, fakeRecorder().recorder);
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.openShort, lv: 300 });
  });

  it('adds to a position held on the same side, and reports how much was added', async () => {
    const grown = { ...POSITION, s: 60 };
    const { svc, sent } = service({ positions: [POSITION], after: [grown], fill: null });
    const { recorder, settled } = fakeRecorder();
    const result = await svc.placeOrder(open, recorder);
    expect(sent[0]).toMatchObject({ t: PERPL_ORDER_TYPE.openLong, lv: 200 });
    // The added size is known from the position. Its price is not: the entry price is now a blend.
    expect(result).toMatchObject({ status: 'filled', action: 'open', size: { atoms: '30', decimals: 5 }, price: null, block: null });
    expect(settled).toEqual([{ orderId: 'order-1', status: 'filled', side: 'long', requestId: 8, size: { atoms: '30', decimals: 5 } }]);
  });

  it('places nothing off testnet', async () => {
    const { svc, sent } = service({}, { network: 'mainnet' });
    const { recorder, begun } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({ status: 'unavailable', message: VENUE_MESSAGES.testnetOnly });
    expect(begun).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses an order outside the limits before anything is recorded or sent', async () => {
    const { svc, sent, timings } = service();
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
    expect(timings).toEqual([]);
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
      const { svc, sent } = service({ after: [POSITION], fill: LIVE_FILL });
      const { recorder, settled } = fakeRecorder(begin);
      expect(await svc.placeOrder(open, recorder)).toEqual(expected);
      expect(sent).toEqual([]);
      expect(settled).toEqual([]);
    }
  });

  it('refuses, on the record, what the account cannot take', async () => {
    const cases: Array<[VenueOpts, typeof open | { asset: string; side: 'long' | 'short'; usd: number; leverage: number }, string]> = [
      [{ positions: [POSITION] }, { ...open, side: 'short' }, 'The account holds a BTC long. Close it before opening a short.'],
      [{ positions: [POSITION] }, { ...open, leverage: 3 }, 'The BTC position is at 2x. An order that adds to it uses the same leverage.'],
      [{ positions: [{ ...POSITION, s: 350 }] }, open, 'The BTC position is $289.96 at entry. A position here is at most $300.'],
      [{ account: { ...ACCOUNT, fr: true } }, open, 'The trading account is frozen.'],
      [{ account: { ...ACCOUNT, fw: false } }, open, 'One-click trading is off for the trading account.'],
      [{ account: { ...ACCOUNT, b: '5000000' } }, open, 'The trading account has 5.00 AUSD free. This order needs 12.50.'],
    ];
    for (const [venue, request, reason] of cases) {
      const { svc, sent } = service(venue);
      const { recorder, settled } = fakeRecorder();
      expect(await svc.placeOrder(request, recorder), reason).toEqual({ status: 'refused', reason });
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

  it('says nothing filled when the venue forwarded the order and the position did not move', async () => {
    const { svc } = service({ fill: null });
    const { recorder, settled } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({
      status: 'unfilled',
      orderId: 'order-1',
      message: VENUE_MESSAGES.nothingFilled,
    });
    expect(settled).toEqual([{ orderId: 'order-1', status: 'unfilled', side: 'long', requestId: 8 }]);
  });

  it('does not say an order failed to fill when the venue has simply not reported on it', async () => {
    const { svc } = service({ neverForwards: true });
    const { recorder, settled } = fakeRecorder();
    expect(await svc.placeOrder(open, recorder)).toEqual({
      status: 'pending',
      orderId: 'order-1',
      message: VENUE_MESSAGES.sentUnreported,
    });
    expect(settled).toEqual([
      { orderId: 'order-1', status: 'failed', side: 'long', requestId: 8, reason: VENUE_MESSAGES.sentUnreported },
    ]);
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

    const after = service({ unreadableAfterSend: true });
    const second = fakeRecorder();
    expect(await after.svc.placeOrder(open, second.recorder)).toEqual({
      status: 'pending',
      orderId: 'order-1',
      message: VENUE_MESSAGES.sentUnread,
    });
    expect(second.settled).toEqual([{ orderId: 'order-1', status: 'failed', reason: VENUE_MESSAGES.sentUnread }]);
    expect(after.sent).toHaveLength(1);
  });

  it('answers once the venue has, not once the record is written, and holds the next order until it is', async () => {
    const { svc } = service({ after: [POSITION], fill: LIVE_FILL });
    const events: string[] = [];
    let release = (): void => {};
    const written = new Promise<void>((resolve) => (release = resolve));
    const recorder: VenueRecorder = {
      begin: async (order) => {
        events.push(`begin ${order.action}`);
        return { ok: true, orderId: `order-${events.length}` };
      },
      settle: async (outcome) => {
        events.push(`writing ${outcome.status}`);
        if (events.filter((e) => e.startsWith('writing')).length === 1) await written;
        events.push(`written ${outcome.status}`);
      },
    };

    // The backend has not finished writing the row, and the answer is already back.
    expect((await svc.placeOrder(open, recorder)).status).toBe('filled');
    expect(events).toEqual(['begin open', 'writing filled']);

    // A second order does not reach the lock while that write is still out.
    const second = svc.closePosition('BTC/USD', recorder);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['begin open', 'writing filled']);

    release();
    await second;
    expect(events.slice(0, 4)).toEqual(['begin open', 'writing filled', 'written filled', 'begin close']);
  });

  it('still reports a fill whose row could not be written', async () => {
    const { svc, errors } = service({ after: [POSITION], fill: LIVE_FILL });
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
  const closing: PerplFill = { ...LIVE_FILL, t: 3, p: 828134, oid: 77 };

  it('closes the whole position at market, at its own leverage', async () => {
    const { svc, sent, timings } = service({ positions: [POSITION], after: [], fill: closing });
    const { recorder, begun, settled } = fakeRecorder();
    const result = await svc.closePosition('BTC/USD', recorder);

    expect(sent).toEqual([
      { rq: 8, mkt: 16, acc: 1049, t: PERPL_ORDER_TYPE.closeLong, p: 0, s: 30, ms: 100, fl: PERPL_FLAG.ioc, lv: 200, lb: 0 },
    ]);
    expect(begun).toEqual([{ network: 'testnet', asset: 'BTC/USD', action: 'close' }]);
    expect(settled[0]).toMatchObject({ status: 'filled', side: 'long', fillPrice: { atoms: '828134', decimals: 1 }, txHash: TX });
    expect(result).toMatchObject({ status: 'filled', action: 'close', side: 'long', asset: 'BTC/USD', txHash: TX });
    expect(timings[0]).toMatchObject({ action: 'close', status: 'filled' });
  });

  it('reports the close once the position is gone, and adds the price and transaction when the history has them', async () => {
    // The close of 2026-10-10 that was reported as not filled: the position went in seconds, the history did not follow in twenty.
    const { svc, settleBackground } = service({ positions: [POSITION], after: [], fill: closing, historyAfterReads: 6 });
    const { recorder, settled, amended } = fakeRecorder();
    expect(await svc.closePosition('BTC/USD', recorder)).toEqual({
      status: 'filled',
      orderId: 'order-1',
      asset: 'BTC/USD',
      action: 'close',
      side: 'long',
      size: { atoms: '30', decimals: 5 },
      price: null,
      fee: null,
      block: null,
      txHash: null,
    });
    expect(settled).toEqual([{ orderId: 'order-1', status: 'filled', side: 'long', requestId: 8, size: { atoms: '30', decimals: 5 } }]);
    await settleBackground();
    expect(amended).toEqual([
      {
        orderId: 'order-1',
        size: { atoms: '30', decimals: 5 },
        fee: { atoms: '8575', decimals: 6 },
        block: 69784237,
        fillPrice: { atoms: '828134', decimals: 1 },
        txHash: TX,
      },
    ]);
  });

  it('closes a short with a short close', async () => {
    const short = { ...POSITION, sd: 2 };
    const { svc, sent } = service({ positions: [short], after: [], fill: LIVE_FILL });
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
