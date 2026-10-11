import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BREAKPOINTS, SHELL, layoutForWidth, navWidth, paneWidth } from './layout';

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

  it('assumes the navigation is open unless told otherwise, which is what a first paint draws', () => {
    for (const size of ['column', 'wide', 'full'] as const) {
      expect(paneWidth(1440, size)).toBe(paneWidth(1440, size, true));
    }
  });
});

describe('the navigation collapsed to its rail', () => {
  it('is 232 open and 56 collapsed', () => {
    expect(navWidth(true)).toBe(232);
    expect(navWidth(false)).toBe(56);
    expect(SHELL.navRailWidth).toBeLessThan(SHELL.navWidth);
  });

  it('hands a full pane the width it gives up', () => {
    const freed = SHELL.navWidth - SHELL.navRailWidth;
    expect(freed).toBe(176);
    expect(paneWidth(1440, 'full', false)).toBe(1440 - SHELL.navRailWidth);
    expect(paneWidth(1440, 'full', false) - paneWidth(1440, 'full', true)).toBe(freed);
    expect(paneWidth(1024, 'full', false)).toBe(968);
  });

  it('widens a wide pane up to its cap and no further', () => {
    expect(paneWidth(1280, 'wide', true)).toBe(1048);
    expect(paneWidth(1280, 'wide', false)).toBe(1224);
    // 1440: 1208 beside the open navigation, 1384 beside the rail, which the 1280 cap then holds.
    expect(paneWidth(1440, 'wide', true)).toBe(1208);
    expect(paneWidth(1440, 'wide', false)).toBe(SHELL.wide);
    expect(paneWidth(1920, 'wide', false)).toBe(SHELL.wide);
  });

  it('leaves a column at 720, which fits beside the navigation either way', () => {
    expect(paneWidth(1024, 'column', true)).toBe(SHELL.column);
    expect(paneWidth(1024, 'column', false)).toBe(SHELL.column);
  });

  it('changes nothing on a phone or a tablet, which have no side navigation', () => {
    for (const size of ['column', 'wide', 'full'] as const) {
      for (const viewport of [390, 640, 768, 1023]) {
        expect(paneWidth(viewport, size, false)).toBe(paneWidth(viewport, size, true));
      }
    }
  });

  it('is drawn by the navigation at the widths this module states', () => {
    // The widths are literal classes there, because Tailwind has to see them.
    const source = readFileSync(new URL('../components/shell/side-nav.tsx', import.meta.url), 'utf8');
    expect(source).toContain(`open: 'w-[${SHELL.navWidth}px]'`);
    expect(source).toContain(`rail: 'w-[${SHELL.navRailWidth}px]'`);
    // And only there: one width per state, so nothing else can disagree with it.
    expect(source.match(/\bw-\[\d+px\]/g)).toEqual([`w-[${SHELL.navWidth}px]`, `w-[${SHELL.navRailWidth}px]`]);
  });
});
