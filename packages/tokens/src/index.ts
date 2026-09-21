/**
 * Kanon design tokens — the single source of truth for colour, type and space.
 *
 * `docs/DESIGN.md` defines the eleven named colours. The remaining entries are
 * the surfaces and states the design canvas uses that the table does not name.
 * Nothing in the app may reference a raw hex or px value. Every value reaches
 * the UI as a Tailwind utility, through the generated `preset.cjs` that both
 * NativeWind (metro) and Next.js (react-native-web) load. Run
 * `pnpm --filter @kanon/tokens build` after editing this file.
 */

export const colors = {
  /** App background. */
  void: '#0B0D10',
  /** Cards, chart ground. */
  panel: '#14181D',
  /** Sheets, inputs, elevated surfaces. */
  raised: '#1D232A',
  /** Borders, gridlines. */
  hairline: '#2A323B',
  /** Primary text, prices. */
  bone: '#E6EAEE',
  /** Labels, axes, metadata. */
  ash: '#8A949E',
  /** Brand, pinned rules, the covenant itself. */
  signal: '#D4A017',
  /** Bids, longs, satisfied predicates. */
  long: '#1FA97A',
  /** Asks, shorts, failed predicates. */
  short: '#D9524A',
  /** The block screen. Hotter than `short` on purpose. */
  refused: '#E8462E',
  /** Attestation links, proof chips. */
  verified: '#3D8BFD',

  /** Dim behind a bottom sheet. Used with an alpha (`bg-scrim/70`), dark in both themes. */
  scrim: '#07090B',

  /** Ground behind the device on wide viewports. Below `void`. */
  canvas: '#07090B',
  /** Recessed drawer, e.g. the compiler's live spec pane, and the track behind a segmented control. */
  sunken: '#0F1216',
  /** The active thing sitting in a `sunken` track: the selected segment. Lighter than the track in both themes. */
  lift: '#1D232A',

  /** Pressed/hover states. */
  'signal-hot': '#E4AF1C',
  'verified-hot': '#6BA6FF',
  'raised-hot': '#242B33',
  /** Ghost-destructive hover wash. */
  'refused-wash': '#1C110F',

  /** Changed-line wash and gutter in a spec diff. */
  'diff-wash': '#1A1710',
  'diff-gutter': '#7A5F0E',

  /** The inferred-defaults callout. */
  'inferred-edge': '#4A3A12',
  'inferred-wash': '#14120C',
} as const;

export type ColorToken = keyof typeof colors;

/**
 * The light palette. Same roles, same names, same semantics: `signal` is still
 * the rule, `long`/`short` still direction, `refused` still hotter than `short`,
 * `verified` still the proof blue. Every text-bearing token clears 4.5:1 on
 * `panel` and `void` (asserted in `packages/ui/src/lib/theme-logic.test.ts`), so
 * the accents are deliberately deeper than their dark-mode twins. Surfaces are
 * cool-tinted (hue 210) to stay in the same family as the dark ramp.
 */
export const lightColors = {
  void: '#F2F4F7',
  panel: '#FFFFFF',
  raised: '#E8ECF1',
  hairline: '#D0D7DF',
  bone: '#11161C',
  ash: '#525D69',
  signal: '#916400',
  long: '#0A7551',
  short: '#BE332B',
  refused: '#CC2A10',
  verified: '#1D5FD1',

  scrim: '#0B1118',

  canvas: '#E3E8EE',
  sunken: '#E2E7ED',
  lift: '#FFFFFF',

  'signal-hot': '#7A5300',
  'verified-hot': '#174FB0',
  'raised-hot': '#DCE2E9',
  'refused-wash': '#FCE8E4',

  'diff-wash': '#FBF3DA',
  'diff-gutter': '#D9AE3C',

  'inferred-edge': '#E5CF94',
  'inferred-wash': '#FBF6E4',
} as const;

export type ThemeScheme = 'dark' | 'light';
export type ThemeMode = ThemeScheme | 'system';

/** Both palettes by scheme. `useTheme().colors` is one of these. */
export const themes = { dark: colors, light: lightColors } as const;

/** Persisted under this key on both platforms; the web boot script reads it too. */
export const THEME_STORAGE_KEY = 'kanon.theme';

/** `#RRGGBB` to the space-separated triplet Tailwind's `rgb(var(--x) / <alpha-value>)` wants. */
export function hexToTriplet(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * The CSS variables for a scheme, as `{ '--c-void': '11 13 16', ... }`. Web reads
 * them from the generated `theme.css`; native hands this to NativeWind's `vars()`.
 * Both come from the tables above, so they cannot drift.
 */
export function themeVars(scheme: ThemeScheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, hex] of Object.entries(themes[scheme])) {
    out[`--c-${name}`] = hexToTriplet(hex);
  }
  return out;
}

/**
 * Runs in `<head>` before first paint so a light-mode user never sees a dark
 * flash. Mirrors `resolveScheme` in `@kanon/ui` (dark unless the stored mode is
 * `light`, or `system` while the OS prefers light).
 */
export const themeBootScript = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');var s=m==='light'?'light':m==='system'&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';var r=document.documentElement;r.setAttribute('data-theme',s);r.style.colorScheme=s;}catch(e){}})();`;

/**
 * Corner radius, px. Tight on purpose: 2 for chips/inputs/buttons, 3 for
 * surfaces, 4 for sheets. Nothing softer than 4 except a full circle.
 */
export const radius = { none: 0, xs: 2, sm: 3, md: 4, full: 999 } as const;

/**
 * Spacing steps for layout rhythm (px). Stay on this scale for gaps and
 * padding; 4-based, with 2 and 6 for tight optical fixes.
 */
export const space = { 0: 0, 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

/**
 * Elevation, as RN shadow tuples. `color` names a token so the shadow follows
 * the theme; `opacity` is per scheme because a dark surface needs a heavier
 * shadow to read at all and a light one a whisper.
 */
export const elevation = {
  0: { y: 0, blur: 0, dark: 0, light: 0 },
  1: { y: 1, blur: 3, dark: 0.35, light: 0.08 },
  2: { y: 4, blur: 12, dark: 0.45, light: 0.12 },
  3: { y: 12, blur: 32, dark: 0.55, light: 0.18 },
} as const;

/**
 * Type scale, keyed by px. `docs/DESIGN.md` names 32/24/18/15/13/11 as the
 * spine; the canvas uses the intermediate steps for figures and micro-labels.
 * Keying by px keeps the mapping to the design literal and unambiguous.
 */
export const fontSize = {
  '9': '9px',
  '10': '10px',
  '10p5': '10.5px',
  '11': '11px',
  '11p5': '11.5px',
  '12': '12px',
  '12p5': '12.5px',
  '13': '13px',
  '13p5': '13.5px',
  '14': '14px',
  '14p5': '14.5px',
  '15': '15px',
  '17': '17px',
  '18': '18px',
  '20': '20px',
  '24': '24px',
  '26': '26px',
  '30': '30px',
  '31': '31px',
  '32': '32px',
  '34': '34px',
  '56': '56px',
} as const;

/** Tracking. `t` prefix is negative (tight), `w` is positive (wide). */
export const tracking = {
  t45: '-0.045em',
  t35: '-0.035em',
  t30: '-0.03em',
  t25: '-0.025em',
  t20: '-0.02em',
  w04: '0.04em',
  w06: '0.06em',
  w08: '0.08em',
  w10: '0.1em',
  w12: '0.12em',
  w14: '0.14em',
  w16: '0.16em',
  w18: '0.18em',
  w20: '0.2em',
  w22: '0.22em',
} as const;

/** The device artboard the design is drawn against. */
export const device = {
  width: 393,
  height: 852,
} as const;

/**
 * The mono face, by weight. On a device each weight is a separately registered
 * family — `fontWeight` against a custom family is unreliable on Android — so
 * the weight is baked into the utility (`font-mono`, `font-mono-medium`,
 * `font-mono-bold`) rather than applied as a modifier.
 */
export const monoFamilies = {
  regular: 'JetBrainsMono_400Regular',
  medium: 'JetBrainsMono_500Medium',
  bold: 'JetBrainsMono_700Bold',
} as const;
