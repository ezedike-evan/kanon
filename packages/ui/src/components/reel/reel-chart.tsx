import { memo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';
import type { ColorToken } from '@kanon/tokens';
import type { ChartGeometry } from '../../lib/predict-chart';
import { useTheme } from '../../theme';
import { Num } from '../ui';

/**
 * The big line on a slide: the pair's recent closes as an area and the live
 * price as a dot. While a trade is running on the pair its entry is a dashed
 * line across it, tagged with the price.
 *
 * Drawn once per geometry (memoised), no animation frame ever runs on it. The
 * line's colour is a direction (the pair's over the day, or the price against
 * the entry while a trade runs) and is always beside a signed figure that says
 * so. The entry is neutral: it is where the trade began, not a direction.
 */
export const ReelChart = memo(function ReelChart({
  geometry,
  width,
  height,
  plotRight,
  tone,
  uid,
  levelText,
}: {
  geometry: ChartGeometry | null;
  width: number;
  height: number;
  /** The line ends here. The rest of the width is left clear for the rail. */
  plotRight: number;
  tone: ColorToken;
  /** Unique per page: SVG gradient ids share one document on the web. */
  uid: string;
  /** What the dashed line is: `ENTRY 61,234.5`. Drawn only when the geometry has a level. */
  levelText?: string | undefined;
}) {
  const { colors } = useTheme();
  if (!geometry) return <View style={{ width, height }} />;
  const stroke = colors[tone];
  const fillId = `reel-fill-${uid}`;
  const level = geometry.targetY;
  // The tag rides above the dashed line, and drops under it when there is no room above.
  const tagAbove = level !== null && level > 30;
  return (
    <View style={{ width, height }}>
      <Svg width={width} height={height} aria-hidden>
        <Defs>
          <SvgGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={stroke} stopOpacity={0.34} />
            <Stop offset="1" stopColor={stroke} stopOpacity={0} />
          </SvgGradient>
        </Defs>
        {geometry.area ? <Path d={geometry.area} fill={`url(#${fillId})`} /> : null}
        {level !== null ? (
          <Line x1={0} x2={plotRight} y1={level} y2={level} stroke={colors.ash} strokeWidth={1.5} strokeDasharray="6 5" />
        ) : null}
        {geometry.line ? (
          <Path d={geometry.line} stroke={stroke} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" fill="none" />
        ) : null}
        {geometry.end ? (
          <>
            <Circle cx={geometry.end.x} cy={geometry.end.y} r={9} fill={stroke} fillOpacity={0.2} />
            <Circle cx={geometry.end.x} cy={geometry.end.y} r={4.5} fill={stroke} stroke={colors.void} strokeWidth={2} />
          </>
        ) : null}
      </Svg>
      {level !== null && levelText ? (
        <View
          className="absolute left-5 h-6 flex-row items-center rounded-xs border border-hairline bg-void/85 px-1.5"
          style={{ top: tagAbove ? level - 28 : level + 6 }}
        >
          <Num className="font-mono-medium text-11 tracking-w04">{levelText}</Num>
        </View>
      ) : null}
    </View>
  );
});

/** Shown in the chart's place while its candles load, or when there are none to draw. A neutral line of fact. */
export function ChartPlaceholder({ text }: { text: string }) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      <Text className="text-center font-mono text-11 text-ash">{text}</Text>
    </View>
  );
}
