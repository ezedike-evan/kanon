import { memo, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ColorToken } from '@kanon/tokens';
import { cx } from '../../lib/cx';
import { withAlpha } from '../../lib/elevation';
import type { TitlePart } from '../../lib/timed-reel';
import { durationLabel } from '../../lib/timed-trade';
import type { TimedDirection } from '../../lib/timed-types';
import { isWeb, useHaptics } from '../../platform';
import { useTheme } from '../../theme';
import { FilterChip } from '../chip';
import { Icon, type Icon as IconName } from '../icons';
import { Label } from '../stat';
import { Num } from '../ui';
import { FOCUS } from './trade-parts';

/**
 * The small pieces a reel slide is made of. Each one is a fixed shape with no
 * state of its own beyond a press, so a slide re-renders cheaply.
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

/** A slide's title, big, with its figure in mono: the question it asks, or the trade running on it. */
export const SlideTitle = memo(function SlideTitle({
  parts,
  size = 'lg',
}: {
  parts: readonly TitlePart[];
  size?: 'lg' | 'md';
}) {
  return (
    <Text
      role="heading"
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

/** A rail control: a tight tile with a glyph, its name beneath it, and a count on its corner when there is one. */
function RailButton({
  icon,
  label,
  name,
  count,
  compact = false,
  onPress,
}: {
  icon: IconName;
  /** The word under the tile. */
  label: string;
  /** What a press does, for a screen reader: `Running trades, 2`. */
  name: string;
  /** Shown on the tile's corner when above zero. */
  count?: number | undefined;
  /** Icon only: the name stays as the accessible name. */
  compact?: boolean;
  onPress: () => void;
}) {
  const { tap } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-label={name}
      onPressIn={tap}
      onPress={onPress}
      hitSlop={4}
      className={cx('items-center gap-1 rounded-sm active:opacity-70', FOCUS)}
    >
      <View className="size-11 items-center justify-center rounded-sm border border-hairline bg-void/70 hover:bg-raised">
        <Icon name={icon} size={20} color="bone" />
        {count !== undefined && count > 0 ? (
          // The count is in `signal`: a running trade is a rule in force, the timer the trade is held to.
          <View className="absolute -right-1.5 -top-1.5 h-4.5 min-w-4.5 items-center justify-center rounded-xs bg-signal px-1">
            <Num className="font-mono-bold text-10 text-void">{count}</Num>
          </View>
        ) : null}
      </View>
      {compact ? null : <Text className="font-mono text-9 uppercase tracking-w10 text-ash">{label}</Text>}
    </Pressable>
  );
}

/**
 * What is running, and what has finished: the caller's trades, one press from
 * any slide. Nothing else: the rail is not a toolbar. The count is how many
 * trades are running, on any pair, so one on another slide is never out of mind.
 */
export const Rail = memo(function Rail({
  horizontal = false,
  running,
  onRunning,
  onHistory,
}: {
  /** A row without labels, for a slide too short for a column. */
  horizontal?: boolean;
  /** How many of the caller's trades are running. */
  running: number;
  onRunning: () => void;
  onHistory: () => void;
}) {
  return (
    <View className={horizontal ? 'flex-row items-center gap-2' : 'items-center gap-3'}>
      <RailButton
        icon="timer"
        label="Running"
        name={running === 0 ? 'Running trades, none' : `Running trades, ${running}`}
        count={running}
        compact={horizontal}
        onPress={onRunning}
      />
      <RailButton icon="history" label="History" name="Finished trades" compact={horizontal} onPress={onHistory} />
    </View>
  );
});

/**
 * UP or DOWN: a big solid block, direction colour with its glyph and its word,
 * and under the word what a press opens (`Long $125`). A press sends the trade:
 * there is no second step.
 */
export function SideButton({
  direction,
  word,
  claim,
  label,
  disabled,
  sending,
  compact,
  onPress,
}: {
  direction: TimedDirection;
  /** `UP`, `DOWN`. */
  word: string;
  /** What the press opens, or null while that is not known. */
  claim: string | null;
  /** What a press does, for a screen reader: `Open up on BTC, 25 dollars, 1 minute`. Or why it does nothing. */
  label: string;
  disabled: boolean;
  /** This side's order is the one on its way. */
  sending: boolean;
  /** A shorter block, for a slide with little height. */
  compact?: boolean;
  onPress: () => void;
}) {
  const { tap } = useHaptics();
  const up = direction === 'up';
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-busy={sending}
      disabled={disabled}
      onPressIn={tap}
      onPress={onPress}
      className={cx(
        'flex-1 items-center justify-center gap-0.5 rounded-sm',
        compact ? 'h-14' : 'h-16',
        up ? 'bg-long' : 'bg-short',
        disabled ? 'opacity-40' : 'hover:opacity-90 active:opacity-80',
        // Outside the block, in bone: a ring inside a block of direction colour would not be seen.
        isWeb && 'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bone',
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon name={up ? 'arrow-up' : 'arrow-down'} size={20} color="void" strokeWidth={2} />
        <Text className="font-mono-bold text-18 tracking-w10 text-void">{sending ? 'OPENING…' : word}</Text>
      </View>
      {claim ? (
        <Text className="font-mono text-11 text-void/80" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
          {claim}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** One sentence of fact under the action zone. Neutral: a state, never a fault. */
export function NoteLine({
  text,
  icon = 'info',
  strong,
  live,
  className,
}: {
  text: string;
  icon?: IconName;
  strong?: boolean;
  /** Read out when it changes: what is on its way, what a trade is doing. */
  live?: boolean;
  className?: string | undefined;
}) {
  return (
    <View className={cx('min-h-8 flex-row items-center justify-center gap-1.5 px-2 pt-2.5', className)}>
      <Icon name={icon} size={14} color={strong ? 'bone' : 'ash'} />
      <Text
        {...(live ? { role: 'status' as const, accessibilityLiveRegion: 'polite' as const } : null)}
        className={cx('shrink font-mono text-11 leading-4', strong ? 'text-bone' : 'text-ash')}
        style={{ fontVariant: ['tabular-nums'] }}
      >
        {text}
      </Text>
    </View>
  );
}

/**
 * The slim strip over the top of the reel: pair filter chips that scroll, and
 * one time chip that cycles. A wash fades it into the slide beneath.
 */
export const TopBar = memo(function TopBar({
  assets,
  asset,
  onAsset,
  seconds,
  timeCount,
  onTime,
  className,
}: {
  assets: readonly string[];
  asset: string | null;
  onAsset: (asset: string | null) => void;
  /** The time the reel is narrowed to, in seconds, or null for any. */
  seconds: number | null;
  /** How many times there are to cycle through. The chip is hidden for fewer than two. */
  timeCount: number;
  onTime: () => void;
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
        {timeCount > 1 ? (
          <View className="pl-2 pr-5">
            <FilterChip
              label={seconds === null ? 'Any' : durationLabel(seconds)}
              icon="timer"
              selected={seconds !== null}
              onPress={onTime}
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
