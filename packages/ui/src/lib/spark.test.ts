import { describe, expect, it } from 'vitest';
import { ringGeometry, sparkGeometry } from './spark';
import { initialsOf } from './initials';
import { withAlpha } from './elevation';

describe('sparkGeometry', () => {
  it('needs two points', () => {
    expect(sparkGeometry([], 72, 28)).toBeNull();
    expect(sparkGeometry([1], 72, 28)).toBeNull();
  });

  it('puts the max at the top pad and the min at the bottom pad', () => {
    const g = sparkGeometry([10, 20, 15], 100, 40, 2)!;
    expect(g.line.startsWith('M2 38')).toBe(true); // first = min -> bottom
    expect(g.line).toContain('L50 2'); // middle = max -> top
    expect(g.last).toEqual({ x: 98, y: 20 });
  });

  it('reports direction from first to last, and flat for equal ends', () => {
    expect(sparkGeometry([1, 5, 3], 50, 20)!.direction).toBe('up');
    expect(sparkGeometry([3, 5, 1], 50, 20)!.direction).toBe('down');
    expect(sparkGeometry([2, 9, 2], 50, 20)!.direction).toBe('flat');
  });

  it('draws a constant series as a centred line, not NaN', () => {
    const g = sparkGeometry([4, 4, 4], 60, 20)!;
    expect(g.line).not.toContain('NaN');
    expect(g.line).toContain(' 10');
  });

  it('closes the area along the bottom edge', () => {
    const g = sparkGeometry([1, 2], 40, 20)!;
    expect(g.area.endsWith('Z')).toBe(true);
    expect(g.area).toContain('L38 20 L2 20');
  });
});

describe('ringGeometry', () => {
  it('derives the radius from the outer size and stroke', () => {
    expect(ringGeometry(56, 6, 0.5).radius).toBe(25);
  });

  it('fills the requested fraction of the circumference', () => {
    const g = ringGeometry(56, 6, 0.25);
    const [filled, total] = g.dash.split(' ').map(Number) as [number, number];
    expect(filled / total).toBeCloseTo(0.25, 2);
  });

  it('clamps out-of-range and non-finite values', () => {
    expect(ringGeometry(40, 4, 3).value).toBe(1);
    expect(ringGeometry(40, 4, -1).value).toBe(0);
    expect(ringGeometry(40, 4, Number.NaN).value).toBe(0);
  });
});

describe('initialsOf', () => {
  it('uses first letters of two words, or the first two of one', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada')).toBe('AD');
    expect(initialsOf('@grace_hopper')).toBe('GH');
  });

  it('reads an address by its first hex digits and never returns empty', () => {
    expect(initialsOf('0x9fE2aB')).toBe('9F');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('withAlpha', () => {
  it('turns hex into rgba', () => {
    expect(withAlpha('#0B0D10', 0.5)).toBe('rgba(11, 13, 16, 0.5)');
  });
});
