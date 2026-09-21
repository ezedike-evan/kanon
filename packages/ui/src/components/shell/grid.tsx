import type { ReactNode } from 'react';
import { View } from 'react-native';
import { cx } from '../../lib/cx';
import { isWeb } from '../../platform';

/*
 * Two-column composition for desktop. Both stack in one column below `lg`
 * (1024px), which is the phone and tablet layout, and sit side by side from `lg`.
 * Nothing here reads the window: it is all `lg:` classes, so the server markup
 * is right and there is no flash. On native the `lg:` classes are not applied, so
 * a phone-sized device always gets the stack.
 */

const web = (classes: string) => (isWeb ? classes : '');

const GAP = { sm: 'gap-3', md: 'gap-4', lg: 'gap-6' } as const;
export type GridGap = keyof typeof GAP;

/** Twelve columns, as literal classes (`lg:flex-[n]` is `flex: n 1 0%`). */
const SPAN = {
  1: 'lg:flex-[1]',
  2: 'lg:flex-[2]',
  3: 'lg:flex-[3]',
  4: 'lg:flex-[4]',
  5: 'lg:flex-[5]',
  6: 'lg:flex-[6]',
  7: 'lg:flex-[7]',
  8: 'lg:flex-[8]',
  9: 'lg:flex-[9]',
  10: 'lg:flex-[10]',
  11: 'lg:flex-[11]',
  12: 'lg:flex-[12]',
} as const;
export type ColSpan = keyof typeof SPAN;

/**
 * A row of `Col`s: one column of stacked blocks below `lg`, side by side from
 * `lg`. `gap` is the space between blocks in both directions (12, 16 or 24px).
 * `align="start"` lets each column be as tall as its own content instead of
 * stretching to the tallest.
 *
 *     <Row>
 *       <Col span={8}><Chart /></Col>
 *       <Col span={4}><Rules /><Activity /></Col>
 *     </Row>
 */
export function Row({
  gap = 'lg',
  align = 'stretch',
  className,
  children,
}: {
  gap?: GridGap | undefined;
  align?: 'start' | 'stretch' | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <View
      className={cx(
        GAP[gap],
        web(cx('lg:flex-row', align === 'start' ? 'lg:items-start' : 'lg:items-stretch')),
        className,
      )}
    >
      {children}
    </View>
  );
}

/**
 * A column of a `Row`. `span` is its share of twelve (`8` beside `4` is two thirds
 * and one third); without one, columns share the row equally. A column stacks its
 * own children with a `gap` of its own, so a `Col` can hold several blocks.
 * Below `lg` it is the full width of the screen.
 */
export function Col({
  span,
  gap = 'lg',
  className,
  children,
}: {
  span?: ColSpan | undefined;
  gap?: GridGap | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <View className={cx('w-full min-w-0', GAP[gap], web(span ? `lg:w-auto ${SPAN[span]}` : 'lg:w-auto lg:flex-1'), className)}>
      {children}
    </View>
  );
}

/** The side panel's width from `lg`: 320, 360 or 420px. */
const SIDE = { sm: 'lg:w-[320px]', md: 'lg:w-[360px]', lg: 'lg:w-[420px]' } as const;
export type SideWidth = keyof typeof SIDE;

/**
 * A main area with a fixed-width side panel beside it. Below `lg` they stack, main
 * first, so the side panel's content follows what it supports rather than
 * leading the screen. The main area takes whatever the side leaves and can shrink;
 * the side keeps its width.
 *
 *     <SplitPane side={<OrderTicket />} sideWidth="md">
 *       <Chart />
 *     </SplitPane>
 *
 * `side="left"` puts the panel before the main area on desktop without changing
 * the stacked order.
 */
export function SplitPane({
  side,
  sideWidth = 'md',
  sidePlacement = 'right',
  gap = 'lg',
  fill = false,
  desktopSide = false,
  className,
  children,
}: {
  /** The panel. */
  side: ReactNode;
  sideWidth?: SideWidth | undefined;
  sidePlacement?: 'left' | 'right' | undefined;
  gap?: GridGap | undefined;
  /**
   * The split is the whole screen: it takes the height its parent leaves (at every
   * width) and its main area is a full-height column of its own, for a screen whose
   * main area is a thread with a composer pinned under it. Without it the split is
   * as tall as its content, which is right for a page that scrolls.
   */
  fill?: boolean | undefined;
  /**
   * The panel only exists from `lg`. Below it is not drawn (and on a device it is
   * not rendered at all), so a phone keeps its own composition of that content,
   * inside the main area, instead of getting it stacked underneath. The panel sits
   * flush against the main area and draws its own edge, so `gap` is not applied.
   */
  desktopSide?: boolean | undefined;
  className?: string | undefined;
  /** The main area. */
  children: ReactNode;
}) {
  return (
    <View
      className={cx(
        desktopSide ? 'gap-0' : GAP[gap],
        fill && 'min-h-0 flex-1',
        web(cx('lg:items-stretch', sidePlacement === 'left' ? 'lg:flex-row-reverse' : 'lg:flex-row')),
        className,
      )}
    >
      <View className={cx('w-full min-w-0 lg:w-auto lg:flex-1', fill && 'min-h-0 flex-1')}>{children}</View>
      {desktopSide && !isWeb ? null : (
        <View
          className={cx(
            'w-full min-w-0 shrink-0',
            desktopSide && 'hidden',
            fill && 'min-h-0',
            web(cx(SIDE[sideWidth], desktopSide && 'lg:flex')),
          )}
        >
          {side}
        </View>
      )}
    </View>
  );
}
