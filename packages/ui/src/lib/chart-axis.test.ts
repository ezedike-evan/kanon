import { describe, expect, it } from 'vitest';
import { TimeAxis } from './chart-axis';

describe('TimeAxis', () => {
  const times = [1000, 1060, 1120, 1180];
  const axis = new TimeAxis(times, 60);

  it('maps a bar time to its index', () => {
    expect(axis.toLogical(1000)).toBe(0);
    expect(axis.toLogical(1120)).toBe(2);
  });

  it('interpolates between bars', () => {
    expect(axis.toLogical(1090)).toBeCloseTo(1.5, 9);
  });

  it('extrapolates past both ends at the bucket width', () => {
    expect(axis.toLogical(1180 + 180)).toBeCloseTo(3 + 3, 9);
    expect(axis.toLogical(1000 - 120)).toBeCloseTo(-2, 9);
  });

  it('is inverted by toTime, inside and outside the data', () => {
    for (const t of [880, 1000, 1030, 1090, 1180, 1360]) {
      expect(axis.toTime(axis.toLogical(t))).toBeCloseTo(t, 6);
    }
  });

  it('a sparse series maps by position, not by elapsed time', () => {
    const gappy = new TimeAxis([0, 60, 600], 60); // a nine-bucket hole between bars 1 and 2
    expect(gappy.toLogical(600)).toBe(2);
    expect(gappy.toLogical(330)).toBeCloseTo(1.5, 9);
  });

  it('follows candles appended to the array it was given', () => {
    const live = [0, 60];
    const a = new TimeAxis(live, 60);
    live.push(120);
    expect(a.toLogical(120)).toBe(2);
    expect(a.length).toBe(3);
  });

  it('the bucket width can change with the timeframe', () => {
    const a = new TimeAxis([0], 60);
    expect(a.toLogical(120)).toBe(2);
    a.bucketSeconds = 120;
    expect(a.toLogical(120)).toBe(1);
  });

  it('an empty axis is defined rather than NaN', () => {
    const empty = new TimeAxis([], 60);
    expect(empty.toLogical(5)).toBe(0);
    expect(empty.toTime(3)).toBe(0);
    expect(empty.nearestIndex(3)).toBe(-1);
  });

  it('nearestIndex clamps to the data', () => {
    expect(axis.nearestIndex(-5)).toBe(0);
    expect(axis.nearestIndex(1.6)).toBe(2);
    expect(axis.nearestIndex(99)).toBe(3);
  });
});
