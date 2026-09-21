import { describe, expect, it } from 'vitest';
import { applyPatch, diffCandles } from './chart-candles';
import type { Candle5 } from './chart-protocol';

const bar = (t: number, close = 100): Candle5 => [t, close, close + 2, close - 2, close];
const run = (n: number, from = 0): Candle5[] => Array.from({ length: n }, (_, i) => bar((from + i) * 60, 100 + i));

describe('diffCandles', () => {
  it('a first upload, or an empty side, is a reset', () => {
    expect(diffCandles(null, run(3)).kind).toBe('reset');
    expect(diffCandles([], run(3)).kind).toBe('reset');
    expect(diffCandles(run(3), []).kind).toBe('reset');
  });

  it('an identical series is a no-op, not a re-upload', () => {
    expect(diffCandles(run(50), run(50)).kind).toBe('noop');
  });

  it('the forming candle moving is a one-candle patch', () => {
    const prev = run(50);
    const next = [...prev.slice(0, -1), bar(49 * 60, 999)];
    expect(diffCandles(prev, next)).toEqual({ kind: 'patch', candles: [next[49]] });
  });

  it('a new candle opening patches the old last candle and the new one', () => {
    const prev = run(50);
    const next = [...prev.slice(0, -1), bar(49 * 60, 150), bar(50 * 60, 151)];
    const diff = diffCandles(prev, next);
    expect(diff.kind).toBe('patch');
    if (diff.kind === 'patch') expect(diff.candles.map((c) => c[0])).toEqual([49 * 60, 50 * 60]);
  });

  it('a window that slid left (oldest dropped, one appended) is still a tail patch', () => {
    const prev = run(50);
    const next = [...prev.slice(1), bar(50 * 60)];
    const diff = diffCandles(prev, next);
    expect(diff.kind).toBe('patch');
    if (diff.kind === 'patch') expect(diff.candles.map((c) => c[0])).toEqual([49 * 60, 50 * 60]);
  });

  it('any change to a candle that is not the tail is a reset (lightweight-charts cannot update it)', () => {
    const prev = run(50);
    const next = prev.map((c, i) => (i === 10 ? bar(c[0], 555) : c));
    expect(diffCandles(prev, next).kind).toBe('reset');
  });

  it('a backfilled older candle is a reset', () => {
    const prev = run(10, 5);
    const next = run(15, 0);
    expect(diffCandles(prev, next).kind).toBe('reset');
  });

  it('a window that no longer overlaps is a reset', () => {
    expect(diffCandles(run(10), run(10, 100)).kind).toBe('reset');
  });

  it('a series that lost its last candle is a reset', () => {
    const prev = run(10);
    expect(diffCandles(prev, prev.slice(0, -1)).kind).toBe('reset');
  });

  it('tolerates 2400 candles, diffing in a fraction of a frame', () => {
    const prev = run(2400);
    const next = [...prev.slice(0, -1), bar(2399 * 60, 4242)];
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) diffCandles(prev, next);
    // Generous: CI and shared machines are slow. The point is it is O(n) compares, not a re-upload.
    expect((performance.now() - t0) / 100).toBeLessThan(25);
    expect(diffCandles(prev, next).kind).toBe('patch');
  });
});

describe('applyPatch', () => {
  it('replaces the last bar and appends newer ones', () => {
    const rows = run(3);
    applyPatch(rows, [bar(2 * 60, 777), bar(3 * 60, 888)]);
    expect(rows.map((c) => c[4])).toEqual([100, 101, 777, 888]);
  });

  it('ignores a candle older than the tail', () => {
    const rows = run(3);
    applyPatch(rows, [bar(0, 1)]);
    expect(rows).toEqual(run(3));
  });

  it('applying the diff reproduces the next series', () => {
    const prev = run(20);
    const next = [...prev.slice(1, -1), bar(19 * 60, 321), bar(20 * 60, 322)];
    const diff = diffCandles(prev, next);
    expect(diff.kind).toBe('patch');
    if (diff.kind !== 'patch') return;
    const rows = [...prev];
    applyPatch(rows, diff.candles);
    // The chart keeps the older candle the window dropped, and matches `next` from there.
    expect(rows.slice(-next.length)).toEqual(next);
  });
});
