import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, SHELL, layoutForWidth, paneWidth } from './layout';

describe('layoutForWidth', () => {
  it('is a phone below 640', () => {
    expect(layoutForWidth(320)).toBe('phone');
    expect(layoutForWidth(390)).toBe('phone');
    expect(layoutForWidth(BREAKPOINTS.tablet - 1)).toBe('phone');
  });

  it('is a tablet from 640 up to 1023', () => {
    expect(layoutForWidth(BREAKPOINTS.tablet)).toBe('tablet');
    expect(layoutForWidth(768)).toBe('tablet');
    expect(layoutForWidth(BREAKPOINTS.desktop - 1)).toBe('tablet');
  });

  it('is a desktop from 1024', () => {
    expect(layoutForWidth(BREAKPOINTS.desktop)).toBe('desktop');
    expect(layoutForWidth(1440)).toBe('desktop');
    expect(layoutForWidth(3840)).toBe('desktop');
  });

  it('treats an unmeasured window as a phone', () => {
    expect(layoutForWidth(0)).toBe('phone');
    expect(layoutForWidth(Number.NaN)).toBe('phone');
    expect(layoutForWidth(Number.POSITIVE_INFINITY)).toBe('phone');
    expect(layoutForWidth(-1)).toBe('phone');
  });

  it('matches the Tailwind breakpoints the shell classes use', () => {
    expect(BREAKPOINTS).toEqual({ tablet: 640, desktop: 1024 });
  });
});

describe('paneWidth', () => {
  it('is the viewport on a phone, whatever the size', () => {
    expect(paneWidth(390, 'column')).toBe(390);
    expect(paneWidth(390, 'wide')).toBe(390);
    expect(paneWidth(390, 'full')).toBe(390);
  });

  it('caps a column at 720 and lets a narrower window win', () => {
    expect(paneWidth(1440, 'column')).toBe(SHELL.column);
    expect(paneWidth(768, 'column')).toBe(720);
    expect(paneWidth(680, 'column')).toBe(680);
    expect(paneWidth(1024, 'column')).toBe(720);
  });

  it('gives a wide pane 1280 on a large desktop, less where the rail leaves less', () => {
    expect(paneWidth(1920, 'wide')).toBe(SHELL.wide);
    expect(paneWidth(1440, 'wide')).toBe(1440 - SHELL.navWidth);
    expect(paneWidth(1024, 'wide')).toBe(1024 - SHELL.navWidth);
  });

  it('does not cap a wide pane on a tablet, which has no rail to subtract', () => {
    expect(paneWidth(900, 'wide')).toBe(900);
  });

  it('gives a full pane everything the rail leaves', () => {
    expect(paneWidth(1440, 'full')).toBe(1440 - SHELL.navWidth);
    expect(paneWidth(2560, 'full')).toBe(2560 - SHELL.navWidth);
    expect(paneWidth(768, 'full')).toBe(768);
  });
});
