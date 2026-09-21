import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Link } from '../nav';
import { cx } from '../lib/cx';
import { elevationStyle } from '../lib/elevation';
import { useTheme } from '../theme';
import { useHaptics } from '../platform';

export type CardVariant = 'base' | 'raised' | 'outlined' | 'interactive';
export type CardPad = 'none' | 'sm' | 'md' | 'lg';

const VARIANT: Record<CardVariant, string> = {
  /** A surface on the ground. The default; most things are this. */
  base: 'border border-hairline bg-panel',
  /** Sits above the page: sheets, the focused block on a screen. */
  raised: 'border border-hairline bg-raised',
  /** No fill. Groups without weight; for secondary and empty regions. */
  outlined: 'border border-hairline bg-transparent',
  /** A base card that is a control: presses to `raised`, chevron-free. */
  interactive: 'border border-hairline bg-panel active:bg-raised hover:bg-raised',
};

const PAD: Record<CardPad, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

export interface CardProps {
  children: ReactNode;
  /** `base` (default), `raised`, `outlined`, `interactive`. Passing `href` or `onPress` implies interactive. */
  variant?: CardVariant | undefined;
  /** Inner padding: `none`, `sm` 12, `md` 16 (default), `lg` 20. */
  pad?: CardPad | undefined;
  /** Elevation step, 0 to 3. `raised` defaults to 2, the rest to 0. */
  elevation?: 0 | 1 | 2 | 3 | undefined;
  href?: string | undefined;
  onPress?: (() => void) | undefined;
  /** Accessible name, for an interactive card whose content is not text. */
  label?: string | undefined;
  className?: string | undefined;
  style?: StyleProp<ViewStyle> | undefined;
}

/**
 * The one surface. 3px corners, a hairline, a tone from the ground ramp.
 *
 *   <Card>                       a panel
 *   <Card variant="raised">      a sheet-weight block
 *   <Card href="/vault">         a whole-card link (press feedback, haptic tap)
 *
 * Depth comes from the surface tone and the hairline first; a shadow is added
 * only where a step of elevation is asked for, and it is tinted with the ink
 * token rather than pure black.
 */
export function Card({
  children,
  variant,
  pad = 'md',
  elevation,
  href,
  onPress,
  label,
  className,
  style,
}: CardProps) {
  const { scheme, colors } = useTheme();
  const { tap } = useHaptics();
  const resolved: CardVariant = variant ?? (href || onPress ? 'interactive' : 'base');
  const step = elevation ?? (resolved === 'raised' ? 2 : 0);
  const shadow = step === 0 ? undefined : elevationStyle(step, scheme, colors);
  const cls = cx('rounded-sm', VARIANT[resolved], PAD[pad], className);
  const merged: StyleProp<ViewStyle> = shadow ? [shadow, style] : style;

  if (href) {
    return (
      <Link href={href} className={cls} style={merged} aria-label={label} onPressIn={tap}>
        {children}
      </Link>
    );
  }
  if (onPress) {
    return (
      <Pressable
        role="button"
        className={cls}
        style={merged}
        aria-label={label}
        onPressIn={tap}
        onPress={onPress}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View className={cls} style={merged}>
      {children}
    </View>
  );
}
