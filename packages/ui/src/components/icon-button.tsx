import { Pressable } from 'react-native';
import type { ColorToken } from '@kanon/tokens';
import { cx } from '../lib/cx';
import { useHaptics } from '../platform';
import { Icon, type Icon as IconName } from './icons';

const BOX = { sm: 'size-8', md: 'size-10', lg: 'size-11' } as const;
const GLYPH = { sm: 16, md: 18, lg: 20 } as const;

export interface IconButtonProps {
  icon: IconName;
  /** Required: an icon button has no visible text, so it needs an accessible name. */
  label: string;
  onPress?: (() => void) | undefined;
  /** `ghost` (default), `outline`, `solid` (signal fill, the one primary per screen). */
  variant?: 'ghost' | 'outline' | 'solid' | undefined;
  /** 32 / 40 / 44 px. Below 40 the hit area still extends to 44 through hitSlop. */
  size?: keyof typeof BOX | undefined;
  color?: ColorToken | undefined;
  disabled?: boolean | undefined;
  /** For a button that opens and closes something: whether that thing is open now. */
  expanded?: boolean | undefined;
  className?: string | undefined;
}

const VARIANT = {
  ghost: 'border-transparent bg-transparent hover:bg-raised active:bg-raised',
  outline: 'border-hairline bg-panel hover:bg-raised active:bg-raised',
  solid: 'border-signal bg-signal hover:bg-signal-hot active:bg-signal-hot',
} as const;

/** A square icon-only control. Plays the `tap` haptic on press-in. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'ghost',
  size = 'md',
  color,
  disabled,
  expanded,
  className,
}: IconButtonProps) {
  const { tap } = useHaptics();
  const glyph: ColorToken = color ?? (variant === 'solid' ? 'void' : 'bone');
  return (
    <Pressable
      role="button"
      aria-label={label}
      {...(expanded === undefined ? null : { 'aria-expanded': expanded })}
      disabled={disabled}
      hitSlop={size === 'sm' ? 6 : 2}
      onPressIn={tap}
      onPress={onPress}
      className={cx(
        'items-center justify-center rounded-sm border',
        BOX[size],
        VARIANT[variant],
        disabled && 'opacity-40',
        className,
      )}
    >
      <Icon name={icon} size={GLYPH[size]} color={glyph} />
    </Pressable>
  );
}
