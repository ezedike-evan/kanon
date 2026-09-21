import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  drawingsKey,
  resolveDrawingStore,
  storeFromStringStorage,
  type StringStorage,
} from './chart-storage';
import type { Drawing } from './chart-drawings';

const drawing: Drawing = { id: 'a', kind: 'trend', points: [{ time: 1, price: 2 }, { time: 3, price: 4 }] };

function fakeStorage(seed: Record<string, string> = {}): StringStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    async get(key) {
      return data[key] ?? null;
    },
    async set(key, value) {
      data[key] = value;
    },
  };
}

describe('drawing keys', () => {
  it('are per asset and timeframe, and ignore how the symbol was written', () => {
    expect(drawingsKey('BTC / USD', 900)).toBe(drawingsKey('btc/usd', 900));
    expect(drawingsKey('BTC/USD', 900)).not.toBe(drawingsKey('BTC/USD', 3600));
    expect(drawingsKey('BTC/USD', 900)).not.toBe(drawingsKey('ETH/USD', 900));
  });
});

describe('stores', () => {
  it('round-trips through a platform storage capability', async () => {
    const storage = fakeStorage();
    const store = storeFromStringStorage(storage);
    store.save('k', [drawing]);
    await Promise.resolve();
    expect(await store.load('k')).toEqual([drawing]);
  });

  it('an unknown key loads as empty', async () => {
    expect(await storeFromStringStorage(fakeStorage()).load('nope')).toEqual([]);
  });

  it('corrupt or hand-edited storage loads as empty instead of throwing', async () => {
    const store = storeFromStringStorage(fakeStorage({ a: '{not json', b: '[{"id":1}]', c: '"str"' }));
    expect(await store.load('a')).toEqual([]);
    expect(await store.load('b')).toEqual([]);
    expect(await store.load('c')).toEqual([]);
  });

  it('a storage that throws never breaks the chart', async () => {
    const boom: StringStorage = {
      get: () => Promise.reject(new Error('blocked')),
      set: () => {
        throw new Error('full');
      },
    };
    const store = storeFromStringStorage(boom);
    expect(await store.load('k')).toEqual([]);
    expect(() => store.save('k', [drawing])).not.toThrow();
  });

  it('memory keeps drawings for the session and hands out copies', async () => {
    const store = createMemoryStore();
    const list = [drawing];
    store.save('k', list);
    list.push({ ...drawing, id: 'b' });
    expect(await store.load('k')).toHaveLength(1);
  });

  it('uses the platform storage when there is one and memory when there is not', async () => {
    const storage = fakeStorage();
    const durable = resolveDrawingStore({ storage });
    durable.save('k', [drawing]);
    await Promise.resolve();
    expect(Object.keys(storage.data)).toEqual(['k']);
    const fallback = resolveDrawingStore({});
    fallback.save('mem', [drawing]);
    expect(await resolveDrawingStore(undefined).load('mem')).toEqual([drawing]);
  });
});
