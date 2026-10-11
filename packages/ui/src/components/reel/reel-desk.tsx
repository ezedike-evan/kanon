import { memo, useMemo } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { formatBps } from '@kanon/spec';
import { assetTitle } from '../../lib/chart-assets';
import { cx } from '../../lib/cx';
import type { PairTicker } from '../../lib/domain-types';
import { useTicker } from '../../lib/domains';
import { slideMode, slideRowView, type ReelFilter, type ReelSlide } from '../../lib/timed-reel';
import { durationLabel, formatTimedPrice, timedView, type TimedMarketChoice } from '../../lib/timed-trade';
import type { TimedTrade } from '../../lib/timed-types';
import type { TimedTicket } from '../../lib/use-timed-ticket';
import { formatLeverage } from '../../lib/venue-trade';
import { useHaptics } from '../../platform';
import { Avatar } from '../avatar';
import { Icon } from '../icons';
import { PanelRail, PanelToggle, usePanelOpen } from '../panel-rail';
import { SectionHeader } from '../section-header';
import { Delta, Label } from '../stat';
import { directionOf } from '../tone';
import { Num } from '../ui';
import { History, RunningList, TradeRules } from './reel-trades';
import { FOCUS } from './trade-parts';

/*
 * The two panels either side of the reel on a desktop. The left is `hidden` below
 * `lg` and `flex` from it, the right from `xl` (at 1024 the pane has room for the
 * 440px reel and one panel, not two), by class. The screen renders them on the web
 * only and gives the left its rows only once the window is a desktop's, so a phone
 * pays for none of it. Everything they show is what the reel already holds: the
 * server's pairs and times, the live tickers, and the caller's trades.
 *
 * Each collapses to a 40px rail (`components/panel-rail.tsx`) and the reel, which
 * keeps its own 440px, re-centres in the width that frees. The choice is
 * remembered on the device, one per panel.
 */

const PANEL = 'hidden min-h-0 shrink-0 bg-panel lg:flex';

/** What each panel is called, open or collapsed, so the landmark and both toggles agree. */
const SLIDES_PANEL = { label: 'Pairs and times', name: 'pairs and times' } as const;
const TRADES_PANEL = { label: 'Your trades', name: 'your trades' } as const;

/* -------------------------------------------------------------------------- */
/* Left: what to look at                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One pair in the filter list, with its live price. Its own subscription, so
 * another pair's tick re-renders nothing here. A pair that can take no trade
 * right now says why in the place its name goes.
 */
const AssetRow = memo(function AssetRow({
  choice,
  selected,
  onPress,
}: {
  choice: TimedMarketChoice;
  selected: boolean;
  onPress: () => void;
}) {
  const ticker = useTicker(choice.asset);
  const { select } = useHaptics();
  const t: PairTicker | null = ticker.status === 'ready' || ticker.status === 'demo' ? ticker.ticker : null;
  return (
    <Pressable
      role="button"
      aria-pressed={selected}
      aria-label={`${selected ? 'Showing' : 'Show'} ${choice.base} slides${choice.busyLine ? `. ${choice.busyLine}` : ''}`}
      onPress={() => {
        select();
        onPress();
      }}
      className={cx(
        'relative min-h-14 flex-row items-center gap-3 px-4 py-2.5',
        selected ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
        FOCUS,
      )}
    >
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', selected ? 'opacity-100' : 'opacity-0')} />
      <Avatar name={choice.base} size="sm" tone={selected ? 'signal' : 'neutral'} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-sans text-13 font-medium text-bone">
          {choice.base}
          <Text className="font-mono text-11 text-ash" style={{ fontVariant: ['tabular-nums'] }}>
            {`  ${formatLeverage(choice.leverage)}`}
          </Text>
        </Text>
        {choice.busyLine ? (
          <Num className="text-10 leading-[14px] text-ash">{choice.busyLine}</Num>
        ) : (
          <Text numberOfLines={1} className="font-sans text-11 text-ash">
            {assetTitle(choice.asset).split(' / ')[0]}
          </Text>
        )}
      </View>
      <View className="items-end gap-0.5">
        {t ? (
          <>
            <Num className="font-mono-medium text-13 tracking-t20">{formatTimedPrice(t.price)}</Num>
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

/** A slide in the list: its pair and its time, and where it stands. The one on screen is lit. */
function SlideRow({
  slide,
  ticket,
  current,
  onPress,
}: {
  slide: ReelSlide;
  ticket: TimedTicket;
  current: boolean;
  onPress: () => void;
}) {
  const row = useMemo(() => {
    const view = timedView(ticket.state, { asset: slide.asset, stakeUsd: ticket.stake, seconds: slide.seconds });
    return slideRowView(slide, slideMode(slide, view, ticket.running, ticket.ended), view.sample);
  }, [slide, ticket.state, ticket.stake, ticket.running, ticket.ended]);
  return (
    <Pressable
      role="button"
      aria-current={current ? 'true' : undefined}
      aria-label={row.accessibilityLabel}
      onPress={onPress}
      className={cx('relative gap-0.5 px-4 py-2.5', current ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised', FOCUS)}
    >
      <View className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', current ? 'opacity-100' : 'opacity-0')} />
      <View className="flex-row items-center gap-2">
        <Text className="font-mono-bold text-12 tracking-w08 text-bone">{row.base}</Text>
        <Num className="text-11 text-ash">{row.time}</Num>
      </View>
      <Num className="text-11 leading-4 text-ash">{row.state}</Num>
    </Pressable>
  );
}

/** Time as a strip: any time, or one of those the server offers. */
function TimeStrip({
  value,
  options,
  onChange,
}: {
  value: number | null;
  options: readonly number[];
  onChange: (seconds: number | null) => void;
}) {
  const { select } = useHaptics();
  const all: ReadonlyArray<number | null> = [null, ...options];
  return (
    <View role="tablist" aria-label="Time" className="flex-row rounded-sm border border-hairline bg-sunken p-0.5">
      {all.map((seconds) => {
        const on = seconds === value;
        return (
          <Pressable
            key={seconds ?? 'any'}
            role="tab"
            aria-selected={on}
            aria-label={seconds === null ? 'Any time' : `Time ${durationLabel(seconds)}`}
            onPress={() => {
              if (on) return;
              select();
              onChange(seconds);
            }}
            className={cx(
              'h-7 flex-1 items-center justify-center rounded-xs border',
              on ? 'border-hairline bg-lift' : 'border-transparent hover:bg-raised',
              FOCUS,
            )}
          >
            <Text
              className={cx('text-11', on ? 'font-mono-bold text-bone' : 'font-mono text-ash')}
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {seconds === null ? 'Any' : durationLabel(seconds)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Left of the reel: the pairs the server lists, with live prices, as a filter;
 * the time; and the slides in view as a list with the current one lit. Every row
 * moves the reel, so it is navigable without swiping.
 */
export function ReelLeftPanel({
  live,
  ticket,
  times,
  filter,
  onAsset,
  onTime,
  slides,
  activeId,
  onPick,
}: {
  /** The window is a desktop's: mount the rows (they subscribe to prices). */
  live: boolean;
  ticket: TimedTicket;
  times: readonly number[];
  filter: ReelFilter;
  onAsset: (asset: string | null) => void;
  onTime: (seconds: number | null) => void;
  /** The slides the filter leaves, in reel order. */
  slides: readonly ReelSlide[];
  activeId: string | null;
  onPick: (slideId: string) => void;
}) {
  const [open, setOpen] = usePanelOpen('predictMarketsPanelOpen');
  const pairs = ticket.base.markets;
  if (!open) {
    return <PanelRail side="left" {...SLIDES_PANEL} caption="Pairs · Times" onOpen={() => setOpen(true)} />;
  }
  return (
    <View
      role="complementary"
      aria-label={SLIDES_PANEL.label}
      className={cx(PANEL, 'w-[264px] border-r border-hairline xl:w-[296px]')}
    >
      <ScrollView className="min-h-0 flex-1" showsVerticalScrollIndicator={false}>
        {/* The toggle shares the first heading's row, so collapsing costs the panel no height. */}
        <View className="flex-row items-center pr-1">
          <SectionHeader
            title="Pairs"
            {...(pairs.length > 0 ? { count: pairs.length } : {})}
            className="min-w-0 flex-1 pb-2.5 pl-4 pt-4"
          />
          <PanelToggle side="left" open name={SLIDES_PANEL.name} onToggle={() => setOpen(false)} className="mt-1.5" />
        </View>
        {live && pairs.length > 0 ? (
          <>
            <Pressable
              role="button"
              aria-pressed={filter.asset === null}
              aria-label={`Show every pair, ${pairs.length}`}
              onPress={() => onAsset(null)}
              className={cx(
                'relative min-h-12 flex-row items-center gap-3 px-4 py-2.5',
                filter.asset === null ? 'bg-raised' : 'hover:bg-raised/60 active:bg-raised',
                FOCUS,
              )}
            >
              <View
                className={cx('absolute inset-y-2 left-0 w-0.5 bg-signal', filter.asset === null ? 'opacity-100' : 'opacity-0')}
              />
              <View className="size-8 items-center justify-center rounded-sm border border-hairline bg-raised">
                <Icon name="layers" size={16} color="ash" />
              </View>
              <Text className="min-w-0 flex-1 font-sans text-13 font-medium text-bone">Every pair</Text>
              <Num className="text-12 text-ash">{pairs.length}</Num>
            </Pressable>
            {pairs.map((choice) => (
              <AssetRow
                key={choice.asset}
                choice={choice}
                selected={filter.asset === choice.base}
                onPress={() => onAsset(filter.asset === choice.base ? null : choice.base)}
              />
            ))}
            {/* Signed out, the prices beside the pairs are the demo's, and the list says so. */}
            {ticket.base.sample ? (
              <Text className="px-4 pb-1 pt-2 font-sans text-11 leading-4 text-ash">Sample prices. Nothing is sent from here.</Text>
            ) : null}
          </>
        ) : pairs.length === 0 ? (
          <Num className="px-4 pb-2 text-12 leading-[18px] text-ash">{ticket.base.hold ?? 'No pair is listed right now.'}</Num>
        ) : null}

        {times.length > 1 ? (
          <View className="gap-2 px-4 pb-1 pt-4">
            <Label>Time</Label>
            <TimeStrip value={filter.seconds} options={times} onChange={onTime} />
          </View>
        ) : null}

        {/* Nothing to list while there is nothing to trade: the reel itself says why. */}
        {slides.length > 0 || filter.asset !== null || filter.seconds !== null ? (
          <View className="mt-3 border-t border-hairline">
            <SectionHeader title="In view" count={slides.length} className="px-4 pb-1.5 pt-4" />
            {slides.length === 0 ? (
              <Text className="px-4 pb-4 pt-1 font-sans text-12 leading-[18px] text-ash">No slide matches this filter.</Text>
            ) : (
              slides.map((slide) => (
                <SlideRow
                  key={slide.id}
                  slide={slide}
                  ticket={ticket}
                  current={slide.id === activeId}
                  onPress={() => onPick(slide.id)}
                />
              ))
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Right: what is running, and what has finished                               */
/* -------------------------------------------------------------------------- */

/**
 * Right of the reel, from `xl`: the caller's trades. What is running, the
 * soonest to end first, each with its countdown and its own "End now"; then
 * every finished trade. A press on a running row takes the reel to its slide; a
 * press on a finished one opens its details.
 *
 * Collapsed, the rail still says how many trades are running, so one is never
 * out of sight behind it.
 */
export function ReelTradesPanel({
  ticket,
  onGo,
  onDetails,
}: {
  ticket: TimedTicket;
  onGo: (trade: TimedTrade) => void;
  onDetails: (tradeId: string) => void;
}) {
  const [open, setOpen] = usePanelOpen('predictTradesPanelOpen');
  const running = ticket.running.length;

  if (!open) {
    return (
      <PanelRail side="right" from="xl" {...TRADES_PANEL} caption="Running · History" onOpen={() => setOpen(true)}>
        {running > 0 ? (
          <View
            aria-label={`${running} running`}
            className="h-5 min-w-5 items-center justify-center rounded-xs bg-signal px-1"
          >
            <Num className="font-mono-bold text-10 text-void">{running}</Num>
          </View>
        ) : null}
      </PanelRail>
    );
  }
  return (
    <View
      role="complementary"
      aria-label={TRADES_PANEL.label}
      className="hidden min-h-0 w-[320px] shrink-0 border-l border-hairline bg-panel xl:flex"
    >
      <ScrollView className="min-h-0 flex-1" showsVerticalScrollIndicator={false}>
        <View className="flex-row items-center pr-1">
          <SectionHeader
            title="Running"
            {...(running > 0 ? { count: running } : {})}
            className="min-w-0 flex-1 pb-3 pl-4 pt-4"
          />
          <PanelToggle side="right" open name={TRADES_PANEL.name} onToggle={() => setOpen(false)} className="mt-1" />
        </View>
        <RunningList ticket={ticket} onGo={onGo} bare className="px-4" />
        <History trades={ticket.history} status={ticket.tradesStatus} onOpen={onDetails} className="px-4 pt-6" />
        <TradeRules ticket={ticket} className="px-4 pb-6 pt-5" />
      </ScrollView>
    </View>
  );
}
