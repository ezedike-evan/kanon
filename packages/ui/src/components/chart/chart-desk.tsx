import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { formatBps, formatDecimal, isMarketAsset } from '@kanon/spec';
import type { DrawingKind } from '../../lib/chart-protocol';
import { assetTitle, baseOf, compactSymbol, predicateCode } from '../../lib/chart-assets';
import { CHART_TIMEFRAMES, type Timeframe } from '../../lib/chart-timeframes';
import { cx } from '../../lib/cx';
import type { PairTicker } from '../../lib/domain-types';
import { useMarkets, useTicker } from '../../lib/domains';
import { routes } from '../../lib/routes';
import type { VenueTicket } from '../../lib/use-venue-ticket';
import { Link } from '../../nav';
import { useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { SectionHeader } from '../section-header';
import { SkeletonRow } from '../skeleton';
import { Delta } from '../stat';
import { DIRECTION_TONE, directionOf, TONE_TEXT } from '../tone';
import { Dot, Meta, Num } from '../ui';
import { useLayout } from '../shell/use-layout';
import { STATUS_DOT, STATUS_LABEL, TOOLS, ToolButton, type ChangeText, type FeedStatus, type Readout } from './chart-chrome';
import { OrderTicket, RecentOrders } from './chart-ticket';
import { ToolIcon } from './tool-icons';

/*
 * The chart on a desktop: a fixed tool rail, a slim toolbar, the canvas, and a
 * panel on the right. Every piece here is `hidden` below `lg` and `flex` from
 * it, by class, so the phone's floating rail and bottom bars are the only chrome
 * a phone or a tablet draws and nothing flashes on hydration. The screen renders
 * these on the web only; a device never mounts them.
 */

/* -------------------------------------------------------------------------- */
/* A label on hover                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A name that appears beside a control on hover, the way a terminal labels its
 * icon buttons. The control keeps its own `aria-label`; this is only for a
 * pointer, so it is drawn with a group-hover class and never takes focus.
 */
function Tip({
  label,
  place = 'below',
  children,
}: {
  label: string;
  place?: 'below' | 'below-end' | 'right';
  children: ReactNode;
}) {
  return (
    <View className="group relative">
      {children}
      <View
        aria-hidden
        className={cx(
          'absolute z-10 hidden rounded-xs border border-hairline bg-raised px-2 py-1 group-hover:flex',
          place === 'right'
            ? 'left-full top-2 ml-2'
            : place === 'below-end'
              ? 'right-0 top-full mt-1.5'
              : 'left-0 top-full mt-1.5',
        )}
        style={{ pointerEvents: 'none' }}
      >
        <Text className="font-mono text-11 text-bone" style={{ whiteSpace: 'nowrap' } as never}>
          {label}
        </Text>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Tool rail                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The drawing tools as a fixed column at the left of the canvas, not floating over
 * it. Same tools, same toggling as the phone's rail: choosing the active tool again
 * puts it down, and a completed drawing returns the runtime to the cursor.
 */
export function DeskToolRail({
  tool,
  onTool,
  canDelete,
  onDelete,
}: {
  tool: DrawingKind | null;
  onTool: (tool: DrawingKind | null) => void;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <View
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Drawing tools"
      className="hidden w-10 shrink-0 gap-0.5 border-r border-hairline bg-panel py-1.5 lg:flex"
      // Above the canvas beside it: react-native-web gives every view its own stacking context, so a hover label would otherwise paint under the chart.
      style={{ zIndex: 5 }}
    >
      {TOOLS.map((t) => (
        <Tip key={t.label} label={t.label} place="right">
          <ToolButton label={t.label} on={tool === t.tool} onPress={() => onTool(t.tool)}>
            <ToolIcon name={t.glyph} size={20} color={tool === t.tool ? 'signal' : 'bone'} />
          </ToolButton>
        </Tip>
      ))}
      <View className="mx-2 my-1 h-px bg-hairline" />
      <Tip label="Delete selected drawing" place="right">
        <ToolButton label="Delete selected drawing" on={false} disabled={!canDelete} onPress={onDelete}>
          <Icon name="trash" size={19} color={canDelete ? 'refused' : 'ash'} />
        </ToolButton>
      </Tip>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                     */
/* -------------------------------------------------------------------------- */

function BarIcon({
  label,
  onPress,
  disabled,
  pressed,
  place = 'below',
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  place?: 'below' | 'below-end';
  /** A toggle that is on. Drawn as a `raised` ground as well as the icon's colour. */
  pressed?: boolean;
  children: ReactNode;
}) {
  const { tap } = useHaptics();
  return (
    <Tip label={label} place={place}>
      <Pressable
        role="button"
        aria-label={label}
        {...(pressed === undefined ? null : { 'aria-pressed': pressed })}
        disabled={disabled}
        onPressIn={tap}
        onPress={onPress}
        className={cx(
          'size-8 items-center justify-center rounded-xs border hover:bg-raised active:bg-raised',
          pressed ? 'border-signal bg-signal/15' : 'border-transparent',
          disabled && 'opacity-35',
        )}
      >
        {children}
      </Pressable>
    </Tip>
  );
}

const Sep = () => <View className="mx-1 h-5 w-px bg-hairline xl:mx-1.5" />;

/**
 * The slim strip over the canvas: symbol picker, timeframe as a segmented strip,
 * history, magnet, and full screen. The picker opens the market sheet, so the
 * symbol and the timeframe can still be chosen from one place.
 */
export function DeskToolbar({
  symbol,
  timeframe,
  onTimeframe,
  onOpenMarket,
  canUndo,
  canRedo,
  hasDrawings,
  onUndo,
  onRedo,
  onClear,
  magnet,
  onMagnet,
  fullscreen,
  onFullscreen,
}: {
  symbol: string;
  timeframe: Timeframe;
  onTimeframe: (timeframe: Timeframe) => void;
  onOpenMarket: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasDrawings: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  magnet: boolean;
  onMagnet: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const { select } = useHaptics();
  return (
    <View
      role="toolbar"
      aria-label="Chart"
      className="hidden h-11 shrink-0 flex-row items-center border-b border-hairline bg-panel px-2 lg:flex"
      style={{ zIndex: 5 }}
    >
      <Pressable
        role="button"
        aria-label={`Change market, now ${symbol} ${timeframe.label}`}
        onPress={onOpenMarket}
        className="h-8 flex-row items-center gap-2 rounded-xs px-2 hover:bg-raised active:bg-raised"
      >
        <View className="hidden size-5 items-center justify-center rounded-[2px] border border-hairline bg-raised xl:flex">
          <Text className="font-mono-bold text-9 text-bone">{baseOf(symbol).slice(0, 1)}</Text>
        </View>
        <Text className="font-mono-bold text-13 tracking-t20 text-bone">{compactSymbol(symbol)}</Text>
        <Icon name="chevron-down" size={13} color="ash" />
      </Pressable>

      <Sep />

      <View role="tablist" aria-label="Timeframe" className="flex-row rounded-sm border border-hairline bg-sunken p-0.5">
        {CHART_TIMEFRAMES.map((tf) => {
          const on = tf.bucketSeconds === timeframe.bucketSeconds;
          return (
            <Pressable
              key={tf.label}
              role="tab"
              aria-selected={on}
              aria-label={`Timeframe ${tf.label}`}
              onPress={() => {
                if (on) return;
                select();
                onTimeframe(tf);
              }}
              className={cx(
                'h-6 min-w-7 items-center justify-center rounded-xs border px-1.5 xl:min-w-8 xl:px-2',
                on ? 'border-hairline bg-lift' : 'border-transparent hover:bg-raised',
              )}
            >
              <Text className={cx('text-11', on ? 'font-mono-bold text-signal' : 'font-mono text-ash')}>{tf.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Sep />

      <View className="flex-row items-center gap-0.5">
        <BarIcon label="Undo" disabled={!canUndo} onPress={onUndo}>
          <Icon name="undo" size={17} color="bone" />
        </BarIcon>
        <BarIcon label="Redo" disabled={!canRedo} onPress={onRedo}>
          <Icon name="redo" size={17} color="bone" />
        </BarIcon>
        <BarIcon label="Clear all drawings" disabled={!hasDrawings} onPress={onClear}>
          <Icon name="trash" size={16} color="ash" />
        </BarIcon>
      </View>

      <Sep />

      <BarIcon label="Magnet: snap to candle highs, lows and closes" pressed={magnet} onPress={onMagnet}>
        <ToolIcon name="magnet" size={18} color={magnet ? 'signal' : 'bone'} />
      </BarIcon>

      <View className="flex-1" />

      <BarIcon label={fullscreen ? 'Exit full screen' : 'Full screen'} place="below-end" onPress={onFullscreen}>
        {fullscreen ? <ToolIcon name="minimize" size={18} color="bone" /> : <Icon name="maximize" size={18} color="bone" />}
      </BarIcon>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* On the canvas                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the crosshair is on, over the canvas's top-left corner: the symbol, the
 * timeframe, where the feed comes from, and O H L C. Read-only: pointer events go
 * through it to the chart.
 */
export function DeskLegend({
  symbol,
  timeframe,
  status,
  readout,
}: {
  symbol: string;
  timeframe: string;
  status: FeedStatus;
  readout: Readout | null;
}) {
  const tone = readout?.direction === 'up' ? 'text-long' : readout?.direction === 'down' ? 'text-short' : 'text-bone';
  const cell = (label: string, value: string) => (
    <View key={label} className="flex-row items-baseline gap-1">
      <Text className="font-mono text-9 text-ash">{label}</Text>
      <Num className={cx('text-11', tone)}>{value}</Num>
    </View>
  );
  return (
    <View className="absolute left-3 top-2.5 hidden gap-1 lg:flex" style={{ pointerEvents: 'none' }}>
      <View className="flex-row items-center gap-2">
        <Text className="font-mono-bold text-13 text-bone">{symbol}</Text>
        <Text className="font-mono text-12 text-signal">{timeframe}</Text>
        <View className="ml-1 flex-row items-center gap-1.5">
          <Dot className={STATUS_DOT[status]} />
          <Text className="font-mono text-9 tracking-w14 text-ash">{STATUS_LABEL[status]}</Text>
        </View>
      </View>
      {readout ? (
        <View className="flex-row items-center gap-3">
          {cell('O', readout.o)}
          {cell('H', readout.h)}
          {cell('L', readout.l)}
          {cell('C', readout.c)}
        </View>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Right panel                                                                 */
/* -------------------------------------------------------------------------- */

function SymbolBlock({
  symbol,
  price,
  change,
  status,
}: {
  symbol: string;
  price: string | null;
  change: ChangeText | null;
  status: FeedStatus;
}) {
  const tone = change ? TONE_TEXT[DIRECTION_TONE[change.direction]] : 'text-ash';
  return (
    <View className="gap-1 border-b border-hairline px-4 pb-3.5 pt-4">
      <View className="flex-row items-center justify-between gap-2">
        <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="font-mono-bold text-15 tracking-t20 text-bone">
            {symbol}
          </Text>
          <Text numberOfLines={1} className="shrink font-sans text-12 text-ash">
            {assetTitle(symbol).split(' / ')[0]}
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <Dot className={STATUS_DOT[status]} />
          <Text className="font-mono text-9 tracking-w14 text-ash">{STATUS_LABEL[status]}</Text>
        </View>
      </View>
      <Num className="text-30 tracking-t30">{price ?? '—'}</Num>
      {change ? (
        <View className="flex-row items-center gap-2">
          {change.direction === 'flat' ? null : (
            <Icon
              name={change.direction === 'up' ? 'arrow-up' : 'arrow-down'}
              size={12}
              color={change.direction === 'up' ? 'long' : 'short'}
              strokeWidth={2}
            />
          )}
          <Num className={cx('text-12', tone)}>{change.absText}</Num>
          <Num className={cx('text-12', tone)}>{change.percentText}</Num>
          <Meta>24H</Meta>
        </View>
      ) : (
        <Meta>24H MOVE APPEARS WITH THE FIRST CANDLES</Meta>
      )}
    </View>
  );
}

const WatchRow = memo(function WatchRow({
  asset,
  selected,
  onSelect,
}: {
  asset: string;
  selected: boolean;
  onSelect: (asset: string) => void;
}) {
  const ticker = useTicker(asset);
  const { select } = useHaptics();
  const base = baseOf(asset);
  const t: PairTicker | null = ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker : null;
  return (
    <Pressable
      role="button"
      aria-pressed={selected}
      aria-label={
        t
          ? `Show ${asset} on the chart, ${formatDecimal(t.price)}${t.changeBps === null ? '' : `, ${formatBps(t.changeBps, { signed: true })} over 24 hours`}`
          : `Show ${asset} on the chart`
      }
      onPress={() => {
        if (selected) return;
        select();
        onSelect(asset);
      }}
      className={cx(
        'relative min-h-14 flex-row items-center gap-3 px-4 py-2.5',
        selected ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
      )}
    >
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', selected ? 'opacity-100' : 'opacity-0')} />
      <Avatar name={base} size="sm" tone={selected ? 'signal' : 'neutral'} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-sans text-13 font-medium text-bone">
          {base}
          <Text className="font-mono text-11 text-ash">{'  /USD'}</Text>
        </Text>
        <Text numberOfLines={1} className="font-sans text-11 text-ash">
          {assetTitle(asset).split(' / ')[0]}
        </Text>
      </View>
      <View className="items-end gap-0.5">
        {t ? (
          <>
            <Num className="font-mono-medium text-13 tracking-t20">{formatDecimal(t.price)}</Num>
            {t.changeBps === null ? (
              <Num className="text-11 text-ash">{'—'}</Num>
            ) : (
              <Delta value={formatBps(Math.abs(t.changeBps))} direction={directionOf(t.changeBps)} />
            )}
          </>
        ) : (
          <Num className="text-12 text-ash">{'—'}</Num>
        )}
      </View>
    </Pressable>
  );
});

/** Tradeable pairs, only those with a signed price feed. Choosing one switches the chart to it. */
function Watchlist({ asset, onAsset }: { asset: string; onAsset: (asset: string) => void }) {
  const markets = useMarkets();
  const assets = useMemo(
    () =>
      markets.status === 'ready' || markets.status === 'demo' ? markets.pairs.map((p) => p.asset).filter(isMarketAsset) : [],
    [markets],
  );
  return (
    <View>
      <SectionHeader title="Markets" {...(assets.length > 0 ? { count: assets.length } : {})} className="px-4 pb-2.5 pt-4" />
      {markets.status === 'loading' ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : assets.length === 0 ? (
        <Text className="px-4 pb-4 font-sans text-12 leading-[18px] text-ash">
          Prices for BTC, ETH, SOL and MON appear here as soon as their signed feeds print.
        </Text>
      ) : (
        assets.map((a) => <WatchRow key={a} asset={a} selected={a === asset} onSelect={onAsset} />)
      )}
    </View>
  );
}

/** The pinned rule the chart is overlaid with, and the switch for its structure on the tape. */
function RuleBlock({
  name,
  predicates,
  structure,
}: {
  name: string;
  predicates: readonly string[];
  structure: { available: boolean; on: boolean; onToggle: () => void };
}) {
  return (
    <View className="gap-3 border-t border-hairline px-4 pb-4 pt-4">
      <SectionHeader title="Pinned rule" />
      <Link
        href={routes.home}
        aria-label={`Open rule ${name}`}
        className="min-h-9 flex-row items-center gap-2 rounded-xs py-1.5 hover:bg-raised/60"
      >
        <View className="size-1.75 shrink-0 bg-signal" />
        <Text numberOfLines={1} className="min-w-0 flex-1 font-mono-medium text-12 text-bone">
          {name}
        </Text>
        <Icon name="chevron-right" size={14} color="ash" />
      </Link>
      {predicates.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {predicates.map((p) => (
            <View key={p} className="rounded-xs border border-hairline bg-raised px-2 py-1">
              <Text className="font-mono text-10 tracking-w06 text-ash">{predicateCode(p)}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {structure.available ? (
        <Pressable
          role="button"
          aria-label={structure.on ? 'Hide rule structure' : 'Show rule structure'}
          aria-pressed={structure.on}
          onPress={structure.onToggle}
          className={cx(
            'h-9 flex-row items-center justify-between rounded-sm border px-3 hover:bg-raised/60',
            structure.on ? 'border-signal bg-signal/15' : 'border-hairline bg-panel',
          )}
        >
          <View className="flex-row items-center gap-2">
            <Icon name={structure.on ? 'eye' : 'eye-off'} size={14} color={structure.on ? 'signal' : 'ash'} />
            <Text className="font-sans text-12 text-bone">Rule structure on the chart</Text>
          </View>
          <Text className={cx('font-mono-bold text-10 tracking-w10', structure.on ? 'text-signal' : 'text-ash')}>
            {structure.on ? 'ON' : 'OFF'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The panel: the symbol at a glance, the markets to switch between, the pinned rule
 * and its structure toggle, the caller's recent orders, and the ticket. Its width is
 * 264 from `lg` and 300 from `xl`, so the canvas keeps room at a laptop's width.
 */
export function DeskPanel({
  asset,
  onAsset,
  price,
  change,
  status,
  rule,
  structure,
  ticket,
  onCheckRule,
  checking,
  note,
}: {
  asset: string;
  onAsset: (asset: string) => void;
  price: string | null;
  change: ChangeText | null;
  status: FeedStatus;
  rule: { name: string; predicates: readonly string[] };
  structure: { available: boolean; on: boolean; onToggle: () => void };
  /** The order ticket's state, held by the screen so the phone's bar and sheet share it. */
  ticket: VenueTicket;
  /** The ticket's secondary action: put the market to the pinned rule. Places nothing. */
  onCheckRule: () => void;
  checking: boolean;
  note: string | null;
}) {
  // The watchlist subscribes to every pair and the order list to the caller's orders, so both
  // mount only where there is a panel to show them in.
  const desktop = useLayout() === 'desktop';
  return (
    <View
      role="complementary"
      aria-label="Markets and order ticket"
      className="hidden min-h-0 w-[264px] shrink-0 border-l border-hairline bg-panel lg:flex xl:w-[300px]"
    >
      <SymbolBlock symbol={asset} price={price} change={change} status={status} />
      {/* Never squeezed to nothing: a tall ticket scrolls its own middle before this list gives up its last rows. */}
      <ScrollView className="min-h-28 flex-1" showsVerticalScrollIndicator={false}>
        {desktop ? <Watchlist asset={asset} onAsset={onAsset} /> : null}
        <RuleBlock name={rule.name} predicates={rule.predicates} structure={structure} />
        {desktop ? <RecentOrders inset className="border-t border-hairline pt-4" /> : null}
      </ScrollView>
      <OrderTicket ticket={ticket} onCheckRule={onCheckRule} checking={checking} note={note} />
    </View>
  );
}
