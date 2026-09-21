import { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Dot } from './ui';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { isWeb } from '../platform';

/**
 * The chrome every screen is built from. The responsive shell (the `Screen` frame,
 * the desktop `SideNav`, the bottom `TabBar`, `Body` and `Content`, and the `Row`,
 * `Col` and `SplitPane` grid) lives in `./shell/` and is re-exported from here, so
 * a screen imports all of it from one place.
 */
export { Screen, Body, Content, type ScreenProps } from './shell/screen';
export { TabBar } from './shell/tab-bar';
export { SideNav } from './shell/side-nav';
export { Row, Col, SplitPane, type ColSpan, type GridGap, type SideWidth } from './shell/grid';
export { useLayout } from './shell/use-layout';
export { TABS, type TabKey, type TabDef } from './shell/tabs';
export { layoutForWidth, BREAKPOINTS, SHELL, type Layout, type PaneSize } from '../lib/layout';

/**
 * Nothing. This used to paint a fake phone status bar (9:41, 5G, battery) so a
 * web screen matched the design mockups. A real device has its own status bar,
 * and a browser has none to imitate, so it only ever added noise. Kept as a
 * component so every screen that mounts it keeps compiling; delete the call
 * sites when convenient.
 */
export function StatusBar() {
  return null;
}

/**
 * Wordmark and enforcement state. The state text is always present: the point
 * of the product is that something is watching, and the header says so.
 */
export function BrandBar({
  status = 'ENFORCEMENT ACTIVE',
  dot = 'bg-signal',
}: {
  status?: string | undefined;
  dot?: string | undefined;
}) {
  return (
    <View className="shrink-0 flex-row items-center justify-between px-5 pt-5.5">
      <Text className="font-mono-bold text-12 tracking-w22 text-bone">KANON</Text>
      <View className="flex-row items-center gap-1.75">
        <Dot className={dot} />
        <Text className="font-mono text-10 tracking-w16 text-ash">{status}</Text>
      </View>
    </View>
  );
}

/** A screen header that is not the home chrome: a title, and a way back. */
export function NavBar({
  left,
  leftHref,
  right,
  leftClassName,
}: {
  left: string;
  leftHref?: string | undefined;
  right?: string | undefined;
  leftClassName?: string | undefined;
}) {
  const leftNode = (
    <Text className={cx('font-mono text-11 tracking-w16 text-bone', leftClassName)}>
      {left}
    </Text>
  );
  return (
    <View className="shrink-0 flex-row items-center justify-between px-5 pt-4.5">
      {leftHref ? <Link href={leftHref}>{leftNode}</Link> : leftNode}
      {right ? (
        <Text className="font-mono text-10 tracking-w12 text-ash">{right}</Text>
      ) : null}
    </View>
  );
}

/** Primary actions are bottom-anchored, always. */
export function Footer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className={cx('shrink-0 px-5 pb-8.5', className)}
      style={isWeb ? undefined : { paddingBottom: Math.max(insets.bottom, 16) + 18 }}
    >
      {children}
    </View>
  );
}
