import type { ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { ringGeometry } from '../lib/spark';
import { useTheme } from '../theme';
import { TONE_COLOR, type Tone } from './tone';

export interface ProgressRingProps {
  /** 0 to 1. Clamped. */
  value: number;
  /** Outer diameter in px. Default 56. */
  size?: number | undefined;
  /** Stroke width in px. Default 5. */
  thickness?: number | undefined;
  tone?: Tone | undefined;
  /** Centre content, typically a `<Num>` with the percentage. */
  children?: ReactNode;
}

/**
 * A ring gauge for a bounded quantity: adherence, budget used, a countdown.
 * Starts at 12 o'clock, fills clockwise, square caps to match the tight-corner
 * language. Static: it renders a value, it does not animate one.
 */
export function ProgressRing({
  value,
  size = 56,
  thickness = 5,
  tone = 'signal',
  children,
}: ProgressRingProps) {
  const { colors } = useTheme();
  const g = ringGeometry(size, thickness, value);
  const c = size / 2;
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg width={size} height={size} style={{ position: 'absolute' }} aria-hidden>
        <Circle cx={c} cy={c} r={g.radius} stroke={colors.hairline} strokeWidth={thickness} fill="none" />
        {g.value > 0 ? (
          <Circle
            cx={c}
            cy={c}
            r={g.radius}
            stroke={colors[TONE_COLOR[tone]]}
            strokeWidth={thickness}
            strokeDasharray={g.dash}
            strokeLinecap="butt"
            fill="none"
            transform={`rotate(-90 ${c} ${c})`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  );
}
