import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { web } from '../lib/desktop';
import { cx } from '../lib/cx';
import { isWeb } from '../platform';
import { Meta } from './ui';

/**
 * A bottom sheet, not a modal: it rises from the foot of the screen it sits in,
 * over a scrim, and never takes the whole surface. Rendered inside the screen
 * (an absolutely placed child), so on the web it stays inside the device frame
 * and on a phone it stays inside the safe area.
 *
 * Opacity and translate only, on the native driver.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  meta,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Right-aligned, ash. The count or the state, not a second title. */
  meta?: string | undefined;
  /** Held at the foot, under the scrolling body: a primary action that must not scroll out of reach. */
  footer?: ReactNode | undefined;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // On the web the sheet is simply there: the JS-driven entrance stalled at its first frame (opacity 0),
  // leaving an invisible sheet under a live scrim. A phone keeps the 160ms rise.
  const rise = useRef(new Animated.Value(isWeb ? 1 : 0)).current;

  useEffect(() => {
    if (!open || isWeb) return;
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: 160, useNativeDriver: true }).start();
  }, [open, rise]);

  if (!open) return null;

  return (
    <View className="absolute inset-0 justify-end" style={{ zIndex: 20 }}>
      <Pressable
        onPress={onClose}
        role="button"
        aria-label="Close"
        className="absolute inset-0 bg-scrim/70"
      />
      {/* className does not reach Animated.View (NativeWind snapshots it), so the motion wraps a plain View. */}
      <Animated.View
        style={{
          maxHeight: '78%',
          flexShrink: 1,
          opacity: rise,
          transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
        }}
      >
        <View
          // From `lg` a sheet is a 560px panel centred at the foot of the pane, not a 1000px slab.
          className={cx(
            'min-h-0 shrink border-t border-hairline bg-raised px-5 pt-4',
            web('lg:w-[560px] lg:max-w-full lg:self-center lg:rounded-t-md lg:border-x'),
          )}
          style={{ paddingBottom: Math.max(insets.bottom, 20) }}
        >
          <View className="flex-row items-center justify-between pb-3">
            <Text className="font-mono-medium text-12 tracking-w16 text-bone">{title}</Text>
            <View className="flex-row items-center gap-4">
              {meta ? <Meta>{meta}</Meta> : null}
              <Pressable onPress={onClose} role="button" aria-label="Close" className="py-1.5 pl-2">
                <Text className="font-mono text-11 tracking-w14 text-ash">CLOSE</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>{children}</ScrollView>
          {footer ? <View className="-mx-5 shrink-0 border-t border-hairline px-5 pt-3">{footer}</View> : null}
        </View>
      </Animated.View>
    </View>
  );
}
