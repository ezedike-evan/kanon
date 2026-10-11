import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cx } from '../../lib/cx';
import type { PaneSize } from '../../lib/layout';
import { isWeb } from '../../platform';
import { ShellContext } from './context';
import { SideNav } from './side-nav';
import { TabBar } from './tab-bar';
import type { TabKey } from './tabs';

/** The pane's cap, as literal classes so Tailwind can see them. `full` has none. */
const PANE_CAP: Record<PaneSize, string> = {
  column: 'sm:max-w-[720px]',
  wide: 'lg:max-w-[1280px]',
  full: '',
};

/** What `desktop` sets from `lg`. `column` repeats the tablet's cap, `full` lifts it. */
const DESKTOP_CAP: Record<PaneSize, string> = {
  column: 'lg:max-w-[720px]',
  wide: 'lg:max-w-[1280px]',
  full: 'lg:max-w-none',
};

/** Horizontal gutters. A column keeps the phone's 20px so it lines up with `NavBar` and `Footer`. */
const GUTTER: Record<PaneSize, string> = {
  column: 'px-5',
  wide: 'px-5 sm:px-8 lg:px-10',
  full: 'px-5 sm:px-8 lg:px-10',
};

/** The tab a `<TabBar active=…>` among the direct children names, so the rail is lit in the server markup. */
function tabAmong(children: ReactNode): TabKey | null {
  for (const child of Children.toArray(children)) {
    if (isValidElement<{ active?: TabKey }>(child) && child.type === TabBar && child.props.active) {
      return child.props.active;
    }
  }
  return null;
}

/** The largest descendant of `root` that scrolls vertically, or null. */
function findScroller(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = null;
  const stack: HTMLElement[] = [...(root.children as unknown as HTMLElement[])];
  while (stack.length > 0) {
    const el = stack.pop() as HTMLElement;
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
      if (!best || el.clientHeight > best.clientHeight) best = el;
    } else {
      stack.push(...(el.children as unknown as HTMLElement[]));
    }
  }
  return best;
}

/**
 * A capped pane leaves empty gutters either side of it, and the wheel does
 * nothing over an empty gutter, which reads as a frozen page. This hands a wheel
 * over the gutter to the pane's own scroller.
 */
function useGutterWheel(outer: RefObject<View | null>, inner: RefObject<View | null>) {
  useEffect(() => {
    if (!isWeb) return;
    const outerEl = outer.current as unknown as HTMLElement | null;
    const innerEl = inner.current as unknown as HTMLElement | null;
    if (!outerEl || !innerEl) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || innerEl.contains(e.target as Node)) return; // pinch-zoom, or the pane's own
      const scroller = findScroller(innerEl);
      if (scroller) scroller.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY });
    };
    outerEl.addEventListener('wheel', onWheel, { passive: true });
    return () => outerEl.removeEventListener('wheel', onWheel);
  }, [outer, inner]);
}

export interface ScreenProps {
  /** The 3px accent along the top. Says what kind of screen this is. */
  rail?: string | undefined;
  /**
   * The design canvas's artboard label ("01 · HOME"). It named the frame above the
   * phone-shaped artboard, which no longer exists, so nothing reads it. Kept so
   * every screen keeps compiling; delete it from a screen when convenient.
   * @deprecated
   */
  label?: string | undefined;
  /**
   * How wide the pane is on tablet and desktop (a phone is always full-bleed).
   * `column` (default) is a centred 720px column, right for a flow or anything still
   * composed for one hand. `wide` is a dashboard, up to 1280px on desktop and the whole
   * window on a tablet. `full` fills what the rail leaves, for a chart or a canvas; put
   * `Content` inside it to centre the text.
   */
  size?: PaneSize | undefined;
  /**
   * The pane's width from `lg` when it differs from `size`: a screen that is a
   * centred column on a phone and a tablet and takes the whole pane on desktop
   * (`size="column" desktop="full"`), so its tablet stays exactly as it was. Omit
   * it and `size` applies at every width.
   */
  desktop?: PaneSize | undefined;
  /** `false` hides the desktop rail: a full-screen chart, a sheet-like takeover. Default `true`. */
  nav?: boolean | undefined;
  /**
   * The current destination, when the screen has no `TabBar` of its own to say so
   * (a sub-screen that still belongs under Profile). A `TabBar` inside the screen
   * sets it without this.
   */
  active?: TabKey | null | undefined;
  children: ReactNode;
}

/**
 * The shell every screen mounts. Compose a screen exactly as before: `Screen`,
 * then its header, `Body` and `TabBar`; the shell does the rest.
 *
 *  - Native: unchanged. The screen is the viewport; the safe-area inset is the frame.
 *  - Phone (< 640): full-bleed, bottom `TabBar`.
 *  - Tablet (640–1023): the same, in a centred column, with its edges drawn.
 *  - Desktop (>= 1024): the `SideNav` on the left, 232px open or a 56px icon rail
 *    when the visitor has collapsed it, the pane beside it, the bottom `TabBar`
 *    hidden. The pane's width is `size`; it is `flex-1`, so it takes whatever
 *    the navigation leaves without being told which state that is.
 *
 * Every breakpoint is a class, so the server-rendered markup is correct at any
 * width and there is nothing to flash on hydration. The pane is a fixed-height
 * flex column (the viewport, `100dvh`) and scrolls inside, as it does on a phone.
 */
export function Screen({ rail = 'bg-signal', size = 'column', desktop, nav = true, active, children }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const [registered, setRegistered] = useState<TabKey | null>(null);
  const registry = useMemo(() => ({ register: setRegistered }), []);
  const outer = useRef<View>(null);
  const inner = useRef<View>(null);
  useGutterWheel(outer, inner);

  if (!isWeb) {
    return (
      <View className="flex-1 bg-void" style={{ paddingTop: insets.top }}>
        <View className={cx('h-0.75 shrink-0', rail)} />
        {children}
      </View>
    );
  }

  const current = active !== undefined ? active : (tabAmong(children) ?? registered);

  return (
    <ShellContext.Provider value={registry}>
      <View className="h-dvh w-full bg-void lg:flex-row">
        {nav ? <SideNav active={current} /> : null}
        <View ref={outer} className="min-h-0 min-w-0 flex-1">
          <View className={cx('h-0.75 shrink-0', rail)} />
          <View
            ref={inner}
            role="main"
            className={cx(
              'min-h-0 w-full flex-1 self-center',
              // A column on a tablet is drawn: the edges of the pane, not the window.
              size === 'column' && 'sm:border-x sm:border-hairline lg:border-x-0',
              PANE_CAP[size],
              desktop && DESKTOP_CAP[desktop],
            )}
          >
            {children}
          </View>
        </View>
      </View>
    </ShellContext.Provider>
  );
}

/**
 * A centred, gutter-padded container for a page built inside a `Screen`'s own
 * scroller, when the screen is `size="full"` or `"wide"` and wants the text kept
 * to a readable width while the scroll area (and the wheel) spans the pane.
 *
 *     <Screen size="full">
 *       <ScrollView className="min-h-0 flex-1">
 *         <Content size="wide">…</Content>
 *       </ScrollView>
 *       <TabBar active="home" />
 *     </Screen>
 *
 * `size` caps at 720 (`column`) or 1280 on desktop (`wide`); gutters are 20 on a
 * phone, 32 on a tablet and 40 on desktop (`wide`, `full`), and 20 throughout for
 * a `column`, matching `NavBar` and `Footer`. On native it is a plain `View`.
 */
export function Content({
  size = 'wide',
  className,
  children,
}: {
  size?: PaneSize | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <View className={cx(isWeb ? ['w-full self-center', PANE_CAP[size], GUTTER[size]].join(' ') : 'px-5', className)}>
      {children}
    </View>
  );
}

/**
 * The scrolling middle of a screen. Bottom actions live outside it.
 *
 * Inside a `Screen` the pane already caps the width, so the default (`full`) adds
 * nothing. Pass `size` when the screen is `full` or `wide` and this body should
 * keep its own column: the scroller spans the pane, the content does not.
 */
export function Body({
  children,
  className,
  contentClassName,
  size = 'full',
}: {
  children: ReactNode;
  className?: string | undefined;
  /** Layout for the scrolled column itself, not the viewport around it. */
  contentClassName?: string | undefined;
  size?: PaneSize | undefined;
}) {
  return (
    <ScrollView
      className={cx('min-h-0 flex-1', className)}
      contentContainerClassName={cx(
        'grow',
        isWeb && size !== 'full' ? `w-full self-center ${PANE_CAP[size]} ${GUTTER[size]}` : 'px-5',
        contentClassName,
      )}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}
