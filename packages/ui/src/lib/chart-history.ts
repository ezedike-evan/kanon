/**
 * Undo / redo over immutable snapshots.
 *
 * The runtime keeps the drawings as an immutable array and pushes a new one
 * when an edit is *committed* (a drawing finished, a drag released, a delete),
 * never on every pointer move, so one drag is one undo step.
 */
export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export const HISTORY_DEPTH = 100;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Records `next` as the present. Clears redo. A no-op when `next` is the same reference. */
export function pushHistory<T>(h: History<T>, next: T, depth = HISTORY_DEPTH): History<T> {
  if (Object.is(next, h.present)) return h;
  const past = [...h.past, h.present];
  return {
    past: past.length > depth ? past.slice(past.length - depth) : past,
    present: next,
    future: [],
  };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

export function undoHistory<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1]!;
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redoHistory<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future as [T, ...T[]];
  return { past: [...h.past, h.present], present: next, future: rest };
}
