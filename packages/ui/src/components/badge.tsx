import { Text, View } from 'react-native';
import { cx } from '../lib/cx';
import { Icon, type Icon as IconName } from './icons';
import { TONE_COLOR, TONE_SOFT, TONE_TEXT, type Tone } from './tone';

export interface BadgeProps {
  label: string;
  tone?: Tone | undefined;
  /** A leading glyph. Direction and refusal badges should always have one. */
  icon?: IconName | undefined;
  /** `sm` 18px (inline with rows, default), `md` 22px. */
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
}

/**
 * A status label: PINNED, VERIFIED, LONG, BLOCKED. Uppercase mono, square-ish,
 * a tinted wash with a hairline of the same hue. Always text; colour alone never
 * says anything (docs/DESIGN.md).
 *
 * A refusal is `tone="refused"` with the `ban` glyph and the word BLOCKED, and
 * is not an error: it is the product doing its job.
 */
export function Badge({ label, tone = 'neutral', icon, size = 'sm', className }: BadgeProps) {
  return (
    <View
      className={cx(
        'flex-row items-center gap-1 self-start rounded-xs border',
        size === 'sm' ? 'h-4.5 px-1.5' : 'h-5.5 px-2',
        TONE_SOFT[tone],
        className,
      )}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 10 : 12} color={TONE_COLOR[tone]} strokeWidth={2} /> : null}
      <Text
        className={cx(
          'font-mono-bold uppercase tracking-w08',
          size === 'sm' ? 'text-9' : 'text-10',
          TONE_TEXT[tone],
        )}
      >
        {label}
      </Text>
    </View>
  );
}
