import { describe, expect, it, vi } from 'vitest';
import { createStore, shallowEqual, shareStructure } from './store';

describe('createStore', () => {
  it('tells subscribers when the value changes, and not when it is set to the same value', () => {
    const store = createStore({ n: 1 });
    const seen = vi.fn();
    const off = store.subscribe(seen);
    const same = store.get();
    store.set(same);
    expect(seen).not.toHaveBeenCalled();
    store.set({ n: 2 });
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    store.set({ n: 3 });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('shallowEqual', () => {
  it('compares own fields by identity', () => {
    const a = {};
    expect(shallowEqual({ x: 1, y: a }, { x: 1, y: a })).toBe(true);
    expect(shallowEqual({ x: 1, y: {} }, { x: 1, y: {} })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(shallowEqual({ x: 1 }, [1])).toBe(false);
    expect(shallowEqual(null, {})).toBe(false);
  });
});

describe('shareStructure', () => {
  type Row = { id: string; v: number };
  const key = (r: Row) => r.id;
  const same = (a: Row, b: Row) => a.v === b.v;

  it('hands back the previous reference for a row that did not change', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const next = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    const out = shareStructure(prev, next, key, same);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out).not.toBe(prev);
  });

  it('hands back the previous list itself when nothing changed', () => {
    const prev = [{ id: 'a', v: 1 }];
    expect(shareStructure(prev, [{ id: 'a', v: 1 }], key, same)).toBe(prev);
  });

  it('follows a reorder and an addition', () => {
    const prev = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const out = shareStructure(prev, [{ id: 'b', v: 1 }, { id: 'c', v: 9 }, { id: 'a', v: 1 }], key, same);
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    expect(out[0]).toBe(prev[1]);
  });

  it('starts from nothing', () => {
    expect(shareStructure(undefined, [{ id: 'a', v: 1 }], key, same)).toEqual([{ id: 'a', v: 1 }]);
  });
});
