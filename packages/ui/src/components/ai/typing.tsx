import { useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import { useReducedMotion } from '../../lib/use-keyboard';
import { useTheme } from '../../theme';
import { AiTile } from './ai-tile';

const DOTS = [0, 1, 2] as const;

/**
 * Three dots while a compile runs. It exists only while the request does, and
 * stands still when the OS asks for less motion; the word beside it says the
 * same thing, so the state never rests on the animation.
 */
export function TypingIndicator({ label = 'Compiling your rule' }: { label?: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const dots = useRef(DOTS.map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    if (reduced) {
      dots.forEach((d) => d.setValue(0.75));
      return;
    }
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(d, { toValue: 1, duration: 330, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(d, { toValue: 0.3, duration: 330, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((DOTS.length - 1 - i) * 150),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots, reduced]);

  return (
    <View className="flex-row items-center gap-2.5" accessibilityLiveRegion="polite" role="status">
      <AiTile size="sm" />
      <View className="h-10 flex-row items-center gap-3 rounded-sm border border-hairline bg-panel px-3.5">
        <View className="flex-row items-center gap-1.5" aria-hidden>
          {dots.map((d, i) => (
            <Animated.View
              key={DOTS[i]}
              style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.signal, opacity: d }}
            />
          ))}
        </View>
        <Text className="font-mono text-11 uppercase tracking-w10 text-ash">{label}</Text>
      </View>
    </View>
  );
}
