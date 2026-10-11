import { describe, expect, it } from 'vitest';
import {
  DISCONNECTED_RISK_STORE,
  RISK_NOT_CONNECTED,
  RISK_UNKNOWN_SHAPE,
  RISK_UNREACHABLE,
  createRiskStore,
  type RiskGet,
} from './perpl-risk-reads';

const market = (mark: number, at: number) => ({
  id: 16,
  symbol: 'BTC',
  funding_interval_sec: 2580,
  config: { is_open: true, price_decimals: 1, size_decimals: 5, initial_margin: 1500, maintenance_margin: 2500 },
  state: { at: { t: at }, orl: mark, mrk: mark, bid: mark - 5, ask: mark + 5 },
});
const ticker = (mark: number, at: number) => ({ d: { '16': { at: { t: at }, orl: mark, mrk: mark, bid: mark - 5, ask: mark + 5 } } });

/** A store whose timers are run by hand and whose answers are queued per path. */
function setup(answers: Record<string, Array<unknown | Error>>) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const asked: string[] = [];
  const get: RiskGet = async (path) => {
    asked.push(path);
    const next = answers[path]?.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error('nothing queued');
    return next;
  };
  const store = createRiskStore({
    get,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, timers, asked, settle };
}

const marks = (state: ReturnType<ReturnType<typeof createRiskStore>['getSnapshot']>) =>
  state.status === 'ready' ? state.markets.map((m) => m.state?.mark) : state.status;

describe('the risk store', () => {
  it('reads nothing until something subscribes, then both halves at once', async () => {
    const { store, asked, settle } = setup({
      '/v1/pub/context': [{ markets: [market(840000, 1_000)] }],
      '/v1/market-data/ticker': [ticker(841000, 2_000)],
    });
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    expect(asked).toEqual([]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(asked.sort()).toEqual(['/v1/market-data/ticker', '/v1/pub/context']);
    // The ticker's state is fresher than the context's own.
    expect(marks(store.getSnapshot())).toEqual([841000]);
    off();
  });

  it('polls the fast half often and the slow half seldom, and stops when the last reader leaves', async () => {
    const { store, timers, asked, settle } = setup({
      '/v1/pub/context': [{ markets: [market(840000, 1_000)] }],
      '/v1/market-data/ticker': [ticker(841000, 2_000), ticker(842000, 3_000)],
    });
    const off = store.subscribe(() => undefined);
    await settle();
    expect(timers.map((t) => t.ms).sort((a, b) => a - b)).toEqual([5_000, 60_000]);
    timers.find((t) => t.ms === 5_000)?.fn();
    await settle();
    expect(marks(store.getSnapshot())).toEqual([842000]);
    off();
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(asked.filter((p) => p === '/v1/market-data/ticker')).toHaveLength(2);
  });

  it('says so when the first read fails, and keeps the last good answer when a later one does', async () => {
    const failing = setup({ '/v1/pub/context': [new Error('down')], '/v1/market-data/ticker': [new Error('down')] });
    const off = failing.store.subscribe(() => undefined);
    await failing.settle();
    expect(failing.store.getSnapshot()).toEqual({ status: 'unavailable', message: RISK_UNREACHABLE });
    off();

    const flaky = setup({
      '/v1/pub/context': [{ markets: [market(840000, 1_000)] }, new Error('down')],
      '/v1/market-data/ticker': [new Error('down')],
    });
    const stop = flaky.store.subscribe(() => undefined);
    await flaky.settle();
    flaky.timers.find((t) => t.ms === 60_000)?.fn();
    await flaky.settle();
    expect(marks(flaky.store.getSnapshot())).toEqual([840000]);
    stop();
  });

  it('asks for the market list again on the fast timer until it has one', async () => {
    const { store, timers, asked, settle } = setup({
      '/v1/pub/context': [new Error('down'), { markets: [market(840000, 1_000)] }],
      '/v1/market-data/ticker': [new Error('down'), new Error('down'), new Error('down')],
    });
    const off = store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', message: RISK_UNREACHABLE });
    const fast = timers.find((t) => t.ms === 5_000);
    fast?.fn();
    await settle();
    expect(marks(store.getSnapshot())).toEqual([840000]);
    // With the list in hand the fast timer leaves it to the slow one.
    fast?.fn();
    await settle();
    expect(asked.filter((p) => p === '/v1/pub/context')).toHaveLength(2);
    off();
  });

  it('does not draw markets from a body that is not a context', async () => {
    const { store, settle } = setup({ '/v1/pub/context': [{ nope: true }], '/v1/market-data/ticker': [ticker(1, 1)] });
    const off = store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', message: RISK_UNKNOWN_SHAPE });
    off();
  });

  it('drops an answer that lands after the last reader has left', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const store = createRiskStore({
      get: async (path) => (path === '/v1/pub/context' ? slow : ticker(1, 1)),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const off = store.subscribe(() => undefined);
    off();
    release({ markets: [market(840000, 1_000)] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
  });

  it('says market data is not connected in a build with no gateway', () => {
    expect(DISCONNECTED_RISK_STORE.getSnapshot()).toEqual({ status: 'unavailable', message: RISK_NOT_CONNECTED });
  });
});
