import { ReactNode, useEffect, useRef } from 'react';
import { Platform, ScrollView, Text, View, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { device } from '@kanon/tokens';
import { Dot, Num } from './ui';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { routes, shareRoute, tradeRoute } from '../lib/routes';
import { RULE, TRADE_ID } from '../lib/demo';

const isWeb = Platform.OS === 'web';

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

type TabKey = 'rules' | 'chart' | 'create' | 'predict' | 'profile';

const TABS: Array<{ key: TabKey; label: string; href: string; round?: boolean; isSphere?: boolean }> = [
  { key: 'rules', label: 'RULES', href: routes.home },
  { key: 'chart', label: 'CHART', href: routes.chart },
  { key: 'create', label: 'CREATE', href: routes.create, isSphere: true },
  { key: 'predict', label: 'PREDICT', href: routes.predict },
  { key: 'profile', label: 'PROFILE', href: shareRoute(RULE.id), round: true },
];

function AnimatedOrb() {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [anim]);

  const scale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.25], // scales up by 25%
  });

  const opacity = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.6, 1],
  });

  return (
    <View className="items-center justify-center" style={{ width: 64, height: 64 }}>
      {/* Massive soft ambient aura */}
      <Animated.View
        style={{
          position: 'absolute',
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: 'rgba(212, 160, 23, 0.2)', // Faint signal gold
          transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.4] }) }],
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.6] }),
        }}
      />

      {/* Intense Animated Outer Glow */}
      <Animated.View
        style={{
          position: 'absolute',
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: '#D4A017',
          shadowColor: '#FFCC40',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: opacity,
          shadowRadius: 24,
          elevation: 20,
          transform: [{ scale }],
        }}
      />

      {/* 3D Orb Body */}
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: '#825600', // Core deep shadow color
          overflow: 'hidden',
        }}
      >
        {/* Mid-tone offset */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: '#BC8500',
            transform: [{ translateY: -4 }, { translateX: -4 }],
          }}
        />
        {/* Main light face */}
        <View
          style={{
            position: 'absolute',
            top: -4,
            left: -4,
            width: 50,
            height: 50,
            borderRadius: 25,
            backgroundColor: '#EAA610',
          }}
        />
        {/* Soft top gradient/highlight area */}
        <View
          style={{
            position: 'absolute',
            top: -10,
            left: -6,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: '#FFCC40',
          }}
        />

        {/* Sharp Specular Highlight (The glassy shine) */}
        <View
          style={{
            position: 'absolute',
            top: 6,
            left: 12,
            width: 18,
            height: 8,
            borderRadius: 6,
            backgroundColor: 'rgba(255, 255, 255, 0.85)',
            transform: [{ rotate: '-25deg' }],
          }}
        />
        {/* Secondary small sharp dot */}
        <View
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            width: 4,
            height: 4,
            borderRadius: 2,
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
          }}
        />

        {/* Bottom rim light (Ambient bounce) */}
        <View
          style={{
            position: 'absolute',
            bottom: -2,
            right: 2,
            width: 36,
            height: 14,
            borderRadius: 10,
            backgroundColor: 'rgba(255, 220, 100, 0.35)',
            transform: [{ rotate: '-20deg' }],
          }}
        />
        {/* Subtle inner dark shadow top right */}
        <View
          style={{
            position: 'absolute',
            top: 4,
            right: -10,
            width: 20,
            height: 40,
            borderRadius: 10,
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
          }}
        />
      </View>
    </View>
  );
}

export function TabBar({ active }: { active: TabKey }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className="shrink-0 flex-row border-t border-hairline pt-3 pb-7.5"
      style={isWeb ? undefined : { paddingBottom: Math.max(insets.bottom, 12) + 12 }}
      role="tablist"
    >
      {TABS.map((tab) => {
        const on = tab.key === active;

        if (tab.isSphere) {
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className="flex-[1.2] items-center justify-center -mt-8"
              aria-selected={on}
            >
              <AnimatedOrb />
            </Link>
          );
        }

        return (
          <Link
            key={tab.key}
            href={tab.href}
            className="flex-1 items-center gap-1.75"
            aria-selected={on}
          >
            <View
              className={cx(
                'size-2.25',
                tab.round && 'rounded-full',
                on ? 'bg-signal' : 'border border-ash',
              )}
            />
            <Text
              className={cx('font-mono text-9 tracking-w12', on ? 'text-bone' : 'text-ash')}
            >
              {tab.label}
            </Text>
          </Link>
        );
      })}
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
