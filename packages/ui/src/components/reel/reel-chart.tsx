import { memo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient as SvgGradient, Path, Stop } from 'react-native-svg';
import type { ColorToken } from '@kanon/tokens';
import type { ChartGeometry } from '../../lib/predict-chart';
import { useTheme } from '../../theme';
import { Icon } from '../icons';
import { Num } from '../ui';

/**
 * The big line under a market's question: the asset's recent closes as an area,
 * the level as a dashed line across it, and the live price as a dot.
 *
 * Drawn once per geometry (memoised), no animation frame ever runs on it. The
 * line's colour is the asset's own direction over the day and is always beside
 * a signed figure that says so. The level is `signal`: it is the rule of this
 * market, not a direction.
 */
export const ReelChart = memo(function ReelChart({
  geometry,
  width,
  height,
  plotRight,
  tone,
  uid,
  targetText,
}: {
  geometry: ChartGeometry | null;
  width: number;
  height: number;
  /** The line ends here. The rest of the width is left clear for the rail. */
  plotRight: number;
  tone: ColorToken;
  /** Unique per page: SVG gradient ids share one document on the web. */
  uid: string;
  targetText: string;
}) {
  const { colors } = useTheme();
  if (!geometry) return <View style={{ width, height }} />;
  const stroke = colors[tone];
  const fillId = `reel-fill-${uid}`;
  // The tag rides above the dashed line, and drops under it when there is no room above.
  const tagAbove = geometry.targetY > 30;
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
        <Line
          x1={0}
          x2={plotRight}
          y1={geometry.targetY}
          y2={geometry.targetY}
          stroke={colors.signal}
          strokeWidth={1.5}
          strokeDasharray="6 5"
        />
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
      <View
        className="absolute left-5 h-6 flex-row items-center gap-1 rounded-xs border border-signal/50 bg-void/85 px-1.5"
        style={{ top: tagAbove ? geometry.targetY - 28 : geometry.targetY + 6 }}
      >
        <Icon name="target" size={12} color="signal" />
        <Num className="font-mono-medium text-11 text-signal">{targetText}</Num>
      </View>
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
