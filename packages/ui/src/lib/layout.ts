/**
 * Breakpoint logic for the responsive shell. Pure, so it is unit-tested without
 * a renderer; `useLayout()` in `components/shell/use-layout.ts` is the hook.
 *
 * The widths match Tailwind's `sm` (640) and `lg` (1024). Layout that a class
 * can express uses the class (`lg:flex-row`), which is correct on the server
 * and never flashes; this module is for the few decisions a class cannot make.
 * Change a breakpoint here and the `sm:` / `lg:` classes in `components/shell`
 * have to move with it.
 */

export type Layout = 'phone' | 'tablet' | 'desktop';

/** Minimum widths, px. Tailwind `sm` and `lg`. */
export const BREAKPOINTS = { tablet: 640, desktop: 1024 } as const;

/**
 * Sizes the shell draws with. Mirrored as literal classes in `components/shell`;
 * `layout.test.ts` reads the navigation's two out of its source, so they cannot drift.
 */
export const SHELL = {
  /** The desktop navigation, open (`w-[232px]`). */
  navWidth: 232,
  /** The desktop navigation collapsed to its icon rail (`w-[56px]`). */
  navRailWidth: 56,
  /** The centred column on tablet and desktop (`max-w-[720px]`). */
  column: 720,
  /** A dashboard-width pane on desktop (`max-w-[1280px]`). */
  wide: 1280,
} as const;

/** How wide a screen's pane is on tablet and desktop. Phones are always full-bleed. */
export type PaneSize = 'column' | 'wide' | 'full';

/**
 * The layout class for a viewport width. A width that is not a finite number
 * (a server render, a not-yet-measured window) is a phone: mobile first.
 */
export function layoutForWidth(width: number): Layout {
  if (!Number.isFinite(width) || width < BREAKPOINTS.tablet) return 'phone';
  return width < BREAKPOINTS.desktop ? 'tablet' : 'desktop';
}

/**
 * The width the desktop navigation draws at, px: open, or collapsed to its icon
 * rail. Which one is the `sideNavOpen` preference (`lib/preferences.ts`).
 */
export function navWidth(open: boolean): number {
  return open ? SHELL.navWidth : SHELL.navRailWidth;
}

/**
 * The width the content pane draws at, px, for a viewport width and pane size.
 * A phone is full-bleed. On tablet and desktop `column` caps at 720, `wide` at
 * 1280 (on a tablet it is the whole window: there is nothing to cap), and
 * `full` takes everything the desktop navigation leaves. `navOpen` says whether
 * that navigation is open (the default, and what a first paint draws) or
 * collapsed to its rail; it changes nothing below desktop, where there is none.
 */
export function paneWidth(viewport: number, size: PaneSize, navOpen = true): number {
  const layout = layoutForWidth(viewport);
  if (layout === 'phone') return viewport;
  const available = layout === 'desktop' ? viewport - navWidth(navOpen) : viewport;
  if (size === 'column') return Math.min(available, SHELL.column);
  if (size === 'wide') return layout === 'desktop' ? Math.min(available, SHELL.wide) : available;
  return available;
}
