import { describe, expect, it } from 'vitest';
import type { IndexerRequest } from './onchain-record';
import {
  NOT_CONNECTED_RECORD_STORE,
  ONCHAIN_EVERY_MS,
  ONCHAIN_NOT_CONNECTED,
  ONCHAIN_UNKNOWN_SHAPE,
  ONCHAIN_UNREACHABLE,
  createIndexerPost,
  createOnchainRecordStore,
  createOnchainRecordStores,
  pickOnchainRecordStore,
  resolveIndexer,
  type OnchainRecordState,
} from './onchain-record-reads';

const CHAIN = 10143;
const OWNER = '0xabcdef0123456789abcdef0123456789abcdef01';
const hash = (c: string) => `0x${c.repeat(64)}`;

// Answers in the shape Envio's GraphQL API gives: `{ data: { <Entity>: [rows] } }`.
const rules = (...ids: number[]) => ({
  data: { Strategy: ids.map((id) => ({ id: `${CHAIN}_${id}`, strategyId: String(id), activeSpecHash: hash('a'), pendingSpecHash: null })) },
});
const pin = (block: number) => ({
  id: `${CHAIN}_${block}_0`,
  strategy_id: `${CHAIN}_3`,
  kind: 'PINNED',
  oldSpecHash: null,
  newSpecHash: hash('a'),
  cooldownEndsAt: null,
  timestamp: 1_760_000_000 + block,
  blockNumber: block,
  logIndex: 0,
  txHash: hash('1'),
});
const refused = (block: number) => ({
  id: `${CHAIN}_${block}_2`,
  strategy_id: `${CHAIN}_3`,
  specHash: hash('a'),
  predicate: 'fvg_present',
  decidingValue: '12',
  timestamp: 1_760_000_000 + block,
  blockNumber: block,
  logIndex: 2,
  txHash: hash('2'),
});
const record = (events: unknown[], refusals: unknown[] = []) => ({ data: { StrategyEvent: events, Refusal: refusals } });

/** A store whose timer is run by hand, whose clock is set by hand and whose answers are queued per operation. */
function setup(answers: { KanonOnchainStrategies?: Array<unknown | Error>; KanonOnchainRecord?: Array<unknown | Error> }) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const asked: IndexerRequest[] = [];
  const clock = { now: 1_000 };
  const store = createOnchainRecordStore({
    post: async (request) => {
      asked.push(request);
      const next = answers[request.operationName as keyof typeof answers]?.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error('nothing queued');
      return next;
    },
    chainId: () => CHAIN,
    owner: OWNER,
    now: () => clock.now,
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
  return { store, timers, asked, clock, settle };
}

const kinds = (state: OnchainRecordState) => (state.status === 'ready' ? state.rows.map((r) => r.kind) : state.status);

describe('the on-chain record store', () => {
  it("reads nothing until something subscribes, then the wallet's rules and then what happened to them", async () => {
    const { store, asked, settle } = setup({ KanonOnchainStrategies: [rules(3)], KanonOnchainRecord: [record([pin(100)], [refused(200)])] });
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    expect(asked).toEqual([]);
    const off = store.subscribe(() => undefined);
    await settle();
    expect(asked.map((r) => r.operationName)).toEqual(['KanonOnchainStrategies', 'KanonOnchainRecord']);
    expect(asked[0]?.variables).toMatchObject({ chainId: CHAIN, owner: OWNER });
    expect(asked[1]?.variables).toMatchObject({ chainId: CHAIN, strategies: [`${CHAIN}_3`] });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', truncated: false, readAt: 1_000, problem: null });
    expect(kinds(store.getSnapshot())).toEqual(['refused', 'pinned']);
    off();
  });

  it('asks nothing more of a wallet with no rule on-chain, and says the record is empty', async () => {
    const { store, asked, settle } = setup({ KanonOnchainStrategies: [rules()] });
    const off = store.subscribe(() => undefined);
    await settle();
    expect(asked.map((r) => r.operationName)).toEqual(['KanonOnchainStrategies']);
    expect(store.getSnapshot()).toEqual({ status: 'ready', rows: [], truncated: false, readAt: 1_000, problem: null });
    off();
  });

  it('reads again every thirty seconds, and stops when the last reader leaves', async () => {
    const { store, timers, asked, clock, settle } = setup({
      KanonOnchainStrategies: [rules(3), rules(3)],
      KanonOnchainRecord: [record([pin(100)]), record([pin(100)], [refused(200)])],
    });
    const first = store.subscribe(() => undefined);
    const second = store.subscribe(() => undefined);
    await settle();
    // Two readers, one timer and one pair of requests.
    expect(timers.map((t) => t.ms)).toEqual([ONCHAIN_EVERY_MS]);
    expect(ONCHAIN_EVERY_MS).toBe(30_000);
    expect(asked).toHaveLength(2);
    clock.now = 31_000;
    timers[0]?.fn();
    await settle();
    expect(kinds(store.getSnapshot())).toEqual(['refused', 'pinned']);
    expect(store.getSnapshot()).toMatchObject({ readAt: 31_000 });
    first();
    expect(timers[0]?.cleared).toBe(false);
    second();
    expect(timers[0]?.cleared).toBe(true);
    expect(asked).toHaveLength(4);
  });

  it('says so when the first read fails', async () => {
    const down = setup({ KanonOnchainStrategies: [new Error('down')] });
    const off = down.store.subscribe(() => undefined);
    await down.settle();
    expect(down.store.getSnapshot()).toEqual({ status: 'unavailable', message: ONCHAIN_UNREACHABLE });
    off();

    // The rules were read and the second request was not: still nothing to draw.
    const half = setup({ KanonOnchainStrategies: [rules(3)], KanonOnchainRecord: [new Error('down')] });
    const stop = half.store.subscribe(() => undefined);
    await half.settle();
    expect(half.store.getSnapshot()).toEqual({ status: 'unavailable', message: ONCHAIN_UNREACHABLE });
    stop();
  });

  it('keeps the last good record when a later read fails, says that it failed, and clears that on the next good read', async () => {
    const { store, timers, clock, settle } = setup({
      KanonOnchainStrategies: [rules(3), new Error('down'), rules(3)],
      KanonOnchainRecord: [record([pin(100)]), record([pin(100)], [refused(200)])],
    });
    const off = store.subscribe(() => undefined);
    await settle();
    clock.now = 31_000;
    timers[0]?.fn();
    await settle();
    // The list is the one read at 1,000, and the state says the newest read is not it.
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', readAt: 1_000, problem: ONCHAIN_UNREACHABLE });
    expect(kinds(store.getSnapshot())).toEqual(['pinned']);
    clock.now = 61_000;
    timers[0]?.fn();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', readAt: 61_000, problem: null });
    expect(kinds(store.getSnapshot())).toEqual(['refused', 'pinned']);
    off();
  });

  it('draws nothing from an answer that is not the one asked for', async () => {
    // Hasura refuses a query it cannot run with HTTP 200 and `errors`.
    const refusedQuery = { errors: [{ message: "field 'Strategy' not found in type: 'query_root'" }] };
    const first = setup({ KanonOnchainStrategies: [refusedQuery] });
    const off = first.store.subscribe(() => undefined);
    await first.settle();
    expect(first.store.getSnapshot()).toEqual({ status: 'unavailable', message: ONCHAIN_UNKNOWN_SHAPE });
    off();

    const second = setup({ KanonOnchainStrategies: [rules(3)], KanonOnchainRecord: [{ data: { StrategyEvent: [] } }] });
    const stop = second.store.subscribe(() => undefined);
    await second.settle();
    expect(second.store.getSnapshot()).toEqual({ status: 'unavailable', message: ONCHAIN_UNKNOWN_SHAPE });
    stop();
  });

  it('hands back the rows it already had when a read changed nothing', async () => {
    const { store, timers, settle } = setup({
      KanonOnchainStrategies: [rules(3), rules(3), rules(3)],
      KanonOnchainRecord: [record([pin(100)]), record([pin(100)]), record([pin(100)], [refused(200)])],
    });
    const off = store.subscribe(() => undefined);
    await settle();
    const before = store.getSnapshot();
    timers[0]?.fn();
    await settle();
    const same = store.getSnapshot();
    expect(before.status === 'ready' && same.status === 'ready' && same.rows === before.rows).toBe(true);
    timers[0]?.fn();
    await settle();
    const grown = store.getSnapshot();
    // A new row at the head; the row already drawn is the same object.
    expect(grown.status === 'ready' && before.status === 'ready' && grown.rows[1] === before.rows[0]).toBe(true);
    off();
  });

  it('does not ask again while a read is still out', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const asked: string[] = [];
    const timers: Array<() => void> = [];
    const store = createOnchainRecordStore({
      post: async (request) => {
        asked.push(request.operationName);
        return request.operationName === 'KanonOnchainStrategies' ? slow : record([pin(100)]);
      },
      chainId: () => CHAIN,
      owner: OWNER,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    const off = store.subscribe(() => undefined);
    timers[0]?.();
    timers[0]?.();
    expect(asked).toEqual(['KanonOnchainStrategies']);
    release(rules(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kinds(store.getSnapshot())).toEqual(['pinned']);
    // With that read back, the next tick reads.
    timers[0]?.();
    expect(asked).toEqual(['KanonOnchainStrategies', 'KanonOnchainRecord', 'KanonOnchainStrategies']);
    off();
  });

  it('drops an answer that lands after the last reader has left', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const store = createOnchainRecordStore({
      post: async () => slow,
      chainId: () => CHAIN,
      owner: OWNER,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const off = store.subscribe(() => undefined);
    off();
    release(rules());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
  });

  it('reads again for a reader who comes back, even with the first read still out', async () => {
    let release: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const store = createOnchainRecordStore({
      post: async (request) => {
        calls += 1;
        if (calls === 1) return slow;
        return request.operationName === 'KanonOnchainStrategies' ? rules(3) : record([pin(100)]);
      },
      chainId: () => CHAIN,
      owner: OWNER,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    store.subscribe(() => undefined)();
    const off = store.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kinds(store.getSnapshot())).toEqual(['pinned']);
    // The first run's answer, arriving late, changes nothing.
    release(rules());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(kinds(store.getSnapshot())).toEqual(['pinned']);
    off();
  });
});

describe('which record a screen is given', () => {
  const stores = createOnchainRecordStores({ post: async () => rules(), chainId: () => CHAIN, setTimer: () => 0, clearTimer: () => undefined });
  const signedIn = { pending: false, signedIn: true };
  const status = (...args: Parameters<typeof pickOnchainRecordStore>) => pickOnchainRecordStore(...args).getSnapshot().status;

  it('says the record is not connected in a build with no indexer, whoever is asking', () => {
    expect(NOT_CONNECTED_RECORD_STORE.getSnapshot()).toEqual({ status: 'not_connected' });
    expect(status(null, signedIn, OWNER)).toBe('not_connected');
    expect(status(null, { pending: false, signedIn: false }, null)).toBe('not_connected');
    expect(status(null, { pending: true, signedIn: false }, null)).toBe('not_connected');
    expect(ONCHAIN_NOT_CONNECTED).toBe('The on-chain record is not connected in this build.');
  });

  it('waits for the session, then asks a visitor to sign in, and reads nothing for either', () => {
    expect(status(stores, { pending: true, signedIn: false }, OWNER)).toBe('loading');
    expect(status(stores, { pending: false, signedIn: false }, OWNER)).toBe('signed_out');
  });

  it('says there is no wallet when a signed-in person has none', () => {
    expect(status(stores, signedIn, null)).toBe('no_wallet');
    expect(status(stores, signedIn, 'not an address')).toBe('no_wallet');
  });

  it('gives one wallet one store, however its address is cased', () => {
    const a = pickOnchainRecordStore(stores, signedIn, OWNER);
    const b = pickOnchainRecordStore(stores, signedIn, OWNER.toUpperCase().replace('0X', '0x'));
    const other = pickOnchainRecordStore(stores, signedIn, `0x${'1'.repeat(40)}`);
    expect(a).toBe(b);
    expect(other).not.toBe(a);
    expect(a.getSnapshot()).toEqual({ status: 'loading' });
  });
});

describe('the indexer client', () => {
  it('posts the request as JSON to the configured address and hands back the parsed answer', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const post = createIndexerPost({
      url: ' https://indexer.kanon.example/v1/graphql ',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => rules(3) };
      }) as unknown as typeof fetch,
    });
    const request = { operationName: 'KanonOnchainStrategies', query: 'query { Strategy { id } }', variables: { chainId: CHAIN } };
    expect(await post(request)).toEqual(rules(3));
    expect(calls[0]?.url).toBe('https://indexer.kanon.example/v1/graphql');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(request);
  });

  it('rejects when the indexer does not answer with a success', async () => {
    const post = createIndexerPost({
      url: 'https://indexer.kanon.example/v1/graphql',
      fetchImpl: (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch,
    });
    await expect(post({ operationName: 'x', query: 'x', variables: {} })).rejects.toThrow('the indexer answered 502');
  });

  it('is absent for a build with no address set', () => {
    expect(resolveIndexer(undefined)).toBeUndefined();
    expect(resolveIndexer('   ')).toBeUndefined();
    expect(typeof resolveIndexer('https://indexer.kanon.example/v1/graphql')).toBe('function');
  });
});
