import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type ViewStyle } from 'react-native';

/*
 * Motion here uses React Native's built-in `Animated`, not Reanimated.
 *
 * Reanimated needs its Babel plugin for worklets, and Next.js compiles with
 * SWC — adding Babel to the web app to animate two elements would slow every
 * build in the repo. These two are transform/opacity only, so the native
 * driver handles them off the JS thread anyway. Reanimated stays installed in
 * the mobile app for gestures and screen transitions, where it earns its cost.
 */

const KANON_EASING = Easing.bezier(0.2, 0, 0, 1);

/**
 * Refusal: fast, hard, no bounce. It should feel like a door closing.
 * Spec diff: changed parameters fade up in `signal`, hold, settle.
 */
export function Enter({
  children,
  variant = 'refuse',
  className,
  style,
}: {
  children: ReactNode;
  variant?: 'refuse' | 'diff' | undefined;
  className?: string | undefined;
  style?: ViewStyle | undefined;
}) {
  const t = useRef(new Animated.Value(0)).current;
  const refuse = variant === 'refuse';

  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: refuse ? 120 : 260,
      easing: KANON_EASING,
      useNativeDriver: true,
    }).start();
  }, [t, refuse]);

  return (
    <Animated.View
      className={className}
      style={[
        style ?? null,
        {
          opacity: t,
          transform: [
            {
              translateY: t.interpolate({
                inputRange: [0, 1],
                // Refusal drops in from above; a diff line rises into place.
                outputRange: [refuse ? -8 : 4, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A left-anchored progress bar driven by `scaleX`, so the native driver can run
 * it off the JS thread. Animating `width` cannot use the native driver, and a
 * cooling-off bar that stutters reads as friction you might argue with.
 */
export function ProgressBar({
  from,
  to,
  durationMs,
  className,
  fillClassName,
  ...a11y
}: {
  /** 0–1. */
  from: number;
  to: number;
  durationMs: number;
  className?: string | undefined;
  fillClassName?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-valuenow'?: number | undefined;
}) {
  const scale = useRef(new Animated.Value(Math.max(from, 0.0001))).current;

  useEffect(() => {
    const run = Animated.timing(scale, {
      toValue: Math.max(to, 0.0001),
      duration: Math.max(durationMs, 0),
      easing: Easing.linear,
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [scale, to, durationMs]);

  return (
    <Animated.View
      className={className}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...a11y}
    >
      <Animated.View
        className={fillClassName}
        style={{
          width: '100%',
          height: '100%',
          transformOrigin: 'left',
          transform: [{ scaleX: scale }],
        }}
      />
    </Animated.View>
  );
}
