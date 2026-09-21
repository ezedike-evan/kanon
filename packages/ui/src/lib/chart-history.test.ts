import { describe, expect, it } from 'vitest';
import {
  HISTORY_DEPTH,
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from './chart-history';

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = createHistory<string[]>([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('undo steps back and redo steps forward', () => {
    let h = createHistory<string[]>([]);
    h = pushHistory(h, ['a']);
    h = pushHistory(h, ['a', 'b']);
    expect(h.present).toEqual(['a', 'b']);
    h = undoHistory(h);
    expect(h.present).toEqual(['a']);
    h = undoHistory(h);
    expect(h.present).toEqual([]);
    expect(canUndo(h)).toBe(false);
    h = redoHistory(h);
    h = redoHistory(h);
    expect(h.present).toEqual(['a', 'b']);
    expect(canRedo(h)).toBe(false);
  });

  it('a new edit after an undo discards the redo branch', () => {
    let h = createHistory<string[]>([]);
    h = pushHistory(h, ['a']);
    h = undoHistory(h);
    h = pushHistory(h, ['z']);
    expect(canRedo(h)).toBe(false);
    expect(h.present).toEqual(['z']);
  });

  it('pushing the same reference is not a step', () => {
    const state = ['a'];
    let h = pushHistory(createHistory<string[]>([]), state);
    h = pushHistory(h, state);
    expect(h.past).toHaveLength(1);
  });

  it('undo and redo at the ends return the same history', () => {
    const h = createHistory<number>(1);
    expect(undoHistory(h)).toBe(h);
    expect(redoHistory(h)).toBe(h);
  });

  it('keeps at most HISTORY_DEPTH steps, dropping the oldest', () => {
    let h = createHistory<number>(0);
    for (let i = 1; i <= HISTORY_DEPTH + 25; i++) h = pushHistory(h, i);
    expect(h.past).toHaveLength(HISTORY_DEPTH);
    expect(h.past[0]).toBe(25);
    expect(h.present).toBe(HISTORY_DEPTH + 25);
  });
});
