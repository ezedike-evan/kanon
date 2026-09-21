import { memo, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ColorToken } from '@kanon/tokens';
import { cx } from '../../lib/cx';
import { withAlpha } from '../../lib/elevation';
import { questionParts, type SideCopy } from '../../lib/predict-reel';
import type { PredictMarket } from '../../lib/predict-types';
import { isWeb } from '../../platform';
import { useTheme } from '../../theme';
import { FilterChip } from '../chip';
import { Icon, type Icon as IconName } from '../icons';
import { Label } from '../stat';
import { Num } from '../ui';

/**
 * The small pieces a reel page is made of. Each one is a fixed shape with no
 * state of its own beyond a press, so a page re-renders cheaply.
 */

/** The page's own snap point on the web, where the scroller has no `snapToInterval`. Native ignores it. */
export const PAGE_SNAP: ViewStyle | undefined = isWeb
  ? ({ scrollSnapAlign: 'start', scrollSnapStop: 'always' } as ViewStyle)
  : undefined;

/**
 * The current second, ticking only while `active`. A reel keeps a few pages
 * mounted at once; a one-second timer on each would be three times the work for
 * two countdowns nobody is looking at. `null` until the first client read, so
 * the server render and the hydrated one agree.
 */
export function usePageClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setNow(Math.floor(Date.now() / 1000));
    read();
    if (!active) return undefined;
    const id = setInterval(read, 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The question, big, with its figure in mono. */
export const Question = memo(function Question({
  market,
  size = 'lg',
}: {
  market: PredictMarket;
  size?: 'lg' | 'md';
}) {
  const parts = questionParts(market);
  return (
    <Text
      className={cx('font-sans font-medium text-bone', size === 'lg' ? 'text-24' : 'text-18')}
      style={{ lineHeight: size === 'lg' ? 31 : 24 }}
    >
      {parts.map((p, i) =>
        p.mono ? (
          <Text key={i} className="font-mono-medium" style={{ fontVariant: ['tabular-nums'] }}>
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </Text>
  );
});

/** A rail control: a tight tile with a glyph, and its name beneath it. */
function RailButton({
  icon,
  label,
  color = 'bone',
  compact = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  color?: ColorToken;
  /** Icon only: the label stays as the accessible name. */
  compact?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      onPress={onPress}
      hitSlop={4}
      className="items-center gap-1 active:opacity-70"
    >
      <View className="size-11 items-center justify-center rounded-sm border border-hairline bg-void/70 hover:bg-raised">
        <Icon name={icon} size={20} color={color} />
      </View>
      {compact ? null : <Text className="font-mono text-9 uppercase tracking-w10 text-ash">{label}</Text>}
    </Pressable>
  );
}

/** Evidence, share, how it settles. Nothing else: the rail is not a toolbar. */
export const Rail = memo(function Rail({
  horizontal = false,
  onEvidence,
  onShare,
  onInfo,
}: {
  /** A row without labels, for a page too short for a column of three. */
  horizontal?: boolean;
  onEvidence: () => void;
  onShare: () => void;
  onInfo: () => void;
}) {
  return (
    <View className={horizontal ? 'flex-row items-center gap-2' : 'items-center gap-3'}>
      <RailButton icon="shield-check" label="Evidence" color="verified" compact={horizontal} onPress={onEvidence} />
      <RailButton icon="share" label="Share" compact={horizontal} onPress={onShare} />
      <RailButton icon="info" label="Settles" compact={horizontal} onPress={onInfo} />
    </View>
  );
});

/** UP or DOWN: a big solid block, direction colour with its glyph and its word. */
export function SideButton({
  side,
  copy,
  disabled,
  onPress,
}: {
  side: 'above' | 'below';
  copy: SideCopy;
  disabled: boolean;
  onPress: () => void;
}) {
  const up = side === 'above';
  return (
    <Pressable
      role="button"
      aria-label={`${copy.label}: ${copy.claim}`}
      disabled={disabled}
      onPress={onPress}
      className={cx(
        'h-16 flex-1 items-center justify-center gap-0.5 rounded-sm active:opacity-80 hover:opacity-90',
        up ? 'bg-long' : 'bg-short',
        disabled && 'opacity-40',
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon name={up ? 'arrow-up' : 'arrow-down'} size={20} color="void" strokeWidth={2} />
        <Text className="font-mono-bold text-18 tracking-w10 text-void">{copy.label}</Text>
      </View>
      <Text className="font-mono text-11 text-void/80" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
        {copy.claim}
      </Text>
    </Pressable>
  );
}

/** One sentence of fact under the action zone. Neutral: a state, never a fault. */
export function NoteLine({
  text,
  icon = 'info',
  strong,
  className,
}: {
  text: string;
  icon?: IconName;
  strong?: boolean;
  className?: string | undefined;
}) {
  return (
    <View className={cx('min-h-8 flex-row items-center justify-center gap-1.5 px-2 pt-2.5', className)}>
      <Icon name={icon} size={14} color={strong ? 'bone' : 'ash'} />
      <Text
        className={cx('shrink font-mono text-11 leading-4', strong ? 'text-bone' : 'text-ash')}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * The slim strip over the top of the feed: asset filter chips that scroll, and
 * one timeframe chip that cycles. A wash fades it into the page beneath.
 */
export const TopBar = memo(function TopBar({
  assets,
  asset,
  onAsset,
  timeframe,
  timeframeCount,
  onTimeframe,
  className,
}: {
  assets: readonly string[];
  asset: string | null;
  onAsset: (asset: string | null) => void;
  timeframe: string | null;
  /** How many windows there are to cycle through. The chip is hidden for fewer than two. */
  timeframeCount: number;
  onTimeframe: () => void;
  /** Classes for the strip's own box: `lg:hidden` where the desktop's left panel does this job. */
  className?: string | undefined;
}) {
  const { colors } = useTheme();
  return (
    <View className={cx('absolute inset-x-0 top-0 z-10', className)} style={{ pointerEvents: 'box-none' }}>
      <LinearGradient
        colors={[withAlpha(colors.void, 0.96), withAlpha(colors.void, 0.7), withAlpha(colors.void, 0)]}
        locations={[0, 0.6, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 68, pointerEvents: 'none' }}
      />
      <View className="flex-row items-center pt-2.5" style={{ pointerEvents: 'box-none' }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="items-center gap-2 px-5"
        >
          <FilterChip label="All" selected={asset === null} onPress={() => onAsset(null)} />
          {assets.map((code) => (
            <FilterChip key={code} label={code} selected={asset === code} onPress={() => onAsset(code)} />
          ))}
        </ScrollView>
        {timeframeCount > 1 ? (
          <View className="pl-2 pr-5">
            <FilterChip
              label={timeframe ?? 'Any'}
              icon="timer"
              selected={timeframe !== null}
              onPress={onTimeframe}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});

/** A signed distance or move, with its glyph. Direction colour only beside the glyph and the figure. */
export function Move({
  text,
  direction,
  suffix,
}: {
  text: string;
  direction: 'up' | 'down' | 'flat';
  suffix?: string | undefined;
}) {
  const color: ColorToken = direction === 'up' ? 'long' : direction === 'down' ? 'short' : 'ash';
  const tone = direction === 'up' ? 'text-long' : direction === 'down' ? 'text-short' : 'text-ash';
  return (
    <View className="flex-row items-center gap-1">
      {direction === 'flat' ? null : (
        <Icon name={direction === 'up' ? 'trending-up' : 'trending-down'} size={14} color={color} strokeWidth={2} />
      )}
      <Num className={cx('text-13', tone)}>{text}</Num>
      {suffix ? <Label className="ml-0.5">{suffix}</Label> : null}
    </View>
  );
}
