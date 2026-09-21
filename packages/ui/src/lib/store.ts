import { useRef, useSyncExternalStore } from 'react';

/**
 * A minimal external store, and a selector hook over it.
 *
 * Why this exists: a React context re-renders every consumer whenever its value
 * changes, and there is no way to say "only if the part I read changed". The
 * data layer holds one big `KanonDataSource`; putting it straight into a
 * context would re-render every screen whenever any one part of it moved. The
 * provider instead puts a *stable* store in context and lets each component
 * subscribe to the slice it reads, through `useStoreSelector`.
 */
export interface Store<T> {
  get(): T;
  /** Replaces the value and tells subscribers, if it is a different value. */
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Equal when both are the same reference, or plain objects/arrays whose own fields are. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * Reads `selector(store.get())` and re-renders only when the result is no
 * longer `isEqual` to the last one this component saw. The selector may be an
 * inline function: it is re-run when the store changes or the selector itself
 * does, and a result `isEqual` to the previous keeps the previous reference, so
 * `useSyncExternalStore` sees a stable snapshot.
 */
export function useStoreSelector<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual: (a: S, b: S) => boolean = Object.is,
): S {
  const last = useRef<{ state: T; selector: (state: T) => S; selected: S } | null>(null);

  const getSnapshot = (): S => {
    const state = store.get();
    const prev = last.current;
    if (prev && prev.state === state && prev.selector === selector) return prev.selected;
    const next = selector(state);
    if (prev && isEqual(prev.selected, next)) {
      last.current = { state, selector, selected: prev.selected };
      return prev.selected;
    }
    last.current = { state, selector, selected: next };
    return next;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Reuses each element of `next` that is `same` as the element of `prev` with
 * the same key, so a list where one row changed hands `React.memo` rows a
 * reference that only differs for that row.
 */
export function shareStructure<T>(
  prev: readonly T[] | undefined,
  next: readonly T[],
  key: (item: T) => string,
  same: (a: T, b: T) => boolean,
): T[] {
  if (!prev || prev.length === 0) return [...next];
  const before = new Map(prev.map((item) => [key(item), item]));
  const out = next.map((item) => {
    const old = before.get(key(item));
    return old !== undefined && same(old, item) ? old : item;
  });
  const unchanged = out.length === prev.length && out.every((item, i) => item === prev[i]);
  return unchanged ? (prev as T[]) : out;
}
