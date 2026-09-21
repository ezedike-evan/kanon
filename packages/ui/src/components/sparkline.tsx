import Svg, { Circle, Path } from 'react-native-svg';
import { sparkGeometry } from '../lib/spark';
import { useTheme } from '../theme';
import { DIRECTION_TONE, TONE_COLOR, type Tone } from './tone';

export interface SparklineProps {
  /** A series of any scale; it is fitted to the box. Fewer than 2 points renders nothing. */
  data: readonly number[];
  width?: number | undefined;
  height?: number | undefined;
  /** Default: `long`/`short` by first-to-last direction, `neutral` when flat. */
  tone?: Tone | undefined;
  /** Wash under the line. Default true. */
  fill?: boolean | undefined;
}

/**
 * A minimal trend line with an end dot. Not a chart: no axes, no hover, no
 * numbers. Sits beside a figure that says what it means, so the colour is
 * never the only carrier of direction.
 */
export function Sparkline({ data, width = 72, height = 28, tone, fill = true }: SparklineProps) {
  const { colors } = useTheme();
  const g = sparkGeometry(data, width, height);
  if (!g) return null;
  const stroke = colors[TONE_COLOR[tone ?? DIRECTION_TONE[g.direction]]];
  return (
    <Svg width={width} height={height} aria-hidden>
      {fill ? <Path d={g.area} fill={stroke} fillOpacity={0.12} /> : null}
      <Path d={g.line} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" fill="none" />
      <Circle cx={g.last.x} cy={g.last.y} r={2} fill={stroke} />
    </Svg>
  );
}
