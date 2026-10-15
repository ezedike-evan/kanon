import { describe, expect, it } from 'vitest';
import {
  DISCONNECTED_SPOT_STORE,
  SPOT_EVERY_MS,
  SPOT_MARKET_PATH,
  SPOT_NOT_CONNECTED,
  SPOT_UNKNOWN_SHAPE,
  SPOT_UNREACHABLE,
  createSpotStore,
  type SpotGet,
} from './spot-reads';

const view = (blockNumber: number) => ({
  ok: true,
  asset: 'tkBTC/USDC',
  network: 'testnet',
  chainId: 10143,
  market: '0x4aC0501686D10048d083Ae8d1e13b9817FF1FF41',
  base: { address: '0x85495222Fd7069B987Ca38C2142732EbBFb7175D', name: 'Kanon Test BTC', symbol: 'tkBTC', decimals: 8, kind: 'test token, open mint' },
  quote: { address: '0x89b928df3A0F929578a3c93E1d6E3Be3433e539C', name: 'Mock USDC', symbol: 'USDC', decimals: 6, kind: 'mock, open mint' },
  note: 'tkBTC is a test token. It is not bitcoin.',
  priceDecimals: 4,
  sizeDecimals: 9,
  minSize: { atoms: '100000', decimals: 9 },
  maxSize: { atoms: '1000000000', decimals: 9 },
  takerFeeBps: 30,
  bids: [{ price: { atoms: '824475248', decimals: 4 }, size: { atoms: '250000000', decimals: 9 } }],
  asks: [{ price: { atoms: '832720000', decimals: 4 }, size: { atoms: '248756210', decimals: 9 } }],
  blockNumber,
  readAt: blockNumber * 1_000,
  listing: { marketTx: `0x${'b2'.repeat(32)}`, tokenTx: `0x${'a1'.repeat(32)}` },
});

/** A store whose timer is run by hand and whose answers are queued. */
function setup(answers: Array<unknown | Error>) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const asked: string[] = [];
  const get: SpotGet = async (path) => {
    asked.push(path);
    const next = answers.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error('nothing queued');
    return next;
  };
  const store = createSpotStore({
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
  const tick = async () => {
    timers.at(-1)?.fn();
    await settle();
  };
  return { store, timers, asked, settle, tick };
}

const block = (state: ReturnType<ReturnType<typeof createSpotStore>['getSnapshot']>) =>
  state.status === 'ready' ? state.market.blockNumber : state.status;

describe('the spot market store', () => {
  it('reads nothing until something subscribes, then the one public path', async () => {
    const { store, asked, settle } = setup([view(7)]);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    expect(asked).toEqual([]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(asked).toEqual([SPOT_MARKET_PATH]);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', failed: false });
    expect(block(store.getSnapshot())).toBe(7);
    off();
  });

  it('polls about every four seconds, and stops when the last reader leaves', async () => {
    const { store, timers, asked, tick, settle } = setup([view(7), view(8)]);
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);
    await settle();
    expect(timers.map((t) => t.ms)).toEqual([SPOT_EVERY_MS]);
    expect(SPOT_EVERY_MS).toBe(4_000);
    await tick();
    expect(block(store.getSnapshot())).toBe(8);
    first();
    expect(timers[0]?.cleared).toBe(false);
    second();
    expect(timers[0]?.cleared).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('says so when the first read fails', async () => {
    const { store, settle } = setup([new Error('offline')]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', code: 'unreachable', message: SPOT_UNREACHABLE });
    off();
  });

  it('keeps the last good book when a later request fails, marked as not the current one', async () => {
    const { store, tick, settle } = setup([view(7), new Error('offline'), { nonsense: true }, view(9)]);
    const off = store.subscribe(() => undefined);
    await settle();
    await tick();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', failed: true });
    expect(block(store.getSnapshot())).toBe(7);
    // An answer in a shape this screen does not know is a failed read too, not a new book.
    await tick();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', failed: true });
    expect(block(store.getSnapshot())).toBe(7);
    await tick();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', failed: false });
    expect(block(store.getSnapshot())).toBe(9);
    off();
  });

  it("drops the book when the gateway itself says there is none to show, and shows the gateway's sentence", async () => {
    const unreachable = { ok: false, code: 'unreachable', message: "Kuru's order book could not be read just now. Trying again." };
    const { store, tick, settle } = setup([view(7), unreachable, new Error('offline')]);
    const off = store.subscribe(() => undefined);
    await settle();
    await tick();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', code: 'unreachable', message: unreachable.message });
    // The book of block 7 is gone for good: a failed request after it does not bring it back.
    await tick();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', code: 'unreachable', message: SPOT_UNREACHABLE });
    off();
  });

  it('says a market is not listed in the words it was told', async () => {
    const { store, settle } = setup([{ ok: false, code: 'not_listed', message: 'No market is listed on Kuru from this deployment yet.' }]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toEqual({
      status: 'unavailable',
      code: 'not_listed',
      message: 'No market is listed on Kuru from this deployment yet.',
    });
    off();
  });

  it('says a first answer in an unknown shape is one, and draws no book from it', async () => {
    const { store, settle } = setup([{ ok: true, asset: 'tkBTC/USDC' }]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(store.getSnapshot()).toEqual({ status: 'unavailable', code: 'unknown_shape', message: SPOT_UNKNOWN_SHAPE });
    off();
  });

  it('starts from a fresh read when a reader comes back: an old book is not shown as the book', async () => {
    const { store, asked, settle } = setup([view(7), view(12)]);
    const off = store.subscribe(() => undefined);
    await settle();
    off();
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    const again = store.subscribe(() => undefined);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    await settle();
    expect(block(store.getSnapshot())).toBe(12);
    expect(asked).toHaveLength(2);
    again();
  });

  it('drops an answer that arrives after its reader has left', async () => {
    let release: (value: unknown) => void = () => undefined;
    const store = createSpotStore({
      get: () => new Promise((resolve) => (release = resolve)),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const off = store.subscribe(() => undefined);
    off();
    release(view(7));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
  });

  it('with no gateway address it says market data is not connected, and asks nothing', () => {
    const off = DISCONNECTED_SPOT_STORE.subscribe(() => undefined);
    expect(DISCONNECTED_SPOT_STORE.getSnapshot()).toEqual({
      status: 'unavailable',
      code: 'not_connected',
      message: SPOT_NOT_CONNECTED,
    });
    off();
  });
});
