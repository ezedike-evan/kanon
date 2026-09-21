import { useEffect, useRef } from 'react';
import { Animated, Easing, View, type DimensionValue } from 'react-native';
import { cx } from '../lib/cx';

/**
 * One shared pulse per mounted skeleton, opacity only, native driver. It is a
 * loading affordance and stops with the component; nothing else in the app
 * animates forever.
 */
export function Skeleton({
  width = '100%',
  height = 12,
  className,
}: {
  width?: DimensionValue | undefined;
  height?: number | undefined;
  className?: string | undefined;
}) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t]);
  return (
    // className does not reach Animated.View: the pulse wraps a plain View.
    <Animated.View
      aria-hidden
      style={{ width, height, opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }}
    >
      <View className={cx('h-full w-full rounded-xs bg-raised', className)} />
    </Animated.View>
  );
}

/** A skeleton shaped like a `ListRow`: tile, two lines, a figure. */
export function SkeletonRow() {
  return (
    <View className="min-h-14 flex-row items-center gap-3 border-b border-hairline px-4 py-3">
      <Skeleton width={32} height={32} />
      <View className="flex-1 gap-1.5">
        <Skeleton width="55%" height={12} />
        <Skeleton width="35%" height={10} />
      </View>
      <Skeleton width={44} height={14} />
    </View>
  );
}
