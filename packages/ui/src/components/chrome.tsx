import { type ReactNode, useRef } from 'react';
import { ScrollView, Text, View, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { device } from '@kanon/tokens';
import { Dot, Num } from './ui';
import { Icon, type Icon as IconName } from './icons';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { withAlpha } from '../lib/elevation';
import { routes } from '../lib/routes';
import { isWeb, useHaptics } from '../platform';
import { useTheme } from '../theme';

/**
 * The device.
 *
 * The design is drawn against a 393×852 artboard. On a phone the screen *is*
 * the viewport, and the safe-area insets are the frame. In a browser it sits on
 * the `canvas` ground with its artboard label above it, the way the design
 * canvas presents it — that framing is a review tool, not part of the product.
 */
export function Screen({
  rail = 'bg-signal',
  label,
  children,
}: {
  /** The 3px accent along the top. Says what kind of screen this is. */
  rail?: string | undefined;
  label?: string | undefined;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  if (!isWeb) {
    return (
      <View className="flex-1 bg-void" style={{ paddingTop: insets.top }}>
        <View className={cx('h-0.75 shrink-0', rail)} />
        {children}
      </View>
    );
  }

  return (
    <View className="min-h-dvh items-center justify-center bg-canvas sm:p-14">
      <View className="w-full gap-3 sm:w-auto">
        {label ? (
          <Text className="hidden font-mono text-11 tracking-w16 text-ash sm:flex">
            {label}
          </Text>
        ) : null}
        <View
          className="h-dvh w-full overflow-hidden bg-void sm:h-device-h sm:w-device-w"
          style={isWeb ? { maxHeight: device.height } : undefined}
        >
          <View className={cx('h-0.75 shrink-0', rail)} />
          {children}
        </View>
      </View>
    </View>
  );
}

/**
 * Device status bar — part of the artboard, not of the product. A real phone
 * draws its own, so this only appears in the browser framing.
 */
export function StatusBar() {
  if (!isWeb) return null;
  return (
    <View className="shrink-0 flex-row items-center justify-between px-5 pt-3.5">
      <Num className="text-11 font-mono-medium text-bone">9:41</Num>
      <View className="flex-row items-center gap-1.25">
        <Text className="font-mono text-11 tracking-w06 text-ash">5G</Text>
        <View className="h-2.5 w-5.5 flex-row rounded-[2px] border border-hairline p-px">
          <View className="w-[72%] rounded-[1px] bg-ash" />
        </View>
      </View>
    </View>
  );
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

export type TabKey = 'home' | 'chart' | 'create' | 'predict' | 'profile';

interface TabDef {
  key: TabKey;
  label: string;
  href: string;
  icon: IconName;
}

/** Home, Chart, AI, Predict, Profile. The middle one is the AI strategy builder. */
const TABS: readonly TabDef[] = [
  { key: 'home', label: 'HOME', href: routes.home, icon: 'home' },
  { key: 'chart', label: 'CHART', href: routes.chart, icon: 'chart' },
  { key: 'create', label: 'AI', href: routes.create, icon: 'sparkles' },
  { key: 'predict', label: 'PREDICT', href: routes.predict, icon: 'zap' },
  { key: 'profile', label: 'PROFILE', href: routes.profile, icon: 'user' },
];

/**
 * A regular tab: icon over label, a short signal bar on the top edge when it is
 * the current one. The bar, the bone icon and the bone label all change
 * together, so the state does not rest on colour alone.
 */
function Tab({ tab, on }: { tab: TabDef; on: boolean }) {
  const { select } = useHaptics();
  return (
    <Link
      href={tab.href}
      role="tab"
      aria-selected={on}
      aria-label={tab.label}
      onPressIn={on ? undefined : select}
      className="relative flex-1 items-center gap-1 pb-1 pt-2.5 active:opacity-70"
    >
      <View
        className={cx('absolute top-0 h-0.5 w-6 bg-signal', on ? 'opacity-100' : 'opacity-0')}
      />
      <Icon name={tab.icon} size={22} color={on ? 'bone' : 'ash'} strokeWidth={on ? 2 : 1.75} />
      <Text
        className={cx(
          'font-mono-medium text-10 tracking-w08',
          on ? 'text-bone' : 'text-ash',
        )}
      >
        {tab.label}
      </Text>
    </Link>
  );
}

/**
 * The centre tab: the AI strategy builder. A raised `signal` button carrying the
 * sparkles glyph and, like every tab, a label under it that says what it is.
 * There is one spring on press and nothing that animates on its own.
 */
function AiTab({ tab, on }: { tab: TabDef; on: boolean }) {
  const { colors } = useTheme();
  const { tap } = useHaptics();
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: to === 1 ? 6 : 0 }).start();

  return (
    <Link
      href={tab.href}
      role="tab"
      aria-selected={on}
      aria-label="AI strategy builder"
      onPressIn={() => {
        tap();
        spring(0.93);
      }}
      onPressOut={() => spring(1)}
      className="flex-[1.15] items-center gap-1 pb-1"
    >
      {/* className does not reach Animated.View, so the spring wraps a plain View. */}
      <View className="-mt-4.5">
        <Animated.View style={{ transform: [{ scale }] }}>
          <View
            className="size-11 items-center justify-center rounded-md bg-signal"
            style={{
              // Static lift: a signal-tinted shadow and a 1px top highlight, and a
              // bone ring when this is the current tab.
              boxShadow: on
                ? `0px 0px 0px 2px ${colors.bone}, 0px 6px 14px ${withAlpha(colors.signal, 0.35)}`
                : `0px 6px 14px ${withAlpha(colors.signal, 0.35)}, inset 0px 1px 0px ${withAlpha(colors.bone, 0.28)}`,
            }}
          >
            <Icon name="sparkles" size={22} color="void" strokeWidth={2} />
          </View>
        </Animated.View>
      </View>
      <Text className={cx('font-mono-bold text-10 tracking-w08', on ? 'text-bone' : 'text-signal')}>
        {tab.label}
      </Text>
    </Link>
  );
}

export function TabBar({ active }: { active: TabKey }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="shrink-0 flex-row border-t border-hairline bg-panel px-1 pb-4"
      style={isWeb ? undefined : { paddingBottom: Math.max(insets.bottom, 8) + 6 }}
      role="tablist"
    >
      {TABS.map((tab) =>
        tab.key === 'create' ? (
          <AiTab key={tab.key} tab={tab} on={tab.key === active} />
        ) : (
          <Tab key={tab.key} tab={tab} on={tab.key === active} />
        ),
      )}
    </View>
  );
}

/** The scrolling middle of a screen. Bottom actions live outside it. */
export function Body({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string | undefined;
  /** Layout for the scrolled column itself, not the viewport around it. */
  contentClassName?: string | undefined;
}) {
  return (
    <ScrollView
      className={cx('min-h-0 flex-1', className)}
      contentContainerClassName={cx('grow px-5', contentClassName)}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
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
