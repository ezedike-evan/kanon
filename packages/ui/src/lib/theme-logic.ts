import { themes, type ThemeMode, type ThemeScheme } from '@kanon/tokens';

/**
 * Pure theme rules, kept apart from React so they can be tested and so the web
 * boot script in `@kanon/tokens` has one obvious twin to stay in step with.
 */

export const THEME_MODES: ReadonlyArray<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: 'dark', label: 'Dark', hint: 'The default. Built for long sessions.' },
  { mode: 'light', label: 'Light', hint: 'Higher ambient contrast for daylight.' },
  { mode: 'system', label: 'System', hint: 'Follows the device setting.' },
];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system';
}

/**
 * The scheme to draw. Dark unless the user chose light, or chose system and the
 * OS says light — an unknown OS preference resolves to dark, the product default.
 */
export function resolveScheme(mode: ThemeMode, system: string | null | undefined): ThemeScheme {
  if (mode === 'system') return system === 'light' ? 'light' : 'dark';
  return mode;
}

/** sRGB relative luminance of `#RRGGBB`, per WCAG 2.x. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The palette for a scheme, as hex, for JS-side uses. */
export const paletteFor = (scheme: ThemeScheme) => themes[scheme];
