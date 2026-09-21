import { describe, expect, it } from 'vitest';
import { createWheelPager, keyStep, stepIndex, TURN_LOCK_MS } from './reel-paging';

const wheel = (time: number, deltaY: number, extra: Partial<{ deltaX: number; deltaMode: number }> = {}) => ({
  time,
  deltaY,
  deltaX: extra.deltaX ?? 0,
  deltaMode: extra.deltaMode ?? 0,
});

describe('createWheelPager', () => {
  it('turns one page for one notch, in the direction of the wheel', () => {
    const page = createWheelPager();
    expect(page(wheel(1_000, 100))).toBe(1);
    const back = createWheelPager();
    expect(back(wheel(1_000, -100))).toBe(-1);
  });

  it('turns one page for a whole trackpad flick, inertia tail included', () => {
    const page = createWheelPager();
    const steps: number[] = [];
    // 60 events 16ms apart, decaying: a flick and its glide.
    for (let i = 0; i < 60; i++) steps.push(page(wheel(1_000 + i * 16, Math.max(5, 120 - i * 2))));
    expect(steps.filter((s) => s !== 0)).toEqual([1]);
  });

  it('turns again for a second notch after the lock and a pause', () => {
    const page = createWheelPager();
    expect(page(wheel(1_000, 100))).toBe(1);
    expect(page(wheel(1_000 + 200, 100))).toBe(0); // inside the lock
    expect(page(wheel(1_000 + TURN_LOCK_MS + 600, 100))).toBe(1);
  });

  it('ignores a resting finger and a sideways scroll', () => {
    const page = createWheelPager();
    expect(page(wheel(1_000, 2))).toBe(0);
    expect(page(wheel(2_000, 30, { deltaX: 90 }))).toBe(0);
    expect(page(wheel(3_000, 50))).toBe(1);
  });

  it('reads line-mode deltas as lines', () => {
    const page = createWheelPager();
    expect(page(wheel(1_000, 3, { deltaMode: 1 }))).toBe(1);
  });
});

describe('keyStep', () => {
  it('maps arrows and page keys, and nothing else', () => {
    expect(keyStep('ArrowDown')).toBe(1);
    expect(keyStep('PageDown')).toBe(1);
    expect(keyStep('ArrowUp')).toBe(-1);
    expect(keyStep('PageUp')).toBe(-1);
    expect(keyStep('a')).toBe(0);
    expect(keyStep('Enter')).toBe(0);
  });
});

describe('stepIndex', () => {
  it('stays inside the reel', () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(2, -1, 5)).toBe(1);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
