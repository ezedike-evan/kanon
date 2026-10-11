import { describe, expect, it } from 'vitest';
import type { PerplMarketInfo } from './perpl-trade';
import {
  TIMED_MESSAGES,
  createTimedRunner,
  type TimedRecord,
  type TimedRunnerDeps,
  type TimedStore,
  type TimedUpdate,
} from './timed-runner';
import type {
  FillDetailsRecord,
  OrderRequest,
  PlaceOptions,
  VenueAccountView,
  VenueOrderResult,
  VenueRecorder,
  VenueService,
} from './venue-service';

const BTC: PerplMarketInfo = { id: 16, symbol: 'BTC', priceDecimals: 1, sizeDecimals: 5, maxLeverage: 1500, open: true };
const MON: PerplMarketInfo = { id: 64, symbol: 'MON', priceDecimals: 5, sizeDecimals: 1, maxLeverage: 300, open: true };
const TX = `0x${'ab'.repeat(32)}`;
const TOKEN = 'aaa.bbb.ccc';

/** The entry fill: 0.00030 BTC at 82,847.1, fee 0.008575 AUSD. */
const FILLED: VenueOrderResult = {
  status: 'filled',
  orderId: 'order-open',
  asset: 'BTC/USD',
  action: 'open',
  side: 'long',
  size: { atoms: '30', decimals: 5 },
  price: { atoms: '828471', decimals: 1 },
  fee: { atoms: '8575', decimals: 6 },
  block: 100,
  txHash: TX,
};
/** The exit fill: at 82,877.1, $30.0 higher. */
const CLOSED: VenueOrderResult = { ...FILLED, orderId: 'order-close', action: 'close', price: { atoms: '828771', decimals: 1 }, block: 200 };

const account = (assets: string[] = []): VenueAccountView => ({
  status: 'ready',
  venue: 'perpl',
  network: 'testnet',
  wallet: '0xabc',
  accountId: 1049,
  balance: { atoms: '100000000', decimals: 6 },
  canTrade: true,
  limits: { minNotionalUsd: 10, maxNotionalUsd: 100, maxLeverage: 5, slippageBps: 100, maxPositionUsd: 300 },
  markets: [],
  positions: assets.map((asset) => ({
    asset,
    side: 'long',
    size: { atoms: '30', decimals: 5 },
    entryPrice: { atoms: '828471', decimals: 1 },
    leverage: 5,
    collateral: { atoms: '5000000', decimals: 6 },
    notional: { atoms: '2485', decimals: 2 },
    openedAt: null,
  })),
});

interface World {
  /** What the next opening order answers. */
  open: VenueOrderResult;
  /** What each closing order answers, in turn; the last one repeats. */
  closes: VenueOrderResult[];
  /** Assets the account holds a position on. */
  held: string[];
  mark: number;
  startFails: boolean;
  owner: boolean;
  stored: TimedRecord[];
}

function setup(over: Partial<World> = {}, depsOver: Partial<TimedRunnerDeps> = {}) {
  const world: World = { open: FILLED, closes: [CLOSED], held: [], mark: 828471, startFails: false, owner: true, stored: [], ...over };
  let clock = 1_000_000;
  const timers: Array<{ run: () => void; at: number; live: boolean }> = [];
  const placed: Array<[OrderRequest, PlaceOptions | undefined]> = [];
  const closed: string[] = [];
  const started: Array<Record<string, unknown>> = [];
  const updates: TimedUpdate[] = [];
  const errors: string[] = [];
  /** The recorder the service was handed for the last closing order, so a test can deliver a late fill. */
  let closer: VenueRecorder | null = null;

  const service: VenueService = {
    account: async () => account(world.held),
    placeOrder: async (request, _recorder, options) => {
      placed.push([request, options]);
      return world.open;
    },
    closePosition: async (asset, recorder) => {
      closed.push(asset);
      closer = recorder;
      const answer = world.closes.length > 1 ? world.closes.shift() : world.closes[0];
      return answer ?? CLOSED;
    },
  };
  const plain: VenueRecorder = { begin: async () => ({ ok: true, orderId: 'o' }), settle: async () => {}, amend: async () => {} };
  const store: TimedStore = {
    start: async (token, trade) => {
      started.push({ token, ...trade });
      return world.startFails ? null : `trade-${started.length}`;
    },
    closerFor: () => plain,
    update: async (update) => {
      updates.push(update);
    },
    running: async () => world.stored,
    owns: async () => world.owner,
  };
  const runner = createTimedRunner({
    network: 'testnet',
    service,
    recorderFor: () => plain,
    store,
    loadMarkets: async () => [BTC, MON],
    readMarkPrice: async () => world.mark,
    now: () => clock,
    setTimer: (run, ms) => {
      const timer = { run, at: clock + ms, live: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { live: boolean }).live = false;
    },
    sleep: async () => {},
    onError: (scope) => errors.push(scope),
    ...depsOver,
  });

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Moves the clock on and runs every timer that has come due, in order. */
  const advance = async (ms: number): Promise<void> => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      due.live = false;
      due.run();
      await flush();
    }
    clock = until;
    await flush();
  };
  const liveTimers = () => timers.filter((t) => t.live).length;
  const amendClose = async (details: FillDetailsRecord): Promise<void> => {
    await (closer as VenueRecorder | null)?.amend?.(details);
  };
  return { world, runner, placed, closed, started, updates, errors, advance, flush, liveTimers, amendClose, now: () => clock };
}

const ask = { asset: 'BTC/USD', direction: 'up', stakeUsd: 25, seconds: 60 } as const;

describe('open', () => {
  it('opens the position a call stands for, and starts its clock at the fill', async () => {
    const t = setup();
    const result = await t.runner.open(ask, TOKEN);

    // Up is a long; the size is the stake times the market's leverage; the market must be free.
    expect(t.placed).toEqual([
      [
        { asset: 'BTC/USD', side: 'long', usd: 125, leverage: 5 },
        { limits: { minNotionalUsd: 1, maxNotionalUsd: 500, maxLeverage: 5, slippageBps: 100, maxPositionUsd: 500 }, freshOnly: true },
      ],
    ]);
    expect(t.started).toEqual([
      {
        token: TOKEN,
        network: 'testnet',
        asset: 'BTC/USD',
        direction: 'up',
        stakeUsd: 25,
        leverage: 5,
        seconds: 60,
        openedAt: 1_000_000,
        expiresAt: 1_060_000,
        size: { atoms: '30', decimals: 5 },
        entryPrice: { atoms: '828471', decimals: 1 },
        openFee: { atoms: '8575', decimals: 6 },
        openTx: TX,
      },
    ]);
    expect(result).toEqual({
      status: 'opened',
      trade: {
        id: 'trade-1',
        asset: 'BTC/USD',
        direction: 'up',
        stakeUsd: 25,
        leverage: 5,
        seconds: 60,
        openedAt: 1_000_000,
        expiresAt: 1_060_000,
        size: { atoms: '30', decimals: 5 },
        entryPrice: { atoms: '828471', decimals: 1 },
      },
    });
  });

  it('opens a short for a call down, at the leverage the market allows', async () => {
    const t = setup();
    await t.runner.open({ asset: 'MON/USD', direction: 'down', stakeUsd: 10, seconds: 300 }, TOKEN);
    expect(t.placed[0]?.[0]).toEqual({ asset: 'MON/USD', side: 'short', usd: 30, leverage: 3 });
  });

  it('refuses what is not on offer before anything is sent', async () => {
    const t = setup();
    expect(await t.runner.open({ ...ask, stakeUsd: 7 }, TOKEN)).toEqual({ status: 'refused', reason: 'A stake here is one of $10, $25, $50, $100.' });
    expect(await t.runner.open({ ...ask, seconds: 30 }, TOKEN)).toEqual({ status: 'refused', reason: 'A trade here runs for one of 1m, 5m, 15m, 1h.' });
    expect(await t.runner.open({ ...ask, asset: 'DOGE/USD' }, TOKEN)).toEqual({ status: 'refused', reason: 'Perpl lists no market for DOGE/USD.' });
    expect(t.placed).toEqual([]);
  });

  it("passes on the order's own answer when it did not fill, and runs nothing", async () => {
    const answers: VenueOrderResult[] = [
      { status: 'refused', reason: 'The shared account already holds a BTC position.' },
      { status: 'busy', message: 'Another order is on its way to this account. Try again in a moment.' },
      { status: 'unavailable', message: 'Sign in to trade.' },
      { status: 'pending', orderId: 'x', message: 'sent' },
      { status: 'unfilled', orderId: 'x', message: 'nothing filled' },
    ];
    for (const open of answers) {
      const t = setup({ open });
      expect(await t.runner.open(ask, TOKEN)).toEqual(open);
      expect(t.started).toEqual([]);
      expect(t.liveTimers()).toBe(0);
    }
  });

  it('takes one timed trade per market at a time, and says when it frees', async () => {
    const t = setup();
    await t.runner.open(ask, TOKEN);
    await t.advance(20_000);
    expect(await t.runner.open({ ...ask, direction: 'down' }, TOKEN)).toEqual({
      status: 'refused',
      reason: 'BTC is in a timed trade on the shared account. It ends in about 40 seconds.',
    });
    expect(t.placed).toHaveLength(1);
    // Another market is free.
    expect((await t.runner.open({ ...ask, asset: 'MON/USD' }, TOKEN)).status).toBe('opened');
  });

  it('closes a position it could not record, rather than leave it open with nobody timing it', async () => {
    const t = setup({ startFails: true });
    expect(await t.runner.open(ask, TOKEN)).toEqual({ status: 'unavailable', message: TIMED_MESSAGES.notRecorded });
    expect(t.closed).toEqual(['BTC/USD']);
    expect(t.liveTimers()).toBe(0);
  });

  it('runs nothing when the fill came back without a price', async () => {
    const t = setup({ open: { ...FILLED, price: null } });
    expect(await t.runner.open(ask, TOKEN)).toEqual({ status: 'pending', message: TIMED_MESSAGES.noPrice });
    expect(t.started).toEqual([]);
  });
});

describe('ending a trade', () => {
  it('closes the position when its time is up, and writes the result of the two fills', async () => {
    const t = setup();
    await t.runner.open(ask, TOKEN);
    await t.advance(59_000);
    expect(t.closed).toEqual([]);
    await t.advance(1_000);
    expect(t.closed).toEqual(['BTC/USD']);
    expect(t.updates).toEqual([
      { tradeId: 'trade-1', status: 'closing' },
      { tradeId: 'trade-1', status: 'closed', endedBy: 'time', closedAt: 1_060_000 },
      {
        tradeId: 'trade-1',
        closeTx: TX,
        exitPrice: { atoms: '828771', decimals: 1 },
        // Up $30.0 on 0.0003 BTC is $0.009; the two fees are $0.01715.
        result: { atoms: '-8150', decimals: 6 },
        fees: { atoms: '17150', decimals: 6 },
      },
    ]);
    expect(t.liveTimers()).toBe(0);
  });

  it('writes the result when the venue lists the exit fill, if that is after the close', async () => {
    const t = setup({ closes: [{ ...CLOSED, price: null, fee: null, block: null, txHash: null }] });
    await t.runner.open({ ...ask, direction: 'down' }, TOKEN);
    await t.advance(60_000);
    expect(t.updates).toEqual([
      { tradeId: 'trade-1', status: 'closing' },
      { tradeId: 'trade-1', status: 'closed', endedBy: 'time', closedAt: 1_060_000 },
    ]);

    await t.amendClose({ orderId: 'order-close', fillPrice: { atoms: '828171', decimals: 1 }, fee: { atoms: '8575', decimals: 6 }, txHash: TX });
    expect(t.updates[2]).toEqual({
      tradeId: 'trade-1',
      closeTx: TX,
      exitPrice: { atoms: '828171', decimals: 1 },
      // Called down, fell $30.0: $0.009 made, less $0.01715 of fees.
      result: { atoms: '-8150', decimals: 6 },
      fees: { atoms: '17150', decimals: 6 },
    });
    // A second listing of the same fill changes nothing.
    await t.amendClose({ orderId: 'order-close', fillPrice: { atoms: '1', decimals: 1 } });
    expect(t.updates).toHaveLength(3);
  });

  it('ends a trade early when it has lost its stake at the mark price', async () => {
    // 0.0003 BTC cannot lose $25 on any real move, so this one is sized to: 0.05 BTC, stake $10.
    const big = { ...FILLED, size: { atoms: '5000', decimals: 5 }, price: { atoms: '800000', decimals: 1 } };
    const t = setup({ open: big, mark: 800_000 });
    await t.runner.open({ ...ask, stakeUsd: 10, seconds: 3600 }, TOKEN);
    await t.advance(5_000);
    expect(t.closed).toEqual([]);
    // $200 down on 0.05 BTC is $10: the stake.
    t.world.mark = 798_000;
    await t.advance(5_000);
    expect(t.closed).toEqual(['BTC/USD']);
    expect(t.updates[1]).toMatchObject({ status: 'closed', endedBy: 'cut' });
  });

  it("ends the caller's own trade when they ask, and nobody else's", async () => {
    const t = setup();
    await t.runner.open(ask, TOKEN);
    expect(await t.runner.close('trade-1', TOKEN)).toEqual({ status: 'closing', tradeId: 'trade-1' });
    await t.flush();
    expect(t.updates[1]).toMatchObject({ status: 'closed', endedBy: 'owner' });

    const other = setup({ owner: false });
    await other.runner.open(ask, TOKEN);
    expect(await other.runner.close('trade-1', 'xxx.yyy.zzz')).toEqual({ status: 'refused', reason: TIMED_MESSAGES.notYours });
    expect(await other.runner.close('trade-9', TOKEN)).toEqual({ status: 'refused', reason: TIMED_MESSAGES.notYours });
    expect(other.closed).toEqual([]);
  });

  it('records a trade as ended elsewhere when its position is already gone', async () => {
    const t = setup({ closes: [{ status: 'refused', reason: 'The account holds no BTC position.' }], held: [] });
    await t.runner.open(ask, TOKEN);
    await t.advance(60_000);
    expect(t.updates.at(-1)).toEqual({ tradeId: 'trade-1', status: 'closed', endedBy: 'venue', closedAt: 1_060_000 });
    expect(t.liveTimers()).toBe(0);
  });

  it('keeps trying a close the venue would not take while the position is still there', async () => {
    const t = setup({
      held: ['BTC/USD'],
      closes: [
        { status: 'refused', reason: 'The trading account is frozen.' },
        { status: 'busy', message: 'Another order is on its way to this account. Try again in a moment.' },
        { status: 'pending', orderId: 'x', message: 'sent' },
        CLOSED,
      ],
    });
    await t.runner.open(ask, TOKEN);
    await t.advance(60_000);
    expect(t.closed).toHaveLength(4);
    expect(t.updates.map((u) => u.reason ?? u.status)).toEqual([
      'closing',
      'The trading account is frozen.',
      'Another order is on its way to this account. Try again in a moment.',
      'sent',
      'closed',
      undefined,
    ]);
    expect(t.updates[4]).toMatchObject({ status: 'closed', endedBy: 'time' });
  });
});

describe('state and restarts', () => {
  it('lists every market with its leverage, and which are taken and until when', async () => {
    const t = setup({ held: ['MON/USD'] });
    await t.runner.open(ask, TOKEN);
    expect(await t.runner.state()).toEqual({
      status: 'ready',
      venue: 'perpl',
      network: 'testnet',
      limits: { stakesUsd: [10, 25, 50, 100], durations: [60, 300, 900, 3600], maxLeverage: 5, slippageBps: 100 },
      markets: [
        // In a timed trade: free when it ends.
        { asset: 'BTC/USD', open: true, leverage: 5, busy: { until: 1_060_000 } },
        // Held from the chart's ticket: nobody knows when it frees.
        { asset: 'MON/USD', open: true, leverage: 3, busy: { until: null } },
      ],
    });
  });

  it('passes on why the account cannot be read', async () => {
    const t = setup();
    const down: VenueService = {
      account: async () => ({ status: 'unavailable', message: 'The venue could not be read. Try again.' }),
      placeOrder: async () => FILLED,
      closePosition: async () => CLOSED,
    };
    const runner = createTimedRunner({
      network: 'testnet',
      service: down,
      recorderFor: () => ({ begin: async () => ({ ok: true, orderId: 'o' }), settle: async () => {} }),
      store: { start: async () => null, closerFor: () => ({ begin: async () => ({ ok: true, orderId: 'o' }), settle: async () => {} }), update: async () => {}, running: async () => [], owns: async () => false },
      loadMarkets: async () => [BTC],
      readMarkPrice: async () => 1,
    });
    expect(await runner.state()).toEqual({ status: 'unavailable', message: 'The venue could not be read. Try again.' });
    expect(t.errors).toEqual([]);
  });

  it('picks up the trades an earlier process left running, and closes the ones whose time has passed', async () => {
    const base = {
      network: 'testnet' as const,
      direction: 'up' as const,
      stakeUsd: 25,
      leverage: 5,
      seconds: 60,
      size: { atoms: '30', decimals: 5 },
      entryPrice: { atoms: '828471', decimals: 1 },
    };
    const t = setup({
      stored: [
        { ...base, id: 'old', asset: 'BTC/USD', openedAt: 900_000, expiresAt: 960_000 },
        { ...base, id: 'young', asset: 'MON/USD', openedAt: 990_000, expiresAt: 1_050_000 },
        // Another network's trade is not this process's to close.
        { ...base, id: 'elsewhere', network: 'mainnet', asset: 'BTC/USD', openedAt: 1, expiresAt: 2 },
      ],
    });
    await t.runner.resume();
    await t.advance(0);
    expect(t.closed).toEqual(['BTC/USD']);
    await t.advance(50_000);
    expect(t.closed).toEqual(['BTC/USD', 'MON/USD']);
    // Resuming again does not double the timers of what is already in hand.
    expect(t.liveTimers()).toBe(0);
  });

  it('stops its timers, and leaves running trades in the store', async () => {
    const t = setup();
    await t.runner.open(ask, TOKEN);
    t.runner.stop();
    await t.advance(120_000);
    expect(t.closed).toEqual([]);
    expect(t.updates).toEqual([]);
  });
});
