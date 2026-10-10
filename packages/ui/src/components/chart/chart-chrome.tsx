import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ASSETS } from '@kanon/spec';
import type { DrawingKind } from '../../lib/chart-protocol';
import { TOOL_LABEL } from '../../lib/chart-drawings';
import { CHART_TIMEFRAMES, type Timeframe } from '../../lib/chart-timeframes';
import { assetTitle, baseOf, predicateCode } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import { routes } from '../../lib/routes';
import type { VenueTicket } from '../../lib/use-venue-ticket';
import { barLine, barSummary } from '../../lib/venue-trade';
import type { VenueSide } from '../../lib/venue-types';
import { Link } from '../../nav';
import { useHaptics } from '../../platform';
import { BottomSheet } from '../bottom-sheet';
import { Icon } from '../icons';
import { Dot, Meta, Num } from '../ui';
import { DirectionButton } from './chart-ticket';
import { ToolIcon, type ToolGlyph } from './tool-icons';

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

export type FeedStatus = 'live' | 'demo' | 'loading' | 'empty';

export const STATUS_LABEL: Record<FeedStatus, string> = {
  live: 'CANONICAL',
  demo: 'DEMO',
  loading: 'SYNC',
  empty: 'NO SAMPLES',
};
export const STATUS_DOT: Record<FeedStatus, string> = {
  live: 'bg-verified',
  demo: 'bg-signal',
  loading: 'bg-ash',
  empty: 'bg-ash',
};

export interface ChangeText {
  absText: string;
  percentText: string;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Symbol, feed status, last price and the day's move. The move is the market's
 * direction, so it takes `long`/`short` and always carries its sign as the
 * glyph; the price itself stays neutral.
 */
export function ChartHeader({
  symbol,
  price,
  change,
  status,
  collapsed,
  onToggle,
}: {
  symbol: string;
  price: string | null;
  change: ChangeText | null;
  status: FeedStatus;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const tone =
    change?.direction === 'up' ? 'text-long' : change?.direction === 'down' ? 'text-short' : 'text-ash';
  return (
    <View className="shrink-0 px-3 pt-2.5">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="size-5 items-center justify-center rounded-[2px] border border-hairline bg-raised">
            <Text className="font-mono-bold text-9 text-bone">{baseOf(symbol).slice(0, 1)}</Text>
          </View>
          <Text className="font-mono-bold text-14 tracking-t20 text-bone">{symbol}</Text>
          <View className="ml-1 flex-row items-center gap-1.5">
            <Dot className={STATUS_DOT[status]} />
            <Text className="font-mono text-9 tracking-w14 text-ash">{STATUS_LABEL[status]}</Text>
          </View>
        </View>
        <Pressable
          role="button"
          aria-label={collapsed ? 'Show rule and readout' : 'Hide rule and readout'}
          aria-expanded={!collapsed}
          onPress={onToggle}
          hitSlop={8}
          className="size-6 items-center justify-center rounded-[2px] border border-hairline bg-panel active:bg-raised"
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} color="ash" />
        </Pressable>
      </View>
      <View className="mt-1.5 flex-row items-baseline gap-2.5">
        <Num className="text-24 tracking-t30">{price ?? '—'}</Num>
        {change ? (
          <View className="flex-row items-baseline gap-2">
            <Num className={cx('text-12', tone)}>{change.absText}</Num>
            <Num className={cx('text-12', tone)}>{change.percentText}</Num>
            <Meta>24H</Meta>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Legend and readout                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The chart's "indicator" line: the pinned rule and the predicates it enforces.
 * Tapping it opens the rule. The eye toggles the rule's structure on the tape
 * (only offered when the pinned spec is known).
 */
export function RuleLegend({
  name,
  predicates,
  structure,
}: {
  name: string;
  predicates: readonly string[];
  structure: { available: boolean; on: boolean; onToggle: () => void };
}) {
  const codes = predicates.map(predicateCode).join(' · ');
  return (
    <View className="flex-row items-center justify-between gap-2 px-3 pt-1.5">
      <Link
        href={routes.home}
        aria-label={`Open rule ${name}`}
        className="min-w-0 flex-1 flex-row items-center gap-2 py-1"
      >
        <View className="size-1.75 shrink-0 bg-signal" />
        <Text numberOfLines={1} className="shrink font-mono-medium text-11 text-bone">
          {name}
        </Text>
        <Text numberOfLines={1} className="shrink-0 font-mono text-10 tracking-w06 text-ash">
          {codes}
        </Text>
        <Icon name="chevron-right" size={12} color="ash" />
      </Link>
      {structure.available ? (
        <Pressable
          role="button"
          aria-label={structure.on ? 'Hide rule structure' : 'Show rule structure'}
          aria-pressed={structure.on}
          onPress={structure.onToggle}
          hitSlop={8}
          className={cx(
            'size-6 items-center justify-center rounded-[2px] border',
            structure.on ? 'border-signal bg-signal/15' : 'border-hairline bg-panel',
          )}
        >
          <Icon name={structure.on ? 'eye' : 'eye-off'} size={13} color={structure.on ? 'signal' : 'ash'} />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface Readout {
  o: string;
  h: string;
  l: string;
  c: string;
  direction: 'up' | 'down' | 'flat';
}

/**
 * O H L C of the candle under the crosshair, or of the last candle. No time
 * here: the chart's own crosshair label on the time axis says when, and a
 * stamp in this row would wrap it.
 */
export function OhlcReadout({ readout }: { readout: Readout | null }) {
  if (!readout) return <View className="h-4.5 px-3" />;
  const tone =
    readout.direction === 'up' ? 'text-long' : readout.direction === 'down' ? 'text-short' : 'text-bone';
  const cell = (label: string, value: string) => (
    <View className="shrink-0 flex-row items-baseline gap-1">
      <Text className="font-mono text-9 text-ash">{label}</Text>
      <Num className={cx('text-10p5', tone)}>{value}</Num>
    </View>
  );
  return (
    <View className="h-4.5 flex-row items-center gap-2.5 px-3">
      {cell('O', readout.o)}
      {cell('H', readout.h)}
      {cell('L', readout.l)}
      {cell('C', readout.c)}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Drawing toolbar                                                             */
/* -------------------------------------------------------------------------- */

/** Air between the rail and the price axis it sits beside. */
const RAIL_GAP = 6;

export const TOOLS: ReadonlyArray<{ tool: DrawingKind | null; glyph: ToolGlyph; label: string }> = [
  { tool: null, glyph: 'cursor', label: 'Cursor' },
  { tool: 'trend', glyph: 'trend', label: TOOL_LABEL.trend },
  { tool: 'hray', glyph: 'hray', label: TOOL_LABEL.hray },
  { tool: 'hline', glyph: 'hline', label: TOOL_LABEL.hline },
  { tool: 'vline', glyph: 'vline', label: TOOL_LABEL.vline },
  { tool: 'rect', glyph: 'rect', label: TOOL_LABEL.rect },
  { tool: 'fib', glyph: 'fib', label: TOOL_LABEL.fib },
  { tool: 'measure', glyph: 'measure', label: TOOL_LABEL.measure },
];

export function ToolButton({
  label,
  on,
  onPress,
  children,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const { tap } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onPressIn={tap}
      onPress={onPress}
      className={cx(
        'size-10 items-center justify-center border-l-2 hover:bg-raised-hot active:bg-raised-hot',
        on ? 'border-signal bg-panel' : 'border-transparent',
        disabled && 'opacity-35',
      )}
    >
      {children}
    </Pressable>
  );
}

/**
 * The floating drawing tools, right-hand edge, collapsible to a single handle.
 * Everything drawn is anchored to time and price, so it survives pan and zoom;
 * the tool returns to the cursor once a drawing is placed.
 */
export function DrawingToolbar({
  tool,
  onTool,
  magnet,
  onMagnet,
  canDelete,
  onDelete,
  collapsed,
  onCollapsed,
  priceAxisWidth,
  className,
}: {
  tool: DrawingKind | null;
  onTool: (tool: DrawingKind | null) => void;
  magnet: boolean;
  onMagnet: () => void;
  canDelete: boolean;
  onDelete: () => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  /** Measured width of the price axis. The rail sits to its left, so no price label is covered. */
  priceAxisWidth: number;
  /** Classes for the floating rail's own box, e.g. `lg:hidden` when the desktop has a fixed rail instead. */
  className?: string | undefined;
}) {
  const right = priceAxisWidth + RAIL_GAP;
  if (collapsed) {
    return (
      <View className={cx('absolute top-2 rounded-[3px] border border-hairline bg-raised/95', className)} style={{ right }}>
        <ToolButton label="Show drawing tools" on={tool !== null} onPress={() => onCollapsed(false)}>
          <ToolIcon name={TOOLS.find((t) => t.tool === tool)?.glyph ?? 'trend'} size={20} color={tool ? 'signal' : 'bone'} />
        </ToolButton>
      </View>
    );
  }
  return (
    <View
      className={cx('absolute top-2 overflow-hidden rounded-[3px] border border-hairline bg-raised/95', className)}
      style={{ right }}
    >
      <Pressable
        role="button"
        aria-label="Hide drawing tools"
        onPress={() => onCollapsed(true)}
        className="h-6 items-center justify-center border-b border-hairline active:bg-raised-hot"
      >
        <ToolIcon name="collapse" size={16} color="ash" />
      </Pressable>
      {TOOLS.map((t) => (
        <ToolButton key={t.label} label={t.label} on={tool === t.tool} onPress={() => onTool(t.tool)}>
          <ToolIcon name={t.glyph} size={20} color={tool === t.tool ? 'signal' : 'bone'} />
        </ToolButton>
      ))}
      <View className="border-t border-hairline">
        <ToolButton label="Magnet: snap to candle highs, lows and closes" on={magnet} onPress={onMagnet}>
          <ToolIcon name="magnet" size={20} color={magnet ? 'signal' : 'bone'} />
        </ToolButton>
        <ToolButton label="Delete selected drawing" on={false} disabled={!canDelete} onPress={onDelete}>
          <Icon name="trash" size={19} color={canDelete ? 'refused' : 'ash'} />
        </ToolButton>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Timeframe strip and bottom bar                                              */
/* -------------------------------------------------------------------------- */

export function TimeframeStrip({
  value,
  onChange,
  className,
}: {
  value: Timeframe;
  onChange: (timeframe: Timeframe) => void;
  className?: string | undefined;
}) {
  return (
    <View className={cx('shrink-0 flex-row border-t border-hairline bg-panel', className)} role="tablist">
      {CHART_TIMEFRAMES.map((tf) => {
        const on = tf.bucketSeconds === value.bucketSeconds;
        return (
          <Pressable
            key={tf.label}
            role="tab"
            aria-selected={on}
            onPress={() => onChange(tf)}
            className={cx(
              'flex-1 items-center border-t-2 py-2.5 active:bg-raised',
              on ? 'border-signal' : 'border-transparent',
            )}
          >
            <Text className={cx('text-11', on ? 'font-mono-bold text-signal' : 'font-mono text-ash')}>
              {tf.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function BarButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { tap } = useHaptics();
  return (
    <Pressable
      role="button"
      aria-label={label}
      disabled={disabled}
      onPressIn={tap}
      onPress={onPress}
      hitSlop={4}
      className={cx('size-9 items-center justify-center rounded-[2px] active:bg-raised hover:bg-raised', disabled && 'opacity-35')}
    >
      {children}
    </Pressable>
  );
}

/** Symbol and timeframe on the left, history and view on the right, as on a phone terminal. */
export function ChartBottomBar({
  symbol,
  timeframe,
  onOpenMarket,
  canUndo,
  canRedo,
  hasDrawings,
  onUndo,
  onRedo,
  onClear,
  fullscreen,
  onFullscreen,
  className,
}: {
  symbol: string;
  timeframe: string;
  onOpenMarket: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasDrawings: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
  className?: string | undefined;
}) {
  return (
    <View className={cx('shrink-0 flex-row items-center justify-between border-t border-hairline bg-panel px-2 py-1', className)}>
      <Pressable
        role="button"
        aria-label={`Change market, now ${symbol} ${timeframe}`}
        onPress={onOpenMarket}
        className="flex-row items-center gap-2 rounded-[2px] px-2 py-2 active:bg-raised hover:bg-raised"
      >
        <Text className="font-mono-bold text-13 text-bone">{symbol.replace('/', '')}</Text>
        <Text className="font-mono text-13 text-signal">{timeframe}</Text>
        <Icon name="chevron-down" size={13} color="ash" />
      </Pressable>
      <View className="flex-row items-center">
        <BarButton label="Undo" disabled={!canUndo} onPress={onUndo}>
          <Icon name="undo" size={18} color="bone" />
        </BarButton>
        <BarButton label="Redo" disabled={!canRedo} onPress={onRedo}>
          <Icon name="redo" size={18} color="bone" />
        </BarButton>
        <BarButton label="Clear all drawings" disabled={!hasDrawings} onPress={onClear}>
          <Icon name="trash" size={17} color="ash" />
        </BarButton>
        <View className="mx-1 h-5 w-px bg-hairline" />
        <BarButton label={fullscreen ? 'Exit full screen' : 'Full screen'} onPress={onFullscreen}>
          {fullscreen ? <ToolIcon name="minimize" size={18} color="bone" /> : <Icon name="maximize" size={18} color="bone" />}
        </BarButton>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Quick trade                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The phone's way into the order ticket, bottom-anchored and compact. It sends
 * nothing itself: LONG and SHORT open the ticket sheet on that side, where the
 * size, the leverage and every limit are in view before anything goes out. The
 * line above them says what is happening (an order on its way, a position to
 * close first, the last answer) and opens the same sheet.
 */
export function QuickTradeBar({
  ticket,
  onSide,
  onOpen,
  className,
}: {
  ticket: VenueTicket;
  /** LONG or SHORT was pressed: the sheet opens on that side. */
  onSide: (side: VenueSide) => void;
  /** The line was pressed: the sheet opens with no side picked. */
  onOpen: () => void;
  className?: string | undefined;
}) {
  const { view, sending, locked, outcome } = ticket;
  const line = barLine(view, sending, outcome);
  const off = locked || view.hold !== null;
  return (
    <View className={cx('shrink-0 border-t border-hairline bg-void px-3 pb-2 pt-0.5', className)} aria-busy={sending !== null}>
      <Pressable
        role="button"
        aria-label={`Open the order ticket. ${line}`}
        onPress={onOpen}
        className="h-8 flex-row items-center justify-between gap-3 active:opacity-70"
      >
        <Text
          numberOfLines={1}
          accessibilityLiveRegion="polite"
          className={cx('min-w-0 flex-1 font-mono text-10', sending || view.hold !== null ? 'text-bone' : 'text-ash')}
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {line}
        </Text>
        <View className="shrink-0 flex-row items-center gap-1">
          <Num className="text-10">{barSummary(view)}</Num>
          <Icon name="chevron-up" size={12} color="ash" />
        </View>
      </Pressable>
      <View className="flex-row gap-2">
        <DirectionButton
          side="long"
          label="Long: open the order ticket"
          disabled={off}
          onPress={() => onSide('long')}
        />
        {/* The tab bar's raised centre action rises into this row; keep clear of it. */}
        <View className="w-14" />
        <DirectionButton
          side="short"
          label="Short: open the order ticket"
          disabled={off}
          onPress={() => onSide('short')}
        />
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Market sheet                                                                */
/* -------------------------------------------------------------------------- */

/** Symbol and timeframe pickers in one bottom sheet. The assets are the ones the spec allows trading. */
export function MarketSheet({
  open,
  onClose,
  symbol,
  timeframe,
  onSymbol,
  onTimeframe,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  timeframe: Timeframe;
  onSymbol: (symbol: string) => void;
  onTimeframe: (timeframe: Timeframe) => void;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title="MARKET" meta={`${ASSETS.length} ASSETS`}>
      <Meta className="pb-2">TIMEFRAME</Meta>
      <View className="flex-row flex-wrap gap-2 pb-5">
        {CHART_TIMEFRAMES.map((tf) => {
          const on = tf.bucketSeconds === timeframe.bucketSeconds;
          return (
            <Pressable
              key={tf.label}
              role="button"
              aria-pressed={on}
              onPress={() => onTimeframe(tf)}
              className={cx(
                'h-9 min-w-16 items-center justify-center rounded-[2px] border px-3',
                on ? 'border-signal bg-signal/15' : 'border-hairline bg-panel',
              )}
            >
              <Text className={cx('text-12', on ? 'font-mono-bold text-signal' : 'font-mono text-bone')}>{tf.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Meta className="pb-1">SYMBOL</Meta>
      {ASSETS.map((asset) => {
        const on = asset.symbol === symbol;
        return (
          <Pressable
            key={asset.symbol}
            role="button"
            aria-pressed={on}
            onPress={() => onSymbol(asset.symbol)}
            className="flex-row items-center justify-between border-b border-hairline py-3 active:bg-panel"
          >
            <View className="gap-1">
              <Text className={cx('font-mono-bold text-13', on ? 'text-signal' : 'text-bone')}>{asset.symbol}</Text>
              <Text className="font-mono text-10 text-ash">{assetTitle(asset.symbol)}</Text>
            </View>
            <View className="flex-row items-center gap-3">
              <Meta>{asset.assetClass.toUpperCase()}</Meta>
              <Icon name="check" size={16} color={on ? 'signal' : 'hairline'} />
            </View>
          </Pressable>
        );
      })}
    </BottomSheet>
  );
}
