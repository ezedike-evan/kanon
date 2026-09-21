import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { initialsOf } from '../lib/initials';
import { TONE_SOFT, TONE_TEXT, type Tone } from './tone';

const SIZE = {
  xs: { box: 'size-6', text: 'text-9' },
  sm: { box: 'size-8', text: 'text-11' },
  md: { box: 'size-10', text: 'text-13' },
  lg: { box: 'size-14', text: 'text-20' },
} as const;

export interface AvatarProps {
  /** A name, handle or address. Initials are derived; `0x…` uses its first two hex digits. */
  name: string;
  size?: keyof typeof SIZE | undefined;
  /** `signal` marks the signed-in user; everything else stays neutral. */
  tone?: Tone | undefined;
  className?: string | undefined;
}

/**
 * A monogram tile. Square with 3px corners rather than a circle: a circle reads
 * as a social profile, and this is a ledger.
 */
export function Avatar({ name, size = 'md', tone = 'neutral', className }: AvatarProps) {
  const { box, text } = SIZE[size];
  return (
    <View
      role="img"
      aria-label={name}
      className={cx('items-center justify-center rounded-sm border', box, TONE_SOFT[tone], className)}
    >
      <Text className={cx('font-mono-bold uppercase tracking-w04', text, TONE_TEXT[tone])}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}
