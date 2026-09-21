import { memo } from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import type { ColorToken } from '@kanon/tokens';
import type { DrawingKind } from '../../lib/chart-protocol';
import { useTheme } from '../../theme';

/**
 * The glyphs for the drawing tools, drawn on the same 24 grid, 1.75 stroke and
 * round joins as the shared `Icon` set so they sit next to it without a seam.
 * They are chart-specific (a horizontal ray, a fib ladder, a magnet) and have
 * no lucide equivalent, so they live here rather than in `icons.tsx`.
 *
 * Colour is a token name resolved through the theme, never a hex.
 */
export type ToolGlyph = DrawingKind | 'cursor' | 'magnet' | 'minimize' | 'collapse';

export interface ToolIconProps {
  name: ToolGlyph;
  size?: number | undefined;
  color?: ColorToken | undefined;
}

function Glyph({ name }: { name: ToolGlyph }) {
  switch (name) {
    case 'cursor':
      return <Path d="M6 4l12 6.2-5.2 1.4L10.6 17 6 4z" />;
    case 'trend':
      return (
        <>
          <Line x1={6.5} y1={17.5} x2={17.5} y2={6.5} />
          <Circle cx={5} cy={19} r={1.9} />
          <Circle cx={19} cy={5} r={1.9} />
        </>
      );
    case 'hray':
      return (
        <>
          <Circle cx={5} cy={12} r={1.9} />
          <Line x1={7} y1={12} x2={21} y2={12} />
          <Path d="M18 9.5l3 2.5-3 2.5" />
        </>
      );
    case 'hline':
      return (
        <>
          <Line x1={3} y1={12} x2={21} y2={12} />
          <Circle cx={12} cy={12} r={1.9} />
        </>
      );
    case 'vline':
      return (
        <>
          <Line x1={12} y1={3} x2={12} y2={21} />
          <Circle cx={12} cy={12} r={1.9} />
        </>
      );
    case 'rect':
      return (
        <>
          <Rect x={4.5} y={6.5} width={15} height={11} rx={0.5} />
          <Circle cx={4.5} cy={6.5} r={1.4} />
          <Circle cx={19.5} cy={17.5} r={1.4} />
        </>
      );
    case 'fib':
      return (
        <>
          <Line x1={4} y1={5} x2={20} y2={5} />
          <Line x1={4} y1={9.5} x2={20} y2={9.5} />
          <Line x1={4} y1={14.5} x2={20} y2={14.5} />
          <Line x1={4} y1={19} x2={20} y2={19} />
          <Line x1={6} y1={19} x2={18} y2={5} strokeDasharray="1.5 2.5" />
        </>
      );
    case 'measure':
      return (
        <>
          <Line x1={12} y1={4} x2={12} y2={20} />
          <Path d="M9 7l3-3 3 3M9 17l3 3 3-3" />
          <Line x1={7} y1={4} x2={17} y2={4} />
          <Line x1={7} y1={20} x2={17} y2={20} />
        </>
      );
    case 'magnet':
      return (
        <>
          <Path d="M6 4v8a6 6 0 0 0 12 0V4" />
          <Line x1={6} y1={8.5} x2={10} y2={8.5} />
          <Line x1={14} y1={8.5} x2={18} y2={8.5} />
        </>
      );
    case 'minimize':
      return <Path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />;
    case 'collapse':
      return (
        <>
          <Circle cx={9} cy={7} r={0.9} />
          <Circle cx={15} cy={7} r={0.9} />
          <Circle cx={9} cy={12} r={0.9} />
          <Circle cx={15} cy={12} r={0.9} />
          <Circle cx={9} cy={17} r={0.9} />
          <Circle cx={15} cy={17} r={0.9} />
        </>
      );
  }
}

function ToolIconBase({ name, size = 20, color = 'bone' }: ToolIconProps) {
  const { colors } = useTheme();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors[color]}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <Glyph name={name} />
    </Svg>
  );
}

export const ToolIcon = memo(ToolIconBase);
