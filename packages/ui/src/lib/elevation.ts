import { elevation, type ThemeScheme, themes } from '@kanon/tokens';
import type { ViewStyle } from 'react-native';

/** `#RRGGBB` plus an alpha to `rgba(r, g, b, a)`. For shadows, which take a real colour. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * A shadow for an elevation step, tinted with the `scrim` ink so it belongs to
 * the theme instead of being pure black. `boxShadow` is native in RN 0.76+ and
 * in react-native-web, so this is one code path on both platforms.
 */
export function elevationStyle(
  step: 1 | 2 | 3,
  scheme: ThemeScheme,
  palette: (typeof themes)[ThemeScheme] = themes[scheme],
): ViewStyle {
  const { y, blur, dark, light } = elevation[step];
  const opacity = scheme === 'dark' ? dark : light;
  return { boxShadow: `0px ${y}px ${blur}px ${withAlpha(palette.scrim, opacity)}` };
}
