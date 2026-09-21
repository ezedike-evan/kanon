import type { ColorToken } from '@kanon/tokens';

/**
 * The semantic tones a primitive can take. Each one is a *meaning*, not a
 * decoration (docs/DESIGN.md, Colour): `signal` is the rule, `long`/`short` are
 * market direction, `refused` is a block, `verified` is proof.
 *
 * Class names are spelled out in full, never assembled, because Tailwind only
 * emits utilities it can read as literals.
 */
export type Tone = 'neutral' | 'signal' | 'long' | 'short' | 'refused' | 'verified';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-bone',
  signal: 'text-signal',
  long: 'text-long',
  short: 'text-short',
  refused: 'text-refused',
  verified: 'text-verified',
};

/** A tinted chip: wash fill plus a hairline of the same hue. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'border-hairline bg-raised',
  signal: 'border-signal/40 bg-signal/15',
  long: 'border-long/40 bg-long/15',
  short: 'border-short/40 bg-short/15',
  refused: 'border-refused/50 bg-refused/15',
  verified: 'border-verified/40 bg-verified/15',
};

/** The token an icon takes to match a tone. */
export const TONE_COLOR: Record<Tone, ColorToken> = {
  neutral: 'bone',
  signal: 'signal',
  long: 'long',
  short: 'short',
  refused: 'refused',
  verified: 'verified',
};

export type Direction = 'up' | 'down' | 'flat';

/** Direction of a signed number. Zero is flat, and flat is never green or red. */
export function directionOf(n: number): Direction {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

export const DIRECTION_TONE: Record<Direction, Tone> = {
  up: 'long',
  down: 'short',
  flat: 'neutral',
};
