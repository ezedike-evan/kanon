import { describe, expect, it } from 'vitest';
import { cx } from './cx';

describe('cx', () => {
  it('keeps a token font size next to a text colour', () => {
    expect(cx('text-11', 'text-ash')).toBe('text-11 text-ash');
    expect(cx('font-mono text-bone', 'text-20 tracking-t20')).toContain('text-20');
  });

  it('still lets a later colour or size win over an earlier one', () => {
    expect(cx('text-bone', 'text-ash')).toBe('text-ash');
    expect(cx('text-11', 'text-13')).toBe('text-13');
    expect(cx('tracking-w08', 'tracking-w12')).toBe('tracking-w12');
  });

  it('a later font family wins', () => {
    expect(cx('font-mono', 'font-mono-bold')).toBe('font-mono-bold');
  });
});
