/**
 * Kanon design tokens — the single source of truth for colour, type and space.
 *
 * `docs/DESIGN.md` defines the eleven named colours. The remaining entries are
 * the surfaces and states the design canvas uses that the table does not name.
 * Nothing in the app may reference a raw hex or px value; it comes from here,
 * either as a Tailwind utility (web, via the generated `tokens.css`) or as a
 * `theme.extend` object (a future NativeWind config, via `tailwindColors`).
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

  /** Ground behind the device on wide viewports. Below `void`. */
  canvas: '#07090B',
  /** Recessed drawer, e.g. the compiler's live spec pane. */
  sunken: '#0F1216',

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

/** Ready to drop into `theme.extend.colors` of a NativeWind config. */
export const tailwindColors: Record<string, string> = { ...colors };
